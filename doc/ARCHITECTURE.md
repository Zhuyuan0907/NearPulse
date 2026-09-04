# NearPulse 系統架構（v0.1.0 實作版）

> 地下通勤場域的非同步災情儀表板——極簡寫入、批次聚合、超輕量讀取。

## 1. 拓撲與資料流

```
[回報頁 #/]
  │ POST /api/reports（UUID 冪等 + 位置聲明 + 選配語音/照片）
  ▼
[API Gateway/驗證] ──▶ [記憶體佇列]（未來：Redis Stream）
                          │ 每 10 秒
                          ▼
                    [批次 Worker]
                      ├─ 歸屬：同站同類型 → 併入既有事件（或開新 candidate）
                      ├─ 狀態機：candidate→active→frozen / cancelled
                      └─ AI advisor（STT/Vision/LLM）＝ stub，不在關鍵路徑
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
      [靜態態勢卡 + ETag]        [確認循環]
              │                       │
[態勢卡頁 #/situation]    [確認頁 #/confirm]
  ETag 輪詢（12 秒、304 為主、   兩段式：在場嗎？→ 有看到嗎？
  前台可見才輪詢）            未確認位置者的否證不算
```

## 2. 核心設計原則（實作對應）

| 原則 | 實作位置 |
|---|---|
| 零打字：粗粒度用點的、細粒度用說的、永遠不用打的 | `ReportPage` 狀態機按鈕 + `voiceRecorder` hold-to-talk |
| 零 GPS 依賴：GPS 是加速器不是必要條件 | `location.js` L1 GPS → L2 session 記憶 → L3 路網圖手選（最終仲裁） |
| LLM 不在關鍵路徑上 | 態勢卡由確定性模板生成；advisor 全部 stub 且 fire-and-forget |
| 非同步批次（10 秒） | `batchWorker.js`：歸屬 → 門檻 → 狀態機 → 卡片重算 |
| 弱網優先讀取 | 態勢卡由 worker 預算 + ETag 304 + Page Visibility 前台輪詢 |
| 冪等（防恐慌連點） | client UUID + server `seenReportUuids` |
| 無狀態驗證（3 人 = 3 個獨立 session） | `cluster.js` 以 sessionId 去重計數 |
| 語氣分級（濫用防線） | candidate → 徵詢區塊（低調）；active → 警示區塊 |
| 否證否決（防殭屍假事件） | 在場否證 ≥ 3 且多於正向 → cancelled |

## 3. 事件狀態機

```
回報 ──比對既有事件──▶ candidate ──獨立正向 ≥ 門檻──▶ active ──45min 無更新──▶ frozen
（同站同類型）              │
                            ├─ candidate 超時（15min 無補確認）──▶ cancelled
                            └─ 在場否證 ≥3 且 > 正向 ──────────▶ cancelled
門檻：火警/急救 2 · 推擠/其他 3（config.eventTypes）
```

## 4. 位置狀態機（client 端）

| 層 | 訊號 | 存活期 | 信心 |
|---|---|---|---|
| L1 | `getCurrentPosition` 一次 | 即時 | accuracy ≥300m 不信任（地下常為過期快取） |
| L2 | session 內上次確認站點（sessionStorage） | 30 分鐘 | 0.6 |
| L3 | 路網圖手選（兩層：路線→站） | 即時 | 1.0（最終仲裁） |

每筆回報附帶：`{ source: gps|manual|session, stationId, confidence, timestamp }`。

## 5. 網頁平台約束（設計已內化，不依賴）

- 不用 Cell-ID / WiFi BSSID / BLE beacon（瀏覽器不可得）
- 不做背景定位、背景輪詢（關頁即凍結）
- Web Push 未接入（iOS 需加主畫面 + 無法 bypass 靜音）→ v0.1 以「徵詢區塊 + 確認頁」閉環替代
- 不依賴 iOS 振動、不依賴持久儲存（Safari 7 天清除 → 全部資料掛 sessionStorage）

## 6. 模組地圖

```
server/src/
  config.js                 全域參數（門檻/凍結/批次間隔/上限）
  store/index.js            儲存層工廠（介面）
  store/memoryStore.js      記憶體實作（日後換 Redis/PG）
  pipeline/cluster.js       分群/門檻/狀態判斷（純函式）
  pipeline/batchWorker.js   10 秒批次主循環
  pipeline/advisors/        STT/Vision/LLM stub（介面穩定、日後接真服務）
  services/reportService.js ingest 驗證與正規化
  services/eventService.js  狀態機執行 + 事件摘要
  services/situationCardService.js  態勢卡建構 + ETag
  routes/reports.js         POST /api/reports、GET /api/reports/context
  routes/events.js          GET /api/events、POST /api/events/:id/confirm
  routes/situation.js       GET /api/situation（ETag/304）

client/src/
  modules/session.js        無身份 session UUID
  modules/location.js       L1/L2/L3 位置狀態機
  modules/api.js            API client + ETag 輪詢器
  modules/voiceRecorder.js hold-to-talk（iOS 無 SpeechRecognition → 上傳制）
  modules/photoCompressor.js canvas 壓縮 <200KB
  data/stations.js          路網圖 subset（正式版換完整路網 JSON）
  components/StationPicker.jsx  路網圖點選（零打字）
  pages/ReportPage.jsx      回報 3 秒流程
  pages/ConfirmPage.jsx     兩段式確認
  pages/SituationPage.jsx   態勢卡（讀取端）
  App.jsx                   hash 路由（零路由依賴）
```

## 7. API 契約摘要

| 端點 | 方法 | 說明 |
|---|---|---|
| `/api/reports` | POST | 回報（UUID 冪等；202 = 已入列） |
| `/api/reports/context?station=&type=` | GET | 同站同類型既有事件（歸屬確認） |
| `/api/events?station=` | GET | 可確認事件清單 |
| `/api/events/:id/confirm` | POST | 兩段式確認（session 一票） |
| `/api/situation` | GET | 態勢卡（ETag → 304） |
| `/healthz` | GET | 健康檢查 |
