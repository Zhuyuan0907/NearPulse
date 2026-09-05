/**
 * ============================================================================
 * sensors.js —— 手機感測器的漸進增強（Progressive Enhancement）
 * ============================================================================
 * 【設計原則】
 * 感測器是**附加證據**，不是必要條件：
 *   - 有 → 拿來強化「使用者在地下」與「正在下樓」的判斷
 *   - 沒有 → 一切照舊（main code 原有的 GPS → session → 手選降級鏈）
 * 每個感測器都要先偵測存在與授權，不存在就靜默退場，絕不報錯打斷流程。
 *
 * 【網頁平台實際拿得到什麼——誠實清單】
 * 氣壓計（barometer）：
 *   沒有標準 Web API。Generic Sensor API 的 Barometer 曾是 W3C 草案
 *   但從未在主流瀏覽器落地（Chrome 只實作過 AmbientPressureSensor 的
 *   flag 實驗，2021 年前後已移除）。所以**網頁端不假裝拿得到氣壓計**——
 *   這正是本專案 android/ 原生模組（AltitudeEstimator.kt）存在的理由。
 *   此模組保留 attachNativeBridge() 接點：當未來包進 WebView 時，
 *   原生層量到的樓層可以直接餵進來，前端邏輯不必改。
 *
 * 加速度計 / 陀螺儀（DeviceMotionEvent）：
 *   多數手機都有，iOS 需要 permission 請求，Android Chrome 需要
 *   https 或 localhost。拿它偵測**垂直位移模式**（走樓梯/電扶梯的
 *   週期性上下震動 + 重力向量變化），作為「正在下樓」的旁證。
 *
 * 磁力計（DeviceOrientationEvent absolute）：
 *   地下空間（鋼筋、列車、變電設備）會造成磁場異常——磁偏角劇烈
 *   抖動是「進入地下/金屬結構」的旁證之一。精度不足以定位，
 *   但可以當 corroboration。
 *
 * 光線感測器：
 *   網頁沒有直接 API。**不作感測器使用**——亮度只能從
 *   Ambient Light Sensor API（已從標準移除）取得，硬做只是假象。
 *   改用螢幕亮度建議的間接提示，不納入判斷。
 *
 * 【這些感測器怎麼用——不增加任何新門檻】
 * 1. 樓層旁證：native bridge 或降級鏈的定位訊號一起送進 server，
 *    讓「使用者在 B2」的判斷多一個維度（救援要往下幾層找）
 * 2. 下樓偵測：accel 偵測到下樓模式 + GPS 失效 → 強化「已進入地下」
 *    → 自動把「下樓前的最後定位」標記為基準（比時間戳更精準）
 * 3. 全部訊號附在回報上（server 可用可不用，前端不依賴回應）
 */

// ---------------------------------------------------------------------------
// 感測器存在性偵測
// ---------------------------------------------------------------------------

/** 各感測器的可用性快取（一次偵測，全程使用） */
let capabilityCache = null;

/**
 * 偵測這支手機的瀏覽器有哪些我們用得到的感測器。
 * 全部靜默嘗試——任何一個失敗都只是「沒有」，不是錯誤。
 *
 * @returns {{
 *   motion: boolean,        // 加速度/陀螺儀（DeviceMotionEvent）
 *   motionNeedsPermission: boolean,  // iOS 13+ 要先 requestPermission
 *   orientation: boolean,   // 磁力計方向的絕對座標事件
 *   nativeFloor: boolean,   // 原生橋接是否已掛上（WebView 情境）
 *   geolocation: boolean,
 * }}
 */
export function detectSensors() {
  if (capabilityCache) return capabilityCache;

  const motion = typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
  const orientation = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
  // iOS 13+ 的 DeviceMotionEvent.requestPermission 是函式；Android 不需要
  const motionNeedsPermission = motion && typeof window.DeviceMotionEvent?.requestPermission === 'function';

  capabilityCache = {
    motion,
    motionNeedsPermission,
    orientation,
    nativeFloor: Boolean(window.__npNativeFloor),
    geolocation: typeof navigator !== 'undefined' && Boolean(navigator.geolocation),
  };
  return capabilityCache;
}

/**
 * 請求 motion 權限（iOS）。必須由使用者手勢觸發（按鈕 onClick）。
 * Android 不需要呼叫這個——直接回 true。
 * @returns {Promise<boolean>} 授權成功與否
 */
