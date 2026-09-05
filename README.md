# NearPulse

**地下場域的災情通報與疏散導引。沒有 GPS、沒有網路、不知道自己在哪，也要能通報與逃生。**

---

## 問題與目標

台北捷運 11 年內發生過 5 起攻擊事件。2014 年鄭捷案發生在**行駛中的板南線列車上**——
從發車到停妥開門，車廂內的人被關在封閉空間約 4 分鐘，而下一站的月台毫無準備。
2025 年那起攻擊則從台北車站的地下連通道移動到中山站，再到誠品生活南西店。

這些場域有三個共同的技術條件，讓現有的通報 App 幾乎都用不上：

- **沒有 GPS。** 地下拿不到定位是常態，不是故障。
- **網路壅塞。** 事件發生時，同一個站體裡數百人同時上網。
- **沒有背景執行。** 網頁平台不能常駐，而沒有人會為了「可能用到」而每天開著一個 App。

**目標使用者**是任何帶著手機、身處地下空間的一般人——不是受過訓練的站務人員，
也不預期他認得這個地方。**預期影響**是把「發現異常」到「附近的人知道並開始移動」
之間的時間，從仰賴廣播系統的數分鐘，縮短到數十秒。

設計上的核心取捨貫穿整個專案：**位置永遠不是通報的前提，AI 永遠不在關鍵路徑上。**

---

## 核心功能

- **地下視覺定位**——地下沒有 GPS，但有站名牌和出口編號牌，那就是地下的地標系統。
  拍張照 → 九宮格指出「牌子在哪一格」→ 從原圖裁那一格放大辨識 →
  讀到的字經 OSM／TDX 圖資**確定性查表** → 場域、出口、座標。
  **AI 只讀字，不猜座標。**
- **移動威脅追蹤**——無差別攻擊的加害者會移動，單點通報會把人往危險推。
  多位獨立目擊者在不同時間、不同出口的指認構成軌跡，據此推算方向，
  並讓疏散建議**避開威脅前進的方向**。同一個人的兩個點不算移動證據（防誤判）。
- **行進中列車的到站預告**——用 TDX 官方站序與行車秒數算出下一站與到站時刻，
  並通知該站月台「事故列車即將進站，請讓開車門動線」。
  車廂裡的人做不了什麼；**能改變結果的是月台上那群人。**
- **無障礙疏散**——TDX 資料顯示北捷 437 個出口中僅 14 個（3.2%）有電梯且無樓梯。
  火災時電梯不可使用，所以對輪椅使用者，正確答案往往是「待援」而不是「往出口走」。
  系統會誠實給出這個答案，而不是套用一般疏散文案。
- **兩段式現場確認 + 否證否決**——只有在場者的回覆計入門檻；在場者的「沒看到」
  可以主動否決一則通報。這是對抗誤報與惡意通報的機制。
- **完全離線可用的通報**——Service Worker 快取殼與態勢卡；送不出去的回報存進
  IndexedDB，恢復連線後自動補送（以 client 產生的 UUID 冪等去重）。

---

## 系統架構

```
┌─────────────────────────── 回報端（恐慌情境，3 次點擊） ──────────────────────────┐
│  類型 → 位置線索（四選一）→ 送出                                                  │
│         拍照辨識 · 附近場域 · 自己描述（可語音）· GPS                              │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ POST /api/reports（UUID 冪等；離線則進 IndexedDB 佇列）
                ▼
┌───────────────────────────── Node + Express ────────────────────────────────────┐
│  reportService   欄位驗證、正規化（**至少一種位置線索**，但不強制是場域）           │
│  batchWorker     10 秒批次：歸屬 → 事件狀態機 → advisor（fire-and-forget）        │
│  cluster         同場域同類型合併；無場域者依座標鄰近或描述文字，否則各自成案        │
│  eventService    candidate → active → frozen / cancelled（唯一改狀態的地方）       │
│  ├ threatMotion       軌跡 → 方向（純函式，防誤判規則是重點）                      │
│  ├ evacuationService  出口建議（**無錨點就不產生「不要走」清單**）                  │
│  ├ trainService       下一站、到站時刻、開門側                                     │
│  └ situationCardService  態勢卡 + ETag（未變動一律 304）                          │
│                                                                                  │
│  advisors/  vision（唯一真的呼叫模型的地方）· stt（stub）· llm（確定性模板）        │
│  data/      venues.json（OSM 衍生）· tdx-trtc.json · trtc-open.json               │
│             ——**執行時只讀檔，不連外**                                            │
└───────────────┬──────────────────────────────────────────────────────────────────┘
                │ GET /api/situation（ETag 304；前台可見才輪詢）
                ▼
┌────────────────────────── 讀取端（弱網優先，卡片 < 50KB） ────────────────────────┐
│  總覽地圖（哪邊有事）→ 範圍篩選 → 事件標示牌（往這裡走／不要走）→ 展開細節地圖     │
└──────────────────────────────────────────────────────────────────────────────────┘
```

