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
bash server/test/e2e.sh   # 24 項：場域圖資 → 回報 → 批次 → 確認 → 升級 → 疏散 → ETag 304
```

## 場域圖資（OpenStreetMap）

全台 519 個地下場域、614 個出口，由 OSM 離線產生後進版控——server 執行時
完全不碰外部網路。需要更新時：

```bash
node server/scripts/build-venues.mjs            # 全台灣（分區查詢 Overpass）
node server/scripts/build-venues.mjs --taipei   # 只做台北（快速驗證）
```

資料授權：© OpenStreetMap contributors（ODbL）。

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
（`server/test/e2e.sh` 24 項檢查即在無金鑰環境下驗證）。

### 選配：啟用 Vision 辨識

```bash
export OPENAI_API_KEY=sk-...      # 未設定 → 自動走 none provider，功能靜默停用
export VISION_MODEL=gpt-4o-mini   # 選配，預設值
```

⚠️ `/api/vision` 目前無認證、無限流（Phase 2 項目）。公開穿 tunnel 前請先補上
防濫用，否則等同對外開放一個免費的 Vision API 代理。
