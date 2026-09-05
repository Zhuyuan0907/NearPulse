#!/usr/bin/env node
/**
 * ============================================================================
 * fetch-trtc-open.mjs —— 台北捷運政府開放資料（離線執行）
 * ============================================================================
 * 【為什麼需要這一份，TDX 還不夠嗎】
 * 使用者問過一個很好的問題：「哪一節車廂離樓梯／電梯近？」
 * 日本的乗換案内類 App 確實有這功能，所以直覺上台灣也該有。
 *
 * 查證後的結論是**沒有開放資料**，三邊都查過：
 *   - 日本 ODPT / 東京メトロ / JR東：沒有。Yahoo!、ジョルダン 的「何号車が便利」
 *     是向「株式会社ナビット」**購買**的人工實地調查資料（ジョルダン 2022-09-30
 *     新聞稿明載），不是開放資料。
 *   - 台灣 TDX：整份 spec 沒有「月台門」「車廂位置」任何欄位。
 *   - OSM：`railway:platform:section`（歐洲的月台分區標籤）全台灣 0 筆。
 *   - 台北捷運Go App 確實有此功能（2024-07-14 北市府新聞稿），
 *     但資料不在 30 個開放 dataset 也不在 TDX，需另行申請北捷 API。
 *
 * **但有一個能立刻用、而且直接有用的官方欄位**：`Doors_Open_Side`。
 * 知道下一站往哪一側開門，車廂裡的人就能在到站前先移動到正確的那一側——
 * 這對「門一開就要出得去」的情境，價值不亞於知道第幾節車廂。
 *
 * 順帶取 `Reserved_Spaces_for_Wheelchairs`：輪椅席在第幾節車廂。
 * 這是**唯一**官方公開的車廂級資訊，對無障礙疏散直接有用。
 *
 * 資料來源：政府資料開放平臺 dataset 128416「臺北捷運車站無障礙設施資料」
 *   https://data.gov.tw/dataset/128416
 * 授權：政府資料開放授權條款第 1 版
 *
 * 用法：
 *   node scripts/fetch-trtc-open.mjs                 # 線上抓取
 *   node scripts/fetch-trtc-open.mjs --from acc.csv  # 用已下載的 CSV
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/data/trtc-open.json');

const CSV_URL = 'https://data.taipei/api/dataset/3c799405-4e44-40dd-b747-daed09e88cdb'
  + '/resource/5d45ef49-d60d-4354-b634-8dcf7d28da07/download';

/** ⚠️ 這份 CSV 是 **Big5**，不是 UTF-8。用 utf-8 讀會整份變亂碼。 */
const CSV_ENCODING = 'big5';

/** 線名 → 路線代碼（與 TDX 的 LineNo 一致） */
const LINE_CODES = {
  文湖線: 'BR',
  淡水信義線: 'R',
  松山新店線: 'G',
  中和新蘆線: 'O',
  板南線: 'BL',
  環狀線: 'Y',
};

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** 極簡 CSV 解析：支援雙引號包住的欄位（這份資料的敘述欄含逗號） */
function parseCsv(text) {
  const rows = [];
  let row = []; let field = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }

  const header = rows.shift().map((h) => h.trim().replace(/^﻿/, ''));
  return rows
    .filter((r) => r.some((v) => v.trim()))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ---------------------------------------------------------------------------
// 開門側解析
// ---------------------------------------------------------------------------

const sideOf = (text) => {
  const left = text.includes('左側開門');
  const right = text.includes('右側開門');
  if (left && right) return 'both';
  if (left) return 'left';
  if (right) return 'right';
  return null;
};

/**
 * 解析 `Doors_Open_Side`。
 *
 * 【為什麼大多數站不需要標方向】
 * 北捷靠右行駛，所以島式月台對兩個方向都在車頭的左側、側式月台都在右側——
 * 開門側因此與行進方向無關。119 站裡只有 11 站需要標方向（古亭、西門、
 * 東門這類疊式月台或跨月台轉乘站），而**那 11 站資料裡明確寫了**
 *（「往新店-左側開門，往松山-右側開門」）。所以這個解析是安全的：
 * 有寫方向就照方向，沒寫就是兩個方向皆同。
 *
 * 實際出現的五種形態：
 *   左側開門。
 *   左側開門。右側開門。                                （雙側都開）
 *   往新北產業園區-右側開門。往大坪林-左側開門。          （分方向）
 *   【文湖線】右側開門。【松山新店線】左側開門。          （分路線）
 *   【中和新蘆線】往蘆洲、迴龍-左側開門，往南勢角-右側開門。（分路線又分方向）
 *
 * @returns {Array<{line: string|null, towards: string[]|null, side: string}>}
 */
