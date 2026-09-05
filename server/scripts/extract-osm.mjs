#!/usr/bin/env node
/**
 * ============================================================================
 * extract-osm.mjs —— 從本機 OSM 抽取檔（.osm.pbf）萃取建表所需元素
 * ============================================================================
 * 為什麼要有這一步：
 *   Overpass 公開實例只有 2 個併發槽，補方向地標需要上百次查詢，實測會被
 *   429 與連線中斷反覆打斷（一次完整建表跑了 20 分鐘還沒跑完）。
 *   改用 Geofabrik 的區域抽取檔在本機解析——**完全沒有限流**，可以任意重跑，
 *   而且能一次看到所有標籤，不必事先猜要查什麼。
 *
 * 用法：
 *   node scripts/extract-osm.mjs <input.osm.pbf> <output.json>
 *   node scripts/extract-osm.mjs taiwan.osm.pbf tw.json --survey
 *
 * 輸出格式刻意與 Overpass 的 `out tags geom` 相容
 * （`{type,id,lat,lon,tags}` 與 `{type,id,tags,geometry}`），
 * 這樣 build-venues.mjs 可以無差別地吃兩種來源。
 *
 * 記憶體策略（這台機器只有 ~2.4GB 可用）：分兩趟讀檔
 *   第一趟：只抓有目標標籤的 POI（出入口、車站、地下街、地下停車場）——資料量小
 *   第二趟：只抓「落在第一趟找到的場域周邊」的節點座標，再組出有名街道的幾何
 *   直接把全台 2000 萬個節點載進記憶體是不可行的，所以先用第一趟的結果縮範圍。
 */

