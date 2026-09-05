# NearPulse 系統架構（v0.5.0 實作版）

> 地下通勤場域的非同步災情儀表板——極簡寫入、批次聚合、超輕量讀取。

## 1. 拓撲與資料流

```
[回報頁 #/]
  │
  ├─ 【事件位置】三條路徑，能用哪條就用哪條，全失敗也不擋回報
  │    ├─ GPS      訊號好（誤差 ≤60m）時一鍵採用——地面層與出入口附近可用
  │    ├─ 地圖點選  真實 OpenStreetMap 底圖上直接點出位置（最精確）
  │    └─ 照片辨識  ↓
  │
  ├─ 拍照 ──▶ 前端壓縮（EXIF 轉正、1024px WebP、<50KB）
  │    │
  │    ├─ ① POST /api/vision?stage=locate（整張圖）
  │    │      → 哪一格（A1~C3）看得到站名/出口牌 + photoRef
  │    ├─ ② 使用者在九宮格上確認或改點（零打字、即時）
  │    ├─ ③ **從原圖裁那一格** ──▶ stage=read → 只讀字（不猜座標）
  │    ├─ ④ venueService 確定性查表：文字 → 場域 + 出口 + 精確經緯度
  │    └─ ⑤ 示意圖上高亮，使用者一眼確認或改點別的出口
  │       （任一步失敗 → 靜默降級回手選，絕不擋回報）
  │
  │ POST /api/reports（UUID 冪等 + 位置聲明 + 選配 nearExitCode/語音/文字/photoRef）
  ▼
[API Gateway/驗證] ──▶ [記憶體佇列]（未來：Redis Stream）
                          │ 每 10 秒
                          ▼
                    [批次 Worker]
                      ├─ 歸屬：同場域同類型 → 併入既有事件（或開新 candidate）
                      ├─ 狀態機：candidate→active→frozen / cancelled
                      └─ AI advisor（STT/LLM）fire-and-forget，不在關鍵路徑
                          │  （視覺定位在回報端已完成，batch 端不重複付費）
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
| 零打字：粗粒度用點的、細粒度用說的、永遠不用打的 | 類型大按鈕 + `PhotoRoiPicker` 影像九宮格 + `VenueMap` 出口點選 + hold-to-talk（文字輸入與搜尋框皆為併行後備，非必經） |
| 零 GPS 依賴：GPS 是加速器不是必要條件 | 粗略 GPS（±300~500m 就夠）→ `/api/venues/nearby` 收斂成點選清單 → 視覺錨點定到出口。地下無 GPS 時整條路徑照走 |
| AI 只讀字、不猜座標 | Vision 只回「哪一格有牌子」與「牌子上的字」；位置由 `venueService.resolveAnchors` 確定性查表得出 |
| LLM 不在關鍵路徑上 | 態勢卡由確定性模板生成；advisor 全部 fire-and-forget，失敗一律回同一種降級形狀 |
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
| L1 | `getCurrentPosition` 一次（粗略即可） | 即時 | 只用來收斂鄰近清單，不作為位置聲明 |
| L2 | session 內上次確認場域（sessionStorage） | 30 分鐘 | 0.6 |
| L3 | 場域點選（鄰近清單，搜尋為後備） | 即時 | 1.0（最終仲裁） |
| L4 | 視覺錨點 → 出口代碼（`nearExitCode`） | 即時 | 選配——疏散建議的輸入 |

每筆回報附帶：`{ source: gps|manual|session, stationId, confidence, timestamp }`，
外加選配的 `nearExitCode`（如 `M3`）。

**L1 的門檻答對了問題**：±300~500m 對「我在哪個月台」沒用，對「我在哪一站」卻綽綽有餘
（站距普遍大於 300m）。v0.2 以前把 accuracy ≥300m 的定位整個丟棄，等於浪費了這個訊號。

> 場域（venue）是通用模型：捷運站體、地下街、地下停車場皆可掛入，
> 條件只有「地下、無可靠 GPS」。資料由 OSM 產生，見 §8。

## 5. 網頁平台約束（設計已內化，不依賴）

- 不用 Cell-ID / WiFi BSSID / BLE beacon（瀏覽器不可得）
- 不做背景定位、背景輪詢（關頁即凍結）
- Web Push 未接入（iOS 需加主畫面 + 無法 bypass 靜音）→ v0.1 以「徵詢區塊 + 確認頁」閉環替代
- 不依賴 iOS 振動、不依賴持久儲存（Safari 7 天清除 → 全部資料掛 sessionStorage）

## 6. 模組地圖

```
server/src/
  config.js                 全域參數（門檻/凍結/批次間隔/上限/vision 供應商）
  data/venues.json          OSM 場域快照（產生物，進版控；見 §8）
  store/index.js            儲存層工廠（介面）
  store/memoryStore.js      記憶體實作 + 照片短 TTL 暫存（日後換 Redis/PG）
  pipeline/cluster.js       分群/門檻/狀態判斷（純函式）
  pipeline/batchWorker.js   10 秒批次主循環
  pipeline/advisors/stt.js     STT stub（介面穩定、日後接 Whisper）
  pipeline/advisors/vision.js  兩段式（locate/read）+ 可插拔 provider（openai / none）
  pipeline/advisors/llm.js     確定性避難建議模板 + 時間線敘事 stub
  services/reportService.js ingest 驗證與正規化
  services/eventService.js  狀態機執行 + 事件摘要
  services/anchorParser.js  出口代碼／站名解析（建表與查表共用，避免規則漂移）
  services/venueService.js  場域查表、鄰近搜尋、錨點解析、示意幾何
  services/evacuationService.js  疏散建議（含移動威脅與無障礙分支，純函式）
  services/threatMotion.js  移動威脅判定（軌跡 → 方向；防誤判是重點）
  services/trainService.js  行進中列車：下一站推算與到站預告（TDX 官方路網）
  services/situationCardService.js  態勢卡建構 + ETag（含預算好的疏散文字）
  routes/reports.js         POST /api/reports、GET /api/reports/context
  routes/events.js          GET /api/events、POST /api/events/:id/confirm
  routes/situation.js       GET /api/situation（ETag/304）
  routes/vision.js          POST /api/vision（兩段式分析 + 錨點候選 + photoRef）
  routes/venues.js          GET /api/venues/nearby|search|:id
