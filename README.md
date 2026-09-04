# NearPulse

地下通勤場域的非同步災情儀表板——極簡寫入、批次聚合、超輕量讀取。

恐慌當下 3 次點擊完成回報；10 秒批次分群；兩段式現場確認交叉驗證；
讀取端態勢卡 < 50KB、ETag 304、前台才輪詢。零帳號、零打字、零 GPS 依賴。

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

## 端到端驗證（不開瀏覽器）

```bash
bash server/test/e2e.sh   # 回報 → 批次 → 確認 → 升級 → ETag 304 全流程
```

## 文件

- `doc/ARCHITECTURE.md` —— 架構、狀態機、模組地圖、API 契約
- `doc/DEVLOG.md` —— 版本開發過程與關鍵決策
- `doc/STATUS.md` —— 功能矩陣（完成 / stub / 計畫中）

## 技術

React + Vite PWA（client）· Node + Express（server）· 記憶體儲存（store 介面化，
日後換 Redis/PG 零改動業務層）· AI advisor（STT/Vision/LLM）為介面 + stub，
事件狀態機完全確定性——AI 不在生命安全資訊的關鍵路徑上。
