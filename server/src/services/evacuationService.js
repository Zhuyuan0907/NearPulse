/**
 * ============================================================================
 * evacuationService —— 疏散向量（確定性、真實距離）
 * ============================================================================
 * v0.2 的版本用九宮格 + Chebyshev 棋盤距離，那是「沒有座標」時的權宜作法，
 * 而且它接收的格位其實來自影像座標系——算出來的方向結構正確但意義隨機。
 *
 * v0.3 有了 OSM 的每個出口精確經緯度，網格整個不需要了：
 *   事件位置 = 辨識到的出口（或場域中心）
 *   疏散建議 = 依真實公尺距離排序其餘出口
 *
 * 三條紀律：
 *   1. 誠實優先於看似精確——資訊不足時說「依現場人員指示」，不硬給方向
 *   2. 純函式、零 AI、零延遲，與 llm.js 的 ADVICE_TEMPLATES 同一層級
 *   3. 由 batch worker 預先算好寫進態勢卡（client 盡量少事）
 */

import { findVenue, findExit, distanceM } from './venueService.js';

/** 距離事件這麼近的出口視為可能受波及，建議避開 */
const AVOID_RADIUS_M = 60;

/**
 * 安全半徑：建議的出口至少要離事件這麼遠。
 *
 * ⚠️ 關鍵：超過這個距離之後就取**最近**的，不是最遠的。
 * 火警時要的是「夠遠離事件、但走得到」的出口——台北車站複合體長達 700m，
 * 叫人往 620m 外的出口跑是壞建議。安全距離是門檻，不是最佳化目標。
 */
const PREFER_MIN_DIST_M = 80;

/**
 * 計算疏散選項。
 * @param {string} venueId
 * @param {string|null} nearExitCode - 事件所在（或最接近）的出口代碼
 * @param {{lat, lon}|null} point - 使用者在地圖上點的事件位置（比出口更精確時）
 * @returns {{away: Array, avoid: Array}|null} 資料不足時回 null
 */
export function suggestExits(venueId, nearExitCode, point = null) {
  const venue = findVenue(venueId);
  if (!venue?.exits?.length) return null;

  // 事件原點的優先序：地圖選點（最精確）→ 辨識到的出口 → 場域中心
  const origin =
    (Number.isFinite(point?.lat) && Number.isFinite(point?.lon) ? point : null) ??
    findExit(venue.id, nearExitCode) ??
    { lat: venue.lat, lon: venue.lon };

  const scored = venue.exits
    .filter((e) => e.code !== nearExitCode) // 事件所在的出口本身不列為去處
    .map((e) => ({ exit: e, dist: Math.round(distanceM(origin, e)) }))
    .sort((a, b) => a.dist - b.dist); // 由近而遠

  if (scored.length === 0) return null;

  // 先過安全距離門檻，再取其中最近的幾個——「安全且走得到」
  const safe = scored.filter((s) => s.dist >= PREFER_MIN_DIST_M);
  // 場域小到所有出口都在安全半徑內時，退而取最遠的那一個（已由近而遠排序）
  const away = safe.length > 0 ? safe : [scored[scored.length - 1]];

  const nearby = scored.filter((s) => s.dist <= AVOID_RADIUS_M);
  return {
    away: away.slice(0, 3),
    // 若每個出口都落在避開半徑內，這份清單就沒有篩選作用——寧可不說
    avoid: nearby.length === scored.length ? [] : nearby.slice(0, 3),
  };
}

/** 出口的可讀標示：有地標就帶上，比裸編號好認得多 */
function label(exit) {
  return exit.landmark ? `${exit.code} 出口（${exit.landmark}）` : `${exit.code} 出口`;
}

/**
 * 產生一行疏散建議文字。
 * @returns {string|null} 無出口圖資時回 null，由呼叫端退回通用建議
 */
export function evacuationLine(venueId, nearExitCode, point = null) {
  const s = suggestExits(venueId, nearExitCode, point);
  if (!s) return null;

  const away = s.away.map((x) => `${label(x.exit)}（約 ${x.dist}m）`).join('、');
  const here = nearExitCode ? ` ${nearExitCode} 出口一帶` : '事件位置';

  // 避開清單的篩選在 suggestExits 就做完了（全部都要避開時會清空）
  const avoidPart =
    s.avoid.length > 0 ? `；避開 ${s.avoid.map((x) => label(x.exit)).join('、')}` : '';

  return `疏散建議：遠離${here}，往 ${away} 方向移動${avoidPart}。`;
}
