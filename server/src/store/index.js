/**
 * ============================================================================
 * createStore：儲存層工廠
 * ============================================================================
 * MVP 使用記憶體實作（重啟即清空），但對外只暴露這個介面。
 * 日後要換 Redis Stream / Postgres 時，只需提供相同介面的新模組，
 * routes / pipeline 層的程式碼完全不用動。
 *
 * 介面一覽：
 *   ingestReport(report)        # 冪等寫入待處理佇列，回傳是否為新報告
 *   drainPendingReports()      # 批次 worker 領走全部待處理回報
 *   upsertEvent(event)         # 寫入/更新事件
 *   getEvent(id)
 *   listEvents()               # 全部事件（批次 worker 掃描用）
 *   markCardDirty() / isCardDirty()
 *   setCard(card) / getCard()  # 態勢卡快取（與 ETag 一起快取）
 *   putPhoto(photo) / takePhoto(ref)  # 照片短 TTL 暫存（見下）
 *
 * 關於 putPhoto/takePhoto：回報端拍完照會先打 /api/vision 取區域建議，
 * 若接著又把同一張圖塞進 report payload，等於在 3G 下白傳第二次。
 * vision 回一個 ref，回報只帶 ref，server 端還原——純加速，遺失可退回原路徑。
 */

import { createMemoryStore } from './memoryStore.js';

export function createStore() {
  // 未來：if (config.useRedis) return createRedisStore(); ...
  return createMemoryStore();
}
