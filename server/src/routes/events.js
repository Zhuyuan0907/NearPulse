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
 *
 * 【第三問：他現在在哪】
 * 前兩問決定事件**成不成立**；第三問決定它**往哪裡去**。
 *
 * 移動威脅判定的原料是「(時間, 錨點, 目擊者) 三元組」，而在此之前這些三元組
 * 只能從**新回報**取得——一個剛答完「有，我看到了」的現場目擊者，
 * 明明是全系統最清楚歹徒位置的人，卻沒有任何管道說出來。這是實際的缺口。
 *
 * 所以第三問是 `sighting`：答完見證票後追問「他現在在哪個出口附近」，
 * 一鍵寫進事件軌跡。它和前兩問有三點本質差異：
 *
 *   1. **不是投票，是觀測**——同一個人可以回報多次（歹徒會一直移動），
 *      所以不做一人一票的去重。
 *   2. **不影響事件狀態**——不計入門檻、不參與否證。看錯位置不該讓事件被取消。
 *   3. **仍要求在場**——不在現場的人「覺得他往那邊跑了」會直接污染軌跡，
 *      而軌跡會變成疏散方向建議。這是最不能放寬的一道。
 */

import { Router } from 'express';
import { appendObservation, toEventSummary } from '../services/eventService.js';
import { findVenue } from '../services/venueService.js';
import { assessMotion } from '../services/threatMotion.js';

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
    } else if (step === 'identify') {
      /**
       * 指認位置：**「我認得照片裡的地方」**。
       *
       * 這一步是為了補上一個先前的死路：態勢卡對圖資外的事件寫著
       * 「如果你認得照片裡的地方，請協助確認」，但點進去卻是
       * 「你現在在『位置待確認』嗎？」——一個無意義的問題。
       * 通報者說不出自己在哪，但**看照片的人可能一眼就認出來**，
       * 而系統當時沒有任何管道收下那個答案。
       *
       * 與前三問不同的是：這一步**不要求在場**。認得一個地方不需要人在那裡，
       * 而這正是它的價值——遠方的人也幫得上忙。
       *
       * 安全性：只在事件**還沒有場域**時生效（先到先得），而且一律留下紀錄。
       * 已經有場域的事件不接受覆寫——那會變成一個可以隨意改寫他人通報
       * 位置的介面。
       */
      const { venueId } = req.body ?? {};
      const venue = typeof venueId === 'string' ? findVenue(venueId) : null;
      if (!venue) return res.status(400).json({ ok: false, error: '查無此場域' });

      event.identifications = event.identifications ?? [];
      event.identifications.push({ sessionId, venueId: venue.id, at: Date.now() });

      if (!event.stationId) {
        event.stationId = venue.id;
        event.stationName = venue.name;
        event.placeText = null;
        event.updatedAt = Date.now();
        store.upsertEvent(event);
        store.markCardDirty();
        return res.json({ ok: true, applied: true, event: toEventSummary(event) });
      }

      store.upsertEvent(event);
      // 已經有場域了：紀錄仍然收下（可用於日後的分歧偵測），但不改變事件
      return res.json({ ok: true, applied: false, event: toEventSummary(event) });
    } else if (step === 'sighting') {
      // 在場才收：軌跡會變成「往哪個方向逃」的建議，不能讓不在現場的人污染它
      const locationVote = event.confirmations.find(
        (c) => c.sessionId === sessionId && c.step === 'location'
      );
      const isOnSite = locationVote ? locationVote.atStation === true : atStation === true;
      if (!isOnSite) {
        return res.status(403).json({ ok: false, error: '未確認在場，目擊位置無效' });
      }

      const { nearExitCode, point } = req.body ?? {};
      const validPoint =
        point && Number.isFinite(point.lat) && Number.isFinite(point.lon)
          ? { lat: point.lat, lon: point.lon }
          : null;

      const recorded = appendObservation(event, {
        incidentPoint: validPoint,
        nearExitCode: typeof nearExitCode === 'string' ? nearExitCode : null,
        sessionId,
        at: Date.now(),
      });
      if (!recorded) {
        // 「我說不出是哪個出口」是合理的答案，不是錯誤——照收，只是不進軌跡
        return res.json({ ok: true, recorded: false, event: toEventSummary(event) });
      }

      // **立刻**重算移動判定，不等下一個批次 tick。
      // 歹徒在移動時，10 秒是很長的時間；而這是純函式，重算成本可以忽略。
      event.motion = assessMotion(event.track, Date.now());
      event.updatedAt = Date.now();
      store.upsertEvent(event);
      store.markCardDirty();
      return res.json({
        ok: true,
        recorded: true,
        motion: event.motion,
        event: toEventSummary(event),
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