function parseDoorSide(raw) {
  if (!raw) return [];
  const out = [];

  // 先切成「路線區段」。沒有【】就是整串套用到這站的所有路線。
  const segments = raw.includes('【')
    ? [...raw.matchAll(/【(.+?)】([^【]*)/g)].map((m) => ({
      line: LINE_CODES[m[1]] ?? null,
      text: m[2],
    }))
    : [{ line: null, text: raw }];

  for (const seg of segments) {
    // 「往XXX-左側開門」：分方向。終點站名可能有多個（「往蘆洲、迴龍」）。
    const directional = [...seg.text.matchAll(/往([^-—－]+)[-—－]\s*([左右]側開門)/g)];
    if (directional.length > 0) {
      for (const m of directional) {
        out.push({
          line: seg.line,
          towards: m[1].split(/[、,，]/).map((t) => t.trim()).filter(Boolean),
          side: sideOf(m[2]),
        });
      }
      continue;
    }
    const side = sideOf(seg.text);
    if (side) out.push({ line: seg.line, towards: null, side });
  }
  return out;
}

/** 「第1節、第4節車廂」→ [1, 4] */
function parseWheelchairCars(raw) {
  if (!raw) return null;
  const nums = [...raw.matchAll(/第\s*(\d+)\s*節/g)].map((m) => Number(m[1]));
  return nums.length > 0 ? [...new Set(nums)] : null;
}

// ---------------------------------------------------------------------------

async function main() {
  const fromIdx = process.argv.indexOf('--from');
  const fromPath = fromIdx >= 0 ? process.argv[fromIdx + 1] : null;

  let buf;
  if (fromPath) {
    console.log(`[trtc] 由本機檔案建快照：${fromPath}`);
    buf = readFileSync(fromPath);
  } else {
    console.log('[trtc] 下載 dataset 128416「臺北捷運車站無障礙設施資料」…');
    const res = await fetch(CSV_URL, {
      headers: { 'User-Agent': 'NearPulse/0.8 (underground incident reporting; snapshot builder)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }

  const rows = parseCsv(new TextDecoder(CSV_ENCODING).decode(buf));

  const stations = {};
  for (const r of rows) {
    // Station_Number 可能是「BR11/G16」這種轉乘站的多代碼
    const codes = (r.Station_Number ?? '').split('/').map((c) => c.trim()).filter(Boolean);
    const doorSide = parseDoorSide(r.Doors_Open_Side);
    const wheelchairCars = parseWheelchairCars(r.Reserved_Spaces_for_Wheelchairs);
    for (const code of codes) {
      stations[code] = {
        name: r.Station_Name,
        underground: r.Station_Form?.includes('地下') ?? false,
        doorSide,
        wheelchairCars,
      };
    }
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: '政府資料開放平臺 dataset 128416「臺北捷運車站無障礙設施資料」',
    license: '政府資料開放授權條款第 1 版',
    stations,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot, null, 1));

  const list = Object.values(stations);
  const withSide = list.filter((s) => s.doorSide.length > 0);
  const directional = list.filter((s) => s.doorSide.some((d) => d.towards));
  const withCars = list.filter((s) => s.wheelchairCars);

  console.log(`[trtc] 車站 ${rows.length} 筆（含轉乘代碼共 ${list.length} 個代碼）`);
  console.log(`  有開門側資訊    ${withSide.length}`);
  console.log(`  其中需分方向    ${directional.length}（疊式月台／跨月台轉乘）`);
  console.log(`  有輪椅席車廂    ${withCars.length}`);
  console.log('    ↑ 這是唯一官方公開的車廂級資訊——車廂↔出口對應並未開放');
  console.log(`  檔案            ${OUT_PATH}`);
}

main().catch((err) => {
  console.error('[trtc] 失敗：', err.message);
  process.exit(1);
});
