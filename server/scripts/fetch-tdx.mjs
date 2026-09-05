#!/usr/bin/env node
/**
 * ============================================================================
 * fetch-tdx.mjs —— 抓取交通部 TDX 的台北捷運官方資料（離線執行）
 * ============================================================================
 * 【為什麼要有這一份，OSM 還不夠嗎】
 * OSM 的出口資料是志工標的，無障礙資訊只覆蓋 42%。TDX 是交通部的官方平台，
 * 台北捷運的 437 個出口**每一個**都帶著設施旗標：
 *
 *   Stair / Escalator / Elevator  —— 有沒有樓梯、幾座電扶梯、有沒有電梯
 *   LocationDescription           —— 官方的方位描述（「中央路4段約100號旁」）
 *
 * 這讓無障礙疏散從「42% 覆蓋的推測」變成「100% 覆蓋的官方事實」。
 *
 * 順帶抓 S2STravelTime：真實的站間行車秒數（中位數 92 秒），
 * 這是「通知下一站」功能唯一可信的時間來源——不是估的。
 *
 * 【額度】
 * TDX 訪客（未登入）每日 20 次基礎資料查詢。我們只抓 4 次並存成快照，
 * server 執行時完全不碰它——與 OSM 快照同一個模式。
 *
 * 用法：
 *   node scripts/fetch-tdx.mjs                  # 線上抓取
 *   node scripts/fetch-tdx.mjs --from /tmp/tdx  # 用已下載的檔案建快照
 *
 * `--from` 存在的理由很實際：訪客配額只有每日 20 次，開發過程很容易用完。
 * 先用 curl 抓下來、再離線建表，比反覆撞配額有效率。
 *
 * 資料來源：交通部運輸資料流通服務平臺（TDX），依其開放資料條款使用。
 */

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(__dirname, '../src/data/tdx-trtc.json');

const BASE = 'https://tdx.transportdata.tw/api/basic/v2/Rail/Metro';
const OPERATOR = 'TRTC';

/**
 * ⚠️ 查詢字串裡的 `$` **不能** URL 編碼成 `%24`——實測會被閘道判為無效請求
 * 而回 401（訪客配額不生效）。這是踩過的坑，別再改。
 */
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

async function get(dataset) {
  const url = `${BASE}/${dataset}/${OPERATOR}?$format=JSON`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'NearPulse/0.7 (underground incident reporting; snapshot builder)',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`${dataset}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const fromIdx = process.argv.indexOf('--from');
  const fromDir = fromIdx >= 0 ? process.argv[fromIdx + 1] : null;

  let exits; let stations; let travelTimes; let routes;

  if (fromDir) {
    console.log(`[tdx] 由本機檔案建快照：${fromDir}`);
    const load = (f) => JSON.parse(readFileSync(`${fromDir}/${f}`, 'utf8'));
    exits = load('exits.json');
    stations = load('station.json');
    travelTimes = load('s2s.json');
    routes = load('route.json');
  } else {
    console.log('[tdx] 抓取台北捷運官方資料…（訪客配額每日 20 次，這裡用 3 次）');
    // 循序抓取並留間隔：並行會觸發訪客配額限制（實測 401）。
    // 刻意不抓 StationFacility——實測它的 Elevators/Toilets 全是空陣列，
    // 真正有用的設施旗標其實在 StationExit 裡（Stair/Escalator/Elevator）。
    exits = await get('StationExit');
    await sleep(1.5);
    stations = await get('Station');
    await sleep(1.5);
    travelTimes = await get('S2STravelTime');
    await sleep(1.5);
    routes = await get('StationOfRoute');
  }

  const snapshot = {
    generatedAt: new Date().toISOString(),
    source: '交通部運輸資料流通服務平臺（TDX）',
    operator: OPERATOR,
    exits,
    stations,
    travelTimes,
    /** 有方向的站序（BL-1 頂埔→南港展覽館 與 南港展覽館→頂埔 是兩筆） */
    routes,
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(snapshot));

  const withLift = exits.filter((e) => e.Elevator).length;
  const stepFreeNoStair = exits.filter((e) => e.Elevator && !e.Stair).length;
  const segments = travelTimes.reduce((n, r) => n + (r.TravelTimes?.length ?? 0), 0);

  console.log(`[tdx] 出口 ${exits.length}、車站 ${stations.length}`);
  console.log(`  有電梯          ${withLift} / ${exits.length}（${Math.round((withLift / exits.length) * 100)}%）`);
  console.log(`  有電梯且無樓梯  ${stepFreeNoStair}（${((stepFreeNoStair / exits.length) * 100).toFixed(1)}%）`);
  console.log('    ↑ 火災時電梯不可用，這是輪椅使用者唯一可能的選項');
  console.log(`  站間行車時間    ${travelTimes.length} 條路線、${segments} 段`);
  console.log(`  有方向的站序    ${routes.length} 條路線（下一站推算的依據）`);
  console.log(`  檔案            ${OUT_PATH}（${(JSON.stringify(snapshot).length / 1024).toFixed(0)} KB）`);
}

main().catch((err) => {
  console.error('[tdx] 失敗：', err.message);
  process.exit(1);
});
