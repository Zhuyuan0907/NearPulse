/**
 * ============================================================================
 * placeLookup —— 用 OSM 找「不在我們圖資裡」的地點
 * ============================================================================
 * 【要解決的問題】
 * 我們的場域快照是**篩選過**的：只留下有地下特徵的地方（捷運出入口、地下街、
 * 地下停車場、有 `building:levels:underground` 的零售）。一間百貨如果 OSM 上
 * 沒有標地下樓層，就整個消失——即使 OSM 明明知道它存在。
 * 實測覆蓋：836 個場域裡百貨只有 58 個，而且多數在關西。
 *
 * 錯誤的解法是我們自己一間一間補進清單。那不可持續，而且會變成一份
 * 越來越舊的手工資料。**正確的解法是去問 OSM**——它本來就有這些地點。
 *
 * 所以這裡代理 Nominatim（OSM 官方地理編碼）。回來的地點**沒有出口資料**，
 * 只有名稱與座標——那正好夠用來說「事件在這裡」，而疏散建議會誠實地說
 * 給不出出口層級的指引。
 *
 * 【這是 server 唯一會在執行時連外的地方】
 * 而且**只在搜尋路徑上**。回報路徑（POST /api/reports）不碰它，
 * 所以 Nominatim 掛掉、限流、或使用者沒網路，通報都照樣成立——
 * 使用者仍然可以自己打地點名稱或拍照。這條界線不能移動。
 *
 * 【Nominatim 使用規範】
 * 官方政策要求：每秒至多 1 次請求、必須提供可識別的 User-Agent、
 * 不得大量批次查詢。這裡以最小間隔 + 結果快取遵守；正式上線應自架實例。
 * 資料為 © OpenStreetMap contributors（ODbL）。
 */

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'NearPulse/0.8 (underground incident reporting; contact via repo)';

/** Nominatim 政策：每秒至多 1 次。留一點餘裕 */
const MIN_INTERVAL_MS = 1200;
const TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;

/**
 * 類別偏好。**這是必要的**：查「台中大遠百」時 Nominatim 回的第一筆是
 * 同名的**公車站**，不是那間百貨。對一個要回報事件的人來說，
 * 把他放到馬路邊的站牌上是錯的。
 *
 * 數字越小越優先。沒列到的類別排在最後但不排除——
 * 我們的偏好不該讓使用者完全找不到他要的地方。
 */
const CATEGORY_RANK = {
  shop: 0,
  building: 1,
  amenity: 2,
  tourism: 3,
  leisure: 4,
  office: 5,
  railway: 6,
  public_transport: 7,
  place: 8,
  highway: 20, // 公車站、路口——幾乎不會是使用者想指的「地點」
};

/** 這些類型本身就是「可以待在裡面的地方」，額外加分 */
const INDOORISH = new Set([
  'mall', 'department_store', 'supermarket', 'marketplace', 'retail',
  'commercial', 'station', 'yes', 'convenience', 'hotel', 'hospital',
]);

let lastCallAt = 0;
const cache = new Map(); // q → { at, results }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fromCache(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.results;
}

function toCache(key, results) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), results });
}

function score(item, q) {
  const name = String(item.name ?? '');
  const rank = CATEGORY_RANK[item.category] ?? 10;
  // 名稱完全相符 > 包含查詢字串 > 其餘
  const nameBonus = name === q ? -3 : name.includes(q) || q.includes(name) ? -1 : 0;
  const indoorBonus = INDOORISH.has(item.type) ? -2 : 0;
  return rank + nameBonus + indoorBonus;
}

/**
 * 查詢地點。
 *
 * @param {string} q
 * @param {{ countryCodes?: string, limit?: number }} [opts]
 * @returns {Promise<Array<{name, kind, lat, lon, address, source}>>}
 *          任何失敗（逾時、限流、無網路）一律回空陣列——
 *          呼叫端只會少一條後備路徑，不會壞掉。
 */
export async function lookupPlaces(q, { countryCodes = 'tw', limit = 6 } = {}) {
  const query = String(q ?? '').trim();
  if (query.length < 2) return [];

  const key = `${countryCodes}:${query}`;
  const cached = fromCache(key);
  if (cached) return cached;

  // 遵守每秒 1 次的政策：必要時就等
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();

  const url = `${ENDPOINT}?${new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: String(limit * 2), // 多取一些再自行排序過濾
    countrycodes: countryCodes,
    'accept-language': 'zh-TW',
    addressdetails: '1',
  })}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const raw = await res.json();
    const results = (Array.isArray(raw) ? raw : [])
      .filter((x) => x.name && Number.isFinite(Number(x.lat)) && Number.isFinite(Number(x.lon)))
      .sort((a, b) => score(a, query) - score(b, query))
      .slice(0, limit)
      .map((x) => ({
        name: x.name,
        /** 給 UI 顯示用的粗略分類，不參與任何計算 */
        kind: x.type === 'department_store' || x.type === 'mall' ? 'retail' : null,
        lat: Number(x.lat),
        lon: Number(x.lon),
        /** 行政區描述，用來區分同名地點（京站時尚廣場在台北與新店各有一個） */
        address: shortAddress(x),
        source: 'osm',
      }));

    toCache(key, results);
    return results;
  } catch {
    return []; // 逾時／限流／無網路——少一條後備路徑而已，回報路徑不受影響
  }
}

/** 由 addressdetails 組出「新北市 新店區」這種可辨識的短描述 */
function shortAddress(x) {
  const a = x.address ?? {};
  const city = a.city ?? a.county ?? a.state ?? '';
  const area = a.suburb ?? a.city_district ?? a.town ?? a.village ?? '';
  const road = a.road ?? '';
  return [city, area, road].filter(Boolean).join(' ') || x.display_name?.split(',').slice(-3, -1).join(' ') || '';
}

export const placeLookupMeta = {
  source: 'OpenStreetMap Nominatim',
  attribution: '© OpenStreetMap contributors (ODbL)',
};
