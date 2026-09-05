/**
 * ============================================================================
 * POST /api/vision —— 照片視覺錨點分析（同步、快速降級）
 * ============================================================================
 * 兩階段，由 client 分兩次呼叫（stage 參數）：
 *
 *   stage=locate —— 送整張壓縮圖，問「哪一格有可辨識地點的牌子」
 *                   回 roiCell 供 UI 預先高亮；使用者可自行改點別格
 *   stage=read   —— 送**從原圖裁出的那一格**（解析度高得多），只讀字
 *                   讀到的字交給 venueService 確定性查表 → 場域 + 出口 + 座標
 *
 * 為什麼分兩次而不是一次問完：整張圖在 detail:low 會被降到 512px，
 * 出口牌上的字只有 20~40px 高；裁切後同一塊牌子可達 120px 以上。
 * 多一次呼叫換來能不能讀得到字的差別，而 low detail 每次成本趨近於零。
 *
 * 非阻塞：前端不等這個結果也能送出回報——分析只是建議。
 *
 * 【限流】
 * 本端點無認證，而它會轉發到**付費的** Vision API——公開部署等同對外開放一個
 * 免費的 Vision 代理。因此接上真實金鑰後一律經過 rateLimit：
 * 每來源每分鐘 12 次（一次回報最多用 2 次），全域每分鐘 120 次保護額度上限。
 *
 * 超限時**回降級形狀而不是 429**：視覺辨識是選配加值，回報流程沒有它照樣走完，
 * 所以呼叫端不需要、也不應該分辨「被限流」與「AI 沒開」。
 * 使用者的通報永遠不會因為限流而失敗。
 */

import { Router } from 'express';
import { config } from '../config.js';
import { analyzePhoto, isVisionEnabled, visionMode } from '../pipeline/advisors/vision.js';
import { resolveAnchors } from '../services/venueService.js';
import { createRateLimiter, clientKey } from './rateLimit.js';

export function createVisionRouter(store) {
  const router = Router();
  const rateLimit = createRateLimiter({
    perIp: Number(process.env.VISION_RATE_PER_IP ?? 12),
    global: Number(process.env.VISION_RATE_GLOBAL ?? 120),
  });

  router.post('/', async (req, res) => {
    const { base64, mimeType, venueId, stage, lat, lon } = req.body ?? {};

    if (!base64 || typeof base64 !== 'string') {
      return res.status(400).json({ ok: false, error: '缺少照片（base64）' });
    }
    if (base64.length > config.limits.maxPhotoBase64) {
      return res.status(413).json({ ok: false, error: '照片過大（請先壓縮）' });
    }

    const safeMime = typeof mimeType === 'string' ? mimeType : 'image/webp';
    const safeStage = stage === 'read' ? 'read' : 'locate';

    // 超限就不呼叫供應商，直接走與「AI 沒開」相同的降級路徑（見檔頭說明）
    const gate = rateLimit(clientKey(req));
    const result = gate.allowed
      ? await analyzePhoto({ base64, mimeType: safeMime, stage: safeStage })
      : { pending: true, roiCell: null, texts: [], anomalies: [], rateLimited: gate.reason };

    // 讀字階段才做錨點解析——把「牌子上的字」變成「場域 + 出口 + 座標」。
    // 這一步是確定性查表，不是 AI 推論。
    const anchors =
      safeStage === 'read'
        ? resolveAnchors({
            texts: result.texts,
            venueId: typeof venueId === 'string' ? venueId : null,
            near:
              Number.isFinite(lat) && Number.isFinite(lon) ? { lat: Number(lat), lon: Number(lon) } : null,
          })
        : { candidates: [] };

    // 只在定位階段暫存整張圖：回報帶 photoRef 即可，不必再上傳一次
    const photoRef = safeStage === 'locate' ? store.putPhoto({ base64, mimeType: safeMime }) : null;

    res.json({
      ok: true,
      stage: safeStage,
      enabled: isVisionEnabled(),
      // 'interactive' | 'deferred' | 'off'——前端據此決定要不要等結果
      mode: visionMode(),
      result,
      candidates: anchors.candidates,
      photoRef,
    });
  });

  return router;
}
