/**
 * ============================================================================
 * 記憶體儲存實作（MVP）
 * ============================================================================
 * 以 Map / Array 保存所有資料。非持久化、非分散式，但完整實作 store 介面，
 * 讓整條資料流（ingest → batch → state machine → situation card）可獨立跑通。
 *
 * 這層刻意不含任何業務邏輯（門檻、狀態轉移都不在這裡），
 * 只負責「存」與「取」——業務邏輯全部在 pipeline 層，方便測試與替換。
 */

export function createMemoryStore() {
  /** 已見過的回報 UUID → 冪等去重（同一 UUID 重送不重複處理） */
  const seenReportUuids = new Map(); // uuid -> { result }（第一次處理的結果）

  /** 待批次處理的回報佇列（對應架構中的 Redis Stream 角色） */
  let pendingReports = [];

  /** 所有事件：id -> event 物件 */
  const events = new Map();

  /** 態勢卡快取 + 髒標記（事件變動時置髒，worker 重算） */
  let cardCache = null;
  let cardDirty = true;

  return {
    /**
     * 冪等寫入一筆回報。
     * @returns {newReport: boolean, previousResult?: object}
     *          如果 UUID 已存在，回傳第一次的處理結果（冪等回應）。
     */
    ingestReport(report) {
      if (seenReportUuids.has(report.uuid)) {
        return { newReport: false, previousResult: seenReportUuids.get(report.uuid).result };
      }
      pendingReports.push(report);
      return { newReport: true };
    },

    /** 記住某 UUID 的處理結果，之後重送直接回覆同一份結果 */
    rememberReportResult(uuid, result) {
      seenReportUuids.set(uuid, { result });
    },

    /** 批次 worker 領走全部待處理回報（清空佇列） */
    drainPendingReports() {
      const drained = pendingReports;
      pendingReports = [];
      return drained;
    },

    upsertEvent(event) {
      events.set(event.id, event);
    },

    getEvent(id) {
      return events.get(id) ?? null;
    },

    listEvents() {
      return [...events.values()];
    },

    // ---- 態勢卡快取 ----
    markCardDirty() { cardDirty = true; },
    isCardDirty() { return cardDirty; },
    setCard(card) {
      cardCache = card;
      cardDirty = false;
    },
    getCard() { return cardCache; },
  };
}
