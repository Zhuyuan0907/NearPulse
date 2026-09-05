#!/usr/bin/env node
/**
 * ============================================================================
 * build-venues.mjs —— 由 OSM 抽取檔產生場域快照（離線執行）
 * ============================================================================
 * 資料來源是**本機 OSM 抽取檔**（見 scripts/extract-osm.mjs）：
 *
 *   node scripts/extract-osm.mjs /tmp/taiwan.osm.pbf /tmp/tw.json
 *   node scripts/build-venues.mjs /tmp/tw.json
 *
 * 為什麼不打 Overpass：公開實例只有 2 個併發槽，補方向地標需要上百次查詢，
 * 實測會被 429 與連線中斷反覆打斷（跑 20 分鐘還跑不完）。改成本機解析後
 * **全台灣 101 秒跑完、零限流、可任意重跑**，而且能一次看到所有標籤。
 *
 * 產出：server/src/data/venues.json（進版控；server 執行時只讀檔，不碰外部網路）
 *
 * 資料分級（依實測覆蓋率決定，不是設計偏好）：
 *   完整級 —— 捷運、地下街：有出口節點（帶編號、座標，部分帶無障礙資訊）
 *   場域級 —— 地下停車場：OSM 只有一個帶名字的點 → exitsAvailable=false
 *
 * 資料授權：OSM 為 ODbL，衍生資料需保留姓名標示（寫入 JSON 的 attribution 欄）。
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 與 venueService 共用同一套解析規則——建表與查表若各寫一份會安靜地比不中
import {
  exitCodeFromTags, landmarkFromTags, normalizeName, parseExitCode,
} from '../src/services/anchorParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/data/venues.json');

const INPUTS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
/**
 * `--network-only`：只重算捷運路網並寫回現有快照，不碰 OSM 場域。
 * TDX 的站序與行車時間比 OSM 圖資更新得頻繁，而重跑 OSM 需要重新下載
 * 數百 MB 的 PBF——把兩者解耦，路網更新就變成幾秒鐘的事。
 */
const NETWORK_ONLY = process.argv.includes('--network-only');

if (INPUTS.length === 0 && !NETWORK_ONLY) {
  console.error('用法：node scripts/build-venues.mjs <extract.json> [extract2.json …]');
  console.error('  抽取檔請先用 scripts/extract-osm.mjs 從 .osm.pbf 產生');
  process.exit(1);
}

/** 出口歸屬到車站的最大距離。台北車站出口群跨度達 700m，故放寬到 400m */
const MAX_ENTRANCE_DIST_M = 400;

/** 方向地標：最近的有名街道，最遠接受到這個距離 */
const MAX_STREET_DIST_M = 70;

/** 願意當作方向指引的道路類別（依可辨識度排序，數字小者優先） */
const ROAD_RANK = {
  trunk: 0, primary: 1, secondary: 2, tertiary: 3,
  pedestrian: 4, residential: 5, living_street: 6,
};

/** 相鄰捷運站的最大合理距離（台北捷運最長站距為文湖線南港軟體園區一帶，約 2.6km） */
const MAX_ADJACENT_STATION_M = 5000;

const UNDERGROUND_RE = /(.*?(?:地下街|地下センター|地下商店街))/;

/** 有地下樓層的公眾零售場所（百貨、購物中心）——見 extract-osm.mjs 的說明 */
const RETAIL_KINDS = new Set(['department_store', 'mall', 'supermarket']);
const undergroundLevels = (t = {}) => Number(t['building:levels:underground'] ?? 0);
const isUndergroundRetail = (t = {}) =>
  Boolean(t.name) &&
  undergroundLevels(t) >= 1 &&
  (RETAIL_KINDS.has(t.shop) || t.building === 'retail' || t.amenity === 'marketplace');

/**
 * 路網命名空間。
 *
 * ⚠️ **捷運路線代碼只在同一個城市內唯一**——`R14` 同時是台北圓山站與
 * 高雄巨蛋站，`K01`~`K10` 也一樣撞號。把多個城市（甚至多個國家）併進同一份
 * 快照後，若直接拿 ref 當 id，後載入的會蓋掉先載入的，使用者選了圓山卻
 * 顯示巨蛋。這是實際踩到的 bug。
 *
 * 用地理區域而非 OSM 的 network/operator 標籤，是因為後者覆蓋不完整
 * （日本只有 16/184 個車站有 network），而捷運系統本來就地理分離，
 * 用座標劃分既完整又穩定。
 */
const REGION_BOXES = [
  { code: 'TPE', name: '北北基桃', bbox: [24.60, 121.00, 25.40, 122.10] },
  { code: 'TXG', name: '台中',     bbox: [23.90, 120.50, 24.40, 120.90] },
  { code: 'TNN', name: '台南',     bbox: [22.85, 120.10, 23.20, 120.40] },
  { code: 'KHH', name: '高雄',     bbox: [22.40, 120.15, 22.95, 120.55] },
  { code: 'KIX', name: '関西',     bbox: [34.20, 134.80, 35.20, 136.10] },
];

/** 座標 → 路網代碼。落在已知區域外時用經緯度格編碼，仍保證全域唯一 */
function regionOf(lat, lon) {
  for (const r of REGION_BOXES) {
    const [s, w, n, e] = r.bbox;
    if (lat >= s && lat <= n && lon >= w && lon <= e) return r.code;
  }
  return `X${Math.round(lat)}${Math.round(lon)}`;
}

// ---------------------------------------------------------------------------
// 幾何
// ---------------------------------------------------------------------------

/** 等距圓柱近似：站體尺度（<1km）下誤差可忽略 */
function toMeters(lat, lon, originLat) {
  return { y: lat * 111_320, x: lon * 111_320 * Math.cos((originLat * Math.PI) / 180) };
}

