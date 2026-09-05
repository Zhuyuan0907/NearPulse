/**
 * ============================================================================
 * trainService —— 行進中列車：下一站推算與到站預告
 * ============================================================================
 * 【要解決的問題】
 * 2014 年鄭捷案發生在**行駛中的板南線列車上**。從江子翠站發車到停妥開門，
 * 車廂內的人被關在一個封閉空間裡約 4 分鐘。那 4 分鐘裡，站內的人不知道
 * 即將進站的是什麼；車上的人也沒有任何「出口」可去。
 *
 * 這個模組只回答兩個問題，兩個都必須有官方資料才回答：
 *
 *   1. 這班車下一站是哪裡、大約多久到？
 *      → TDX StationOfRoute（有方向站序）+ S2STravelTime（官方行車秒數）
 *
 *   2. 下一站的人現在該知道什麼？
 *      → 產生一則「即將到站」預告，讓月台上的人**讓出車門與動線**，
 *        而不是照平常一樣擠著上車。車廂裡的人才出得來。
 *
 * 【為什麼不問使用者「往哪個方向」】
 * 恐慌中「方向」是抽象問題（南港展覽館方向？往東？上行？）。
 * 改問「下一站是哪一站」——那是車廂顯示器正在跑的字、廣播正在唸的詞，
 * 抬頭就能回答。而在捷運路網上，「目前站 + 下一站」唯一決定了方向，
 * 所以這個好回答的問題和那個難回答的問題資訊量完全相同。
 *
 * 【誠實的邊界：車廂位置】
 * 使用者問過「哪個車廂離樓梯近」。實測結論是**做不到**：北捷未公開
 * 車廂與出口／樓梯的對應關係（月台門編號 `月台號-車廂號-車門號` 只在
 * 站內實體標示上，不在任何開放資料集裡）。與其猜一個「往第 3 節車廂走」
 * 而把人推向錯的方向，這裡不提供車廂建議——只提供「到站前先移動到車門邊」
 * 這種與車廂編號無關、且一定正確的指引。
 *
 * 資料來源：交通部運輸資料流通服務平臺（TDX），離線快照，執行時不連外。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { venueDisplayName } from './venueService.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 沒有官方行車時間時的保守預設。TDX 全線中位數 92 秒，取整為 90。 */
const FALLBACK_RUN_SEC = 90;

const SIDE_LABEL = { left: '左側', right: '右側', both: '兩側' };

let network = null;
/**
 * venueId → [{ routeIdx, index }]，建一次就好。
 *
 * ⚠️ 存的是 routes 陣列的**位置**，不是 RouteID。TDX 的 `RouteID` 不唯一——
 * 同一條線的兩個方向共用同一個 id（`BL-1` 既是頂埔→南港展覽館，也是
 * 南港展覽館→頂埔）。初版用 RouteID 反查，永遠拿到第一筆（正向），
 * 於是反向路線的站序索引被套到正向路線上，台北車站的下一站跑出了
 * 「國父紀念館」這種隔了五站的答案。
 */
let stationIndex = null;

function load() {
  if (stationIndex) return;
  try {
    const snapshot = JSON.parse(
      readFileSync(resolve(__dirname, '../data/venues.json'), 'utf8')
    );
    network = snapshot.network ?? null;
  } catch {
    network = null;
  }

  stationIndex = new Map();
  (network?.routes ?? []).forEach((route, routeIdx) => {
    route.stations.forEach((venueId, index) => {
      if (!stationIndex.has(venueId)) stationIndex.set(venueId, []);
      stationIndex.get(venueId).push({ routeIdx, index });
    });
  });
}

/** 官方站間秒數；查不到時回保守預設並標記 estimated */
function runTimeSec(fromVenueId, toVenueId) {
  const sec = network?.runTimes?.[`${fromVenueId}|${toVenueId}`];
  if (Number.isFinite(sec)) return { sec, estimated: false };
  // 反向也試一次：同一段軌道兩個方向的行車時間實測差異在數秒內
  const rev = network?.runTimes?.[`${toVenueId}|${fromVenueId}`];
  if (Number.isFinite(rev)) return { sec: rev, estimated: false };
  return { sec: FALLBACK_RUN_SEC, estimated: true };
}

/**
 * 某站、某路線、某方向的開門側。
 *
 * 【這是「哪一節車廂」問題的可行替代】
 * 車廂↔樓梯／出口的對應**沒有任何開放資料**：日本的乗換案内是向
 * 株式会社ナビット 購買人工實測資料；TDX 整份 spec 沒有月台門或車廂欄位；
 * OSM 的 `railway:platform:section` 全台灣 0 筆。台北捷運Go 有此功能但未開放。
 *
 * 但開門側是官方公開的，而且對車廂裡的人同樣可執行：**到站前先移動到
 * 會開門的那一側**，門一開就出得去。它不需要知道車廂編號就成立。
 *
 * 匹配規則：line 為 null 表示該站所有路線皆同；towards 為 null 表示
 * 兩個方向皆同（北捷靠右行駛，島式月台對兩個方向都在左側，所以多數站
 * 確實與方向無關；需要分方向的 16 筆資料裡明確寫了終點站名）。
 */
