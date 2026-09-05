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
 *
 * 【L1.5：下樓前的最後定位】
 * 舊版在「拿不到 GPS」時只剩一個搜尋框和一片空白——而那正是**這個專案的
 * 核心情境**（地下沒有 GPS）。等於最可能發生的狀況，剛好是唯一需要打字的狀況，
 * 直接違反「零打字：打字永不是必要條件」這條硬性約束。
 *
 * 但 GPS 不是憑空消失的：你三分鐘前在地面出入口還收得到。那一筆定位是地下
 * 能拿到的最好先驗——走下樓梯不會讓你跑到別的城市。所以成功的粗略定位會被
 * 留存，訊號消失時拿它去收斂場域清單，並在畫面上誠實標示「依你下樓前的位置」。
 *
 * 【隱私取捨】
 * 這是專案裡**唯一**寫進 localStorage 的位置資料，所以刻意設了三道限制：
 *   - 座標無條件捨去到小數第 3 位（約 110 公尺網格）——足以判斷哪一站，
 *     不足以還原你站在哪個路口
 *   - 30 分鐘後失效，讀取時檢查、寫入時順手清掉過期的
 *   - 只存座標與時間，不存任何識別碼
 * 文件裡的「無持久個資」因此更新為「僅一筆粗略定位，30 分鐘自動失效」。
 */

const LAST_STATION_KEY = 'np_last_station'; // sessionStorage：關頁即滅（語意 = 上次確認的場域）
const LAST_FIX_KEY = 'np_last_fix';         // localStorage：下樓前的最後定位（見檔頭隱私說明）
const RECENT_KEY = 'np_recent_venues';      // localStorage：最近去過的場域（只有 id 與名稱）

/** 最後定位的有效期。走下月台再回報遠短於此；過久則位置已不可信 */
const FIX_TTL_MS = 30 * 60_000;
/** 最近場域保留幾個。通勤族的常用站就是兩三個，列太多反而要挑 */
const RECENT_MAX = 4;

/** 座標粗化到約 110 公尺網格——夠判斷哪一站，不足以還原站在哪個路口 */
const coarsen = (n) => Math.round(n * 1000) / 1000;

const readJson = (store, key) => {
  try { return JSON.parse(store.getItem(key) ?? 'null'); } catch { return null; }
};

/** 超過這個誤差半徑就連「哪一站」都判不準，不再拿來收斂清單 */
const MAX_USEFUL_ACCURACY_M = 2000;

/**
 * 目前的定位授權狀態。
 *
 * 為什麼需要這個：一開 App 就跳定位授權是很糟的設計——使用者還沒搞懂這是什麼
 * 就被要求授權，很多人會直接拒絕，而**拒絕之後整個 session 的定位就死了**。
 * 有了這個查詢，我們可以「已經授權過的人靜默取用、沒授權過的人等到理由自明時
 * 再問」（也就是他打開場域選擇器、螢幕上正寫著「附近的場域」的那一刻）。
 *
 * Permissions API 在部分瀏覽器不支援 → 回 'unknown'，呼叫端當作要延後詢問。
 * @returns {Promise<'granted'|'prompt'|'denied'|'unknown'>}
 */
export async function geolocationPermission() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state; // granted | prompt | denied
  } catch {
    return 'unknown';
  }
}

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
    const fix = { lat: latitude, lon: longitude, accuracy };
    rememberFix(fix); // 存起來——下樓後這會是唯一的位置線索
    return fix;
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
      const { stationId, stationName, at } = JSON.parse(last);
      if (Date.now() - at < 30 * 60_000) {
        return {
          claim: { source: 'session', stationId, confidence: 0.6, timestamp: at },
          // 名稱一起存，頂欄才不會先閃一下站碼（BL13）再變成「善導寺」
          stationName: stationName ?? null,
        };
      }
    } catch {
      // 損壞的記憶不該擋住回報
    }
  }
  return { claim: null, stationName: null };
}

/** 使用者完成手選（或確認 session 記憶）後呼叫：寫入 L2 記憶 */
export function rememberStation(stationId, stationName = null) {
  sessionStorage.setItem(
    LAST_STATION_KEY,
    JSON.stringify({ stationId, stationName, at: Date.now() })
  );
  rememberRecent(stationId, stationName);
}

/** 產生一筆「手選」位置聲明（最終仲裁，信心最高） */
export function manualClaim(stationId) {
  return { source: 'manual', stationId, confidence: 1.0, timestamp: Date.now() };
}

// ---------------------------------------------------------------------------
// L1.5 下樓前的最後定位
// ---------------------------------------------------------------------------

/** 記住一次成功的粗略定位（座標已粗化，見檔頭隱私說明） */
function rememberFix({ lat, lon, accuracy }) {
  try {
    localStorage.setItem(LAST_FIX_KEY, JSON.stringify({
      lat: coarsen(lat), lon: coarsen(lon), accuracy: Math.round(accuracy), at: Date.now(),
    }));
  } catch { /* 無痕模式等情境會丟例外——不該擋住任何事 */ }
}

/**
 * 取出仍在有效期內的最後定位。
 * @returns {{lat, lon, accuracy, at, ageMin}|null}
 */
export function lastKnownFix() {
  const f = readJson(localStorage, LAST_FIX_KEY);
  if (!f || !Number.isFinite(f.lat) || !Number.isFinite(f.lon)) return null;
  const age = Date.now() - (f.at ?? 0);
  if (age > FIX_TTL_MS) {
    // 過期就順手清掉，不要讓它一直躺在裝置上
    try { localStorage.removeItem(LAST_FIX_KEY); } catch { /* 忽略 */ }
    return null;
  }
  return { ...f, ageMin: Math.max(1, Math.round(age / 60_000)) };
}

// ---------------------------------------------------------------------------
// L2.5 最近去過的場域
// ---------------------------------------------------------------------------

/**
 * 最近選過的場域（最新在前）。
 *
 * 通勤族每天進出的就是那兩三站，所以在完全沒有位置訊號時，這份清單的
 * 命中率遠高於任何猜測——而且是純點選。只存場域 id 與名稱，那是公開圖資。
 */
export function recentVenues() {
  const list = readJson(localStorage, RECENT_KEY);
  return Array.isArray(list) ? list.filter((v) => v?.id && v?.name) : [];
}

function rememberRecent(stationId, stationName) {
  if (!stationId || !stationName) return; // 沒名稱的先不記，避免清單出現裸站碼
  try {
    const next = [
      { id: stationId, name: stationName },
      ...recentVenues().filter((v) => v.id !== stationId),
    ].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch { /* 忽略 */ }
}
