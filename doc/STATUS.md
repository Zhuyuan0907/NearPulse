# NearPulse 功能整體狀況（STATUS）

> ✅ 完成 · 🔶 stub / 介面預留 · ⬜ 計畫中
> 對應版本：v0.1.0（2026-09-04）

## 回報端（client）

| 功能 | 狀態 | 說明 |
|---|---|---|
| 四類型狀態機大按鈕（火警/急救/推擠/其他） | ✅ | 首屏直達，1 次點擊 |
| UUID 冪等鍵（防恐慌連點） | ✅ | client 產 UUID + server 去重 |
| L1 GPS 一次查詢 | ✅ | accuracy 檢查；此版不反查站點 |
| L2 session 位置記憶（30 分鐘） | ✅ | sessionStorage，關頁即滅 |
| L3 路網圖手選（兩層、零打字） | ✅ | subset 路網；正式版換完整 JSON |
| GPS 座標反查最近站點 | ⬜ | 需站點座標圖資 |
| 歸屬確認（同一件/另一件） | ✅ | `GET /api/reports/context` 比對 |
| hold-to-talk 語音（選配補充） | ✅ | MediaRecorder 上傳制（iOS 相容） |
| 照片壓縮上傳（選配，<200KB） | ✅ | canvas 1000px / q0.7 |
| 樂觀 UI「已通報」 | ✅ | 不等批次、不問 AI 結果 |
| Service Worker 離線殼 | ⬜ | 設計採「有網路」假設，暫緩 |

## 確認循環（client + server）

| 功能 | 狀態 | 說明 |
|---|---|---|
| 兩段式確認（在場嗎 → 有看到嗎） | ✅ | 未在場者的否證不計入 |
| 一 session 一票去重 | ✅ | server 端強制 |
| deep link `#/confirm?event=` | ✅ | 未來 Web Push 點擊目標 |
| 徵詢區塊（candidate 低調語氣） | ✅ | 態勢卡 `pending` 區塊 |
| Web Push（VAPID） | ⬜ | Phase 2；iOS 需加主畫面 |
| 推播圈定（依位置過濾接收者） | ⬜ | 無持久側寫，靠廣域 + 自我篩選 |

## 批次分群（server）

| 功能 | 狀態 | 說明 |
|---|---|---|
| 10 秒批次 worker | ✅ | 歸屬 → 門檻 → 狀態機 → 卡片重算 |
| 同站同類型自動歸屬 | ✅ | candidate/active 才可比對 |
| 獨立正向計數（sessionId 去重） | ✅ | 回報 + 在場見證票聯集 |
| 嚴重度分級門檻（火警/急救 2、其他 3） | ✅ | `config.eventTypes` |
| 否證否決（在場 ≥3 且多於正向 → 取消） | ✅ | 防殭屍假事件 |
| candidate 超時取消（15 分鐘） | ✅ | 可調 |
| 45 分鐘凍結 | ✅ | closingNotice 收尾文字 |
| 位置聲明加權（confidence 影響計分） | 🔶 | 目前 gps/manual/session 都計正向，權重細化為 Phase 2 |
| 凍結後產出 Markdown 報告書 | ⬜ | 設計規格，未實作 |

## AI Pipeline（server）

| 功能 | 狀態 | 說明 |
|---|---|---|
| STT（Whisper） | 🔶 | 介面 + stub；上傳路徑已通 |
| Vision（照片驗證/標籤） | 🔶 | 介面 + stub |
| LLM 敘事（時間線） | 🔶 | stub 為確定性字串 |
| 確定性避難建議（模板） | ✅ | 零 AI、零延遲——降級路徑即主路徑 |
| AI 完全不在關鍵路徑 | ✅ | advisor fire-and-forget，失敗不影響狀態機 |

## 讀取端（client + server）

| 功能 | 狀態 | 說明 |
|---|---|---|
| 態勢卡（<50KB JSON） | ✅ | worker 預算 + 大小預警 |
| ETag / 304 輪詢 | ✅ | 12 秒；命中零傳輸 |
| 前台才輪詢（Page Visibility） | ✅ | 背景零請求 |
| 警示/徵詢語氣分級呈現 | ✅ | threatLevel 徽章 + 區塊分離 |
| 讀取端獨立輕量 bundle | ⬜ | 目前同 bundle；拆分為 Phase 2 |
| SSE 串流 | ⬜ | 設計結論：ETag 輪詢為主 |

## 基礎設施

| 功能 | 狀態 | 說明 |
|---|---|---|
| 記憶體儲存（store 介面） | ✅ | 重啟即清；介面穩定 |
| Redis Stream / Postgres | ⬜ | 換 store 實作即可 |
| Rate limiter | ⬜ | Phase 2（config 已預留 limits） |
| PWA manifest（可安裝） | ✅ | iOS 加主畫面即得推播資格 |
| 端到端 API 測試腳本 | ✅ | `server/test/e2e.sh`（curl 全流程驗證） |

## 約束遵循（設計原則 → 實作檢查）

- 零打字：✅ 全 UI 無鍵盤輸入欄位
- 零 GPS 依賴：✅ L3 手選為最終仲裁
- 無持久個資：✅ 僅 sessionStorage（關頁即滅）
- 不依賴 Cell-ID/BLE/背景執行：✅ 未使用任何不可得 API