**AI 只出現在一個地方**：`advisors/vision.js` 把照片裡的**字**讀出來。
位置由 `venueService` 拿那些字做確定性查表得出。所有失敗路徑（逾時、無金鑰、
供應商不存在、超過限流）都回**完全相同的降級形狀**，呼叫端無從分辨——
因此 AI 永遠不可能擋住通報。`server/test/e2e.sh` 的 104 項檢查即在**無任何 API 金鑰**
的環境下驗證這一點。

---

## 使用技術

| 類型 | 技術 | 用途 |
|---|---|---|
| AI 模型 | MiniMaxAI/MiniMax-M3（GMI Cloud） | 視覺辨識：兩段式（定位九宮格 → 讀取該格文字）。實測 locate 1.9s／read 1.8s |
| AI 模型 | GPT-4o-mini Vision（可替換） | 同上；`VISION_PROVIDER` 可插拔，缺金鑰時自動降級 |
| 前端 | React 18 + Vite | PWA；hash 路由；無狀態管理套件 |
| 前端 | Leaflet + 官方 OSM 圖磚 | 總覽地圖與事件地圖（動態載入，不進主 bundle） |
| 前端 | Web Speech API | 語音播報（`speechSynthesis`）與語音輸入（`SpeechRecognition`），零 API 零金鑰 |
| 前端 | Service Worker + IndexedDB | 離線殼、態勢卡快取、回報佇列 |
| 後端 | Node 22 + Express 4 | 唯一的執行時相依套件 |
| 後端 | 記憶體 store（介面化） | 重啟即清；換 Redis／Postgres 只需替換實作 |
| 資料 | OpenStreetMap（Geofabrik PBF） | 836 個地下場域、1356 個出口。本機解析，零限流 |
| 資料 | 交通部 TDX | 北捷官方出口設施、站間行車秒數、有方向站序 |
| 資料 | 政府資料開放平臺 128416 | 逐站開門側、輪椅席車廂 |
| 資料 | OSM Nominatim | 圖資外地點的搜尋後備（**唯一的執行時連外**，且只在搜尋路徑上） |
| Android | Kotlin + Compose | 氣壓計樓層偵測、加速度計人流停滯偵測（21 項單元測試） |

---

## 安裝與執行

```bash
git clone https://github.com/FanYueee/NearPulse.git && cd NearPulse

# 1. 建置前端
cd client && npm install && npm run build

# 2. 啟動後端（:3000，同時服務 API 與前端靜態檔）
cd ../server && npm install && npm start

# 打開 http://localhost:3000
#   /             回報頁
#   #/situation   目前狀況
#   #/confirm     協助確認

# ── 以上不需要任何 API 金鑰即可完整運作 ──────────────────────────────
# 視覺辨識是選配。要啟用的話：
GMI_API_KEY=<your-key> VISION_PROVIDER=gmi VISION_MODEL=MiniMaxAI/MiniMax-M3 npm start

# 端到端驗證（104 項，同樣不需要金鑰）
bash server/test/e2e.sh

# 開發模式（HMR，兩個 port）
cd server && npm start        # :3000
cd client && npm run dev      # :5173，/api 已代理

# Android（選配）
cd android && ./gradlew test assembleDebug
```

### 重建圖資快照（選配，資料已進版控）

```bash
curl -O https://download.geofabrik.de/asia/taiwan-latest.osm.pbf
node server/scripts/extract-osm.mjs taiwan-latest.osm.pbf /tmp/tw.json --survey
node server/scripts/build-venues.mjs /tmp/tw.json

node server/scripts/fetch-tdx.mjs                      # 北捷官方資料
node server/scripts/fetch-trtc-open.mjs                # 開門側、輪椅席
node server/scripts/build-venues.mjs --network-only    # 只重算路網（數秒）
```

---

## 作品展示

- Demo：`https://naturals-linda-homepage-functioning.trycloudflare.com`
  （選填；開發用 Cloudflare Tunnel，網址會變動——建議依上方步驟本機執行）