function distanceM(a, b) {
  const p = toMeters(a.lat, a.lon, a.lat);
  const q = toMeters(b.lat, b.lon, a.lat);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** 點到線段的距離 */
function pointToSegmentM(p, a, b) {
  const k = 111_320;
  const c = Math.cos((p.lat * Math.PI) / 180);
  const to = (q) => ({ x: q.lon * k * c, y: q.lat * k });
  const P = to(p); const A = to(a); const B = to(b);
  const dx = B.x - A.x; const dy = B.y - A.y;
  const L = dx * dx + dy * dy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / L));
  return Math.hypot(P.x - (A.x + t * dx), P.y - (A.y + t * dy));
}

function coordOf(el) {
  if (typeof el.lat === 'number') return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

/**
 * 把出口點雲投影到主軸對齊的正規化座標（無圖磚環境的示意繪圖後備）。
 * 站體是線性的（月台是長廊），正北對齊會讓 700m×300m 的站擠在畫面一角。
 * 這組 x/y **不帶語意**——事件位置一律用出口代碼或真實經緯度表示。
 */
function projectExits(exits) {
  if (exits.length === 0) return { exits, spanM: { along: 0, across: 0 } };
  const lat0 = exits[0].lat;
  const pts = exits.map((e) => toMeters(e.lat, e.lon, lat0));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const centered = pts.map((p) => ({ x: p.x - cx, y: p.y - cy }));

  const sxx = centered.reduce((s, p) => s + p.x * p.x, 0);
  const syy = centered.reduce((s, p) => s + p.y * p.y, 0);
  const sxy = centered.reduce((s, p) => s + p.x * p.y, 0);
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ct = Math.cos(theta); const st = Math.sin(theta);

  const rot = centered.map((p) => ({ u: p.x * ct + p.y * st, v: -p.x * st + p.y * ct }));
  const us = rot.map((r) => r.u); const vs = rot.map((r) => r.v);
  const [uMin, uMax] = [Math.min(...us), Math.max(...us)];
  const [vMin, vMax] = [Math.min(...vs), Math.max(...vs)];
  const spanU = uMax - uMin; const spanV = vMax - vMin;
  const norm = (val, min, span) => (span < 1 ? 0.5 : (val - min) / span);

  return {
    exits: exits.map((e, i) => ({
      ...e,
      x: Number(norm(rot[i].u, uMin, spanU).toFixed(4)),
      y: Number(norm(rot[i].v, vMin, spanV).toFixed(4)),
    })),
    spanM: { along: Math.round(spanU), across: Math.round(spanV) },
  };
}

// ---------------------------------------------------------------------------
// 無障礙資訊
// ---------------------------------------------------------------------------

/**
 * 判斷一個出口是否「無需爬樓梯即可通行」。
 *
 * ⚠️ 安全預設：**沒有標註一律回 null（未知），絕不當成可通行**。
 * 對輪椅使用者、推嬰兒車的人、行動不便的長者而言，把「不知道」講成「可以」
 * 是會害死人的。UI 必須把「未知」和「可通行」分開呈現。
 *
 * 資料來源（依可信度排序）：
 *   1. wheelchair 標籤（實測台灣 52% 覆蓋、關西 30%）
 *   2. highway=elevator —— 這個出口本身就是電梯
 *   3. description 文字（台灣標註者寫得很完整：
 *      「設有電梯及雙向電扶梯」「祇設有樓梯及往地面電扶梯」）
 */
function accessibilityOf(tags = {}) {
  const wc = tags.wheelchair;
  const desc = tags.description ?? '';
  const isElevator = tags.highway === 'elevator' || tags.elevator === 'yes';
  const hasLift = isElevator || /電梯|昇降|エレベーター|\blift\b|elevator/i.test(desc);
  const stairsOnly = /祇設有樓梯|僅設有樓梯|只有樓梯|階段のみ|staircase only/i.test(desc);

  let stepFree = null; // null = 未知（安全預設）
  if (wc === 'yes' || wc === 'designated') stepFree = 'yes';
  else if (wc === 'no') stepFree = 'no';
  else if (wc === 'limited') stepFree = 'limited';
  else if (hasLift) stepFree = 'yes';
  else if (stairsOnly) stepFree = 'no';

  return {
    stepFree,
    hasLift: hasLift || null,
    facilities: desc || null,
    // level 可能是 "-2;-1;0" 這種多值，代表這個出入口貫穿多層
    levels: tags.level
      ? tags.level.split(';').map((v) => Number(v)).filter((v) => Number.isFinite(v))
      : null,
  };
}

// ---------------------------------------------------------------------------
// 場域組裝
// ---------------------------------------------------------------------------

function aliasesOf(...names) {
  const out = new Set();
  for (const n of names) {
    if (!n) continue;
    out.add(n);
    const norm = normalizeName(n);
    if (norm && norm !== n) out.add(norm);
  }
  return [...out];
}

/** 輕量穩定雜湊（地下街 id 用）——沿用專案既有的 FNV-1a 慣例 */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

function makeExit(el, tags) {
  const c = coordOf(el);
  const landmark = landmarkFromTags(tags);
  return {
    code: exitCodeFromTags(tags),
    name: tags.name ?? null,
    landmark,
    landmarkSource: landmark ? 'osm_tag' : null,
    lat: c.lat,
    lon: c.lon,
    ...accessibilityOf(tags),
  };
}

/**
 * 捷運：先合併同一個實體車站，再以空間最近歸屬出口。
 * 轉乘站在 OSM 常有多個節點（台北車站 = 北捷 BL12/R10 + 機場捷運 A1）；
 * 不合併的話同一場火警會裂成兩個事件，直接打斷「同場域同類型 → 同一件」分群。
 */
function buildMetro(stations, entrances, stats) {
  const groups = [];
  for (const st of stations) {
    const c = coordOf(st);
    if (!c) continue;
    const key = normalizeName(st.tags.name);
    const hit = groups.find((g) => g.key === key && distanceM(c, g) < 600);
    if (hit) { hit.nodes.push(st); stats.mergedStations++; }
    else groups.push({ key, lat: c.lat, lon: c.lon, nodes: [st] });
  }

  const list = groups.map((g) => {
    const refs = [...new Set(
      g.nodes.flatMap((n) => (n.tags.ref ?? '').split(';').map((r) => r.trim()).filter(Boolean))
    )].sort();
    const primary = g.nodes[0];
    // 加上路網前綴：R14 在台北是圓山、在高雄是巨蛋，不加前綴會互相覆蓋
    const local = refs[0] ?? `s${fnv1a(normalizeName(primary.tags.name) || String(primary.id))}`;
    const id = `${regionOf(g.lat, g.lon)}-${local}`;
    return {
      id,
      name: primary.tags.name ?? id,
      nameEn: g.nodes.map((n) => n.tags['name:en']).find(Boolean) ?? null,
      kind: 'metro',
      lat: g.lat,
      lon: g.lon,
      aliases: aliasesOf(
        ...g.nodes.map((n) => n.tags.name),
        ...g.nodes.map((n) => n.tags['name:en']),
        ...g.nodes.map((n) => n.tags['name:ja']),
        ...refs
      ),
      // 合併後的質心不能拿來歸屬出口：台北車站複合體寬達 700m，
      // 質心離自己遠端的出口比鄰站還遠。改以「到任一組成節點的最短距離」判定。
      _coords: g.nodes.map(coordOf).filter(Boolean),
      exits: [],
    };
  });

  for (const en of entrances) {
    const c = coordOf(en);
    if (!c) continue;
    let best = null;
    for (const v of list) {
      const d = Math.min(...v._coords.map((p) => distanceM(c, p)));
      if (!best || d < best.d) best = { d, v };
    }
    if (!best || best.d > MAX_ENTRANCE_DIST_M) { stats.orphanEntrances++; continue; }
    best.v.exits.push(makeExit(en, en.tags));
  }
  return list;
}

/**
 * 地下街：OSM 沒有對應的「車站節點」可歸屬，改由出口名稱反推場域。
 * 命名結構穩定（「西門地下街1號出入口」「東區地下街出入口9」），
 * 場域名與出口編號在同一字串裡——正好是 OCR 會讀到的形式。
 */
function buildUnderground(elements, stats) {
  const venues = new Map();
  const IS_ENTRANCE = /出入?口|出口/;

  for (const el of elements) {
    const name = el.tags?.name ?? '';
    const c = coordOf(el);
    if (!c) continue;
    const m = name.match(UNDERGROUND_RE);
    if (!m) continue;

    const venueName = m[1];
    const id = `${regionOf(c.lat, c.lon)}-ug${fnv1a(normalizeName(venueName))}`;
    if (!venues.has(id)) {
      venues.set(id, {
        id, name: venueName, nameEn: el.tags['name:en'] ?? null,
        kind: 'underground', lat: c.lat, lon: c.lon,
        aliases: aliasesOf(venueName, el.tags['name:en'], el.tags['name:ja']),
        exits: [],
      });
    }
    const v = venues.get(id);

    // 地下街本體帶的 ref 是「分區代號」不是出口編號（站前地下街 ref=Z、
    // 臺北地下街 ref=Y），直接拿來當出口會產生一堆假出口。必須是出入口才算。
    const code = IS_ENTRANCE.test(name) ? exitCodeFromTags(el.tags) : null;
    if (code) v.exits.push(makeExit(el, el.tags));
    else { v.lat = c.lat; v.lon = c.lon; stats.ugVenueAnchors++; }
  }
  return [...venues.values()];
}

/**
 * 百貨／購物中心：OSM 有 `building:levels:underground`（幾層地下）但
 * 極少標出入口節點（全台僅 7.6% 的地下建物有）。所以只建到場域層級，
 * 誠實標記 exitsAvailable=false——**不假裝有出口級的疏散路線**。
 *
 * `undergroundLevels` 仍然有價值：它界定了場域的垂直範圍，
 * 也是 Android 版氣壓計樓層偵測的對照基準（「B2，此場域共 6 層地下」）。
 */
function buildRetail(elements) {
  const venues = [];
  const seen = new Set();
  for (const el of elements) {
    const t = el.tags ?? {};
    if (!isUndergroundRetail(t)) continue;
    const c = coordOf(el);
    if (!c) continue;
    const key = normalizeName(t.name);
    if (seen.has(key)) continue;
    seen.add(key);
    venues.push({
      id: `${regionOf(c.lat, c.lon)}-rt${fnv1a(key)}`,
      name: t.name,
      nameEn: t['name:en'] ?? null,
      kind: 'retail',
      lat: c.lat, lon: c.lon,
      aliases: aliasesOf(t.name, t['name:en'], t['name:ja']),
      undergroundLevels: undergroundLevels(t),
      exits: [],
    });
  }
  return venues;
}

/**
 * 地下停車場：OSM 只有一個帶名字的點，無出入口節點、無樓層標籤。
 * 只建到場域層級——誠實標記 exitsAvailable=false 讓 UI 降級，
 * 而不是產生一份看起來完整、實際上空的出口清單。
 */
function buildParking(elements) {
  const venues = [];
  const seen = new Set();
  for (const el of elements) {
    const name = el.tags?.name;
    const c = coordOf(el);
    if (!name || !c || name.length < 3) continue; // 無名停車場無法辨識也無法選擇
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);
    venues.push({
      id: `${regionOf(c.lat, c.lon)}-pk${el.type[0]}${el.id}`,
      name, nameEn: el.tags['name:en'] ?? null,
      kind: 'parking', lat: c.lat, lon: c.lon,
      aliases: aliasesOf(name, el.tags['name:en']),
      exits: [],
    });
  }
  return venues;
}

