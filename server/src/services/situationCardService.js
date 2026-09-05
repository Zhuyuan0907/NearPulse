/**
 * ============================================================================
 * situationCard —— 態勢卡產生器（確定性、無 AI 依賴）
 * ============================================================================
 * 設計原則的落實：
 *   1. 卡片內容完全由事件結構化資料 + 模板建議文字組成——
 *      AI pipeline 全掛掉時這條路徑依然完整可用（降級路徑即主路徑）
 *   2. 每次批次結束後重算一次，之後 GET /api/situation 直接回快取
 *      + ETag 比對 → 未變動一律 304，符合「極輕量讀取」原則
 *   3. candidate 事件以「徵詢中」區塊呈現（未經確認標記），
 *      這是 Web Push 尚未接入前的替代徵詢通道
 */

import { config } from '../config.js';
import { countIndependentPositives } from '../pipeline/cluster.js';
import { getAdvice } from '../pipeline/advisors/llm.js';
import { toEventSummary } from './eventService.js';
import { distanceM, findVenue, nearbyVenues } from './venueService.js';
import { evacuationPlan } from './evacuationService.js';
import { arrivalForecast, wheelchairCarsAt } from './trainService.js';

/** 事件在列車上時的到站預告；其餘情況一律 null */
function arrivalOf(ev, now) {
  if (!ev.onTrain || !ev.nextVenueId) return null;
  const f = arrivalForecast({
    fromVenueId: ev.stationId,
    nextVenueId: ev.nextVenueId,
    departedAt: ev.departedAt,
    now,
  });
  // 刻意剝掉 etaSec：卡片裡不放隨時間變動的值，否則每次輪詢都會是新的 ETag。
  // client 用 arriveAt 自行倒數（見 trainService.arrivalForecast 的說明）。
  if (!f) return null;
  const { etaSec, ...stable } = f;
  return {
    ...stable,
    // 官方唯一公開的車廂級資訊。輪椅使用者在車上時，這是他實際所在的位置，
    // 也是站務人員知道要去哪裡接應的位置。
    wheelchairCars: wheelchairCarsAt(f.venueId),
  };
}

/** 威脅等級映射：active 依類型嚴重度、candidate 一律 unverified */
function threatLevelOf(event) {
  if (event.status !== 'active') return 'unverified';
  return config.eventTypes[event.type]?.severity ?? 'low';
}

/**
 * 由事件列表建構態勢卡 JSON。
 * @returns {card, etag, bytes}
 */