- 評審影片：（待補）

---

## 限制與未來工作

**已知限制（都經過實測確認，不是推測）**

- **圖資覆蓋不完整，而且不會完整。** 836 個場域中有出口圖資的僅 279 個；
  百貨只有 58 個且多數在關西。OSM 對台灣室內空間幾乎沒有 mapping。
  因應方式不是等圖資變好，而是讓系統在圖資缺席時仍然可用——
  通報照樣成立，只有「往哪個出口走」這一層誠實地說給不出來。
- **給不出「第幾節車廂離樓梯近」。** 這個功能日本的乗換案內有，
  但那是向株式会社ナビット**購買**的人工實地調查資料（ジョルダン 2022-09-30
  新聞稿明載），不是開放資料。ODPT、TDX 都沒有；OSM 的
  `railway:platform:section` 全球 3098 筆、約 91% 在德語區，台日皆 0。
  台北捷運Go 有此功能但資料未開放。改以**開門側**替代——它是官方逐站資料，
  而且不需要知道車廂編號就能執行。
- **不顯示公尺數。** 地下通道的實際步行距離與地面直線距離可以差上兩三倍，
  講「約 91m」是假精確。只有到站秒數是例外，因為那有 TDX 官方行車時間支撐，
  而且刻意取整到 10 秒／半分鐘。
- **語音輸入依賴網路。** Chrome 的 `SpeechRecognition` 會把音訊送到 Google 伺服器，
  所以它是加速器而非必經路徑；不支援或失敗時靜默回到打字。
- **語音附件尚未轉錄。** `advisors/stt.js` 仍是 stub，錄音會被保存但沒有內容萃取。
- **信任模型薄弱。** `sessionId` 的鑄造成本是零，「N 個獨立 session」承載不了
  升級門檻的重量。這是目前最大的結構性弱點。

**未來工作**

1. Web Push（VAPID）——目前「徵詢中」完全依賴有人主動打開 App，
   一個緊急告警產品沒有人會被告警。deep link 介面已備妥，缺的是訂閱與推送。
2. 信任模型：時間離散度、非對稱證據（照片比按鈕難偽造）、
   高嚴重度轉換交給站務端確認。
3. STT 接真實模型（advisor 介面不變）。
4. Redis Stream + Postgres 持久化（store 介面直接替換）。
5. 自架 OSM 圖磚與 Nominatim（現在用官方服務，不適合正式流量）。
6. 讀取端獨立輕量 bundle。

---

## 第三方服務、資料與素材

| 項目 | 來源 | 授權 |
|---|---|---|
| `server/src/data/venues.json` | OpenStreetMap（Geofabrik 區域抽取檔，本機解析） | ODbL —— © OpenStreetMap contributors |
| 底圖圖磚 | `tile.openstreetmap.org` | ODbL；依 OSM Tile Usage Policy，僅供開發與展示 |
| 地點搜尋後備 | OpenStreetMap Nominatim | ODbL；遵守每秒 1 次與 User-Agent 規範 |
| `server/src/data/tdx-trtc.json` | 交通部運輸資料流通服務平臺（TDX） | 依 TDX 開放資料條款 |
| `server/src/data/trtc-open.json` | 政府資料開放平臺 [dataset 128416](https://data.gov.tw/dataset/128416)「臺北捷運車站無障礙設施資料」 | 政府資料開放授權條款第 1 版 |
| 視覺辨識 | GMI Cloud（MiniMaxAI/MiniMax-M3） | 依供應商條款；**金鑰僅由環境變數提供** |
| React 18 / Vite / Express 4 / Leaflet | npm | MIT / BSD-2 |

**本專案不含任何金鑰、token 或個人資料。** 所有 API 金鑰一律透過環境變數提供，
未寫入任何進版控的檔案。使用者資料只存在 `sessionStorage`（關頁即滅）；
唯一寫入 `localStorage` 的是「下樓前的最後定位」——座標粗化到約 110 公尺網格、
30 分鐘自動失效、不含任何識別碼。現場照片暫存 10 分鐘後失效。

---

## 團隊成員

| 姓名 | 分工 |
|---|---|
| FanYueee | 全端開發、資料工程、產品設計 |

---

## License

MIT（見 [`LICENSE`](LICENSE)）。

衍生資料另依其原始授權：`venues.json` 為 OpenStreetMap 的 ODbL 衍生資料庫，
使用時需保留姓名標示。