/** 同一出口常有多個 OSM 節點（台大醫院 ref=2 出現兩次）→ 依 code 去重 */
function dedupeExits(venue, stats) {
  const byCode = new Map();
  // 同編號多節點時保留資訊較多的：優先有無障礙判定，其次有地標、有名稱
  const score = (e) => (e.stepFree ? 4 : 0) + (e.landmark ? 2 : 0) + (e.name ? 1 : 0);
  for (const ex of venue.exits) {
    if (!ex.code) { stats.droppedUnnumbered++; continue; }
    const prev = byCode.get(ex.code);
    if (!prev || score(ex) > score(prev)) byCode.set(ex.code, ex);
  }
  return [...byCode.values()].sort((a, b) =>
    a.code.localeCompare(b.code, 'en', { numeric: true })
  );
}

// ---------------------------------------------------------------------------
// 方向地標補完（最近的有名街道）
// ---------------------------------------------------------------------------

/** 出口牌不會寫「市民大道高架道路」，只會寫「市民大道」；巷弄不是方向指引 */
function cleanStreetName(name) {
  if (!name) return null;
  if (/[巷弄()（）]/.test(name)) return null;
  return name.replace(/高架(道路|橋)$/, '').trim() || null;
}

/**
 * OSM 的 exit_to 與名稱括號只覆蓋約四分之一的出口，而且剛好在最重要的大站
 * （台北車站 27 個出口、北門 13 個、民權西路 10 個）全部是空的。
 *
 * 補完方式：取最近的有名街道。捷運出口牌本來就大量以路名導引
 * （「M7 出口 忠孝西路」），所以推導出的方向資訊跟現場指標是同一件事。
 * 全程在本機算，不需要任何網路查詢。
 */