export async function requestMotionPermission() {
  if (!detectSensors().motion) return false;
  if (!detectSensors().motionNeedsPermission) return true; // Android/桌面：不需要
  try {
    const state = await window.DeviceMotionEvent.requestPermission();
    return state === 'granted';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 原生橋接（WebView 情境）：android/ 的 AltitudeEstimator 透過這裡餡進來
// ---------------------------------------------------------------------------

/**
 * 原生層呼叫：更新目前的樓層估計。
 * android/ SensorHub 透過 addJavascriptInterface 或 postMessage 打進來。
 *
 * @param {Object} estimate
 * @param {number|null} estimate.level   0=地面, -1=B1, -2=B2…；null=未知
 * @param {number|null} estimate.depthM  相對地面深度（公尺）
 * @param {string} estimate.confidence   'high'|'low'|'moving'|'stale'
 */
export function attachNativeFloorProvider() {
  // 掛上接點讓 detectSensors() 下次偵測到 nativeFloor
  // （由原生層注入 window.__npNativeFloor = { level, depthM, confidence }）
  return Boolean(window.__npNativeFloor);
}

/** 目前原生樓層估計（沒有橋接就回 null——呼叫端不必判斷來源） */
export function nativeFloorEstimate() {
  const f = window.__npNativeFloor;
  if (!f || typeof f.level !== 'number') return null;
  return f;
}

// ---------------------------------------------------------------------------
// 垂直移動偵測（加速度計）：走樓梯/電扶梯的下行模式
// ---------------------------------------------------------------------------

/**
 * 監聽垂直移動。走樓梯的特徵是「重力向量 g 的 Z 分量週期性波動 +
 *  總加速度的步頻振盪」；電扶梯則是平穩但持續的位移。
 * 這裡做的是**粗模式判斷**——不估算走了幾階，只回答三件事：
 *   descending：正在往下（含走樓梯與電扶梯下行）
 *   ascending：正在往上
 *   累計淨垂直變化量（用於輔助判斷「進入地下多深」的旁證）
 *
 * @param {(state: {kind: 'descend'|'ascend'|'still', netDz: number}) => void} onUpdate
 * @returns {{stop: () => void} | null} 不支援時回 null
 */
export function watchVerticalMotion(onUpdate) {
  if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return null;
  if (detectSensors().motionNeedsPermission) {
    // iOS 還沒授權——這裡不能擅自跳權限框（必須手勢觸發），
    // 由 UI 在合適時機呼叫 requestMotionPermission() 之後再啟用
    return null;
  }

  const WIN_MS = 4000;        // 滑動視窗：走一層樓約 15~30 秒，取短窗抓模式
  const STEP_HZ_MIN = 1.2;    // 走樓梯的步頻下限（每秒至少跨一步才算「在走」）
  const samples = [];          // {t, az} 重力向量 z 分量（不含線性加速度的穩定部分）

  function handle(ev) {
    const g = ev.accelerationIncludingGravity;
    if (!g || g.z == null) return;
    const now = performance.now();
    samples.push({ t: now, az: g.z });
    while (samples.length > 0 && now - samples[0].t > WIN_MS) samples.shift();

    if (samples.length < 10) return; // 至少 ~10 取樣才判模式（60Hz 裝置約 0.17s）

    // 1) 步頻：z 分量跨越重力的次數（每跨一次＝一步）
    const crossings = [];
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i - 1].az - 9.8) * (samples[i].az - 9.8) < 0) {
        crossings.push(samples[i].t);
      }
    }
    const spanS = (samples[samples.length - 1].t - samples[0].t) / 1000;
    const stepHz = crossings.length / Math.max(spanS, 0.1);

    // 2) 淨垂直趨勢：z 分量的線性回歸斜率（趨勢，不是單點雜訊）
    //    手機持平時 z≈+9.8；下樓的每一步會讓它瞬間 >9.8（減速向下衝擊）
    //    之後 <9.8（落下）。斜率的**符號**在樓梯方向上不可靠（持機姿態影響太大），
    //    但**波動幅度搭配事件順序**（先大於後小於 = 向下踏步）可以用。
    let up = 0, down = 0;
    for (let i = 1; i < crossings.length; i++) {
      // 在每個「步」裡看主體位移方向：穿越後的均值低於穿越前 → 向下
      const before = samples.filter((s) => s.t <= crossings[i - 1] && s.t >= crossings[i - 1] - 600);
      const after = samples.filter((s) => s.t >= crossings[i] && s.t <= crossings[i] + 600);
      if (!before.length || !after.length) continue;
      const bMean = before.reduce((a, s) => a + s.az, 0) / before.length;
      const aMean = after.reduce((a, s) => a + s.az, 0) / after.length;
      if (aMean > bMean) up += 1; else down += 1;
    }

    const stepping = stepHz >= STEP_HZ_MIN;
    if (stepping && down > up * 1.5) {
      onUpdate({ kind: 'descend', netDz: down - up });
    } else if (stepping && up > down * 1.5) {
      onUpdate({ kind: 'ascend', netDz: up - down });
    } else {
      onUpdate({ kind: 'still', netDz: 0 });
    }
  }

  try {
    window.addEventListener('devicemotion', handle);
  } catch {
    return null;
  }
  return {
    stop() {
      window.removeEventListener('devicemotion', handle);
    },
  };
}

