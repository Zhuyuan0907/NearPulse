/**
 * ============================================================================
 * threatMotion —— 移動威脅追蹤（純函式、確定性、零 AI）
 * ============================================================================
 * 【為什麼需要這個】
 * 火警、積水、有人昏倒——事件不會跑。但**無差別攻擊會**。
 *
 * 原本的實作是 `event.nearExitCode = report.nearExitCode`：只記得最新位置，
 * 把前面的全部覆寫掉。這對移動中的威脅是危險的錯誤：
 *
 *   2 號出口回報 → 一分鐘後 4 號出口回報
 *   系統：「事件在 4 號出口，往 2、3、5 號疏散」
 *   事實：威脅正從 2 往 4 移動，而系統剛剛叫人往它來的方向走，
 *         同時把「它正前往的方向」列為安全出口
 *
 * 好消息是原料本來就在：每筆回報都帶 (時間, 出口錨點, sessionId)。
 * 多筆回報就是一條軌跡——只是以前被丟掉了。
 *
 * 【使用者不需要多做任何事】
 * 這一切都是從既有回報推導出來的，沒有新增任何操作步驟。
 *
 * 【防誤判是這個模組的重點】
 * 一條假的「移動軌跡」會導致把人往威脅的方向趕，比沒有這個功能更糟。
 * 因此判準刻意保守，寧可回「無法判定」也不硬給方向——與疏散建議同一個紀律。
 */

import { distanceM } from './venueService.js';

/** 兩次觀測至少要相隔這麼久，否則只是同一時刻不同人從不同角度回報同一件事 */
const MIN_GAP_SEC = 20;

/** 超過這個間隔的觀測視為過期，不納入軌跡（威脅可能早就離開） */
const MAX_GAP_SEC = 600;

/** 位移小於這個距離時，差異更可能來自定位誤差而非真的移動 */
const MIN_DISPLACEMENT_M = 30;

/**
 * 移動速度的合理範圍。
 *
 * 上限刻意設得寬：**攻擊者會跑，逃跑的人也會跑**（4~6 m/s 是一般人的奔跑速度）。
 * 而且觀測到的「速度」本身有雜訊——目擊者看到之後要拿出手機、開啟頁面、
 * 點選位置，這段延遲會讓推算出的速度偏高或偏低。
 * 初版設 3.5 m/s，實測時把「95 公尺／21 秒」這種完全合理的奔跑誤判成
 * 「兩起獨立事件」。超過 6 m/s（21.6 km/h）才是人類難以持續的速度。
 */
const MIN_SPEED_MPS = 0.3;
const MAX_SPEED_MPS = 6;

/** 多段軌跡的方向若發散超過這個角度，就不宣稱有一致的移動方向 */
const MAX_BEARING_SPREAD_DEG = 75;

/** 出口與威脅前進方向的夾角小於這個值 → 視為「在威脅的前方」，必須避開 */
export const AHEAD_CONE_DEG = 70;

// ---------------------------------------------------------------------------
// 幾何
// ---------------------------------------------------------------------------

