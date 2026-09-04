/**
 * ============================================================================
 * api.js —— 後端 API 客戶端
 * ============================================================================
 * 全部走相對路徑 /api/...（dev 由 vite proxy、prod 由反向代理轉發）。
 *
 * 態勢卡輪詢的 ETag 處理是重點：
 *   - 前一次回應的 ETag 存在記憶體，下次請求帶 If-None-Match
 *   - 304 時沿用上一次的卡片內容 → 零傳輸成本
 *   - 輪詢節奏 12 秒，且只在 document 可見時跑（Page Visibility）
 *     —— 背景分頁完全停止請求，省電也省基地台頻寬
 */

import { getSessionId } from './session.js';

const jsonHeaders = { 'Content-Type': 'application/json' };

/** analyzePhoto 失敗時的降級形狀——與 server 端 advisor 的降級結構一致 */
const VISION_DEGRADED = { pending: true, roiCell: null, texts: [], anomalies: [] };

/**
 * 送出一筆回報。
 * 攜帶 client 產生的 UUID 作為冪等鍵——恐慌連點重送時 server 去重。
 * zone（九宮格）、note（文字補充）、語音、照片皆為選配。
 *
 * 照片有兩種帶法，擇一即可：
 *   - photoRef：拍照時已打過 /api/vision，server 那邊還留著這張圖 → 只帶 ref，
 *     3G 下省掉第二次 50KB 上傳（首選）
 *   - photo：沒有 ref 時（分析失敗／ref 過期）才帶完整 base64（後備）
 *
 * 事件位置同樣擇一：incidentPoint（地圖選點，最精確）或 nearExitCode（出口錨點）。
 */
export async function postReport({
  uuid, type, locationClaim, attachToEventId = null,
  nearExitCode = null, incidentPoint = null, photoRoi = null,
  note = null, audio = null, photo = null, photoRef = null,
}) {
  const res = await fetch('/api/reports', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      uuid,
      sessionId: getSessionId(),
      type,
      locationClaim,
      attachToEventId,
      nearExitCode,               // 場域錨點（出口代碼，確定性查表得出）
      incidentPoint,              // 地圖選點 { lat, lon }（最精確的事件位置）
      photoRoi,                   // 照片九宮格（影像座標，僅供追溯）
      note,                       // 文字補充（≤140 字，選配）
      audio,                      // { base64, mimeType } | null
      // 有 ref 就不重傳圖；沒有才帶 base64
      photo: photoRef ? null : photo,
      photoRef,                   // server 端暫存的照片代號
    }),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`回報失敗（${res.status}）`);
  }
  return res.json();
}

/**
 * 視覺錨點分析（兩階段，非阻塞）：
 *   stage='locate' 送整張壓縮圖 → 回 roiCell（哪一格有站名/出口牌）+ photoRef
 *   stage='read'   送裁切後的那一格 → 回 texts（讀到的字）+ candidates（查表結果）
 *
 * 失敗或未設供應商時回降級形狀——UI 靜默退回手選，絕不擋回報。
 *
 * @returns {Promise<{result, candidates, photoRef, enabled}>}
 */
export async function analyzePhoto({ base64, mimeType, stage = 'locate', venueId, lat, lon }) {
  const fallback = { result: VISION_DEGRADED, candidates: [], photoRef: null, enabled: false };
  try {
    const res = await fetch('/api/vision', {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ base64, mimeType, stage, venueId, lat, lon }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    return {
      result: data.result ?? VISION_DEGRADED,
      candidates: data.candidates ?? [],
      photoRef: data.photoRef ?? null,
      enabled: Boolean(data.enabled),
    };
  } catch {
    // 網路中斷也不能擋回報——照片改走完整上傳路徑
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// 場域圖資（全部在 server：client 不持有任何地圖資料）
// ---------------------------------------------------------------------------

/** 依粗略座標取鄰近場域——零打字選擇的主路徑 */
export async function fetchNearbyVenues(lat, lon) {
  try {
    const res = await fetch(`/api/venues/nearby?lat=${lat}&lon=${lon}`);
    if (!res.ok) return [];
    return (await res.json()).venues ?? [];
  } catch {
    return [];
  }
}

/** 場域名稱搜尋——沒有定位訊號時的後備路徑 */
export async function searchVenues(q) {
  try {
    const res = await fetch(`/api/venues/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return [];
    return (await res.json()).venues ?? [];
  } catch {
    return [];
  }
}

/** 單一場域的出口清單與示意幾何（畫 SVG 小地圖用；無圖磚、僅幾 KB） */
export async function fetchVenue(venueId) {
  try {
    const res = await fetch(`/api/venues/${encodeURIComponent(venueId)}`);
    if (!res.ok) return null;
    return (await res.json()).venue ?? null;
  } catch {
    return null;
  }
}

/** 查某站（可選加類型）進行中的事件——「同一件/另一件」歸屬確認用 */
export async function fetchEventsContext(stationId, type) {
  const params = new URLSearchParams({ station: stationId });
  if (type) params.set('type', type);
  const res = await fetch(`/api/reports/context?${params}`);
  const data = await res.json();
  return data.events ?? [];
}

/** 事件清單（確認頁入口；可帶 station 過濾） */
export async function fetchEvents(stationId) {
  const params = stationId ? `?station=${encodeURIComponent(stationId)}` : '';
  const res = await fetch(`/api/events${params}`);
  const data = await res.json();
  return data.events ?? [];
}

/**
 * 兩段式確認：提交某一問的答案。
 * step='location'（在/不在）或 step='witness'（有/沒有/沒注意）
 */
export async function confirmEvent(eventId, { step, atStation, witnessed }) {
  const res = await fetch(`/api/events/${eventId}/confirm`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ sessionId: getSessionId(), step, atStation, witnessed }),
  });
  return res.json();
}

/**
 * 態勢卡 ETag 輪詢器。
 * 用法：
 *   const stop = startSituationPolling(onCard, {intervalMs: 12000});
 *   // onCard(card) 會在「內容有變」時被呼叫（304 時不觸發）
 *
 * 前台/背景切換由 document.visibilitychange 控制——背景暫停、回前台即刻補輪詢一次。
 */
export function startSituationPolling(onCard, { intervalMs = 12_000 } = {}) {
  let etag = null;
  let lastCard = null;
  let timer = null;

  async function poll() {
    try {
      const headers = etag ? { 'If-None-Match': etag } : {};
      const res = await fetch('/api/situation', { headers });
      if (res.status === 304) return; // 未變動——沿用上一次內容
      etag = res.headers.get('ETag');
      const data = await res.json();
      lastCard = data;
      onCard(data);
    } catch {
      // 弱網失敗是常態：安靜跳過，下個 tick 再試
    }
  }

  function start() {
    if (timer) return;
    poll();
    timer = setInterval(poll, intervalMs);
  }
  function stop() {
    clearInterval(timer);
    timer = null;
  }

  // ---- 前台才輪詢（設計原則：背景分頁零請求） ----
  document.addEventListener('visibilitychange', () => {
    document.hidden ? stop() : start();
  });
  start();

  return { stop, getLastCard: () => lastCard };
}