/**
 * 用**具名地標**補出口的方向描述。
 *
 * 【為什麼這比最近街道好得多】
 * 舊版用「最近的有名街道」，結果是東區地下街的 11 個出口全部寫著
 * 「忠孝東路四段」——完全無法區分，使用者的原話是「真沒有一些準確的資料嗎」。
 *
 * 而站內出口指示牌寫的從來不是街名，是**地標**：「往 新光三越」
 * 「往 台鐵車站」「往 國父紀念館」。那些地標 OSM 有，只是先前沒去抓。
 * OSM 真正記錄指示牌內容的 `exit_to` 標籤全台只有 5 筆，所以推導是唯一的路。
 *
 * 距離門檻比街道嚴格（120m vs 70m 但改用直線距離到地標中心）：
 * 太遠的地標會誤導——「往 台北 101」在一公里外沒有意義。
 */
const MAX_LANDMARK_DIST_M = 120;

/**
 * 這串描述是不是「純門牌號碼」。
 * 「忠孝東路4段175號」「敦化南路1段209號」「中央路4段約100號旁」→ 是
 * 「台鐵台北車站北一門旁」「近青島國宅」→ 不是（那是真地標）
 */
function isBareAddress(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return /^[\u4e00-\u9fa5]{2,8}(路|街|大道)[0-9一二三四五六七八九十]{0,3}段?約?\d+號(對面|旁|附近)?$/.test(t);
}

/** 地標類別的可辨識度排序（數字小者優先出現在指示牌上） */
const LANDMARK_RANK = {
  'railway=station': 0,
  'building=train_station': 0,
  'shop=department_store': 1,
  'shop=mall': 1,
  'aeroway=terminal': 1,
  'amenity=hospital': 2,
  'amenity=university': 2,
  'leisure=park': 3,
  'tourism=museum': 3,
  'tourism=attraction': 3,
  'amenity=school': 4,
  'amenity=college': 4,
  'leisure=stadium': 4,
  'amenity=theatre': 5,
  'amenity=cinema': 5,
  'historic=memorial': 5,
  'historic=monument': 5,
  'amenity=marketplace': 6,
  'amenity=townhall': 6,
  'amenity=library': 6,
  'shop=supermarket': 7,
  place_of_worship: 7,
};

function enrichWithLandmarks(venues, landmarks, stats) {
  if (!landmarks?.length) return;
  const CELL = 0.002; // 約 220m
  const key = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  const index = new Map();
  for (const lm of landmarks) {
    if (!lm?.name || !Number.isFinite(lm.lat)) continue;
    const k = key(lm.lat, lm.lon);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push(lm);
  }

  for (const v of venues) {
    for (const exit of v.exits) {
      /**
       * TDX 的官方描述通常優先——那是北捷自己寫的。
       *
       * **但純門牌號碼例外。**「忠孝東路4段175號」在地下室沒有任何用處：
       * 它回答的是「我出去之後會在哪」，而不是「我在站內該往哪走」。
       * 使用者的原話是「我在地下室怎麼會知道幾號」。
       * TDX 若給的是真地標（「台鐵台北車站北一門旁」）就保留，
       * 只有純門牌才讓具名地標蓋過去。
       */
      if (exit.landmark && exit.landmarkSource === 'osm_tag') continue;
      if (exit.landmark && exit.landmarkSource === 'tdx' && !isBareAddress(exit.landmark)) continue;

      /**
       * ⚠️ **場域自己不能當成自己的地標。**
       * 車站節點也在地標索引裡（`railway=station`），所以衛武營站的六個出口
       * 一度全部寫著「往衛武營」——那是同義反覆，讀的人得不到任何資訊。
       * 名稱互相包含就視為同一個地方（「衛武營」vs「衛武營站」）。
       */
      const own = normalizeName(v.name);
      const isSelf = (name) => {
        const n = normalizeName(name);
        return n === own || n.includes(own) || own.includes(n);
      };

      let best = null;
      for (const dLat of [-CELL, 0, CELL]) {
        for (const dLon of [-CELL, 0, CELL]) {
          for (const lm of index.get(key(exit.lat + dLat, exit.lon + dLon)) ?? []) {
            if (isSelf(lm.name)) continue;
            const d = distanceM(exit, lm);
            if (d > MAX_LANDMARK_DIST_M) continue;
            const rank = LANDMARK_RANK[lm.kind] ?? 9;
            // 先比可辨識度，再比距離——近的便利商店贏不過稍遠的百貨
            if (!best || rank < best.rank || (rank === best.rank && d < best.dist)) {
              best = { name: lm.name, rank, dist: Math.round(d) };
            }
          }
        }
      }
      if (best) {
        exit.landmark = best.name;
        exit.landmarkSource = 'osm_poi';
        stats.landmarkFromPoi = (stats.landmarkFromPoi ?? 0) + 1;
      }
    }
  }
}

