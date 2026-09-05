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

import { config } from '../config.js';

export function createMemoryStore() {
  /** 已見過的回報 UUID → 冪等去重（同一 UUID 重送不重複處理） */
  const seenReportUuids = new Map(); // uuid -> { result }（第一次處理的結果）

  /**
   * 照片暫存：ref -> { photo, expiresAt }
   * 用途——回報端拍完照會先送 /api/vision 拿區域建議，若接著再把同一張圖
   * 塞進 report payload 等於在 3G 下白傳第二次。改由 vision 回一個 ref，
   * 回報只帶 ref，server 端還原。純加速用，過期或遺失都能退回帶 base64 的路徑。
   */
  const photoRefs = new Map();

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

    /**
     * 刪除事件。
     *
     * 目前唯一的用途是**遲到的併案**：照片辨識比分群晚完成，所以同一個地點
     * 的多筆通報會先各自成案，解析出場域後才發現它們是同一件——
     * 併走之後原本那筆就該消失，否則態勢卡上會並排出現三個「土城」。
     */
    removeEvent(id) {
      return events.delete(id);
    },

    // ---- 照片暫存（/api/vision → 回報帶 photoRef，省掉第二次上傳） ----

    /** 存一張照片並回傳 ref；順手清掉過期項目（量小，不需背景 timer） */
    putPhoto(photo) {
      const now = Date.now();
      for (const [key, entry] of photoRefs) {
        if (entry.expiresAt <= now) photoRefs.delete(key);
      }
      const ref = `ph_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      photoRefs.set(ref, { photo, expiresAt: now + config.vision.photoRefTtlMs });
      return ref;
    },

    /** 取出並移除一張暫存照片；ref 無效/過期回 null（呼叫端須容忍） */
    takePhoto(ref) {
      const entry = photoRefs.get(ref);
      if (!entry) return null;
      photoRefs.delete(ref);
      return entry.expiresAt > Date.now() ? entry.photo : null;
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
