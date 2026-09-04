/**
 * ============================================================================
 * location.js —— 位置狀態機（L1 GPS → L2 session 記憶 → L3 手選）
 * ============================================================================
 * 「GPS 是加速器、session 記憶是便利性、手選路網圖是最終仲裁」。
 * 每筆回報都附帶結構化位置聲明：
 *   { source: 'gps'|'manual'|'session', stationId, confidence, timestamp }
 *
 * 注意網頁平台限制（設計時已內化）：
 *   - 只用 getCurrentPosition 一次（watchPosition 耗電且地下無意義）
 *   - accuracy 半徑 >= 300m 視為不可信（地下常回傳過期快取）
 *   - 不做背景定位、不用 Cell-ID（瀏覽器拿不到）
 */

const LAST_STATION_KEY = 'np_last_station'; // sessionStorage：關頁即滅

/**
 * 嘗試解析當前位置。
 * @returns {Promise<{claim: Object|null, gpsAccuracy?: number}>}
 *   - 有可信 GPS → gps 聲明（但地下無法得知「在哪个站」，
 *     MVP 簡化：GPS 只用來輔助，最終 station 仍需手選或 session 記憶）
 *   - 有 session 記憶 → session 聲明（上次確認的站）
 *   - 都沒有 → null，UI 進入手選流程
 *
 * 說明：MVP 不做「GPS 座標 → 反查最近站點」（需站點座標圖資），
 *       該功能列入 doc/STATUS.md 的 Phase 2。GPS 結果此版本僅記錄信心資訊。
 */
export async function resolveLocation() {
  // ---- L2：session 記憶（上次確認的站） ----
  const last = sessionStorage.getItem(LAST_STATION_KEY);
  if (last) {
    const { stationId, at } = JSON.parse(last);
    const fresh = Date.now() - at < 30 * 60_000; // 30 分鐘內的有效
    if (fresh) {
      return {
        claim: { source: 'session', stationId, confidence: 0.6, timestamp: at },
      };
    }
  }

  // ---- L1：GPS 一次查詢（僅用於信心資訊，不反查站點） ----
  let gpsAccuracy;
  try {
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation?.getCurrentPosition(resolve, reject, {
        timeout: 5000,
        maximumAge: 60_000,
      });
    });
    gpsAccuracy = pos.coords.accuracy;
  } catch {
    // 地下拿不到 GPS 是常態，不是錯誤——靜默降級到手選
  }

  return { claim: null, gpsAccuracy };
}

/** 使用者完成手選（或確認 session 記憶）後呼叫：寫入 L2 記憶 */
export function rememberStation(stationId) {
  sessionStorage.setItem(
    LAST_STATION_KEY,
    JSON.stringify({ stationId, at: Date.now() })
  );
}

/** 產生一筆「手選」位置聲明（最終仲裁，信心最高） */
export function manualClaim(stationId) {
  return { source: 'manual', stationId, confidence: 1.0, timestamp: Date.now() };
}