import { createReadStream, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const parseOSM = require('osm-pbf-parser');
// through2 的新版把 API 掛在 default 底下（CJS/ESM 互通的產物）
const through2 = require('through2');
const through = through2.obj ? through2 : through2.default;

const [, , INPUT, OUTPUT, ...FLAGS] = process.argv;
if (!INPUT || !OUTPUT) {
  console.error('用法：node scripts/extract-osm.mjs <input.osm.pbf> <output.json> [--survey]');
  process.exit(1);
}
const SURVEY = FLAGS.includes('--survey');

/**
 * 關注網格的邊長（度）。0.002° ≈ 220m；連同 8 個鄰格，每個 POI 周邊
 * 至少涵蓋 220m——遠超過我們需要的 70m 街道搜尋半徑。
 *
 * ⚠️ 這個值不能放大：初版用 0.01°（1.1km）加鄰格，等於每個 POI 涵蓋 3km 見方，
 * 在關西那種密集都會區會讓節點數超過 JS Map 的 1670 萬上限而直接崩潰。
 */
const CELL_DEG = 0.002;

/**
 * 座標打包：把 (lat, lon) 壓成單一 Number，省掉每個節點一個物件的配置。
 * 1e5 的尺度約等於 1.1m 精度——我們是在算 70m 級距的街道距離，綽綽有餘。
 * 位元預算：lat*1e5 需 24 bits、lon*1e5 需 25 bits，合計 49 < 53（Number 安全整數）。
 */
const LON_SPAN = 36_000_001;
const packCoord = (lat, lon) =>
  (Math.round(lat * 1e5) + 9_000_000) * LON_SPAN + (Math.round(lon * 1e5) + 18_000_000);
const unpackCoord = (v) => ({
  lat: (Math.floor(v / LON_SPAN) - 9_000_000) / 1e5,
  lon: ((v % LON_SPAN) - 18_000_000) / 1e5,
});

/** 願意當作方向指引的道路類別 */
const ROAD_CLASSES = new Set([
  'trunk', 'primary', 'secondary', 'tertiary', 'pedestrian', 'residential', 'living_street',
]);

/** 地下商場的命名樣式：台灣「地下街」、日本「地下街 / 地下センター」 */
const UNDERGROUND_RE = /地下街|地下センター|地下商店街/;

/**
 * 有地下樓層的公眾零售場所（百貨、購物中心）。
 *
 * 這是使用者指出的缺口：百貨的 B1/B2 美食街是典型的地下人潮空間，
 * 而且 2025 年台北無差別攻擊的最後一站就是誠品生活南西店。
 *
 * OSM 的 `building:levels:underground` 直接告訴我們有幾層地下——全台實測
 * 1724 個元素帶這個標籤，其中公眾零售場所 35 個（新光三越 B6、京站 B6、
 * 遠東SOGO B4…）。數量不多，但正好是最關鍵的那些。
 *
 * ⚠️ 只有 7.6% 的地下建物標了出入口節點，所以這一類只能做到**場域層級**，
 * 沒有出口級定位與疏散路線。誠實標記，不假裝有。
 */
const RETAIL_KINDS = new Set(['department_store', 'mall', 'supermarket']);
const undergroundLevels = (t = {}) => Number(t['building:levels:underground'] ?? 0);
const isUndergroundRetail = (t = {}) =>
  Boolean(t.name) &&
  undergroundLevels(t) >= 1 &&
  (RETAIL_KINDS.has(t.shop) || t.building === 'retail' || t.amenity === 'marketplace');

// ---------------------------------------------------------------------------

function isPoi(tags = {}) {
  if (tags.railway === 'subway_entrance') return true;
  if (tags.railway === 'station' && tags.station === 'subway') return true;
  if (tags.railway === 'train_station_entrance') return true;
  if (UNDERGROUND_RE.test(tags.name ?? '')) return true;
  if (tags.amenity === 'parking' && (tags.parking === 'underground' || tags.location === 'underground')) return true;
  if (isUndergroundRetail(tags)) return true;
  return false;
}

/** 串流讀一次檔案，對每個元素呼叫 handler */
function scan(file, handler) {
  return new Promise((resolve, reject) => {
    createReadStream(file)
      .pipe(parseOSM())
      .pipe(through.obj((items, _enc, next) => {
        for (const item of items) handler(item);
        next();
      }))
      .on('finish', resolve)
      .on('error', reject);
  });
}

/** way / relation 的代表座標（用已知節點的平均，Overpass 的 center 等價物） */
function centerOf(refs, nodeCoords) {
  let sx = 0; let sy = 0; let n = 0;
  for (const r of refs) {
    const packed = nodeCoords.get(r);
    if (packed === undefined) continue;
    const c = unpackCoord(packed);
    sx += c.lon; sy += c.lat; n++;
  }
  return n > 0 ? { lat: sy / n, lon: sx / n } : null;
}

async function main() {
  const t0 = Date.now();

  // ===== 第一趟：POI（小量，直接全收） =====
  console.log(`[extract] 第一趟：掃描 POI … ${INPUT}`);
  const poiNodes = [];
  const poiWays = [];      // 地下街/停車場有時是面（way）
  const wayRefsNeeded = new Set(); // 這些 way 需要節點座標才能算中心
  const tagSurvey = new Map();

  await scan(INPUT, (item) => {
    if (item.type === 'node' && isPoi(item.tags)) {
      poiNodes.push({ type: 'node', id: item.id, lat: item.lat, lon: item.lon, tags: item.tags });
      if (SURVEY) for (const k of Object.keys(item.tags)) tagSurvey.set(k, (tagSurvey.get(k) ?? 0) + 1);
    } else if (item.type === 'way' && isPoi(item.tags)) {
      poiWays.push({ type: 'way', id: item.id, tags: item.tags, refs: item.refs });
      for (const r of item.refs) wayRefsNeeded.add(r);
    }
  });
  console.log(`  POI 節點 ${poiNodes.length}、POI 面 ${poiWays.length}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);

  // ===== 依 POI 位置圈出關注區域（縮小第二趟的範圍） =====
  // 網格粗篩比逐一比對 bbox 快得多
  const cells = new Set();
  const cellKey = (lat, lon) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;
  for (const n of poiNodes) {
    for (const dLat of [-CELL_DEG, 0, CELL_DEG]) {
      for (const dLon of [-CELL_DEG, 0, CELL_DEG]) cells.add(cellKey(n.lat + dLat, n.lon + dLon));
    }
  }
  const cellKm2 = (CELL_DEG * 111) ** 2;
  console.log(`  關注網格 ${cells.size} 格（約 ${(cells.size * cellKm2).toFixed(0)} km²）`);

  const inArea = (lat, lon) => cells.has(cellKey(lat, lon));

  // ===== 第二趟：關注區域內的節點座標 + 有名街道 =====
  console.log('[extract] 第二趟：抓取關注區域的節點座標與街道 …');
  const nodeCoords = new Map();
  const streetWays = [];

  await scan(INPUT, (item) => {
    if (item.type === 'node') {
      if (wayRefsNeeded.has(item.id) || inArea(item.lat, item.lon)) {
        nodeCoords.set(item.id, packCoord(item.lat, item.lon));
      }
    } else if (item.type === 'way') {
      const t = item.tags ?? {};
      if (!t.name || !ROAD_CLASSES.has(t.highway)) return;
      // 只保留至少有一個節點落在關注區域的街道
      if (!item.refs.some((r) => nodeCoords.has(r))) return;
      streetWays.push({ type: 'way', id: item.id, tags: t, refs: item.refs });
    }
  });
  console.log(`  節點座標 ${nodeCoords.size}、候選街道 ${streetWays.length}（${((Date.now() - t0) / 1000).toFixed(0)}s）`);

  // ===== 組裝成 Overpass 相容格式 =====
  const elements = [...poiNodes];

  for (const w of poiWays) {
    const c = centerOf(w.refs, nodeCoords);
    if (c) elements.push({ type: 'way', id: w.id, tags: w.tags, center: c });
  }

  const streets = [];
  for (const w of streetWays) {
    const geometry = w.refs
      .map((r) => nodeCoords.get(r))
      .filter((v) => v !== undefined)
      .map(unpackCoord);
    if (geometry.length >= 2) streets.push({ type: 'way', id: w.id, tags: w.tags, geometry });
  }

  const out = {
    source: INPUT,
    generatedAt: new Date().toISOString(),
    elements,   // 與 Overpass `out tags center` 同形
    streets,    // 與 Overpass `out tags geom` 同形
  };
  writeFileSync(OUTPUT, JSON.stringify(out));

  console.log(`[extract] 完成：${elements.length} 個 POI、${streets.length} 條街道 → ${OUTPUT}`);
  console.log(`  耗時 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  if (SURVEY) {
    console.log('\n[extract] POI 標籤出現頻率（找還沒用到的資料）：');
    [...tagSurvey.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .forEach(([k, v]) => console.log(`  ${String(v).padStart(6)}  ${k}`));
  }
}

main().catch((err) => {
  console.error('[extract] 失敗：', err);
  process.exit(1);
});