export function buildSituationCard(events, now = Date.now()) {
  const visible = events.filter(
    (ev) => ev.status === 'active' || ev.status === 'candidate'
  );

  // ---- 依站點分組（卡片以站點為單位組織） ----
  const byStation = new Map();
  for (const ev of visible) {
    if (!byStation.has(ev.stationId)) {
      byStation.set(ev.stationId, {
        stationId: ev.stationId,
        stationName: ev.stationName,
        // 場域類型：地下場域不只有捷運站，還有地下街與地下停車場
        kind: findVenue(ev.stationId)?.kind ?? null,
        events: [],
      });
    }
    byStation.get(ev.stationId).events.push({
      ...toEventSummary(ev),
      threatLevel: threatLevelOf(ev),
      // 有人無法自行疏散——這是給救援方的最高優先資訊
      assistanceReports: ev.assistanceReports ?? 0,
      independentSignals: countIndependentPositives(ev),
      advice: getAdvice(ev.type, ev.status),
      // 疏散向量在這裡就算好寫進卡片——與 advice 同一條路徑。
      // client 不持有圖資也不做幾何運算，只負責顯示。
      // 無出口圖資的場域回 null，UI 退回通用建議文字。
      // **結構化**的疏散計畫，不是一整段散文——恐慌情境下眼睛需要可掃視的結構。
      // 散文只在語音播報時由 client 從結構組出來。
      plan: evacuationPlan({
        venueId: ev.stationId, nearExitCode: ev.nearExitCode,
        point: ev.incidentPoint, motion: ev.motion, incidentType: ev.type,
        onTrain: ev.onTrain,
      }),
      // 無障礙版一起預算進卡片：讀取端切換時不必再發請求，離線也能用
      planStepFree: evacuationPlan({
        venueId: ev.stationId, nearExitCode: ev.nearExitCode,
        point: ev.incidentPoint, motion: ev.motion, incidentType: ev.type,
        onTrain: ev.onTrain, mobility: 'stepFree',
      }),
      /**
       * 到站預告（僅事件在列車上時）。這是車廂內唯一有意義的「進度」——
       * 沒有出口可去，只有「還要撐多久門才會開」。
       * 查不到（沒指認下一站、或兩站不相鄰）就是 null，UI 直接不顯示。
       */
      arrival: arrivalOf(ev, now),
    });
  }

  /**
   * 鄰近場域警示。
   *
   * 事件是以場域為單位聚合的，所以攻擊者移動到下一個場域時會成為
   * 「另一起事件」——但下一個場域的人**現在**就該知道。
   * 2025 年那起攻擊從台北車站移動到中山站（約 800m）再到誠品生活南西店。
   *
   * 這裡**不合併事件**（誤併兩起獨立事件的代價太高），只是把警示擴散出去：
   * 「附近 800 公尺的台北車站有進行中的攻擊事件」。
   * 只對高嚴重度且已確認的事件這麼做——candidate 還沒驗證過，
   * 擴散未經確認的警示會製造恐慌。
   */
  const candidates = [];
  const alerted = new Set();
  for (const ev of visible) {
    if (ev.status !== 'active') continue;
    if ((config.eventTypes[ev.type]?.severity ?? 'low') !== 'high') continue;
    const origin = findVenue(ev.stationId);
    if (!origin) continue;
    for (const near of nearbyVenues(origin.lat, origin.lon, {
      radiusM: config.nearbyAlertRadiusM, limit: 6,
    })) {
      if (near.id === origin.id || byStation.has(near.id) || alerted.has(near.id)) continue;
      alerted.add(near.id);
      // nearbyVenues 的摘要形狀刻意不帶座標（那是給選單用的），
      // 但「同一個實體地點」的判斷需要座標——回頭查一次完整場域。
      const full = findVenue(near.id);
      candidates.push({
        venueId: near.id,
        venueName: near.name,
        kind: near.kind,
        lat: full?.lat ?? null,
        lon: full?.lon ?? null,
        distanceM: near.distanceM,
        fromVenue: origin.name,
        typeLabel: config.eventTypes[ev.type]?.label ?? ev.type,
        moving: Boolean(ev.motion?.moving),
      });
    }
  }

  /**
   * 收斂鄰近警示。
   *
   * 【為什麼要收斂】實測台北車站一起火警就產出 11 則鄰近警示，把真正的事件
   * 擠到畫面很下面——這正是使用者說的「文字太亂、看不出重點」。
   * 一個警示清單長到要捲三次，等於沒有警示。
   *
   * 三道規則，都是為了「同樣的版面放更有用的東西」：
   *
   *   1. **同一個實體地點只留一則**。「臺北車站K區地下街」「K區地下街」
   *      「K區地下街停車場」在 OSM 是三個節點，實際上是同一條地下街，
   *      彼此相距不到 5 公尺。對讀的人來說那是同一件事講三次。
   *   2. **人多的地方優先**。地下街、捷運站、百貨是人群聚集處；地下停車場
   *      多半是過路的少數人，而且沒有出口圖資、給不出任何可執行的指引。
   *      名額有限時先給前者。
   *   3. **總數上限**。看得完才叫警示。
   */
  const SAME_PLACE_M = 60;
  /**
   * 名稱包含關係 → 同一個地點。
   *
   * 「臺北車站K區地下街」與「K區地下街」在 OSM 是相距 76 公尺的兩個節點，
   * 但那是同一條地下街被標了兩次——地下街本來就長，光靠距離門檻分不出
   * 「同一條街的兩端」與「兩條不同的街」。名稱包含是這類重複標註的典型特徵，
   * 而且比把距離門檻拉大安全：後者會誤併真正不同的場域。
   */
  const samePlaceByName = (a, b) =>
    a.venueName.includes(b.venueName) || b.venueName.includes(a.venueName);
  const KIND_PRIORITY = { underground: 0, metro: 1, retail: 2, parking: 3 };
  const MAX_NEARBY_ALERTS = 5;
  /**
   * 地下停車場的名額上限。它們在 OSM 極密集（台北車站 1.2km 內就有十幾個），
   * 但只有場域層級的資料——沒有出口、沒有樓層，給不出任何可執行的指引，
   * 而且裡面多半是過路的少數人。留一個名額表示「這個方向也受影響」就夠了，
   * 其餘名額留給人群真正聚集的地下街、車站與百貨。
   */
  const MAX_PARKING_ALERTS = 1;

  const nearbyAlerts = [];
  for (const c of candidates.sort((a, b) =>
    (KIND_PRIORITY[a.kind] ?? 9) - (KIND_PRIORITY[b.kind] ?? 9) || a.distanceM - b.distanceM
  )) {
    if (nearbyAlerts.length >= MAX_NEARBY_ALERTS) break;
    if (c.kind === 'parking'
      && nearbyAlerts.filter((a) => a.kind === 'parking').length >= MAX_PARKING_ALERTS) continue;
    const duplicate = nearbyAlerts.some(
      (a) => samePlaceByName(a, c)
        || (Number.isFinite(a.lat) && Number.isFinite(c.lat)
          && distanceM(a, c) <= SAME_PLACE_M)
    );
    if (duplicate) continue;
    nearbyAlerts.push(c);
  }
  // 呈現時仍以距離排序：讀的人在意的是「離我多近」，不是我們的挑選邏輯。
  // 座標只是挑選過程的中間值，不送到 client——卡片的每個位元組都要有用途。
  nearbyAlerts.sort((a, b) => a.distanceM - b.distanceM);
  for (const a of nearbyAlerts) { delete a.lat; delete a.lon; }

  /**
   * 到站警示 —— 通知下一站的人「這班車上有事」。
   *
   * 這是整個列車情境真正的價值所在。車廂裡的人做不了什麼；能改變結果的是
   * **月台上的人**：門一開就讓開，不要照平常擠著上車，把動線讓出來。
   * 2014 年鄭捷案裡，車廂內的四分鐘無人知情；下一站的月台也一樣毫無準備。
   *
   * 刻意的克制：
   *   - 只對 active 的高嚴重度事件發出。未經確認的通報擴散到整座月台，
   *     製造的推擠風險可能大過它避免的風險。
   *   - 不猜車廂編號。北捷未公開車廂與樓梯／出口的對應關係，
   *     「往第 3 節走」這種建議在錯的時候會把人推向危險。
   *   - 到站後（arrived）仍保留警示，因為疏散不會在開門那一刻結束。
   */
  const inboundAlerts = [];
  for (const group of byStation.values()) {
    for (const ev of group.events) {
      if (!ev.arrival || ev.status !== 'active') continue;
      if ((config.eventTypes[ev.type]?.severity ?? 'low') !== 'high') continue;
      inboundAlerts.push({
        venueId: ev.arrival.venueId,
        venueName: ev.arrival.name,
        lineNo: ev.arrival.lineNo,
        towards: ev.arrival.towards,
        fromVenue: group.stationName,
        typeLabel: ev.typeLabel,
        arriveAt: ev.arrival.arriveAt,
        runSec: ev.arrival.runSec,
        estimated: ev.arrival.estimated,
      });
    }
  }

  const card = {
    generatedAt: now,
    /** 事故列車即將抵達的車站警示（月台上的人是能改變結果的那群人） */
    inboundAlerts,
    /** 鄰近場域警示：事件不在你這裡，但離得夠近，你該知道 */
    nearbyAlerts,
    /** 經確認的事件（警示區塊） */
    stations: [...byStation.values()],
    /** 徵詢中的未確認回報（低調語氣區塊——未來由 Web Push 承接） */
    pending: visible
      .filter((ev) => ev.status === 'candidate')
      .map((ev) => ({
        eventId: ev.id,
        typeLabel: config.eventTypes[ev.type]?.label ?? ev.type,
        stationId: ev.stationId,
        stationName: ev.stationName,
        reportedAt: ev.createdAt,
        message: `附近有人回報【${config.eventTypes[ev.type]?.label ?? ev.type}】，您在現場嗎？`,
      })),
  };

  const json = JSON.stringify(card);
  const etag = `"${hashString(json)}"`;
  const bytes = Buffer.byteLength(json);

  return { card, etag, bytes };
}

/** 輕量字串雜湊（態勢卡 ETag 用；非密碼學用途，FNV-1a 足夠且極快） */
function hashString(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash.toString(16);
}
