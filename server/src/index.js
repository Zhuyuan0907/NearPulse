/**
 * ============================================================================
 * NearPulse server —— 應用程式進入點
 * ============================================================================
 * 啟動順序：
 *   1. 建立 store（MVP: 記憶體；日後換 Redis/PG）
 *   2. 啟動 10 秒批次 worker（歸屬 → 門檻 → 狀態機 → 態勢卡重算）
 *   3. 掛載路由：/api/reports, /api/events, /api/situation
 *
 * 開發時 vite dev server（5173）會把 /api 代理到這裡（見 client/vite.config.js）。
 */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { config } from './config.js';
import { createStore } from './store/index.js';
import { startBatchWorker } from './pipeline/batchWorker.js';
import { createReportsRouter } from './routes/reports.js';
import { createEventsRouter } from './routes/events.js';
import { createSituationRouter } from './routes/situation.js';

const app = express();

// JSON 上限放大：附件（語音/照片）以 base64 內嵌在 JSON 中
app.use(express.json({ limit: '12mb' }));

const store = createStore();

// ---- 路由掛載 ----
app.use('/api/reports', createReportsRouter(store));
app.use('/api/events', createEventsRouter(store));
app.use('/api/situation', createSituationRouter(store));

// ---- 健康檢查（部署與測試用） ----
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ============================================================================
   單一埠號模式（:3000 同時服務 API 與前端靜態檔）
   ============================================================================
   目的：方便透過 Cloudflare Tunnel 等反向代理「一個 port 穿出去」。
   前端靜態檔來自 client 的 build 產物（client/dist），
   SPA fallback 回 index.html（hash 路由其實不需要，但保險起見）。
   開發時的 HMR 仍然走 `cd client && npm run dev`（:5173 + /api 代理）。
============================================================================ */

const clientDist = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../client/dist'
);

// 未 build 的 /api 路徑必須回 404 JSON（不能落進 SPA fallback）
app.use('/api', (_req, res) => res.status(404).json({ ok: false, error: '未知的 API 路徑' }));

if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
} else {
  console.warn('[nearpulse] 找不到 client/dist——只提供 API（先執行 cd client && npm run build）');
}

// ---- 啟動批次 worker ----
startBatchWorker(store);

app.listen(config.port, () => {
  console.log(`[nearpulse] server 啟動於 :${config.port}`);
  console.log(`[nearpulse] 批次間隔 ${config.batchIntervalMs / 1000}s、` +
    `凍結 ${config.freezeAfterMinutes}min、candidate TTL ${config.candidateTtlMinutes}min`);
});
