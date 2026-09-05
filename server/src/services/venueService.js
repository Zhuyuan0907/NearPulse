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

/**
 * 可做**子字串**比對的別名清單，依長度由長到短。
 *
 * 【為什麼需要】視覺辨識回來的不是乾淨的欄位，而是牌子上的整行字：
 *   '土城 Tucheng'、'← 海山 Haishan'、'往頂埔 To Dingpu'
 * 只做完全相等比對的話，這些**一個都對不上**——實測就是這樣讓一張
 * 清楚拍到站名的月台照最後顯示「位置待確認」。
 *
 * 長度由長到短是為了**最長匹配優先**：'中山國小' 必須勝過 '中山'，
 * 否則使用者在中山國小站會被判到中山站。
 *
 * 只收長度 >= 2 的別名：單字別名（若有）在整行字裡的誤中率太高。
 */
const ALIAS_LIST = [...byAlias.entries()]
  .filter(([k]) => k.length >= 2)
  .sort((a, b) => b[0].length - a[0].length)
  .map(([key, venue]) => ({
    key,
    venue,
    /**
     * 路線代碼（R3、BL16）**不能用純子字串比對**。
     *
     * 實測：「車廂3 Car 3」正規化成 `車廂3car3`，其中的 `ar3` 讓高雄 `R3`
     * （小港站）命中——一張忠孝敦化的月台照被判到高雄。短代碼藏在普通
     * 英文字裡的機率太高了。
     *
     * 所以代碼一律用單詞邊界比對（`\bR3\b`），CJK 站名才用子字串。
     */
    boundary: /^[a-z]{1,3}\d{1,3}$/.test(key)
      ? new RegExp(`(?:^|[^a-z0-9])${key}(?:[^a-z0-9]|$)`, 'i')
      : null,
  }));

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

/**
 * 在一組候選站裡找出「月台名牌的中心站」。
 *
 * 名牌上是「← 前站　本站　後站 →」，所以本站是唯一與其他候選都相鄰的那一個。
 * 相鄰關係來自 TDX 官方站序（見 trainService），不是推測。
 *
 * 只在候選數 >= 2 且**恰好有一個**站符合時才回傳——有兩個以上符合就表示
 * 這不是一塊名牌（可能是路線圖或轉乘指示），那種情況不該猜。
 *
 * @returns {object|null} 場域物件
 */
function centreOfBand(hits) {
  const ids = [...hits.keys()];
  if (ids.length < 2) return null;

  const centres = ids.filter((id) => {
    const neighbours = ADJACENT.get(id);
    if (!neighbours) return false;
    const others = ids.filter((x) => x !== id);
    return others.length > 0 && others.every((x) => neighbours.has(x));
  });
  return centres.length === 1 ? byId.get(centres[0]) ?? null : null;
}

/**
 * 相鄰車站表，由快照裡的官方站序（TDX）建出。
 *
 * 刻意**不** import trainService——那會造成循環相依（trainService 需要
 * venueService 的站名）。這裡要的只是「誰跟誰相鄰」，直接讀同一份快照即可。
 */
const ADJACENT = (() => {
  const map = new Map();
  const link = (a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  for (const route of snapshot.network?.routes ?? []) {
    const st = route.stations ?? [];
    for (let i = 0; i + 1 < st.length; i++) { link(st[i], st[i + 1]); link(st[i + 1], st[i]); }
  }
  return map;
})();

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

    // 先試完全相等（最可信）
    const exact = byAlias.get(normalizeName(raw));
    if (exact) {
      const strength = STATION_CODE_RE.test(raw.trim()) ? 2 : 1;
      hits.set(exact.id, Math.max(hits.get(exact.id) ?? 0, strength));
      continue;
    }

    /**
     * 再試子字串——辨識回來的是牌子上的整行字（'土城 Tucheng'），
     * 不是乾淨的欄位。同一行裡可能同時有中英文站名與代碼。
     *
     * 找到一個就停：一行字通常只講一個地方，繼續找只會撿到
     * 更短、更容易誤中的別名（'中山' 藏在 '中山國小' 裡）。
     */
    const norm = normalizeName(raw);
    if (norm.length < 2) continue;
    for (const { key, venue, boundary } of ALIAS_LIST) {
      const matched = boundary ? boundary.test(norm) : norm.includes(key);
      if (!matched) continue;
      const strength = boundary ? 2 : 1;
      hits.set(venue.id, Math.max(hits.get(venue.id) ?? 0, strength));
      break;
    }
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
    } else if (centreOfBand(hits)) {
      /**
       * **月台名牌的幾何**：牌子上同時印著前站、本站、後站，而本站是唯一
       * 與另外兩者都相鄰的那一個。我們手上正好有官方路網（TDX 站序），
       * 所以這個「誰在中間」是查得出來的，不是猜的。
       *
       * 這條規則專治使用者實際回報的狀況：拍土城月台，讀到
       * 土城／海山／永寧，而模型剛好沒讀到 BL03 代碼。
       */
      venueFromText = centreOfBand(hits);
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

  /**
   * ---- 出口線索 ----
   *
   * ⚠️ **裸數字只有在被標成出口時才算出口代碼。**
   *
   * 月台上到處都是數字：車門上的「車廂3 / Car 3」、看板的「2月台」、
   * 月台門的三位數編號。使用者實測拍忠孝敦化月台，車廂編號 3 被讀成
   * 「3 號出口」——而那會把人指到站內完全不同的位置。
   *
   * 帶字母前綴的代碼（M3、Y13）沒有這個問題，它們本來就只出現在出口牌上。
   * 有疑慮的只有裸數字，所以規則是：**它要嘛出現在含「出口/Exit」的字串裡，
   * 要嘛被模型標成出口類別**，否則寧可放棄——漏掉一個出口代碼的代價是
   * 使用者多點一次地圖；認錯的代價是別人跑錯方向。
   */
  const EXITISH_LABEL = /出口|出入口|exit/i;
  const NOT_EXIT_LABEL = /車廂|車門|月台|月臺|car\b|platform/i;

  /**
   * 站名代碼的數字部分（BL16 → 16）不可以當成出口編號。
   *
   * 實測使用者拍的忠孝敦化月台：站名牌是「BL16 忠孝敦化」，而模型把 `16`
   * 單獨列出來、還標成「出口」。這次僥倖沒事（忠孝敦化沒有 16 號出口，
   * 查表落空），但只要某站剛好有那個編號就會把人指到錯的地方。
   *
   * 用命中的場域代碼反推該排除哪些數字——這比要求模型永遠標對可靠得多。
   */
  const codeDigits = new Set();
  for (const raw of values) {
    for (const m of String(raw).matchAll(/\b[A-Za-z]{1,3}(\d{1,3})\b/g)) codeDigits.add(m[1]);
  }

  const codes = [...new Set(
    texts
      .map((t) => {
        const raw = typeof t === 'string' ? t : t?.value;
        const label = typeof t === 'string' ? '' : String(t?.label ?? '');
        if (typeof raw !== 'string' || !raw.trim()) return null;
        if (NOT_EXIT_LABEL.test(label)) return null;

        const code = parseExitCode(raw);
        if (!code) return null;

        // 純數字（無字母前綴）→ 需要出口的佐證
        const bare = /^\d{1,3}$/.test(code);
        if (bare && !EXITISH_LABEL.test(label) && !EXITISH_LABEL.test(raw)) return null;
        // 而且不能是站名代碼的數字部分（BL16 的 16）
        if (bare && codeDigits.has(code)) return null;
        return code;
      })
      .filter(Boolean)
  )];

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
