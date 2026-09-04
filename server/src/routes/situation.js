/**
 * ============================================================================
 * GET /api/situation —— 態勢卡路由（ETag 輪詢讀取端）
 * ============================================================================
 * 「極輕量讀取」的落實：
 *   - 內容由批次 worker 預先算好，這裡零計算、直接回快取
 *   - ETag 比對：If-None-Match 命中 → 304（無 body），
 *     客戶端 10-15 秒輪詢一次時，絕大多數請求都是 304，基地台成本趨近於零
 */

import { Router } from 'express';

export function createSituationRouter(store) {
  const router = Router();

  router.get('/', (req, res) => {
    const cached = store.getCard();
    if (!cached) {
      // worker 尚未跑完第一個 tick 的空窗期
      return res.status(503).json({ ok: false, error: '態勢卡尚未就緒' });
    }

    const { card, etag, bytes } = cached;

    // ---- ETag 命中 → 304 Not Modified（無 body，最省頻寬） ----
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).set('ETag', etag).end();
    }

    res
      .set('ETag', etag)
      .set('X-Card-Bytes', String(bytes))
      .set('Cache-Control', 'no-cache') // ETag 比對每次都要問，但不存本體
      .json({ ok: true, ...card });
  });

  return router;
}
