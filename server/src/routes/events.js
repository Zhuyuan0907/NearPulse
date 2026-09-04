/**
 * ============================================================================
 * 事件確認路由（兩段式確認的伺服器端）
 * ============================================================================
 * 兩段式流程（與客戶端 ConfirmPage 對應）：
 *
 *   第一問：你現在在 X 站嗎？ [在] [不在]
 *     └─ 不在 → 記錄 locationFeedback（未來用於修正推播圈定），流程結束
 *   第二問（僅在場者）：你有看到【類型】嗎？ [有] [沒有] [沒注意]
 *     └─ 在場的「有/沒有」計入門檻與否證規則
 *         [有] ×N（獨立 session）→ 達門檻 → active
 *         [沒有] ×N（在場）且多於正向 → cancelled
 *
 * 同一 session 對同一事件只算一票（重複投票被忽略）。
 */

import { Router } from 'express';
import { toEventSummary } from '../services/eventService.js';

export function createEventsRouter(store) {
  const router = Router();

  /** 取得可確認的事件清單（deep link ?event= 的清單來源） */
  router.get('/', (req, res) => {
    const stationId = String(req.query.station ?? '');
    let events = store.listEvents().filter(
      (ev) => ev.status === 'candidate' || ev.status === 'active'
    );
    if (stationId) events = events.filter((ev) => ev.stationId === stationId);
    res.json({ ok: true, events: events.map(toEventSummary) });
  });

  router.get('/:id', (req, res) => {
    const event = store.getEvent(req.params.id);
    if (!event) return res.status(404).json({ ok: false, error: '事件不存在' });
    res.json({ ok: true, event: toEventSummary(event) });
  });

  /**
   * 提交確認回覆。
   * body: {
   *   sessionId: string,            // 一人一票的去重鍵
   *   step: 'location'|'witness',  // 第一問／第二問
   *   atStation: boolean,          // 第一問答案（在/不在）
   *   witnessed?: 'yes'|'no'|'unsure' // 第二問答案
   * }
   */
  router.post('/:id/confirm', (req, res) => {
    const event = store.getEvent(req.params.id);
    if (!event) return res.status(404).json({ ok: false, error: '事件不存在' });
    if (event.status !== 'candidate' && event.status !== 'active') {
      return res.status(409).json({ ok: false, error: `事件已結束（${event.status}）` });
    }

    const { sessionId, step, atStation, witnessed } = req.body ?? {};
    if (!sessionId) return res.status(400).json({ ok: false, error: '缺少 sessionId' });

    // ---- 一 session 針對「每一問」各一票（location / witness 分開去重） ----
    const hasVoted = (s) =>
      event.confirmations.some((c) => c.sessionId === sessionId && c.step === s);

    if (step === 'location') {
      if (hasVoted('location')) {
        return res.json({ ok: true, alreadyVoted: true, event: toEventSummary(event) });
      }
      // 第一問：只記錄在場與否（不在場者的後續「沒看到」不算否證）
      event.confirmations.push({
        sessionId,
        step: 'location',
        atStation: Boolean(atStation),
        witnessed: null,
        at: Date.now(),
      });
    } else if (step === 'witness') {
      if (hasVoted('witness')) {
        return res.json({ ok: true, alreadyVoted: true, event: toEventSummary(event) });
      }
      // 在場判定：第一問已答「在」，或本請求直接帶 atStation=true（單步 deep link 場景）
      const locationVote = event.confirmations.find(
        (c) => c.sessionId === sessionId && c.step === 'location'
      );
      const isOnSite = locationVote ? locationVote.atStation === true : atStation === true;
      if (!isOnSite) {
        return res.status(403).json({ ok: false, error: '未確認在場，見證票無效' });
      }
      event.confirmations.push({
        sessionId,
        step: 'witness',
        atStation: true,
        witnessed: ['yes', 'no', 'unsure'].includes(witnessed) ? witnessed : 'unsure',
        at: Date.now(),
      });
    } else {
      return res.status(400).json({ ok: false, error: '不支援的 step' });
    }

    event.updatedAt = Date.now(); // 有互動 → 重置凍結計時
    store.upsertEvent(event);
    store.markCardDirty();

    res.json({ ok: true, event: toEventSummary(event) });
  });

  return router;
}
