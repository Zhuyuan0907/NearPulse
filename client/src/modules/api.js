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

/**
 * 送出一筆回報。
 * 攜帶 client 產生的 UUID 作為冪等鍵——恐慌連點重送時 server 去重。
 */
export async function postReport({ uuid, type, locationClaim, attachToEventId = null, audio = null, photo = null }) {
  const res = await fetch('/api/reports', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({
      uuid,
      sessionId: getSessionId(),
      type,
      locationClaim,
      attachToEventId,
      audio, // { base64, mimeType } | null
      photo, // { base64 } | null
    }),
  });
  if (!res.ok && res.status !== 202) {
    throw new Error(`回報失敗（${res.status}）`);
  }
  return res.json();
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
