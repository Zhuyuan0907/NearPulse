/**
 * ============================================================================
 * location.js —— 位置狀態機（L1 粗略 GPS → L2 session 記憶 → L3 手選）
 * ============================================================================
 * 「GPS 是加速器、session 記憶是便利性、手選場域是最終仲裁」。
 * 每筆回報都附帶結構化位置聲明：
 *   { source: 'gps'|'manual'|'session', stationId, confidence, timestamp }
 *
 * v0.3 的關鍵轉變——**粗略 GPS 不再被丟棄**：
 * 舊版把 accuracy ≥300m 的定位整個視為不可信而捨棄。但那個門檻答錯了問題：
 * ±300~500m 對「我在哪個月台」確實沒用，對「我在哪一站」卻綽綽有餘
 * （站距普遍大於 300m）。有了 server 端的 OSM 圖資，這個粗糙訊號足以把
 * 全台 500+ 個場域收斂成 3~8 個點選目標——**零打字的主路徑**。
 *
 * 網頁平台限制（設計時已內化）：
 *   - 只用 getCurrentPosition 一次（watchPosition 耗電且地下無意義）
 *   - 不做背景定位、不用 Cell-ID（瀏覽器拿不到）
 *   - 地下拿不到 GPS 是常態而非錯誤，靜默降級到手選
 */

const LAST_STATION_KEY = 'np_last_station'; // sessionStorage：關頁即滅（語意 = 上次確認的場域）

/** 超過這個誤差半徑就連「哪一站」都判不準，不再拿來收斂清單 */
const MAX_USEFUL_ACCURACY_M = 2000;

/**
 * 取一次粗略座標。純粹用來收斂場域清單，不作為位置聲明。
 * @returns {Promise<{lat, lon, accuracy}|null>}
 */
export async function coarseFix() {
  if (!navigator.geolocation) return null;
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        timeout: 5000,
        maximumAge: 120_000, // 地下多半只拿得到快取，這裡刻意接受
        enableHighAccuracy: false, // 只要知道哪一站，不必耗電求精準
      });
    });
    const { latitude, longitude, accuracy } = pos.coords;
    if (accuracy > MAX_USEFUL_ACCURACY_M) return null;
    return { lat: latitude, lon: longitude, accuracy };
  } catch {
    return null; // 拒絕授權 / 逾時 / 地下無訊號——皆為常態
  }
}

/**
 * 嘗試解析當前位置聲明。
 * @returns {Promise<{claim: Object|null}>}
 *   - 有 session 記憶（30 分鐘內）→ session 聲明
 *   - 否則 null，由 UI 帶使用者進入場域選擇（清單由 coarseFix 收斂）
 */
export async function resolveLocation() {
  const last = sessionStorage.getItem(LAST_STATION_KEY);
  if (last) {
    try {
      const { stationId, at } = JSON.parse(last);
      if (Date.now() - at < 30 * 60_000) {
        return { claim: { source: 'session', stationId, confidence: 0.6, timestamp: at } };
      }
    } catch {
      // 損壞的記憶不該擋住回報
    }
  }
  return { claim: null };
}

/** 使用者完成手選（或確認 session 記憶）後呼叫：寫入 L2 記憶 */
export function rememberStation(stationId) {
  sessionStorage.setItem(LAST_STATION_KEY, JSON.stringify({ stationId, at: Date.now() }));
}

/** 產生一筆「手選」位置聲明（最終仲裁，信心最高） */
export function manualClaim(stationId) {
  return { source: 'manual', stationId, confidence: 1.0, timestamp: Date.now() };
}