function enrichLandmarks(venues, streets, stats) {
  // 街道依網格建索引，避免每個出口都掃過全部街道
  const CELL = 0.005;
  const key = (lat, lon) => `${Math.floor(lat / CELL)}:${Math.floor(lon / CELL)}`;
  const index = new Map();
  for (const w of streets) {
    const hw = w.tags?.highway;
    if (ROAD_RANK[hw] === undefined || !cleanStreetName(w.tags?.name)) continue;
    const cells = new Set();
    for (const g of w.geometry) cells.add(key(g.lat, g.lon));
    for (const c of cells) {
      if (!index.has(c)) index.set(c, []);
      index.get(c).push(w);
    }
  }

  for (const v of venues) {
    for (const exit of v.exits) {
      if (exit.landmark) continue;
      const near = new Set();
      for (const dLat of [-CELL, 0, CELL]) {
        for (const dLon of [-CELL, 0, CELL]) {
          for (const w of index.get(key(exit.lat + dLat, exit.lon + dLon)) ?? []) near.add(w);
        }
      }
      let best = null;
      for (const w of near) {
        const rank = ROAD_RANK[w.tags.highway];
        const g = w.geometry;
        for (let i = 0; i < g.length - 1; i++) {
          const d = pointToSegmentM(exit, g[i], g[i + 1]);
          if (d > MAX_STREET_DIST_M) continue;
          // 先比道路等級（大路才是指標會寫的），同級再比距離
          if (!best || rank < best.rank || (rank === best.rank && d < best.dist)) {
            best = { rank, dist: d, name: cleanStreetName(w.tags.name) };
          }
        }
      }
      if (best) {
        exit.landmark = best.name;
        exit.landmarkSource = 'nearest_street'; // 標明是推導的，不是官方出口標示
        stats.landmarkFromStreet++;
      }
    }
  }
}

/**
 * 唯一性收尾。
 *
 * 區域前綴解決了跨城市的撞號（台北 R14 vs 高雄 R14），但**同一區域內仍可能撞**：
 * 神戶市營地下鐵海岸線與京都市營地下鐵烏丸線都用 K01~K10，而兩者都在関西。
 *
 * 與其為每種情況想一個規則，不如在最後做一次通用處理：撞號的後續項目
 * 附加場域名的短雜湊。先排序再處理，所以結果是確定性的（同樣的輸入always
 * 產生同樣的 id），不會因為讀檔順序而變動。
 */
function ensureUniqueIds(venues) {
  const seen = new Map();
  for (const v of venues) {
    const n = (seen.get(v.id) ?? 0) + 1;
    seen.set(v.id, n);
    if (n > 1) {
      v.id = `${v.id}-${fnv1a(normalizeName(v.name))}`;
      // 原本的代碼仍留在別名裡，OCR 讀到裸代碼時還是查得到
      // （但若別名本身有歧義，venueService 會拒絕解析而非亂猜）
    }
  }
}

// ---------------------------------------------------------------------------
// TDX 官方資料合併（台北捷運）
// ---------------------------------------------------------------------------

/**
 * 用交通部 TDX 的官方出口資料覆蓋 OSM 的推測值。
 *
 * 【為什麼要覆蓋而不是補充】
 * OSM 的無障礙資訊是志工標的，覆蓋率 42%；TDX 是官方資料，台北捷運
 * **437 個出口每一個**都帶 Stair / Escalator / Elevator 旗標。
 * 在「輪椅使用者火災時往哪走」這種問題上，官方 100% 覆蓋的事實
 * 應該勝過志工 42% 覆蓋的推測。OSM 仍負責台北捷運以外的所有場域。
 *
 * 【一個殘酷但重要的數字】
 * 437 個出口裡有電梯的 148 個（34%），而**有電梯且無樓梯的只有 14 個（3.2%）**。
 * 火災時電梯不可使用 → 對輪椅使用者而言，96.8% 的出口在那一刻並不存在。
 * 這正是無障礙疏散必須切換成「待援」而非「往出口」的實證基礎。
 */
function mergeTdx(venues, tdx, stats) {
  if (!tdx?.exits?.length) return;

  // TDX StationID（BL01）→ 我們的場域。用別名比對，因為我們的 id 帶路網前綴
  const byRef = new Map();
  for (const v of venues) {
    if (v.kind !== 'metro') continue;
    for (const a of v.aliases ?? []) {
      const key = String(a).toUpperCase();
      // 只認台北：TDX 這份是 TRTC，別讓高雄同名代碼被誤配
      if (v.id.startsWith('TPE-') && /^[A-Z]{1,2}\d{1,2}$/.test(key)) byRef.set(key, v);
    }
  }

  const grouped = new Map();
  for (const e of tdx.exits) {
    const v = byRef.get(String(e.StationID).toUpperCase());
    if (!v) { stats.tdxUnmatched++; continue; }
    if (!grouped.has(v.id)) grouped.set(v.id, { venue: v, exits: [] });

    const pos = e.ExitPosition ?? {};
    if (!Number.isFinite(pos.PositionLat) || !Number.isFinite(pos.PositionLon)) continue;

    const hasLift = e.Elevator === true;
    const hasStair = e.Stair === true;
    // ⚠️ 部分出口的 ExitID 是空字串（實測 437 筆中有 19 筆，全部集中在
    // 台北車站這類大型複合站），但編號其實在名稱裡（「台北車站M8」）。
    // 用共用的解析器救回——這正是 anchorParser 存在的理由。
    const code = String(e.ExitID ?? '').toUpperCase() || parseExitCode(e.ExitName?.Zh_tw);

    grouped.get(v.id).exits.push({
      code: code || null,
      name: e.ExitName?.Zh_tw ?? null,
      // 官方的方位描述，比我們用最近街道推導的更準
      landmark: cleanDescription(e.LocationDescription),
      landmarkSource: 'tdx',
      lat: pos.PositionLat,
      lon: pos.PositionLon,
      // 無台階通行 = 有電梯。電扶梯與樓梯對輪椅使用者都不算通行。
      stepFree: hasLift ? 'yes' : 'no',
      hasLift: hasLift || null,
      // 有電梯但也有樓梯 → 依賴電梯；火災時這個出口對輪椅使用者無效
      facilities: [hasStair && '樓梯', e.Escalator > 0 && `電扶梯×${e.Escalator}`, hasLift && '電梯']
        .filter(Boolean).join('、') || null,
      levels: null,
      source: 'tdx',
    });
  }

  for (const { venue, exits } of grouped.values()) {
    // 【聯集，不是取代】TDX 只涵蓋北捷（TRTC）。台北車站在 OSM 有 27 個出口
    // ——含站前地下街的 Y 系列與台鐵/高鐵的 1~5 號——但 TDX 只列 M 系列 8 個。
    // 直接覆蓋會讓場域「變小」，把真實存在的出口從系統裡抹掉。
    // 所以：以 OSM 為底，TDX 有的覆蓋上去（官方資料優先），TDX 沒有的保留。
    const byCode = new Map();
    for (const e of venue.exits ?? []) if (e.code) byCode.set(e.code, e);
    let overridden = 0;
    for (const e of exits) {
      if (!e.code) continue;
      if (byCode.has(e.code)) overridden++;
      byCode.set(e.code, e); // TDX 優先
    }
    if (byCode.size === 0) continue;
    venue.exits = [...byCode.values()]
      .sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
    stats.tdxVenues++;
    stats.tdxExits += exits.filter((e) => e.code).length;
    stats.tdxOverridden += overridden;
  }
}

