/**
 * ============================================================================
 * venueService —— 場域查表、鄰近搜尋、視覺錨點解析（server 唯一的圖資來源）
 * ============================================================================
 * 場域資料在 v0.3 從 client 搬到 server，原因有三：
 *   1. client 盡量少事——165KB 的全台圖資不該塞進手機 bundle
 *   2. 修掉既有缺陷——server 過去不持有場域資料，導致 stationName 退化成
 *      stationId，任何非本 client 的消費端（站務台、報告書）都拿不到可讀名稱
 *   3. 錨點解析是確定性查表，屬於業務邏輯，本來就該在 server
 *
 * 【核心：AI 只讀字，座標由查表得出】
 * Vision 從照片讀到「M3」或「台北車站」這種牌子上的字，本模組把它解析成
 * 場域 + 出口 + 精確經緯度。AI 永遠不猜座標——那是它做不到也不該做的事。
 *
 * 資料來源：server/src/data/venues.json（由 scripts/build-venues.mjs 離線產生）
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeName, parseExitCode } from './anchorParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(__dirname, '../data/venues.json');

// ---------------------------------------------------------------------------
// 載入與索引（啟動時一次，之後全記憶體）
// ---------------------------------------------------------------------------

let snapshot = { venues: [], attribution: '', generatedAt: null };
try {
  snapshot = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
} catch {
  // 快照不存在時降級成空資料集：server 照常啟動，場域選擇退回純手動輸入。
  // （與 advisor 相同的紀律——資料缺席不該讓服務起不來）
  console.warn('[venues] 找不到 venues.json，場域功能停用。執行 node scripts/build-venues.mjs 產生。');
}

const VENUES = snapshot.venues ?? [];

/** id → venue */
const byId = new Map(VENUES.map((v) => [v.id, v]));

/**
 * 別名（含路線代碼、中英文站名）→ venue。OCR 讀到任何一種寫法都查得到。
 *
 * ⚠️ **有歧義的別名一律不註冊**，而不是先到先得。
 * 路線代碼只在同一城市內唯一——`R14` 同時是台北圓山與高雄巨蛋。
 * 先到先得會讓查詢安靜地回傳錯的場域（實際踩過這個 bug：使用者選了圓山，
 * 畫面顯示巨蛋）。查不到會逼使用者手選或提供位置線索，那是安全的失敗方式；
 * 猜錯不是。
 */
const byAlias = new Map();
{
  const seen = new Map(); // key -> venue | AMBIGUOUS
  const AMBIGUOUS = Symbol('ambiguous');
  for (const v of VENUES) {
    for (const a of [v.id, ...(v.aliases ?? [])]) {
      const key = normalizeName(a);
      if (!key) continue;
      const prev = seen.get(key);
      if (prev === undefined) seen.set(key, v);
      else if (prev !== v && prev !== AMBIGUOUS) seen.set(key, AMBIGUOUS);
    }
  }
  let dropped = 0;
  for (const [k, v] of seen) {
    if (v === AMBIGUOUS) { dropped++; continue; }
    byAlias.set(k, v);
  }
  if (dropped > 0) {
    console.log(`[venues] ${dropped} 個別名有歧義（跨城市共用代碼），已排除以免查錯場域`);
  }
}

/** venueId → (出口代碼 → 出口) */
const exitIndex = new Map(
  VENUES.map((v) => [v.id, new Map((v.exits ?? []).map((e) => [e.code, e]))])
);

// ---------------------------------------------------------------------------
// 幾何
// ---------------------------------------------------------------------------