scripts/extract-osm.mjs     .osm.pbf → 過濾後的 JSON（本機，零限流）
scripts/build-venues.mjs    抽取檔 → venues.json（非 server 依賴）

client/src/
  modules/session.js        無身份 session UUID
  modules/location.js       粗略定位 + session 記憶（client 不持有任何圖資）
  modules/api.js            API client + ETag 輪詢器
  modules/voiceRecorder.js hold-to-talk（iOS 無 SpeechRecognition → 上傳制）
  modules/photoCompressor.js EXIF 轉正、壓到 <50KB、**從原圖裁九宮格的一格**
  components/VenuePicker.jsx    鄰近場域點選（搜尋為後備）
  components/PhotoRoiPicker.jsx 照片九宮格：標出有站名/出口牌的那一格
  components/VenueMap.jsx       真實 OSM 地圖（Leaflet，動態載入不進首屏）
  components/OfflineBar.jsx     離線狀態與待送出回報
  modules/speech.js             疏散指示語音播報（瀏覽器內建，離線可用）
  modules/offline.js            連線狀態追蹤
public/sw.js                    Service Worker：離線殼 + 回報排隊

android/                        Android app（補上網頁做不到的感測器層）
  app/src/main/.../sensor/AltitudeEstimator.kt    氣壓計樓層偵測
  app/src/main/.../sensor/CrowdMotionDetector.kt  人流停滯偵測
  app/src/test/                 21 項單元測試（純邏輯，JVM 可跑）
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
| `/api/vision` | POST | 兩段式視覺分析（`stage=locate|read`）+ 錨點候選 + `photoRef`（⚠️ 無防濫用） |
| `/api/venues/nearby?lat=&lon=` | GET | 鄰近場域（零打字選擇的主路徑） |
| `/api/venues/search?q=` | GET | 場域搜尋（後備路徑） |
| `/api/venues/:id` | GET | 出口清單 + 真實經緯度（地圖標記用） |
| `/healthz` | GET | 健康檢查 |