/** 官方描述往往很長（「中央路4段約100號旁」），取前段當方向指引就夠 */
/**
 * 由 TDX 的有方向站序 + 站間行車秒數，建出「下一站」推算所需的路網。
 *
 * 【為什麼需要方向，以及為什麼不問使用者方向】
 * 事件發生在行進中的列車上時，車廂裡的人沒有出口可去——他們唯一能做的是
 * 撐到下一站開門。要通知下一站，就必須知道列車往哪邊開。
 *
 * TDX 的 StationOfRoute 把同一條線的兩個方向拆成兩筆（BL-1 有「頂埔→南港展覽館」
 * 與「南港展覽館→頂埔」），所以站序本身就帶方向，不需要另外的方向欄位。
 *
 * 但 UI **不會問使用者「你往哪個方向」**——恐慌中那是個抽象問題。改問
 * 「下一站是哪一站」：那是車廂顯示器上正在跑的字、以及廣播正在唸的詞，
 * 抬頭就能回答，而且答案本身就唯一決定了方向。這是刻意的設計取捨。
 *
 * 產出：
 *   routes   每條有方向路線的場域 id 序列
 *   runTimes 「A|B」→ 秒數（TDX 官方值，不是估的）
 */
function buildNetwork(venues, tdx) {
  if (!tdx?.routes?.length) return null;

  // TDX 的 StationID（BL12）不一定等於我們的 venue id：轉乘站在 OSM 合併後
  // 只留一個主代碼（台北車站是 TPE-A1），其餘代碼落在 aliases 裡。
  //
  // ⚠️ **只在該營運機構的路網命名空間內查**。初版用全台捷運建對照表，
  // 結果台北車站（TDX 的 BL12/R10）的「下一站」跑出高雄車站——因為
  // `R11`、`R21` 在北高兩地都是有效代碼，而 `KHH-` 排序在 `TPE-` 之前先贏。
  // 這正是先前修過的跨城市撞號問題在另一個地方復發，所以這裡除了限定
  // 命名空間，還一併沿用「有歧義就不註冊」的規則。
  const OPERATOR_REGION = { TRTC: 'TPE' };
  const region = OPERATOR_REGION[tdx.operator];
  const prefix = region ? `${region}-` : null;

  const byAlias = new Map();
  const ambiguous = new Set();
  for (const v of venues) {
    if (v.kind !== 'metro') continue;
    if (prefix && !v.id.startsWith(prefix)) continue;
    for (const a of v.aliases ?? []) {
      const k = a.toLowerCase();
      if (byAlias.has(k) && byAlias.get(k) !== v.id) ambiguous.add(k);
      else byAlias.set(k, v.id);
    }
  }
  for (const k of ambiguous) byAlias.delete(k);
  const toVenue = (stationId) => byAlias.get(String(stationId).toLowerCase()) ?? null;

  const routes = [];
  const implausible = [];
  let unmapped = 0;
  for (const r of tdx.routes) {
    const seq = [...(r.Stations ?? [])].sort((a, b) => a.Sequence - b.Sequence);
    const stations = seq.map((s) => toVenue(s.StationID));
    if (stations.some((s) => !s)) { unmapped++; continue; }
    // 相鄰站距離健檢：捷運站距最遠不過數公里，超出就是對照表接錯了。
    // 這個檢查是為了讓「下一站接到別的城市」這類錯誤在建表時就爆出來，
    // 而不是等到有人在車廂裡看到荒謬的站名。
    let bad = null;
    for (let i = 0; i + 1 < stations.length; i++) {
      const a = venues.find((v) => v.id === stations[i]);
      const b = venues.find((v) => v.id === stations[i + 1]);
      if (a && b && distanceM(a, b) > MAX_ADJACENT_STATION_M) {
        bad = `${a.name}(${a.id}) → ${b.name}(${b.id}) 相距 ${Math.round(distanceM(a, b))}m`;
        break;
      }
    }
    if (bad) { implausible.push(`${r.RouteID}: ${bad}`); continue; }

    routes.push({
      id: r.RouteID,
      lineNo: r.LineNo,
      name: r.RouteName?.Zh_tw ?? r.RouteID,
      // 終點站名就是車頭與月台看板上寫的「往 ○○」——直接拿來當方向標籤
      towards: seq[seq.length - 1].StationName?.Zh_tw ?? '',
      stations,
    });
  }

  const runTimes = {};
  for (const line of tdx.travelTimes ?? []) {
    for (const t of line.TravelTimes ?? []) {
      const from = toVenue(t.FromStationID);
      const to = toVenue(t.ToStationID);
      if (!from || !to || !Number.isFinite(t.RunTime)) continue;
      // 同一組站在不同路線可能重複出現，取第一筆即可（實測差異在數秒內）。
      //
      // ⚠️ 只取 RunTime，**不加 StopTime**。StopTime 是在站停靠開關門的時間
      //（台北車站→西門 是 RunTime 120 + StopTime 42），加進去會讓「還有多久到站」
      // 多算 42 秒。對車廂裡等著開門的人，那是完全不同的一段時間。
      const key = `${from}|${to}`;
      if (runTimes[key] === undefined) runTimes[key] = t.RunTime;
    }
  }

  /**
   * 開門側與輪椅席車廂（政府資料開放平臺 dataset 128416）。
   *
   * 使用者問「哪一節車廂離樓梯近」——查證後確認**沒有任何開放資料**
   * 有車廂↔出口對應（日本的乗換案内是向 ナビット 購買人工實測資料；
   * TDX 與 OSM 都沒有）。但開門側是官方公開的，而且對車廂裡的人同樣有用：
   * 知道下一站往哪側開門，就能在到站前先移動到正確的那一側。
   *
   * 以 TDX 的 StationID 為鍵合併——轉乘站的多個代碼會落到同一個 venue，
   * 而每筆 doorSide 都帶 line 標記，所以不會互相蓋掉。
   */
  let doorSide = {};
  let wheelchairCars = {};
  try {
    const open = JSON.parse(readFileSync(resolve(__dirname, '../src/data/trtc-open.json'), 'utf8'));
    for (const [code, info] of Object.entries(open.stations ?? {})) {
      const venueId = toVenue(code);
      if (!venueId) continue;
      if (info.doorSide?.length) {
        doorSide[venueId] = [...(doorSide[venueId] ?? []), ...info.doorSide];
      }
      if (info.wheelchairCars) wheelchairCars[venueId] = info.wheelchairCars;
    }
  } catch {
    console.log('[build-venues] 沒有 TRTC 開放資料快照，略過開門側'
      + '（可執行 node scripts/fetch-trtc-open.mjs 產生）');
    doorSide = {}; wheelchairCars = {};
  }

  return {
    source: '交通部運輸資料流通服務平臺（TDX）— 台北捷運 TRTC',
    doorSideSource: '政府資料開放平臺 dataset 128416（臺北捷運車站無障礙設施資料）',
    operator: 'TRTC',
    routes,
    runTimes,
    doorSide,
    wheelchairCars,
    unmappedRoutes: unmapped,
    implausibleRoutes: implausible,
  };
}

