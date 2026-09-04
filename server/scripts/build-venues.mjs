#!/usr/bin/env node
/**
 * ============================================================================
 * build-venues.mjs —— 由 OpenStreetMap 產生場域快照（離線執行）
 * ============================================================================
 * 為什麼是離線 script 而不是 server 啟動時抓：
 *   Overpass 是共用的免費服務，不適合逐請求／逐啟動查詢；而且回報路徑上
 *   多一個外部依賴就多一個失敗模式。本 script 產出的 JSON 進版控，
 *   server 只讀檔——執行時完全不碰外部網路。更新是手動 / CI 步驟。
 *
 * 產出：server/src/data/venues.json
 *
 * 用法：
 *   node server/scripts/build-venues.mjs            # 全台灣
 *   node server/scripts/build-venues.mjs --taipei   # 只做台北（快速驗證用）
 *
 * 資料分兩級（依實測覆蓋率決定，不是設計偏好）：
 *   完整級 —— 捷運、地下街：OSM 有出口節點（帶編號與座標）
 *             → 錨點辨識、地圖確認、疏散距離全部可用
 *   場域級 —— 地下停車場：OSM 只有一個帶名字的點，無出入口節點、無樓層標籤
 *             → 只能回報「在某停車場」，exitsAvailable=false，UI 自動降級
 *
 * 資料授權：OSM 為 ODbL，衍生資料需保留姓名標示（寫入 JSON 的 attribution 欄）。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// 與 venueService 共用同一套解析規則——建表與查表若各寫一份會安靜地比不中
import { exitCodeFromTags, landmarkFromTags, normalizeName } from '../src/services/anchorParser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/data/venues.json');

const ENDPOINT = process.env.OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter';

/**
 * 分區查詢而非一次抓全台灣：實測單一大範圍查詢會讓 Overpass 連線中斷。
 * 分成幾個小區塊各自查再合併，成功率高很多，也對這個共用免費服務友善。
 * 只涵蓋有軌道系統的都會區——其餘地區沒有地下通勤場域。
 */
// 註：台南目前無營運中的捷運系統，不查（省一次對共用服務的請求）
const REGIONS = [
  { name: '北北基桃', bbox: [24.80, 121.15, 25.35, 121.90] },
  { name: '台中',     bbox: [23.95, 120.55, 24.35, 120.80] },
  { name: '高雄',     bbox: [22.45, 120.20, 22.85, 120.45] },
];
const BBOX_TAIPEI = [24.95, 121.40, 25.20, 121.68];

/** 出口歸屬到車站的最大距離。台北車站出口群跨度達 700m，故放寬到 400m */
const MAX_ENTRANCE_DIST_M = 400;

// ---------------------------------------------------------------------------
// Overpass
// ---------------------------------------------------------------------------

function buildQuery([s, w, n, e]) {
  const bbox = `${s},${w},${n},${e}`;
  return `[out:json][timeout:300];
(
  node["railway"="station"]["station"="subway"](${bbox});
  node["railway"="subway_entrance"](${bbox});
  nwr["name"~"地下街"](${bbox});
  nwr["amenity"="parking"]["parking"="underground"](${bbox});
  nwr["amenity"="parking"]["location"="underground"](${bbox});
);
out tags center;`;
}

