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
import { evacuationLine } from './evacuationService.js';

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
        events: [],
      });
    }
    byStation.get(ev.stationId).events.push({
      ...toEventSummary(ev),
      threatLevel: threatLevelOf(ev),
      independentSignals: countIndependentPositives(ev),
      advice: getAdvice(ev.type, ev.status),
      // 疏散向量在這裡就算好寫進卡片——與 advice 同一條路徑。
      // client 不持有圖資也不做幾何運算，只負責顯示。
      // 無出口圖資的場域回 null，UI 退回通用建議文字。
      evacuation: evacuationLine(ev.stationId, ev.nearExitCode, ev.incidentPoint),
    });
  }

  const card = {
    generatedAt: now,
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
