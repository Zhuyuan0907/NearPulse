/**
 * ============================================================================
 * 全域設定檔（單一事實來源）
 * ============================================================================
 * 所有可調參數集中在這裡，方便調整與日後抽換成環境變數。
 * MVP 階段刻意把數值放寬（如凍結時間縮短），讓開發與試玩能快速觀察到
 * 完整的事件生命週期：candidate → active → frozen / cancelled。
 */

export const config = {
  /** HTTP 埠號 */
  port: 3000,

  /** 批次處理間隔（對應架構中的「10 秒批次聚合」） */
  batchIntervalMs: 10_000,

  /**
   * 事件類型定義與升級門檻。
   * 依設計原則：火警／急救屬高嚴重度，2 個獨立 session 即升級為 active；
   * 其他類型需 3 個，避免單一假回報直接觸發警示。
   */
  eventTypes: {
    fire:    { label: '火警', threshold: 2, severity: 'high' },
    medical: { label: '急救', threshold: 2, severity: 'high' },
    crush:   { label: '推擠', threshold: 3, severity: 'medium' },
    other:   { label: '其他', threshold: 3, severity: 'low' },
  },

  /**
   * 否證否決規則：
   * 「在場且沒看到」的否證數 >= cancelNegatives 且多於正向數 → 事件取消。
   * 防止假事件一直掛著等待湊門檻（殭屍事件）。
   */
  cancelNegatives: 3,

  /** active 事件多久無新確認後凍結（規格為 45 分鐘，開發環境縮短） */
  freezeAfterMinutes: 45,

  /** candidate 事件多久無人補確認後自動過期取消（開發環境縮短） */
  candidateTtlMinutes: 15,

  /** 附件大小上限（base64 後的字元數，避免惡意大檔） */
  limits: {
    maxAudioBase64: 4_000_000, // ~3MB 原始音檔
    maxPhotoBase64: 2_000_000, // ~1.5MB 壓縮後照片
  },

  /** 態勢卡靜態檔的最大建議大小（位元組），超過時記 warning（不擋） */
  situationCardTargetBytes: 50_000,
};
