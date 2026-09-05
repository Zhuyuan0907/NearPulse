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
   *
   * 門檻的邏輯是「等待的成本」：後果愈嚴重、擴散愈快的類型，愈不能等湊人數。
   * 其餘類型需 3 個獨立訊號，避免單一假回報直接觸發警示。
   *
   * 【attack 是依真實案例補上的】
   * 原本沒有這個類型，持械攻擊只能歸到「其他」——門檻 3、嚴重度 low。
   * 這是嚴重的錯誤分類。對照台北捷運 11 年來的 5 起攻擊事件：
   *
   *   2014 鄭捷案      板南線列車上，龍山寺→江子翠密閉車廂 4 分鐘無處可逃
   *                    4 死 24 傷，至今最嚴重
   *   2015 中山站      4 號出口附近連續刺傷 4 人
   *   2024 新埔站      美工刀傷人
   *   2025 台北車站    M 區出口地下連通道投擲煙霧彈並持刀行凶，
   *                    接著移動到中山站外的誠品生活南西店；4 死 11 傷
   *
   * 三個設計含意：
   *   1. 攻擊事件的擴散速度最快，門檻必須是 2（與火警同級），不能等 3 個人
   *   2. 攻擊者**會移動**（2025 年跨越了兩個站與一間百貨）——
   *      這正是 threatMotion 存在的理由
   *   3. 建議內容與其他類型本質不同：不是「往出口疏散」而是
   *      「遠離、不要圍觀、找掩蔽」（見 llm.js 的 ADVICE_TEMPLATES）
   */
  eventTypes: {
    fire:    { label: '火警', threshold: 2, severity: 'high' },
    attack:  { label: '攻擊', threshold: 2, severity: 'high' },
    medical: { label: '急救', threshold: 2, severity: 'high' },
    crush:   { label: '推擠', threshold: 3, severity: 'medium' },
    other:   { label: '其他', threshold: 3, severity: 'low' },
  },

  /**
   * 鄰近場域警示：高嚴重度事件會提醒周邊場域，半徑內的人也看得到。
   *
   * 2025 年那起攻擊從台北車站移動到中山站（約 800m）再到誠品南西。
   * 事件是以場域為單位聚合的，所以攻擊者移動到下一個場域時會變成
   * 「另一起事件」——但**下一個場域的人現在就該知道**。
   * 這裡不合併事件（誤併兩起獨立事件的代價太高），只是把警示擴散出去。
   */
  /**
   * 事件結案後，「已解除」訊息還要在態勢卡上留多久。
   *
   * 之前結案的事件是**無聲消失**的——closingNotice 產生了卻從未送到使用者面前。
   * 但在疏散情境裡，不知道警報解除和不知道警報發生幾乎一樣糟：
   * 人會繼續避開那個出口、繼續緊張，或是認為這個 App 壞了。
   */
  resolvedWindowMs: 10 * 60_000,
  nearbyAlertRadiusM: 1200,

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
    /**
     * 互動 or 延後。**由供應商的實測延遲決定，不是偏好問題。**
     *   interactive —— 拍完照當場等結果（gpt-4o-mini 約 1~2 秒）
     *   deferred    —— 回報立刻成立，辨識在批次端非同步跑，錨點稍後補上
     *
     * opencode 的免費層實測 34.5 秒（reasoning model），互動式完全不可行；
     * 但延後模式剛好符合本專案「advisor 是 fire-and-forget、永不擋回報」的架構。
     */
    mode: process.env.VISION_MODE ?? null, // null = 依供應商自動決定
    /** 互動模式的逾時：這是「絕不卡住使用者」的保險絲 */
    /**
     * 互動式逾時。
     *
     * 6 秒是照「裁切後的一格」抓的（實測 1.8 秒，餘裕很大）。但「AI 指不出
     * 是哪一格 → 讀整張圖」現在是正式的後備路徑，而整圖實測要 5.2 秒——
     * 6 秒只剩 0.8 秒餘裕，行動網路稍微抖一下就會逾時，而逾時的結果
     * 是使用者看到「認不出來」。放寬到 10 秒。
     */
    timeoutMs: Number(process.env.VISION_TIMEOUT_MS ?? 10_000),
    /** 延後模式的逾時：沒有人在等，可以放寬 */
    deferredTimeoutMs: Number(process.env.VISION_DEFERRED_TIMEOUT_MS ?? 90_000),
    /** low detail：成本與延遲最低，對柱號/招牌/燈箱文字已足夠 */
    detail: 'low',
    /** 照片暫存（/api/vision → 回報帶 photoRef，省掉第二次上傳）存活時間 */
    photoRefTtlMs: 10 * 60_000,
  },

  /** 態勢卡靜態檔的最大建議大小（位元組），超過時記 warning（不擋） */
  situationCardTargetBytes: 50_000,
};
