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
import { findVenue, nearbyVenues } from './venueService.js';
import { evacuationPlan } from './evacuationService.js';

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
  const nearbyAlerts = [];
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
      nearbyAlerts.push({
        venueId: near.id,
        venueName: near.name,
        kind: near.kind,
        distanceM: near.distanceM,
        fromVenue: origin.name,
        typeLabel: config.eventTypes[ev.type]?.label ?? ev.type,
        moving: Boolean(ev.motion?.moving),
      });
    }
  }

  const card = {
    generatedAt: now,
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