function cleanDescription(desc) {
  if (!desc) return null;
  const t = String(desc).trim();
  return t.length > 18 ? `${t.slice(0, 18)}…` : t;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function updateNetworkOnly() {
  const snapshot = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
  const tdx = JSON.parse(readFileSync(resolve(__dirname, '../src/data/tdx-trtc.json'), 'utf8'));
  snapshot.network = buildNetwork(snapshot.venues, tdx);
  snapshot.networkUpdatedAt = new Date().toISOString();
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 1));

  const n = snapshot.network;
  console.log(`[build-venues] 路網已更新：${n.routes.length} 條有方向路線、`
    + `${Object.keys(n.runTimes).length} 段官方行車時間`
    + (n.unmappedRoutes ? `（${n.unmappedRoutes} 條站點對不上而略過）` : ''));
  console.log(`  開門側資訊    ${Object.keys(n.doorSide).length} 站`
    + `、輪椅席車廂 ${Object.keys(n.wheelchairCars).length} 站`);
  if (n.implausibleRoutes.length > 0) {
    console.error(`[build-venues] ❌ ${n.implausibleRoutes.length} 條路線的相鄰站距不合理，已排除：`);
    for (const m of n.implausibleRoutes) console.error(`    ${m}`);
    process.exitCode = 1;
  }
  console.log(`  場域未變動：${snapshot.venues.length} 筆`);
}

