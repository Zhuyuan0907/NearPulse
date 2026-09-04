# NearPulse 開發版本過程（DEVLOG）

本文件記錄每個版本的：開發範圍、關鍵決策、與架構討論結論的對應/偏離。

---

## v0.1.0 —— Walking Skeleton（2026-09-04）

### 目標

以「簡單可行性優先」實作完整縱切：
**回報 → 批次分群 → 兩段式確認 → 事件升級 → 態勢卡 ETag 讀取**，
讓設計討論中的核心機制全部可以在本機跑通、用 curl 驗證。

### 開發範圍（完成）

- **Server（Node + Express，零額外持久化依賴）**
  - 回報 ingest：欄位驗證、UUID 冪等、附件大小防呆
  - 10 秒批次 worker：歸屬（`attachToEventId` 優先 → 同站同類型自動比對 → 開新 candidate）
  - 事件狀態機：`candidate → active → frozen / cancelled`（含否證否決與超時取消）
  - 態勢卡：確定性模板生成、worker 預算、ETag/304 快取
  - AI advisor 三件套（STT/Vision/LLM）：介面 + stub、fire-and-forget
- **Client（React + Vite PWA）**
  - session UUID（sessionStorage，關頁即滅）
  - 位置狀態機 L1/L2/L3（GPS 一次查詢 → session 記憶 → 路網圖手選）
  - 回報頁：四類型大按鈕、歸屬確認（同一件/另一件）、hold-to-talk 語音、照片壓縮、UUID 冪等 + 樂觀 UI
  - 確認頁：兩段式（在場嗎 → 有看到嗎），清單入口 + deep link 入口
  - 態勢卡頁：ETag 輪詢（12 秒、304 沿用、Page Visibility 背景停止）
  - manifest（可安裝 PWA）；刻意不安裝 Service Worker（網路可用假設）

### 關鍵決策與理由

1. **記憶體儲存 + store 介面**：架構要求 Redis/PG，但 walking skeleton
   的目的是驗證資料流。`store/index.js` 工廠模式讓日後換儲存零改動業務層。
2. **態勢卡不經過 AI**：討論結論「LLM 不在關鍵路徑」的直接實作——
   建議文字全部來自 `ADVICE_TEMPLATES` 確定性模板；LLM stub 只產時間線字串。
   這讓 MVP 的降級路徑＝主路徑，天然驗證了設計原則。
3. **推播以「徵詢區塊 + 確認頁」閉環替代**：Web Push 需要 VAPID 金鑰、
   iOS 需加主畫面，且無法 bypass 靜音。MVP 先讓循環跑起來：
   態勢卡 `pending` 區塊 → 點擊 → 兩段式確認 → 門檻 → 升級。
   介面（deep link `#/confirm?event=`）與未來推播完全相容。
4. **語音採「上傳制」**：iOS Safari 無 `SpeechRecognition`（設計討論結論），
   因此 client 只用 `MediaRecorder` 錄製上傳，STT 在 server 端 stub。
5. **零路由依賴**：hash router 30 行自寫，避免 walking skeleton 階段
   引入 react-router；三頁面結構已為未來 code-split（讀取端拆輕量 bundle）預留。
6. **GPS 此版不反查站點**：「座標 → 最近站」需要站點座標圖資，
   v0.1 的 GPS 僅記錄信心資訊，站點由 L2/L3 解析。列為 Phase 2。

### 刻意的簡化（非偏離，是分期）

- 附件（語音/照片）只保存於記憶體事件內，不落磁碟、不供下載
- 態勢卡 `pending` 徵詢為全站廣播式（未依使用者位置過濾——位置聲明在 client）
- `locationClaim.stationName` 由 client 帶站名（server 不持有完整路網）

### 已知問題

- 記憶體儲存重啟即清空（by design，Phase 2 換 Redis/PG）
- 附件（語音/照片）只保存於記憶體事件內，不落磁碟、不供下載
- 態勢卡 `pending` 徵詢為全站廣播式（未依使用者位置過濾——位置聲明在 client）
- `locationClaim.stationName` 由 client 帶站名（server 不持有完整路網）
- 無任何認證：MVP 假設信任模型靠「獨立 session 交叉驗證」，Rate limit 未實作

---

## v0.1.1 —— 單一埠號模式（2026-09-04）

### 變更

- server 進入點新增靜態檔服務：直接服務 `client/dist`，
  **:3000 同時提供 API 與前端**，單 port 即可穿 Cloudflare Tunnel。
- SPA fallback 回 index.html（hash 路由保險）；未知 `/api/*` 回 404 JSON
  而非落入 fallback。
- `client/dist` 不存在時僅提供 API 並印出提示（不 crash）。

### 部署形態

- 單 port（tunnel 用）：`client build → server :3000`
- 開發（HMR）：server :3000 + vite :5173（/api 代理不變）

---

## 下一步（Phase 2 候選）

1. Web Push（VAPID）接入：徵詢區塊 → 推播，deep link 介面不變
2. GPS 反查站點（站點座標圖資）＋ accuracy 加權分群
3. Redis Stream + Postgres 持久化（store 介面直接替換）
4. STT/Vision 接真實 API（advisor 介面不變）
5. Rate limiter / 濫用防護（config 已預留 limits）
6. 讀取端獨立輕量 bundle（讀取端/回報端拆分）
