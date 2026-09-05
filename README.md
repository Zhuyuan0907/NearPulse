# NearPulse

地下通勤場域的非同步災情儀表板——極簡寫入、批次聚合、超輕量讀取。

恐慌當下 3 次點擊完成回報；10 秒批次分群；兩段式現場確認交叉驗證；
讀取端態勢卡 < 50KB、ETag 304、前台才輪詢。零帳號、零打字、零 GPS 依賴。

**地下視覺定位**：地下沒有 GPS，但有站名牌和出口編號牌——那就是地下的地標系統。
拍張照 → 在九宮格上點出「牌子在哪一格」→ 系統從原圖裁那一格放大辨識 →
讀到的字經 OSM 圖資確定性查表 → 場域、出口、精確座標與疏散距離。
**AI 只讀字，不猜座標。**

事件位置有三條路徑，能用哪條就用哪條：**GPS**（訊號好時）、
**真實 OpenStreetMap 地圖點選**（永遠可用）、**照片辨識**（有牌子時）。
全部失敗也不擋回報——位置永遠不是通報的前提。

## 快速開始

### 單一埠號模式（推薦：方便穿 Cloudflare Tunnel / 反向代理）

```bash
# 1. build 前端
cd client && npm install && npm run build

# 2. 啟動後端 :3000（同時服務 API 與前端靜態檔）
cd ../server && npm install && npm start

# 3. 穿出去（擇一）
cloudflared tunnel --url http://localhost:3000
```

打開輸出的 URL 即為回報頁；`#/situation` 為態勢卡；`#/confirm` 為確認頁。

### 開發模式（HMR，兩個 port）

```bash
cd server && npm start        # :3000
cd client && npm run dev      # :5173，/api 已代理到 :3000
```

## 端到端驗證（不開瀏覽器、不需任何 API 金鑰）

```bash
bash server/test/e2e.sh   # 85 項：場域圖資 → 回報 → 批次 → 確認 → 目擊追蹤 → 疏散 → 列車到站 → ETag 304
```

## 場域圖資（OpenStreetMap）

**836 個地下場域、1356 個出口**（捷運站、地下街、地下停車場、百貨；含日本關西），由 OSM 離線產生後進版控——
server 執行時完全不碰外部網路。

資料改由**本機解析 Geofabrik 抽取檔**產生，不再打 Overpass：公開實例只有
2 個併發槽，補方向地標需要上百次查詢會被反覆限流；本機解析全台 **101 秒**跑完、
零限流、且能一次看到所有標籤。

```bash
# 1. 下載區域抽取檔（一次即可）
curl -O https://download.geofabrik.de/asia/taiwan-latest.osm.pbf

# 2. 抽取 → 建表
node server/scripts/extract-osm.mjs taiwan-latest.osm.pbf /tmp/tw.json --survey
node server/scripts/build-venues.mjs /tmp/tw.json
```

資料授權：© OpenStreetMap contributors（ODbL）。詳見 `LICENSE`。

## 官方捷運資料（TDX）

台北捷運的部分改用**交通部 TDX 官方資料**覆蓋 OSM 的志工推測值，同樣是離線快照：

| 資料集 | 用途 | 覆蓋 |
|---|---|---|
| `StationExit` | 出口的樓梯／電扶梯／電梯旗標與官方方位描述 | 437 出口，無障礙資訊 **100%**（OSM 僅 42%） |
| `S2STravelTime` | 站間官方行車秒數 | 173 段——「還有多久到站」唯一可信的來源 |
| `StationOfRoute` | **有方向的**站序 | 22 條路線，推算「下一站」的依據 |