/** 從 a 到 b 的方位角（度，正北為 0，順時針） */
export function bearingDeg(a, b) {
  const toRad = Math.PI / 180;
  const dLon = (b.lon - a.lon) * toRad;
  const y = Math.sin(dLon) * Math.cos(b.lat * toRad);
  const x =
    Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
    Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** 兩個方位角的最小夾角（0~180） */
export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/** 八方位的中文說法——比「方位角 217 度」對人有用得多 */
const COMPASS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
export function compassOf(deg) {
  return COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

// ---------------------------------------------------------------------------
// 軌跡判定
// ---------------------------------------------------------------------------

/**
 * 由觀測序列判斷威脅是否在移動。
 *
 * @param {Array<{lat, lon, at, sessionId, exitCode}>} track 依時間排序的錨點觀測
 * @param {number} now
 * @returns {{
 *   moving: boolean,
 *   reason: string,
 *   from?: object, to?: object,
 *   bearing?: number, compass?: string,
 *   speedMps?: number, confidence?: 'high'|'low',
 *   observations?: number,
 * }}
 */
export function assessMotion(track = [], now = Date.now()) {
  // 只留下有座標、且還沒過期的觀測
  const pts = track
    .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
    .filter((p) => now - p.at <= MAX_GAP_SEC * 1000)
    .sort((a, b) => a.at - b.at);

  if (pts.length < 2) {
    return { moving: false, reason: 'insufficient_observations', observations: pts.length };
  }

  // ---- 關鍵防誤判：必須是不同 session ----
  // 同一個人邊走邊回報，會製造出一條看起來很像威脅在移動的假軌跡。
  // 移動的判定必須來自互相獨立的目擊者。
  const sessions = new Set(pts.map((p) => p.sessionId).filter(Boolean));
  if (sessions.size < 2) {
    return { moving: false, reason: 'single_reporter', observations: pts.length };
  }

  // ---- 逐段檢查，收集合格的移動段 ----
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a.sessionId && b.sessionId && a.sessionId === b.sessionId) continue; // 同一人的兩點不算
    const gapSec = (b.at - a.at) / 1000;
    if (gapSec < MIN_GAP_SEC) continue;   // 太近：更像同時回報而非移動
    const dist = distanceM(a, b);
    if (dist < MIN_DISPLACEMENT_M) continue; // 位移太小：更可能是定位誤差
    const speed = dist / gapSec;
    if (speed < MIN_SPEED_MPS || speed > MAX_SPEED_MPS) continue; // 不像人在走
    legs.push({ a, b, dist, gapSec, speed, bearing: bearingDeg(a, b) });
  }

  if (legs.length === 0) {
    return { moving: false, reason: 'no_valid_leg', observations: pts.length };
  }

  // ---- 方向一致性：多段軌跡若方向發散，就不宣稱有明確去向 ----
  const last = legs[legs.length - 1];
  if (legs.length >= 2) {
    const spread = Math.max(...legs.map((l) => angleDiff(l.bearing, last.bearing)));
    if (spread > MAX_BEARING_SPREAD_DEG) {
      return {
        moving: true,
        reason: 'erratic',
        confidence: 'low',
        observations: pts.length,
        from: legs[0].a,
        to: last.b,
      };
    }
  }

  return {
    moving: true,
    reason: 'consistent',
    // 兩點只夠說「移動過」；三點以上方向一致才算高信心
    confidence: legs.length >= 2 ? 'high' : 'low',
    observations: pts.length,
    from: legs[0].a,
    to: last.b,
    bearing: Math.round(last.bearing),
    compass: compassOf(last.bearing),
    speedMps: Number(last.speed.toFixed(2)),
  };
}

/**
 * 這個出口是不是在威脅的前進方向上？
 * 是的話絕對不能建議往那裡疏散——那等於把人往威脅趕。
 *
 * @param {object} motion assessMotion() 的結果
 * @param {{lat, lon}} exit
 */
export function isAheadOfThreat(motion, exit) {
  if (!motion?.moving || motion.bearing === undefined || !motion.to) return false;
  return angleDiff(bearingDeg(motion.to, exit), motion.bearing) <= AHEAD_CONE_DEG;
}

/**
 * 給使用者看的一句話描述。
 * 方向發散時明說「位置不明確」，而不是硬掰一個方向出來。
 */
export function motionLine(motion) {
  if (!motion?.moving) return null;
  if (motion.reason === 'erratic') {
    return '⚠️ 有多處回報且位置不一致，可能不只一處或正在移動——請以現場狀況為準。';
  }
  const fromCode = motion.from?.exitCode;
  const toCode = motion.to?.exitCode;
  const path = fromCode && toCode && fromCode !== toCode ? `${fromCode} → ${toCode} 出口` : null;
  const dir = motion.compass ? `往${motion.compass}方` : '';
  const hedge = motion.confidence === 'low' ? '（僅兩筆觀測，方向待確認）' : '';
  return `⚠️ 威脅正在移動：${path ? `${path}，` : ''}${dir}移動中${hedge}。`;
}