### 照片只上傳一次

`POST /api/vision` 收下照片後會暫存 10 分鐘並回一個 `photoRef`。
回報改帶 `photoRef` 取代 `photo.base64`，3G 下省掉第二次 50KB 上傳；
視覺定位在回報端就完成了，batch 端不再對同一張圖呼叫第二次 Vision。
ref 過期或遺失時 server 靜默略過——照片是選配，不擋回報。

## 8. 場域圖資（OpenStreetMap）

手工維護出口圖資不只是麻煩，是會錯而且錯得安靜——v0.2 的示範資料裡
`R09`（實為台大醫院）被寫成台北101、`BL13`（實為善導寺）被寫成忠孝復興。
v0.3 改由 OSM 產生：

```
scripts/build-venues.mjs   分區查詢 Overpass（一次抓全台會斷線）
   ├─ 捷運：station 節點依「站名 + 600m」合併轉乘站，
   │        出口以「到任一組成節點的最短距離」歸屬（≤400m）
   ├─ 地下街：無車站節點可歸屬，由出口名稱反推場域（「西門地下街1號出入口」）
   ├─ 停車場：OSM 只有一個帶名字的點 → 僅建到場域層級
   └─ 出口點雲以 PCA 主軸對齊後正規化到 0~1（純服務繪圖，不帶語意）
        ↓
server/src/data/venues.json   519 場域 / 614 出口 / 165KB，進版控
```

**為什麼是離線 script 而非啟動時抓**：Overpass 是共用免費服務，不適合逐請求查詢；
回報路徑上多一個外部依賴就多一個失敗模式。server 執行時完全不碰外部網路。

**資料分兩級**（依實測覆蓋率，不是設計偏好）：

| 級別 | 場域 | OSM 有什麼 | 能做什麼 |
|---|---|---|---|
| 完整級 | 捷運、地下街 | 出口節點（`ref` 編號 + 座標） | 錨點辨識、地圖確認、疏散距離 |
| 場域級 | 地下停車場 | 只有一個帶名字的點 | 僅能回報「在某停車場」，UI 自動降級 |

資料授權：OSM 為 ODbL，`venues.json` 內含姓名標示，UI 頁尾顯示。

### v0.5 改為本機解析（零限流）

Overpass 公開實例只有 2 個併發槽，補方向地標的上百次查詢會被反覆 429。
改為下載 Geofabrik 抽取檔在本機解析：**全台 101 秒、零限流、可任意重跑**，
而且能一次看到所有標籤——這直接促成了無障礙功能（`wheelchair` 標籤原本
沒人想到要查）。

| 指標 | v0.3（Overpass） | v0.5（本機） |
|---|---|---|
| 場域數 | 519 | **778**（含日本關西） |
| 出口數 | 614 | **1340** |
| 方向地標覆蓋 | 23% | **96%** |
| 無障礙資料 | — | 42% 出口有標註 |
| 建表耗時 | 20 分鐘仍失敗 | **101 秒** |

## 10. 移動威脅追蹤

火警不會跑，但**無差別攻擊會**。事件從「一個點」改為「一條錨點軌跡」
（只追加不覆寫），由 `threatMotion.js` 做確定性判定。

防誤判是這個模組的重點——一條假軌跡會把人往威脅方向趕，比沒有功能更糟：

| 判準 | 擋掉的情況 |
|---|---|
| 觀測必須來自不同 session | 同一人邊走邊回報（最可能的假陽性） |
| 間隔 ≥ 20 秒 | 多人同時回報同一件事 |
| 位移 ≥ 30m | 定位誤差 |
| 速度 0.3~6 m/s | 兩起獨立事件被誤併 |
| 多段方向發散 > 75° | 不硬給方向，改說「位置不一致」 |