另從政府資料開放平臺取 [dataset 128416](https://data.gov.tw/dataset/128416)
（臺北捷運車站無障礙設施資料）的兩個欄位：

| 欄位 | 用途 |
|---|---|
| `Doors_Open_Side` | 逐站（必要時逐方向）左／右開門 → 車廂內「往哪一側車門移動」 |
| `Reserved_Spaces_for_Wheelchairs` | 輪椅席在第幾節車廂 → 無障礙疏散 |

### 為什麼不做「第幾節車廂離樓梯最近」

日本的乗換案内類 App 有這功能，所以直覺上台灣也該有。查證後確認**沒有開放資料**：

- 日本 ODPT / 東京メトロ / JR東 都沒有。Yahoo!、ジョルダン 的「何号車が便利」
  是向**株式会社ナビット購買**的人工實地調查資料（ジョルダン 2022-09-30 新聞稿明載）
- TDX 整份 spec 沒有「月台門」「車廂位置」任何欄位
- OSM 的 `railway:platform:section`（歐洲月台分區標籤）全台灣 **0 筆**
- 台北捷運Go App 確實有此功能（2024-07-14 北市府新聞稿），但資料不在
  30 個開放 dataset 也不在 TDX，需另行申請北捷 API

與其猜一個「往第 3 節走」而在錯的時候把人推向危險，這裡改用**開門側**——
官方公開、逐站正確，而且不需要知道車廂編號就能執行。

```bash
node server/scripts/fetch-tdx.mjs          # 產生 tdx-trtc.json 快照
node server/scripts/build-venues.mjs --network-only   # 只重算路網，不重跑 OSM
```

TDX 比 OSM 更新頻繁，所以路網更新與場域重建是**解耦的**——前者幾秒鐘，
後者要重新下載數百 MB 的 PBF。

**合併規則是聯集，不是取代**：TDX 只涵蓋北捷（TRTC），台北車站在 OSM 有 27 個出口
（含站前地下街的 Y 系列與台鐵／高鐵的 1~5 號），TDX 只列 M 系列 8 個。
兩邊都保留，同編號時以 TDX 為準。

## 視覺辨識供應商

`VISION_PROVIDER` 決定用誰，缺對應金鑰時**自動失效並落回降級形狀**——
所以沒有任何金鑰時整個專案照樣跑完（e2e 74 項即在該狀態下驗證）。

| provider | 模型 | 實測延遲 | 模式 |
|---|---|---|---|
| `gmi` | MiniMaxAI/MiniMax-M3（GMI Cloud 閘道） | locate 1.9s／read（裁切後）1.8s | interactive |
| `openai` | gpt-4o-mini | 1~2s | interactive |
| `opencode` | 免費層 reasoning model | 34.5s | deferred |
| `none` | — | — | 全程降級 |

```bash
GMI_API_KEY=... VISION_PROVIDER=gmi VISION_MODEL=MiniMaxAI/MiniMax-M3 npm start
```

裁切的效果實測很明顯：同一張站廳照，整圖讀字 5.2 秒、裁出九宮格的那一格
只要 1.8 秒，而且只回該格的字。這就是兩段式（locate → 裁切 → read）的理由。

⚠️ `/api/vision` 無認證且會轉發到付費 API，所以一律經過限流
（每來源 12 次/分、全域 120 次/分）。超限時回**降級形狀而非 429**：
視覺辨識是選配加值，通報流程不該因為限流而失敗。

## 授權與資料來源

| 項目 | 授權 |
|---|---|
| 程式碼 | MIT（見 `LICENSE`） |
| `server/src/data/venues.json` | ODbL —— OpenStreetMap 衍生資料庫，© OpenStreetMap contributors |
| 底圖圖磚 | 官方 OpenStreetMap 圖磚（`tile.openstreetmap.org`） |
| `server/src/data/tdx-trtc.json` | 交通部運輸資料流通服務平臺（TDX）開放資料 |

### 第三方相依

| 套件 | 用途 |
|---|---|
| React 18 + Vite | 前端框架與建置 |
| Express 4 | 後端 HTTP |
| Leaflet 1.9 | 地圖繪製 |

外部服務：Overpass API（離線建表用，執行時不呼叫）、
OpenAI gpt-4o-mini Vision（選配；未設金鑰時自動停用，功能靜默降級）。

## 文件

- `doc/ARCHITECTURE.md` —— 架構、狀態機、模組地圖、API 契約
- `doc/DEVLOG.md` —— 版本開發過程與關鍵決策
- `doc/STATUS.md` —— 功能矩陣（完成 / stub / 計畫中）

## 技術

React + Vite PWA（client）· Node + Express（server）· 記憶體儲存（store 介面化，
日後換 Redis/PG 零改動業務層）。

**AI 的位置**：事件狀態機、態勢卡、避難建議、疏散距離、場域與出口解析
全部是確定性程式碼。AI 只負責兩件它真的做得到的事——
「照片哪一格有牌子」與「牌子上寫什麼字」（可插拔 provider，預設
gpt-4o-mini + detail low）；STT/LLM 仍為 stub。

所有 advisor 失敗、逾時或未設定時回傳同一種降級形狀，呼叫端無從分辨，
因此 AI 永遠不可能擋住一筆回報——**不設任何金鑰也能跑完整條流程**
（`server/test/e2e.sh` 85 項檢查即在無金鑰環境下驗證）。

### 選配：啟用 Vision 辨識

```bash
export OPENAI_API_KEY=sk-...      # 未設定 → 自動走 none provider，功能靜默停用
export VISION_MODEL=gpt-4o-mini   # 選配，預設值
```

⚠️ `/api/vision` 目前無認證、無限流（Phase 2 項目）。公開穿 tunnel 前請先補上
防濫用，否則等同對外開放一個免費的 Vision API 代理。
