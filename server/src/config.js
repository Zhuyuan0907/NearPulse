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

  /**
   * Vision advisor（地下視覺錨點辨識）。
   * provider 為可插拔表格（見 pipeline/advisors/vision.js）：
   *   'openai' —— GPT-4o-mini Vision，detail: low（微型圖足夠讀柱號/燈箱）
   *   'none'   —— 不呼叫任何外部服務，一律回 pending（降級形狀）
   * 未設 OPENAI_API_KEY 時自動落到 'none'，因此本機/展示環境零設定即可跑。
   * 日後接小型地端 OCR 只需在 provider 表新增一個 entry，回傳形狀不變。
   */
  vision: {
    provider: process.env.VISION_PROVIDER ?? 'openai',
    model: process.env.VISION_MODEL ?? 'gpt-4o-mini',
    /** 逾時上限：規格目標是 1 秒內回，這是「絕不卡住使用者」的保險絲 */
    timeoutMs: Number(process.env.VISION_TIMEOUT_MS ?? 6_000),
    /** low detail：成本與延遲最低，對柱號/招牌/燈箱文字已足夠 */
    detail: 'low',
    /** 照片暫存（/api/vision → 回報帶 photoRef，省掉第二次上傳）存活時間 */
    photoRefTtlMs: 10 * 60_000,
  },

  /** 態勢卡靜態檔的最大建議大小（位元組），超過時記 warning（不擋） */
  situationCardTargetBytes: 50_000,
};