/** 等距圓柱近似——都會尺度下誤差可忽略 */
export function distanceM(a, b) {
  const k = 111_320;
  const dy = (a.lat - b.lat) * k;
  const dx = (a.lon - b.lon) * k * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

// ---------------------------------------------------------------------------
// 基本查詢
// ---------------------------------------------------------------------------

export function findVenue(venueId) {
  if (!venueId) return null;
  return byId.get(venueId) ?? byAlias.get(normalizeName(venueId)) ?? null;
}

/** 顯示名稱。查不到時原樣回傳 id——不讓未知場域變成空字串 */
export function venueDisplayName(venueId) {
  return findVenue(venueId)?.name ?? venueId;
}

export function findExit(venueId, code) {
  const v = findVenue(venueId);
  if (!v || !code) return null;
  return exitIndex.get(v.id)?.get(String(code).toUpperCase()) ?? null;
}

/** 對外的精簡形狀——不含 exits 大陣列，供清單使用 */
function toSummary(venue, extra = {}) {
  return {
    id: venue.id,
    name: venue.name,
    nameEn: venue.nameEn,
    kind: venue.kind,
    exitCount: venue.exits?.length ?? 0,
    exitsAvailable: venue.exitsAvailable,
    ...extra,
  };
}

/**
 * 鄰近場域清單——「零打字」的主路徑。
 *
 * 地下拿不到精確 GPS，但這裡不需要精確：站距普遍大於 300m，
 * 一個 ±300~500m 的粗糙定位足以把全台 519 個場域收斂成 3~5 個點選目標。
 * 舊版 location.js 把 accuracy ≥300m 的定位整個丟棄，等於浪費了這個訊號。
 */
export function nearbyVenues(lat, lon, { radiusM = 1200, limit = 8 } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [];
  const here = { lat, lon };

  // 排序距離加權：沒有出口資料的場域（多為停車場）乘以懲罰係數。
  // 純按距離排的話，台北車站周邊 8 個結果會有 7 個是停車場與空地下街——
  // 恐慌中要從那種清單裡挑，等於沒有清單。腳下的停車場仍排得進來
  // （50m × 2 = 100m 仍勝過 300m 外的車站），但遠處的雜訊會被推掉。
  const NO_EXIT_PENALTY = 2;
  /** 無出口場域的名額上限：台北車站周邊的無出口場域全在 150m 內，
   *  光靠距離加權推不掉，會佔滿整份清單。硬性限額才保得住可用選項。 */
  const MAX_NO_EXIT = 3;

  const ranked = VENUES.map((v) => {
    const d = distanceM(here, v);
    return { v, d, rank: v.exitsAvailable ? d : d * NO_EXIT_PENALTY };
  })
    .filter((x) => x.d <= radiusM)
    .sort((a, b) => a.rank - b.rank);

  const picked = [];
  let noExitCount = 0;
  for (const x of ranked) {
    if (picked.length >= limit) break;
    if (!x.v.exitsAvailable) {
      if (noExitCount >= MAX_NO_EXIT) continue;
      noExitCount++;
    }
    picked.push(x);
  }
  return picked.map((x) => toSummary(x.v, { distanceM: Math.round(x.d) }));
}

/**
 * 文字搜尋——**後備路徑**，不是主路徑。
 * 「零打字」的原則沒有改變：這條路只在沒有定位訊號、且鄰近清單也沒有目標時才用到。
 */
export function searchVenues(q, { limit = 10 } = {}) {
  const key = normalizeName(q);
  if (key.length < 1) return [];

  const scored = [];
  for (const v of VENUES) {
    const names = [v.name, v.nameEn, ...(v.aliases ?? [])].filter(Boolean);
    let best = Infinity;
    for (const n of names) {
      const nn = normalizeName(n);
      if (nn === key) best = Math.min(best, 0);          // 完全相符
      else if (nn.startsWith(key)) best = Math.min(best, 1); // 前綴
      else if (nn.includes(key)) best = Math.min(best, 2);   // 包含
    }
    if (best < Infinity) scored.push({ v, score: best });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score ||
        // 同分時有出口的優先：搜「忠孝」該先看到忠孝復興／敦化／新生，
        // 而不是忠孝公園地下停車場
        Number(b.v.exitsAvailable) - Number(a.v.exitsAvailable) ||
        a.v.name.localeCompare(b.v.name, 'zh-TW')
    )
    .slice(0, limit)
    .map((x) => toSummary(x.v));
}

// ---------------------------------------------------------------------------
// 視覺錨點解析（整條地下定位鏈路的終點）
// ---------------------------------------------------------------------------

/**
 * 把 OCR 讀到的文字解析成「場域 + 出口」候選。
 *
 * 解析優先序（愈上面愈可信）：
 *   1. 讀到站名 → 場域確定 → 出口代碼在該場域內唯一 → 完全命中
 *   2. 只讀到出口代碼 + 使用者已選場域 → 在該場域內查
 *   3. 只讀到出口代碼 + 有粗略定位 → 在鄰近場域裡找相符的代碼（可能多個候選）
 *   4. 什麼都對不上 → 回空陣列，UI 靜默退回手選（絕不擋回報）
 *
 * 為什麼「只有裸編號、又沒有任何場域線索」幾乎無解：
 * 全台有上百個站都有「出口 3」。這種情況必須靠站名或定位收斂，
 * 硬猜一個出來只會給出看似精確的錯誤位置。
 *
 * @param {object} input
 * @param {Array<{label?: string, value: string}>|string[]} input.texts - OCR 結果
 * @param {string|null} input.venueId - 使用者已選的場域（若有）
 * @param {{lat: number, lon: number}|null} input.near - 粗略定位（若有）
 * @returns {{candidates: Array, venue: object|null}}
 */
/**
 * 這串文字是不是在講「目的地」而不是「所在地」。
 *
 * 月台上方最大的那塊牌子寫的是「往頂埔 / To Dingpu」——它是你**要去**的方向，
 * 不是你站的位置。把它當成位置線索會直接送出另一座車站的疏散指示。
 */
function isDestinationText(raw) {
  const t = String(raw).trim();
  return /^(往|前往|開往|开往)\s*\S/.test(t)
    || /^to\s+\S/i.test(t)
    || /^towards?\s+\S/i.test(t)
    || /方向$/.test(t);
}

/** 路線代碼樣式（BL03、R10、BR11）——只印在本站自己的牌子上 */
const STATION_CODE_RE = /^[A-Za-z]{1,3}\d{1,3}$/;

export function resolveAnchors({ texts = [], venueId = null, near = null } = {}) {
  const values = texts
    .map((t) => (typeof t === 'string' ? t : t?.value))
    .filter((s) => typeof s === 'string' && s.trim());

  if (values.length === 0) return { candidates: [], venue: findVenue(venueId) };

  // ---- 場域線索：文字裡有沒有對得上的站名/別名 ----
  //
  // ⚠️ **月台上最顯眼的字，多半不是你所在的站。**
  // 實測（使用者回報的真實 bug）：拍土城月台，讀到
  // ['海山', 'Haishan', '土城', 'Tucheng', '往頂埔']——
  // 舊版「第一個命中就採用並覆蓋使用者選擇」會把場域切成**海山**，
  // 然後給出海山的疏散建議。模型輸出順序一變，答案就變，而使用者
  // 明明已經手選了土城。
  //
  // 三道修正：
  //   1. 方向詞（往X / To X）代表**目的地，不是所在地**，整個排除
  //   2. 不再第一個命中就採用——全部收集起來再消歧
  //   3. 消歧時代碼命中優先：`BL03` 這種路線代碼只印在**本站自己**的牌子上，
  //      鄰站在月台指標帶上只會出現名字。這是區分「我在哪」與「隔壁是哪」
  //      最可靠的訊號。
  let venue = findVenue(venueId);
  const hits = new Map(); // venueId → 最強命中強度（2 = 代碼、1 = 站名）

  for (const raw of values) {
    if (isDestinationText(raw)) continue;
    const hit = byAlias.get(normalizeName(raw));
    if (!hit) continue;
    const strength = STATION_CODE_RE.test(raw.trim()) ? 2 : 1;
    hits.set(hit.id, Math.max(hits.get(hit.id) ?? 0, strength));
  }

  let venueFromText = null;
  let ambiguousVenues = [];

  if (hits.size === 1) {
    venueFromText = byId.get([...hits.keys()][0]);
  } else if (hits.size > 1) {
    const byCode = [...hits.entries()].filter(([, st]) => st === 2).map(([id]) => id);
    if (byCode.length === 1) {
      // 只有一個站以代碼出現 → 那就是本站
      venueFromText = byId.get(byCode[0]);
    } else if (venueId && hits.has(venueId)) {
      // 使用者手選的場域也在照片裡 → 尊重使用者的選擇，不要自作主張換掉
      venueFromText = null;
    } else if (near) {
      // 有粗略定位就取最近的
      const sorted = [...hits.keys()]
        .map((id) => byId.get(id))
        .filter(Boolean)
        .sort((a, b) => distanceM(near, a) - distanceM(near, b));
      venueFromText = sorted[0] ?? null;
    } else {
      // **猜不出來就不要猜**：把所有可能的站交給使用者點選。
      // 猜錯會給出另一座車站的疏散指示，那比多一次點擊糟得多。
      ambiguousVenues = [...hits.keys()].map((id) => byId.get(id)).filter(Boolean);
    }
  }

  // 照片讀到的站名優先於使用者先前的選擇——他可能只是忘了改。
  // 但**只有在照片明確指向單一車站時**才這麼做（見上面的消歧）。
  if (venueFromText) venue = venueFromText;

  // ---- 出口線索：抽出所有像出口代碼的字串 ----
  const codes = [...new Set(values.map(parseExitCode).filter(Boolean))];

  const candidates = [];
  const push = (v, exit, confidence, reason) => {
    if (candidates.some((c) => c.venueId === v.id && c.exitCode === exit?.code)) return;
    candidates.push({
      venueId: v.id,
      venueName: v.name,
      exitCode: exit?.code ?? null,
      exitName: exit?.name ?? null,
      landmark: exit?.landmark ?? null,
      lat: exit?.lat ?? v.lat,
      lon: exit?.lon ?? v.lon,
      confidence,
      reason,
    });
  };

  if (venue) {
    // 場域已知：在該場域內比對出口代碼
    for (const code of codes) {
      const exit = exitIndex.get(venue.id)?.get(code);
      if (exit) push(venue, exit, venueFromText ? 'high' : 'medium', venueFromText ? '站名與出口編號皆相符' : '出口編號相符');
    }
    // 只認出站名、認不出出口 → 仍是有用的場域級結果
    if (candidates.length === 0 && venueFromText) {
      push(venue, null, 'medium', '站名相符（未讀到出口編號）');
    }
  } else if (codes.length > 0 && near) {
    // 場域未知但有粗略定位：在鄰近場域裡找有這個出口代碼的
    for (const summary of nearbyVenues(near.lat, near.lon, { radiusM: 1200, limit: 12 })) {
      const v = byId.get(summary.id);
      for (const code of codes) {
        const exit = exitIndex.get(v.id)?.get(code);
        if (exit) push(v, exit, 'low', '出口編號相符（依鄰近位置推測場域）');
      }
    }
  }

  // 照片裡出現多個站名又無從消歧 → 全部列出讓使用者點，一律低信心。
  // UI 據此不自動套用，改為要求確認（見 ReportPage 的說明）。
  for (const v of ambiguousVenues) {
    push(v, null, 'low', '照片中出現多個站名，請確認你在哪一站');
  }

  // 高信心在前；同信心時保持穩定順序
  const rank = { high: 0, medium: 1, low: 2 };
  candidates.sort((a, b) => rank[a.confidence] - rank[b.confidence]);

  return { candidates, venue: venue ?? null };
}

// ---------------------------------------------------------------------------
// 示意圖幾何（給 client 畫 SVG）
// ---------------------------------------------------------------------------

/**
 * 場域幾何：出口的真實經緯度（供 client 在 OpenStreetMap 上標記）。
 *
 * 同時保留建表時算好的正規化 x/y（主軸對齊後 0~1）。那組座標不帶語意，
 * 只是給無圖磚環境的示意繪圖後備用——事件位置一律以出口代碼或經緯度表示。
 */
export function venueGeometry(venueId) {
  const v = findVenue(venueId);
  if (!v) return null;
  return {
    id: v.id,
    name: v.name,
    kind: v.kind,
    lat: v.lat,
    lon: v.lon,
    exitsAvailable: v.exitsAvailable,
    spanM: v.spanM ?? { along: 0, across: 0 },
    exits: (v.exits ?? []).map((e) => ({
      code: e.code,
      name: e.name,
      landmark: e.landmark,
      lat: e.lat,
      lon: e.lon,
      x: e.x,
      y: e.y,
    })),
    attribution: snapshot.attribution,
  };
}

/**
 * 由座標找出最近的出口——地圖自由選點、或 GPS 定位後用來換算錨點。
 * @returns {{code, name, landmark, lat, lon, distanceM}|null}
 */
export function nearestExit(venueId, lat, lon, { maxDistM = 400 } = {}) {
  const v = findVenue(venueId);
  if (!v?.exits?.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best = null;
  for (const e of v.exits) {
    const d = distanceM({ lat, lon }, e);
    if (!best || d < best.distanceM) best = { ...e, distanceM: Math.round(d) };
  }
  return best && best.distanceM <= maxDistM ? best : null;
}

export function venueMeta() {
  return {
    count: VENUES.length,
    generatedAt: snapshot.generatedAt ?? null,
    attribution: snapshot.attribution ?? null,
  };
}