const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function overpass(query, attempt = 1) {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Overpass 使用政策要求可識別的 User-Agent
        'User-Agent': 'NearPulse/0.3 (underground incident reporting; venue snapshot builder)',
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      // 429 = 併發槽用完（公開實例只給 2 個），504 = 忙碌。都要退避重試
      if ([429, 502, 503, 504].includes(res.status)) throw new Error(`HTTP ${res.status}`);
      throw new Error(`Overpass 回應 ${res.status}`);
    }
    return await res.json();
  } catch (err) {
    // 連線中斷同樣要退避重試——大範圍查詢時是常見的失敗模式
    if (attempt < 5) {
      const wait = attempt * 25;
      console.warn(`  ${err.message}，${wait}s 後重試（第 ${attempt + 1} 次）`);
      await sleep(wait);
      return overpass(query, attempt + 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 幾何
// ---------------------------------------------------------------------------

/** 等距圓柱近似：站體尺度（<1km）下誤差可忽略，且不需要三角函數展開 */
function toMeters(lat, lon, originLat) {
  return {
    y: lat * 111_320,
    x: lon * 111_320 * Math.cos((originLat * Math.PI) / 180),
  };
}

function distanceM(a, b) {
  const p = toMeters(a.lat, a.lon, a.lat);
  const q = toMeters(b.lat, b.lon, a.lat);
  return Math.hypot(p.x - q.x, p.y - q.y);
}

/** 元素的代表座標（node 用 lat/lon；way/relation 用 Overpass 給的 center） */
function coordOf(el) {
  if (typeof el.lat === 'number') return { lat: el.lat, lon: el.lon };
  if (el.center) return { lat: el.center.lat, lon: el.center.lon };
  return null;
}

/**
 * 把出口點雲投影到「主軸對齊」的正規化座標（給示意圖用）。
 *
 * 為什麼用 PCA 而不是正北對齊：站體是線性的（月台是長廊）。
 * 正北對齊會讓一個 700m×300m 的站擠在畫面一角；沿主軸攤開才畫得出可讀的示意圖。
 * 注意這裡的 x/y 純粹服務繪圖，**不帶任何語意**——事件位置一律用出口代碼表示。
 */
function projectExits(exits) {
  if (exits.length === 0) return { exits, spanM: { along: 0, across: 0 } };

  const lat0 = exits[0].lat;
  const pts = exits.map((e) => toMeters(e.lat, e.lon, lat0));
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const centered = pts.map((p) => ({ x: p.x - cx, y: p.y - cy }));

  // 二階矩 → 主軸角度
  const sxx = centered.reduce((s, p) => s + p.x * p.x, 0);
  const syy = centered.reduce((s, p) => s + p.y * p.y, 0);
  const sxy = centered.reduce((s, p) => s + p.x * p.y, 0);
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);

  const rot = centered.map((p) => ({ u: p.x * ct + p.y * st, v: -p.x * st + p.y * ct }));
  const us = rot.map((r) => r.u);
  const vs = rot.map((r) => r.v);
  const [uMin, uMax] = [Math.min(...us), Math.max(...us)];
  const [vMin, vMax] = [Math.min(...vs), Math.max(...vs)];
  const spanU = uMax - uMin;
  const spanV = vMax - vMin;

  // 單一出口或全部共線時避免除以零，置中即可
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
// 標籤解析
// ---------------------------------------------------------------------------

/** 場域名去重後的別名集合（供 OCR 站名比對） */
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

// ---------------------------------------------------------------------------
// 方向地標補完（最近的有名街道）
// ---------------------------------------------------------------------------

/**
 * OSM 的 exit_to 與名稱括號只覆蓋約四分之一的出口——而且剛好在最重要的大站
 * （台北車站 27 個出口、北門 13 個、民權西路 10 個）全部是空的。
 *
 * 補完方式：取**最近的有名街道**。台北捷運的出口牌本來就大量以路名導引
 * （「M7 出口 忠孝西路」），所以這個推導出的方向資訊跟現場指標是同一件事。
 *
 * 只在缺地標時才補；已有 exit_to / 名稱括號的以原始標註為準。
 */

/** 願意當作方向指引的道路類別（依可辨識度排序，數字小者優先） */
const ROAD_RANK = {
  trunk: 0, primary: 1, secondary: 2, tertiary: 3,
  pedestrian: 4, residential: 5, living_street: 6,
};

const MAX_STREET_DIST_M = 70;

/** 點到線段的距離（先投影到公尺平面，站體尺度下誤差可忽略） */
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

/**
 * 路名清理：出口牌不會寫「市民大道高架道路」，只會寫「市民大道」。
 * 巷弄與括號註記（「公園路 (大客車專用道)」）不是方向指引，直接排除。
 */
function cleanStreetName(name) {
  if (!name) return null;
  if (/[巷弄()（）]/.test(name)) return null;
  return name.replace(/高架(道路|橋)$/, '').trim() || null;
}

async function enrichLandmarks(venues, stats, save) {
  const targets = venues.filter(
    (v) => v.exitsAvailable && v.exits.some((e) => !e.landmark)
  );
  console.log(`[build-venues] 補方向地標：${targets.length} 個場域缺少出口方向資訊`);
  console.log('  （Overpass 公開實例限流嚴格；此步驟可中斷後重跑，已補的會保留）');

  for (const [i, v] of targets.entries()) {
    const lats = v.exits.map((e) => e.lat);
    const lons = v.exits.map((e) => e.lon);
    const pad = 0.0008; // 約 90m，足以涵蓋出口周邊街廓
    const bbox = [
      Math.min(...lats) - pad, Math.min(...lons) - pad,
      Math.max(...lats) + pad, Math.max(...lons) + pad,
    ].join(',');

    let streets = [];
    try {
      const data = await overpass(
        `[out:json][timeout:60][bbox:${bbox}];way["highway"]["name"];out tags geom;`
      );
      streets = (data.elements ?? []).filter(
        (w) => ROAD_RANK[w.tags?.highway] !== undefined && cleanStreetName(w.tags?.name)
      );
    } catch {
      stats.landmarkQueryFailed++;
      continue; // 補完失敗不是錯誤——缺方向資訊只是少一個提示，不影響出口編號
    }

    for (const exit of v.exits) {
      if (exit.landmark) continue;
      let best = null;
      for (const w of streets) {
        const rank = ROAD_RANK[w.tags.highway];
        const g = w.geometry ?? [];
        for (let j = 0; j < g.length - 1; j++) {
          const d = pointToSegmentM(exit, g[j], g[j + 1]);
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

    // 每 10 個場域存一次檔：限流很容易讓整批中斷，已完成的成果不該賠掉。
    // 重跑時已有 landmark 的出口會被跳過，等於自動續跑。
    if ((i + 1) % 10 === 0) { save(); console.log(`  … ${i + 1}/${targets.length}（已存檔）`); }
    await sleep(3);
  }
}

// ---------------------------------------------------------------------------
// 場域組裝
// ---------------------------------------------------------------------------

/**
 * 捷運：出口以空間最近歸屬到車站。
 * 為何不用 public_transport=stop_area 關聯——實測台北的 stop_area 多為公車站，
 * 且大量出口節點根本沒有任何車站參照，空間歸屬是唯一可靠的路徑。
 */
function buildMetro(stations, entrances, stats) {
  // ---- 步驟 1：合併同一個實體車站 ----
  // 轉乘站在 OSM 常有多個節點（台北車站 = 北捷 BL12/R10 + 機場捷運 A1）。
  // 不合併的話同一場火警會裂成兩個事件，直接打斷「同場域同類型 → 同一件」分群。
  // 判準：正規化站名相同且距離 < 600m（連通的地下複合體尺度）。
  const groups = [];
  for (const st of stations) {
    const c = coordOf(st);
    if (!c) continue;
    const key = normalizeName(st.tags.name);
    const hit = groups.find((g) => g.key === key && distanceM(c, g) < 600);
    if (hit) {
      hit.nodes.push(st);
      stats.mergedStations++;
    } else {
      groups.push({ key, lat: c.lat, lon: c.lon, nodes: [st] });
    }
  }

  const list = groups.map((g) => {
    const refs = [
      ...new Set(g.nodes.flatMap((n) => (n.tags.ref ?? '').split(';').map((r) => r.trim()).filter(Boolean))),
    ].sort();
    const primary = g.nodes[0];
    // 字典序第一個 ref 當 id；其餘全數進別名，OCR 讀到任何一個代碼都查得到
    const id = refs[0] ?? `mrt-${fnv1a(normalizeName(primary.tags.name) || String(primary.id))}`;
    return {
      id,
      name: primary.tags.name ?? id,
      nameEn: g.nodes.map((n) => n.tags['name:en']).find(Boolean) ?? null,
      kind: 'metro',
      lat: g.lat,
      lon: g.lon,
      aliases: aliasesOf(...g.nodes.map((n) => n.tags.name), ...g.nodes.map((n) => n.tags['name:en']), ...refs),
      // 合併後的質心不能拿來歸屬出口：台北車站複合體寬達 700m，
      // 質心離自己遠端的出口比鄰站還遠。改以「到任一組成節點的最短距離」判定。
      _coords: g.nodes.map(coordOf).filter(Boolean),
      exits: [],
    };
  });

  // ---- 步驟 2：出口以空間最近歸屬 ----
  for (const en of entrances) {
    const c = coordOf(en);
    if (!c) continue;

    let best = null;
    for (const v of list) {
      const d = Math.min(...v._coords.map((p) => distanceM(c, p)));
      if (!best || d < best.d) best = { d, v };
    }
    if (!best || best.d > MAX_ENTRANCE_DIST_M) {
      stats.orphanEntrances++;
      continue;
    }
    best.v.exits.push({
      code: exitCodeFromTags(en.tags),
      name: en.tags.name ?? null,
      landmark: landmarkFromTags(en.tags),
      landmarkSource: landmarkFromTags(en.tags) ? 'osm_tag' : null,
      lat: c.lat,
      lon: c.lon,
    });
  }
  return list;
}

/**
 * 地下街：OSM 沒有對應的「車站節點」可歸屬，改由出口名稱反推場域。
 * 實測命名結構穩定：「西門地下街1號出入口」「東區地下街出入口9」，
 * 場域名與出口編號在同一字串裡，正好是 OCR 會讀到的形式。
 */
function buildUnderground(elements, stats) {
  const venues = new Map();
  const NAME_RE = /^(.*?地下街)/;
  /** 必須是出入口才算出口。地下街本體帶的 ref 是「分區代號」不是出口編號——
   *  站前地下街 ref=Z、臺北地下街 ref=Y、中山地下街 ref=R，
   *  若直接拿 ref 當出口會產生一堆假出口。 */
  const IS_ENTRANCE = /出入?口/;

  for (const el of elements) {
    const name = el.tags?.name ?? '';
    const c = coordOf(el);
    if (!c) continue;
    const m = name.match(NAME_RE);
    if (!m) continue;

    const venueName = m[1];
    const id = `ug-${fnv1a(normalizeName(venueName))}`;
    if (!venues.has(id)) {
      venues.set(id, {
        id,
        name: venueName,
        nameEn: null,
        kind: 'underground',
        lat: c.lat,
        lon: c.lon,
        aliases: aliasesOf(venueName),
        exits: [],
      });
    }
    const v = venues.get(id);

    const code = IS_ENTRANCE.test(name) ? exitCodeFromTags(el.tags) : null;
    if (code) {
      v.exits.push({ code, name, landmark: landmarkFromTags(el.tags), lat: c.lat, lon: c.lon });
    } else {
      // 地下街本體的面/點 —— 拿來校正場域中心（比出口平均更準）
      v.lat = c.lat;
      v.lon = c.lon;
      stats.ugVenueAnchors++;
    }
  }
  return [...venues.values()];
}

/**
 * 地下停車場：OSM 只有一個帶名字的點，無出入口節點、無樓層標籤。
 * 故只建到場域層級——誠實標記 exitsAvailable=false，讓 UI 自動降級，
 * 而不是產生一份看起來完整、實際上空的出口清單。
 */
function buildParking(elements) {
  const venues = [];
  const seen = new Set();

  for (const el of elements) {
    const name = el.tags?.name;
    const c = coordOf(el);
    // 無名停車場無法辨識也無法選擇，直接略過
    if (!name || !c || name.length < 3) continue;
    const key = normalizeName(name);
    if (seen.has(key)) continue;
    seen.add(key);

    venues.push({
      id: `pk-${el.type[0]}${el.id}`,
      name,
      nameEn: el.tags['name:en'] ?? null,
      kind: 'parking',
      lat: c.lat,
      lon: c.lon,
      aliases: aliasesOf(name, el.tags['name:en']),
      exits: [],
    });
  }
  return venues;
}

/** 同一出口常有多個 OSM 節點（實測台大醫院 ref=2 出現兩次）→ 依 code 去重 */
function dedupeExits(venue, stats) {
  const byCode = new Map();
  let unnumbered = 0;

  for (const ex of venue.exits) {
    if (!ex.code) {
      unnumbered++;
      continue; // 無編號的出口對 OCR 比對沒有價值，且會污染疏散排序
    }
    const prev = byCode.get(ex.code);
    // 同編號多節點時保留資訊較多的那個（有名稱 / 有地標）
    if (!prev || (!prev.landmark && ex.landmark) || (!prev.name && ex.name)) {
      byCode.set(ex.code, ex);
    }
  }
  stats.droppedUnnumbered += unnumbered;
  return [...byCode.values()].sort((a, b) =>
    a.code.localeCompare(b.code, 'en', { numeric: true })
  );
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const taipeiOnly = process.argv.includes('--taipei');
  const regions = taipeiOnly ? [{ name: '台北', bbox: BBOX_TAIPEI }] : REGIONS;

  // 分區查詢後依 type+id 去重（區塊邊界會重疊到同一個元素）
  const seen = new Map();
  for (const [i, region] of regions.entries()) {
    process.stdout.write(`[build-venues] 查詢 ${region.name}…`);
    const data = await overpass(buildQuery(region.bbox));
    const got = data.elements ?? [];
    for (const el of got) seen.set(`${el.type}${el.id}`, el);
    console.log(` ${got.length} 個元素`);
    if (i < regions.length - 1) await sleep(3); // 對共用服務的基本禮貌
  }
  const els = [...seen.values()];
  console.log(`[build-venues] 合計 ${els.length} 個不重複元素`);

  const stations = els.filter((e) => e.tags?.railway === 'station' && e.tags?.station === 'subway');
  const entrances = els.filter((e) => e.tags?.railway === 'subway_entrance');
  const ugRaw = els.filter((e) => (e.tags?.name ?? '').includes('地下街'));
  const pkRaw = els.filter((e) => e.tags?.amenity === 'parking');

  const stats = {
    orphanEntrances: 0, droppedUnnumbered: 0, ugVenueAnchors: 0, mergedStations: 0,
    landmarkFromStreet: 0, landmarkQueryFailed: 0,
  };

  // 地下街的出口不該同時被捷運吸走（西門地下街緊鄰西門站）
  const ugIds = new Set(ugRaw.map((e) => `${e.type}${e.id}`));
  const metroEntrances = entrances.filter((e) => !ugIds.has(`${e.type}${e.id}`));

  let venues = [
    ...buildMetro(stations, metroEntrances, stats),
    ...buildUnderground(ugRaw, stats),
    ...buildParking(pkRaw),
  ];

  // 去重出口 → 投影 → 清掉內部欄位
  venues = venues.map((v) => {
    const exits = dedupeExits(v, stats);
    const { exits: projected, spanM } = projectExits(exits);
    const { _coords, ...rest } = v;
    return {
      ...rest,
      lat: Number(v.lat.toFixed(6)),
      lon: Number(v.lon.toFixed(6)),
      exitsAvailable: projected.length > 0,
      spanM,
      exits: projected.map((e) => ({
        ...e,
        lat: Number(e.lat.toFixed(6)),
        lon: Number(e.lon.toFixed(6)),
      })),
    };
  });

  // 沒有出口的捷運站代表 OSM 資料不全，保留但標記；停車場則本來就沒有
  venues.sort((a, b) => a.id.localeCompare(b.id));

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: 'OpenStreetMap via Overpass API',
    attribution: '© OpenStreetMap contributors (ODbL)',
    regions: regions.map((r) => r.name),
    venues,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  const save = () => writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 1));

  // 先把基礎資料寫下來：補地標需要上百次額外查詢，很容易被限流中斷，
  // 基礎資料不該跟著陪葬。
  save();

  // 方向地標補完（可中斷、可續跑）
  if (!process.argv.includes('--no-landmarks')) {
    await enrichLandmarks(venues, stats, save);
  }
  save();

  // ---- 統計：這份輸出必須人工掃過一遍再 commit ----
  const byKind = venues.reduce((acc, v) => {
    acc[v.kind] = (acc[v.kind] ?? 0) + 1;
    return acc;
  }, {});
  const withExits = venues.filter((v) => v.exitsAvailable);
  const metroNoExits = venues.filter((v) => v.kind === 'metro' && !v.exitsAvailable);
  const totalExits = venues.reduce((s, v) => s + v.exits.length, 0);

  console.log('\n[build-venues] ---- 統計 ----');
  console.log(`  場域總數      ${venues.length}  ${JSON.stringify(byKind)}`);
  console.log(`  有出口的場域  ${withExits.length}（出口共 ${totalExits} 個）`);
  console.log(`  轉乘站已合併  ${stats.mergedStations}（多節點併成同一場域，避免事件裂開）`);
  console.log(`  捷運站無出口  ${metroNoExits.length}${metroNoExits.length ? ` ← ${metroNoExits.slice(0, 5).map((v) => v.name).join('、')}（OSM 未標出入口）` : ''}`);
  console.log(`  無主出口      ${stats.orphanEntrances}（距離所有車站 > ${MAX_ENTRANCE_DIST_M}m）`);
  console.log(`  無編號被丟棄  ${stats.droppedUnnumbered}`);
  const withLm = venues.reduce((n, v) => n + v.exits.filter((e) => e.landmark).length, 0);
  console.log(`  有方向地標    ${withLm}/${totalExits}（${Math.round((withLm / totalExits) * 100)}%）—— 其中 ${stats.landmarkFromStreet} 個由最近街道推導`);
  if (stats.landmarkQueryFailed) console.log(`  地標查詢失敗  ${stats.landmarkQueryFailed} 個場域`);
  console.log(`  檔案          ${OUT_PATH}  (${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB)`);

  const sample = venues.filter((v) => v.exits.length >= 4).slice(0, 2);
  for (const v of sample) {
    console.log(`\n  範例 ${v.name}（${v.id}，${v.exits.length} 出口，主軸 ${v.spanM.along}m）`);
    for (const e of v.exits.slice(0, 5)) {
      console.log(`     ${e.code.padEnd(4)} ${(e.landmark ? '往' + e.landmark : '(無方向資訊)').padEnd(18)} ${e.landmarkSource ?? ''}`);
    }
  }
}

main().catch((err) => {
  console.error('[build-venues] 失敗：', err.message);
  process.exit(1);
});
