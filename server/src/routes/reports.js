/**
 * ============================================================================
 * POST /api/reports —— 回報 ingest 路由
 * ============================================================================
 * 契約重點：
 *   1. 冪等：同一 UUID 重送 → 回傳與第一次相同的結果（防恐慌連點）
 *   2. 「已通報」不等於「已確認」——回應中的 status 是事件當下狀態，
 *      讓客戶端誠實顯示「已記錄，等待現場其他人確認」
 */

import { Router } from 'express';
import { validateReport, normalizeReport } from '../services/reportService.js';
import { toEventSummary } from '../services/eventService.js';

export function createReportsRouter(store) {
  const router = Router();

  router.post('/', (req, res) => {
    const { ok, errors } = validateReport(req.body ?? {});
    if (!ok) {
      return res.status(400).json({ ok: false, errors });
    }

    // ---- photoRef 還原：照片已在 /api/vision 上傳過，這裡取回即可 ----
    // 取不到（過期／server 重啟／偽造 ref）就當作沒附照片——照片是選配，不擋回報。
    if (!req.body.photo && req.body.photoRef) {
      const cached = store.takePhoto(req.body.photoRef);
      if (cached) req.body.photo = cached;
    }

    // ---- 冪等檢查：同一 UUID 直接回上次的結果 ----
    const ingested = store.ingestReport(normalizeReport(req.body));
    if (!ingested.newReport) {
      return res.status(200).json(ingested.previousResult);
    }

    // ---- 組回應並記住（之後重送同一 UUID 會拿到一模一樣的內容） ----
    // 注意：歸屬到哪個事件要等下一個批次 tick 才確定（架構：非同步批次），
    // 這裡先回「已入列」，客戶端之後從態勢卡/事件查詢看到歸屬結果。
    const result = {
      ok: true,
      received: true,
      message: '已記錄。系統將於數秒內進行分群，若現場有其他人確認，事件將升級顯示。',
    };
    store.rememberReportResult(req.body.uuid, result);

    store.markCardDirty();
    return res.status(202).json(result);
  });

  /** 查某站點的進行中事件（供客戶端「同一件/另一件」歸屬確認用） */
  router.get('/context', (req, res) => {
    const stationId = String(req.query.station ?? '');
    const type = String(req.query.type ?? '');
    if (!stationId) return res.status(400).json({ ok: false, error: '缺少 station' });

    const matches = store
      .listEvents()
      .filter(
        (ev) =>
          ev.stationId === stationId &&
          (ev.status === 'candidate' || ev.status === 'active') &&
          (type === '' || ev.type === type)
      )
      .map(toEventSummary);

    res.json({ ok: true, events: matches });
  });

  return router;
}