// ---------------------------------------------------------------------------
// 磁力計異常偵測：進入鋼筋/地下結構的旁證
// ---------------------------------------------------------------------------

/**
 * 監聽磁偏角抖動。地面上磁偏角穩定；進入地下後鋼筋、列車、
 * 變電設備會讓它劇烈抖動。**只是旁證**——精度不足以定位，
 * 搭配 GPS 失效一起看才有意義（GPS 好好的時候磁場抖動只是經過鐵門）。
 *
 * @param {(anomalous: boolean) => void} onUpdate
 * @returns {{stop: () => void} | null}
 */
export function watchMagneticAnomaly(onUpdate) {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return null;

  const WIN_MS = 10_000;
  const samples = []; // {t, heading}

  function handle(ev) {
    if (ev.heading == null || Number.isNaN(ev.heading)) return;
    const now = performance.now();
    samples.push({ t: now, heading: ev.heading });
    while (samples.length > 0 && now - samples[0].t > WIN_MS) samples.shift();

    if (samples.length < 20) return;
    // 環繞 0/360 的 circular variance（不能直接算標準差）
    const sinSum = samples.reduce((a, s) => a + Math.sin((s.heading * Math.PI) / 180), 0);
    const cosSum = samples.reduce((a, s) => a + Math.cos((s.heading * Math.PI) / 180), 0);
    const r = Math.hypot(sinSum, cosSum) / samples.length; // 1=極穩定, 0=全亂
    onUpdate(r < 0.7); // 平均向長度低於 0.7 → 磁場不穩定
  }

  try {
    window.addEventListener('deviceorientationabsolute', handle, true);
    window.addEventListener('deviceorientation', handle);
  } catch {
    return null;
  }
  return {
    stop() {
      window.removeEventListener('deviceorientationabsolute', handle, true);
      window.removeEventListener('deviceorientation', handle);
    },
  };
}

// ---------------------------------------------------------------------------
// 整合：地下偵測融合器
// ---------------------------------------------------------------------------

/**
 * 融合所有可用訊號，回答「這個人現在在不在地下」的**旁證強度**。
 *
 * 輸入（全部可選——有多少用多少）：
 *   gpsOk：GPS 目前拿得到嗎（地下幾乎必失效）
 *   vertical：watchVerticalMotion 的最新狀態（descend 強證據）
 *   magnetic：watchMagneticAnomaly 的最新狀態
 *
 * 輸出 evidence：
 *   score  -1（一定在地面）～ +3（強烈支持在地下）
 *   reasons  人類可讀的理由（給除錯與 server 端日誌用）
 *
 * 【不覆蓋主判斷】——main code 的降級鏈（GPS→session→手選）不變，
 * 這個分數只是附加在回報上的一個欄位。就算全部感測器都沒有，
 * score 恆為 0，回報流程與原本一模一樣。
 */
export function fuseUndergroundEvidence({ gpsOk = null, vertical = null, magnetic = null } = {}) {
  let score = 0;
  const reasons = [];

  if (gpsOk === false) { score += 1; reasons.push('GPS 失效（地下的常態）'); }
  if (gpsOk === true) { score -= 2; reasons.push('GPS 正常——應在地面'); }
  if (vertical?.kind === 'descend') { score += 2; reasons.push('偵測到下樓模式'); }
  if (vertical?.kind === 'ascend') { score -= 1; reasons.push('偵測到上樓模式'); }
  if (magnetic === true) { score += 1; reasons.push('磁場不穩定（鋼筋/地下結構旁證）'); }

  return { score, reasons };
}

/**
 * 把感測器證據整理成可附加在回報上的 compact 物件。
 * 沒有任何感測器時回 null——server 端不需要多處理一個空物件。
 */
export function sensorEvidenceForReport({ gpsOk = null, vertical = null, magnetic = null, floor = null } = {}) {
  const fused = fuseUndergroundEvidence({ gpsOk, vertical, magnetic });
  const nativeFloor = floor ?? nativeFloorEstimate();

  if (fused.score === 0 && !nativeFloor) return null;

  return {
    undergroundScore: fused.score,
    reasons: fused.reasons,
    verticalKind: vertical?.kind ?? null,
    magneticAnomaly: magnetic ?? null,
    // 原生橋接的樓層（僅 WebView 情境有值；web 端恆 null）
    floorLevel: nativeFloor?.level ?? null,
    floorDepthM: nativeFloor?.depthM ?? null,
    floorConfidence: nativeFloor?.confidence ?? null,
  };
}
