/**
 * ============================================================================
 * evacuationService —— 疏散建議（確定性、且只講知道的事）
 * ============================================================================
 * 【這個模組最重要的一條紀律：不要輸出我們其實不知道的數字】
 *
 * 我們手上唯一的幾何資料，是 OSM 上每個出入口的**地面**經緯度。
 * 用它算出來的「M3 到 M7 距離 91 公尺」有四個問題：
 *
 *   1. 量的是地面，不是地下——地下要走通道、穿大廳、上下樓梯，路徑完全不同
 *   2. 量的不是使用者所在的樓層——垂直移動與走到樓梯的距離都沒算進去
 *   3. 起點本身就不精確——「近 M3 出口」用的是地面出入口座標，
 *      但事件在地下，可能離那個樓梯口 30~50m
 *   4. 地下不能走直線——牆、月台邊緣、閘門、單向電扶梯
 *
 * 在生命安全情境下顯示一個看似精確的錯誤數字，比不顯示更糟。
 * 所以座標在這裡只做**兩件它做得好的事**：排序、以及畫地圖。
 * 對使用者輸出的是「出口編號 + 通往哪裡」——
 * **因為站內的指標系統本來就是用出口編號在導引的**。牆上寫的是「← M7 出口」，
 * 不是「往東 91 公尺」。給出跟現場指標對得上的資訊，才是可行動的。
 *
 * 真正可信的數字只有一種來源：實測步行時間（見 traversalService，
 * 由使用者的錨點配對累積而來）。有實測值時才顯示，並明確標示「實測」。
 *
 * 其餘紀律不變：
 *   - 純函式、零 AI、零延遲，與 llm.js 的 ADVICE_TEMPLATES 同一層級
 *   - 由 batch worker 預先算好寫進態勢卡（client 盡量少事）
 *   - 資訊不足時說「依現場人員指示」，不硬給方向
 */

import { findVenue, findExit, distanceM } from './venueService.js';

/**
 * 以下兩個半徑是**內部排序用的啟發式**，不對外顯示。
 * 直線距離拿來做「排序」與「粗略分組」是穩健的（差一個數量級的東西排得出來），
 * 拿來當「你要走幾公尺」則不成立——這正是它們不出現在輸出文字裡的原因。
 */
const AVOID_RADIUS_M = 60;   // 這麼近的出口視為可能與事件在同一區
const PREFER_MIN_DIST_M = 80; // 建議的出口至少要離這麼遠才算「另一個區域」

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

  // 先過門檻（另一個區域），再取其中最近的幾個——「離事件夠遠、但走得到」。
  // 台北車站複合體長達 700m，叫人往最遠的出口跑是壞建議：門檻不是最佳化目標。
  const safe = scored.filter((s) => s.dist >= PREFER_MIN_DIST_M);
  const away = safe.length > 0 ? safe : [scored[scored.length - 1]];

  const nearby = scored.filter((s) => s.dist <= AVOID_RADIUS_M);
  return {
    away: away.slice(0, 3),
    // 若每個出口都落在避開半徑內，這份清單就沒有篩選作用——寧可不說
    avoid: nearby.length === scored.length ? [] : nearby.slice(0, 3),
  };
}

/**
 * 出口的可讀標示。
 * 地標（OSM 的 exit_to / 名稱括號內文字）是**方向資訊**，不是距離——
 * 「M7 出口（市民大道）」告訴你往哪走，而且跟站內指標寫的是同一件事。
 */
function label(exit) {
  return exit.landmark ? `${exit.code} 出口（往${exit.landmark}）` : `${exit.code} 出口`;
}

/**
 * 產生一行疏散建議文字。
 *
 * @param {string} venueId
 * @param {string|null} nearExitCode
 * @param {{lat, lon}|null} point
 * @param {(from: string|null, to: string) => {minutes: number, samples: number}|null} [measured]
 *        實測步行時間查詢函式（traversalService 提供）。**只有實測值才顯示時間**；
 *        沒有就不講，不用直線距離換算一個假的估計值出來。
 * @returns {string|null} 無出口圖資時回 null，由呼叫端退回通用建議
 */
export function evacuationLine(venueId, nearExitCode, point = null, measured = null) {
  const s = suggestExits(venueId, nearExitCode, point);
  if (!s) return null;

  const describe = (x) => {
    const m = measured?.(nearExitCode, x.exit.code);
    // 實測值才有資格出現在文字裡，並標明它是實測、幾個人走過
    return m
      ? `${label(x.exit)}——實測步行約 ${m.minutes} 分（${m.samples} 人走過）`
      : label(x.exit);
  };

  const away = s.away.map(describe).join('、');
  const here = nearExitCode ? `${nearExitCode} 出口一帶` : '事件位置';
  const from = nearExitCode ? `遠離 ${here}` : '遠離事件位置';

  // 避開清單的篩選在 suggestExits 就做完了（全部都要避開時會清空）
  const avoidPart =
    s.avoid.length > 0 ? `；避開 ${s.avoid.map((x) => label(x.exit)).join('、')}` : '';

  return `${from}，改往 ${away}${avoidPart}。請依站內出口指標前進。`;
}