export function doorSideAt(venueId, lineNo, towards) {
  load();
  const entries = network?.doorSide?.[venueId] ?? [];
  if (entries.length === 0) return null;

  const byLine = entries.filter((e) => !e.line || e.line === lineNo);
  if (byLine.length === 0) return null;

  // 有標方向的優先——那是為了區分同一站不同方向而存在的
  const towardsNames = String(towards ?? '').split('／').filter(Boolean);
  const directional = byLine.find(
    (e) => e.towards?.some((t) => towardsNames.some((n) => n.includes(t) || t.includes(n)))
  );
  const hit = directional ?? byLine.find((e) => !e.towards);
  if (!hit) return null;

  return { side: hit.side, label: SIDE_LABEL[hit.side] ?? null, directional: Boolean(directional) };
}

/** 輪椅席所在的車廂（官方唯一公開的車廂級資訊） */
export function wheelchairCarsAt(venueId) {
  load();
  return network?.wheelchairCars?.[venueId] ?? null;
}

/** 這個場域有沒有路網資料（決定 UI 要不要問「下一站」） */
export function hasNetwork(venueId) {
  load();
  return stationIndex.has(venueId);
}

/**
 * 從某站可能的下一站。
 *
 * 回傳的是**使用者抬頭就能核對的選項**：站名 + 這條線的終點方向。
 * 一般車站會有 2 個（兩個方向各一），轉乘站會多一些。
 *
 * @returns {Array<{venueId, name, lineNo, towards, runSec, estimated}>}
 */
export function nextStations(venueId) {
  load();
  const out = new Map();

  for (const { routeIdx, index } of stationIndex.get(venueId) ?? []) {
    const route = network.routes[routeIdx];
    const nextId = route?.stations[index + 1];
    if (!nextId) continue; // 這條路線在這站就是終點——沒有下一站

    const { sec, estimated } = runTimeSec(venueId, nextId);
    const existing = out.get(nextId);
    // 同一個下一站可能由多條路線抵達（例如區間車與全程車）。
    // 合併成一筆，方向標籤收集起來——使用者看到的仍是「一個下一站」。
    if (existing) {
      if (!existing.towardsAll.includes(route.towards)) {
        existing.towardsAll.push(route.towards);
      }
      continue;
    }
    out.set(nextId, {
      venueId: nextId,
      name: venueDisplayName(nextId),
      lineNo: route.lineNo,
      towards: route.towards,
      towardsAll: [route.towards],
      runSec: sec,
      estimated,
    });
  }

  return [...out.values()].map(({ towardsAll, ...rest }) => ({
    ...rest,
    // 多條路線共用同一個下一站時，方向標籤全列出來（「往南港展覽館／往昆陽」）
    towards: towardsAll.join('／'),
  }));
}

/**
 * 針對一起「事件在列車上」的通報，算出到站預告。
 *
 * @param {object} opts
 * @param {string} opts.fromVenueId  列車剛離開（或事件發生時所在）的站
 * @param {string} opts.nextVenueId  使用者指認的下一站
 * @param {number} opts.departedAt   離站時間（ms）；預設事件建立時間
 * @param {number} opts.now
 * @returns {null | {venueId, name, lineNo, towards, runSec, arriveAt, etaSec, estimated}}
 */
export function arrivalForecast({ fromVenueId, nextVenueId, departedAt, now = Date.now() }) {
  load();
  if (!fromVenueId || !nextVenueId) return null;

  const candidate = nextStations(fromVenueId).find((s) => s.venueId === nextVenueId);
  if (!candidate) return null; // 兩站不相鄰——不是我們能回答的問題，寧可不答

  const departed = departedAt ?? now;

  return {
    ...candidate,
    /**
     * **絕對到站時刻**，不是剩餘秒數。
     *
     * 這個區別很重要：態勢卡靠 ETag 比對達成「沒變動就回 304」，而剩餘秒數
     * 每一秒都不一樣——把它寫進卡片，等於強迫每次輪詢都重傳整張卡，
     * 弱網預算會被這一個欄位吃掉。改放固定時刻後卡片保持位元組相同，
     * 倒數由 client 自己算，順帶還能做到每秒更新而不是每 12 秒跳一次。
     */
    arriveAt: departed + candidate.runSec * 1000,
    /**
     * 下一站的開門側。這是「往哪一側車門移動」的依據——
     * 我們給不出「第幾節車廂」（無開放資料），但給得出「哪一側」，
     * 而後者不需要車廂編號就能執行。
     */
    doorSide: doorSideAt(nextVenueId, candidate.lineNo, candidate.towards),
    etaSec: Math.max(0, candidate.runSec - Math.max(0, Math.round((now - departed) / 1000))),
  };
}

/** 秒數 → 給人看的說法。刻意粗略：資料精度不支持「87 秒」這種講法。 */
export function etaText(etaSec) {
  if (etaSec <= 15) return '即將進站';
  if (etaSec < 60) return `約 ${Math.round(etaSec / 10) * 10} 秒後進站`;
  return `約 ${Math.round(etaSec / 30) * 0.5} 分鐘後進站`;
}

export function networkMeta() {
  load();
  return network
    ? { source: network.source, routes: network.routes.length, available: true }
    : { available: false };
}