function main() {
  if (NETWORK_ONLY) return updateNetworkOnly();
  const t0 = Date.now();
  const elements = [];
  const streets = [];
  const landmarks = [];
  for (const f of INPUTS) {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    elements.push(...(d.elements ?? []));
    streets.push(...(d.streets ?? []));
    landmarks.push(...(d.landmarks ?? []));
    console.log(`[build-venues] 讀入 ${f}：${d.elements?.length ?? 0} POI、`
      + `${d.streets?.length ?? 0} 街道、${d.landmarks?.length ?? 0} 具名地標`);
  }

  const stations = elements.filter((e) => e.tags?.railway === 'station' && e.tags?.station === 'subway');
  const entrances = elements.filter((e) => e.tags?.railway === 'subway_entrance');
  const ugRaw = elements.filter((e) => UNDERGROUND_RE.test(e.tags?.name ?? ''));
  const pkRaw = elements.filter((e) => e.tags?.amenity === 'parking');
  const rtRaw = elements.filter((e) => isUndergroundRetail(e.tags));

  const stats = {
    orphanEntrances: 0, droppedUnnumbered: 0, ugVenueAnchors: 0,
    mergedStations: 0, landmarkFromStreet: 0,
    tdxVenues: 0, tdxExits: 0, tdxUnmatched: 0, tdxOverridden: 0,
  };

  // 地下街的出口不該同時被捷運吸走（西門地下街緊鄰西門站）
  const ugIds = new Set(ugRaw.map((e) => `${e.type}${e.id}`));
  const metroEntrances = entrances.filter((e) => !ugIds.has(`${e.type}${e.id}`));

  let venues = [
    ...buildMetro(stations, metroEntrances, stats),
    ...buildUnderground(ugRaw, stats),
    ...buildParking(pkRaw),
    ...buildRetail(rtRaw),
  ];

  venues = venues.map((v) => {
    const exits = dedupeExits(v, stats);
    const { _coords, ...rest } = v;
    return { ...rest, exits };
  });

  // TDX 官方資料優先於 OSM 推測值（僅台北捷運）——必須在補地標之前，
  // 因為 TDX 自帶官方方位描述，不需要再用最近街道推導
  let tdx = null;
  try {
    tdx = JSON.parse(readFileSync(resolve(__dirname, '../src/data/tdx-trtc.json'), 'utf8'));
    mergeTdx(venues, tdx, stats);
  } catch {
    console.log('[build-venues] 沒有 TDX 快照，台北捷運沿用 OSM 資料'
      + '（可執行 node scripts/fetch-tdx.mjs 產生）');
  }

  // 順序很重要：先用具名地標（指示牌會寫的東西），
  // 剩下沒有地標可用的才退回最近街道
  enrichWithLandmarks(venues, landmarks, stats);
  enrichLandmarks(venues, streets, stats);

  venues = venues.map((v) => {
    const { exits: projected, spanM } = projectExits(v.exits);
    return {
      ...v,
      lat: Number(v.lat.toFixed(6)),
      lon: Number(v.lon.toFixed(6)),
      exitsAvailable: projected.length > 0,
      /** 無障礙資訊的可用程度——UI 必須據此區分「沒有無障礙出口」與「不知道」 */
      accessibility: {
        known: projected.filter((e) => e.stepFree !== null).length,
        stepFree: projected.filter((e) => e.stepFree === 'yes').length,
        total: projected.length,
      },
      spanM,
      exits: projected.map((e) => ({
        ...e,
        lat: Number(e.lat.toFixed(6)),
        lon: Number(e.lon.toFixed(6)),
      })),
    };
  });

  venues.sort((a, b) => a.id.localeCompare(b.id));
  ensureUniqueIds(venues);

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap（Geofabrik 區域抽取檔，本機解析）',
    attribution: '© OpenStreetMap contributors (ODbL)',
    inputs: INPUTS,
    venues,
    /** 捷運路網（下一站推算用）；沒有 TDX 快照時為 null，功能自動關閉 */
    network: buildNetwork(venues, tdx),
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 1));

  // ---- 統計：這份輸出必須人工掃過一遍再提交 ----
  const byKind = venues.reduce((a, v) => { a[v.kind] = (a[v.kind] ?? 0) + 1; return a; }, {});
  const withExits = venues.filter((v) => v.exitsAvailable);
  const totalExits = venues.reduce((s, v) => s + v.exits.length, 0);
  const withLm = venues.reduce((n, v) => n + v.exits.filter((e) => e.landmark).length, 0);
  const acc = venues.reduce((n, v) => n + v.accessibility.known, 0);
  const stepFree = venues.reduce((n, v) => n + v.accessibility.stepFree, 0);
  const decidable = venues.filter((v) => v.accessibility.known >= 2 && v.accessibility.stepFree > 0);

  const pct = (n) => (totalExits ? Math.round((n / totalExits) * 100) : 0);
  // id 唯一性是硬性要求——撞號會讓使用者選了 A 卻看到 B
  const idCounts = venues.reduce((a, v) => { a[v.id] = (a[v.id] ?? 0) + 1; return a; }, {});
  const dupIds = Object.entries(idCounts).filter(([, n]) => n > 1);
  if (dupIds.length > 0) {
    console.error(`\n[build-venues] ❌ 發現 ${dupIds.length} 個重複 id：`,
      dupIds.slice(0, 10).map(([k]) => k).join(', '));
    process.exitCode = 1;
  }

  if (snapshot.network) {
    const n = snapshot.network;
    console.log(`  捷運路網      ${n.routes.length} 條有方向路線、`
      + `${Object.keys(n.runTimes).length} 段官方行車時間`
      + (n.unmappedRoutes ? `（${n.unmappedRoutes} 條因站點對不上而略過）` : ''));
  }

  console.log('\n[build-venues] ---- 統計 ----');
  console.log(`  場域總數      ${venues.length}  ${JSON.stringify(byKind)}`);
  console.log(`  id 唯一       ${dupIds.length === 0 ? '✓' : '❌ ' + dupIds.length + ' 個重複'}`);
  console.log(`  有出口的場域  ${withExits.length}（出口共 ${totalExits} 個）`);
  console.log(`  轉乘站已合併  ${stats.mergedStations}`);
  console.log(`  無主出口      ${stats.orphanEntrances}（距離所有車站 > ${MAX_ENTRANCE_DIST_M}m）`);
  console.log(`  無編號被丟棄  ${stats.droppedUnnumbered}`);
  console.log(`  有方向地標    ${withLm}/${totalExits}（${pct(withLm)}%）—— 其中 ${stats.landmarkFromStreet} 個由最近街道推導`);
  console.log(`  無障礙已知    ${acc}/${totalExits}（${pct(acc)}%）—— 其中 ${stepFree} 個無台階可通行`);
  if (stats.tdxVenues > 0) {
    console.log(`  TDX 官方覆蓋  ${stats.tdxVenues} 個台北捷運場域、${stats.tdxExits} 個出口（其中 ${stats.tdxOverridden} 個覆蓋 OSM 推測值）`);
  }
  console.log(`  可做無障礙疏散判斷的場域：${decidable.length}`);
  console.log(`  檔案          ${OUT_PATH}（${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB，${((Date.now() - t0) / 1000).toFixed(1)}s）`);

  for (const v of decidable.slice(0, 3)) {
    console.log(`\n  範例 ${v.name}（${v.id}）：${v.exits.length} 出口，${v.accessibility.stepFree} 個無台階`);
    for (const e of v.exits.slice(0, 6)) {
      const a = e.stepFree === 'yes' ? '♿ 可通行'
        : e.stepFree === 'no' ? '⛔ 有台階'
        : e.stepFree ? `△ ${e.stepFree}` : '？ 未知';
      console.log(`     ${e.code.padEnd(5)} ${a.padEnd(11)} ${e.landmark ? '往' + e.landmark : ''}`);
    }
  }
}

main();