疏散建議跟著翻轉：位於威脅前進方向（夾角 ≤70°）的出口進避開清單；
若所有出口都在前方，誠實說「請尋找避難空間」。

## 11. 無障礙疏散

**火災時電梯不可用，而捷運站裡多數無障礙出口就是電梯**——兩者相乘的結論是：
對輪椅使用者而言，火警時多數「無障礙出口」並不存在。國際官方準則對這個處境
的建議是前往避難空間待援，而非前往出口。

所以這不是把出口清單過濾一下，而是**切換成性質不同的答案**：

```
府中站  推擠（電梯可用）→ 改往無台階可通行的 1 出口
        火警（電梯禁用）→ 無障礙出口需要電梯，火災時不可使用
                          請前往避難空間待援
```

**安全預設**：`wheelchair` 沒有標註一律視為「未知」，絕不當成可通行。
把「不知道」講成「可以」，對必須依賴這個資訊的人是會害死人的。

篩選順序刻意與一般路徑相反：**先過無障礙，再套安全距離與威脅方向**。
可通行的出口本來就稀少，若先用距離砍到剩三個，往往一個都不剩。

## 9. 地圖（v0.4 修訂）

v0.3 用自繪 SVG 示意圖，理由是圖磚太重。v0.4 改為**真實的 OpenStreetMap 底圖**
（Leaflet），因為示意圖無法回答「我到底在哪」——沒有街景參照，使用者無從
確認系統猜的位置對不對，而確認正是這一步存在的理由。

頻寬問題改用兩個手段解決，而不是放棄地圖：

| 手段 | 效果 |
|---|---|
| 動態載入（`React.lazy`） | Leaflet 與圖磚 CSS 切成獨立 chunk（約 45KB gzip），只有展開「補充細節」的人才下載。首屏維持 55KB gzip |
| 讀取端不載入地圖 | 態勢卡（弱網下最需要開得起來的頁面）完全不碰 Leaflet |

底圖用 CARTO 而非 `tile.openstreetmap.org`：OSM 官方圖磚的使用政策明文不供
應用程式正式流量使用。CARTO 的底圖同樣是 OpenStreetMap 資料（姓名標示照給），
深色版也與本專案的深色 UI 一致。要換回官方圖磚只需改 `VenueMap.jsx` 的 `TILE` 常數。

### 事件位置的三條路徑

| 路徑 | 精度 | 何時可用 |
|---|---|---|
| GPS | 誤差 ≤60m 才採用 | 地面層、出入口附近；地下多半失敗（設計中的常態） |
| 照片辨識 | 出口級 | 畫面中有站名牌／出口編號牌 |
| 地圖點選 | 任意精度 | 永遠可用——事件不在出口旁（月台中段、通道）時尤其重要 |

三者寫入同一組欄位：`incidentPoint`（座標）或 `nearExitCode`（出口代碼），
疏散計算的原點優先序為 **選點 → 出口 → 場域中心**。

### 為什麼疏散建議不顯示公尺數

我們唯一的幾何資料是 OSM 上每個出入口的**地面**座標。用它算出的
「M3 到 M7 距離 91 公尺」有四個問題：量的是地面不是地下、沒有包含所在樓層與
垂直移動、起點本身就有 30~50m 的不確定、而且地下不能走直線。

**在生命安全情境下顯示一個看似精確的錯誤數字，比不顯示更糟。**
所以座標只做兩件它做得好的事：**排序**與**畫地圖**。

對使用者輸出的是「出口編號 + 通往哪裡」——因為**站內的指標系統本來就是用
出口編號在導引的**。牆上寫的是「← M7 出口」，不是「往東 91 公尺」。

唯一有資格顯示的數字是**實測步行時間**（由使用者錨點配對累積），
且必須標明「實測、幾人走過」。
