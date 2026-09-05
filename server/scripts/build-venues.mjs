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
import { exitCodeFromTags, landmarkFromTags, normalizeName } from '../src/services/anchorParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/data/venues.json');

const INPUTS = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (INPUTS.length === 0) {
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
// 主流程
// ---------------------------------------------------------------------------

function main() {
  const t0 = Date.now();
  const elements = [];
  const streets = [];
  for (const f of INPUTS) {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    elements.push(...(d.elements ?? []));
    streets.push(...(d.streets ?? []));
    console.log(`[build-venues] 讀入 ${f}：${d.elements?.length ?? 0} POI、${d.streets?.length ?? 0} 街道`);
  }

  const stations = elements.filter((e) => e.tags?.railway === 'station' && e.tags?.station === 'subway');
  const entrances = elements.filter((e) => e.tags?.railway === 'subway_entrance');
  const ugRaw = elements.filter((e) => UNDERGROUND_RE.test(e.tags?.name ?? ''));
  const pkRaw = elements.filter((e) => e.tags?.amenity === 'parking');
  const rtRaw = elements.filter((e) => isUndergroundRetail(e.tags));

  const stats = {
    orphanEntrances: 0, droppedUnnumbered: 0, ugVenueAnchors: 0,
    mergedStations: 0, landmarkFromStreet: 0,
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

  console.log('\n[build-venues] ---- 統計 ----');
  console.log(`  場域總數      ${venues.length}  ${JSON.stringify(byKind)}`);
  console.log(`  id 唯一       ${dupIds.length === 0 ? '✓' : '❌ ' + dupIds.length + ' 個重複'}`);
  console.log(`  有出口的場域  ${withExits.length}（出口共 ${totalExits} 個）`);
  console.log(`  轉乘站已合併  ${stats.mergedStations}`);
  console.log(`  無主出口      ${stats.orphanEntrances}（距離所有車站 > ${MAX_ENTRANCE_DIST_M}m）`);
  console.log(`  無編號被丟棄  ${stats.droppedUnnumbered}`);
  console.log(`  有方向地標    ${withLm}/${totalExits}（${pct(withLm)}%）—— 其中 ${stats.landmarkFromStreet} 個由最近街道推導`);
  console.log(`  無障礙已知    ${acc}/${totalExits}（${pct(acc)}%）—— 其中 ${stepFree} 個無台階可通行`);
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
