/**
 * ============================================================================
 * ConfirmPage —— 兩段式確認頁（Web Push 的 deep link 目標）
 * ============================================================================
 * 流程（否證嚴謹性的關鍵設計）：
 *
 *   第一問：你現在在【站】嗎？ [在] [不在]
 *     └─ 不在 → 回覆記錄（未來修正推播圈定），流程結束
 *   第二問（僅在場者）：你有看到【類型】嗎？ [有] [沒有] [沒注意]
 *     └─ 未確認位置者的「沒有」不算否證（server 端強制）
 *
 * 入口：
 *   #/confirm?event=evt_xxx → 直接進該事件的兩段式流程
 *   #/confirm              → 列出徵詢中事件，讓使用者挑一件來確認
 *                             （MVP 的推播替代通道：搭配態勢卡的 pending 區塊）
 */

import { useEffect, useState } from 'react';
import { fetchEvents, confirmEvent } from '../modules/api.js';
import { resolveLocation } from '../modules/location.js';
import { stationDisplayName } from '../data/stations.js';

export default function ConfirmPage({ eventId }) {
  const [events, setEvents] = useState([]);
  const [target, setTarget] = useState(null); // 目前確認中的事件
  const [step, setStep] = useState(null);      // 'location' | 'witness' | 'done'
  const [finishedMsg, setFinishedMsg] = useState(null);

  // ---- 載入：deep link 直接指名事件，否則列清單 ----
  useEffect(() => {
    (async () => {
      const { claim } = await resolveLocation();
      const list = await fetchEvents(claim?.stationId ?? null);
      setEvents(list);
      if (eventId) {
        const found = list.find((e) => e.id === eventId);
        if (found) {
          setTarget(found);
          setStep('location');
        }
      }
    })();
  }, [eventId]);

  /** 第一問答案 */
  async function answerLocation(atStation) {
    const res = await confirmEvent(target.id, { step: 'location', atStation });
    if (!atStation) {
      setFinishedMsg('收到。若您之後抵達該站，歡迎協助確認。');
      setStep('done');
      return;
    }
    setStep('witness'); // 在場 → 進第二問
  }

  /** 第二問答案（在場者的見證票） */
  async function answerWitness(witnessed) {
    const res = await confirmEvent(target.id, { step: 'witness', atStation: true, witnessed });
    if (res.alreadyVoted) {
      setFinishedMsg('您已經回覆過這個事件了，感謝。');
    } else if (res.event?.status === 'active') {
      setFinishedMsg('感謝確認！事件已升級並顯示在態勢卡上。');
    } else {
      setFinishedMsg('感謝回覆。');
    }
    setStep('done');
  }

  // ===================== 完成畫面 =====================
  if (step === 'done') {
    return (
      <div className="page">
        <div className="done-box">
          <div className="done-icon">🙏</div>
          <h2>{finishedMsg}</h2>
          <div className="done-actions">
            <a className="primary-btn" href="#/situation">查看態勢卡</a>
          </div>
        </div>
      </div>
    );
  }

  // ===================== 兩段式問答 =====================
  if (target) {
    return (
      <div className="page">
        <div className="confirm-box">
          {step === 'location' && (
            <>
              <h2>你現在在 {stationDisplayName(target.stationId)} 嗎？</h2>
              <p className="muted">據回報，附近疑似有【{target.typeLabel}】狀況。</p>
              <div className="confirm-actions">
                <button className="primary-btn big" onClick={() => answerLocation(true)}>在</button>
                <button className="ghost-btn big" onClick={() => answerLocation(false)}>不在</button>
              </div>
            </>
          )}
          {step === 'witness' && (
            <>
              <h2>你有看到【{target.typeLabel}】嗎？</h2>
              <p className="muted">您的回覆將影響事件驗證。</p>
              <div className="confirm-actions">
                <button className="primary-btn big" onClick={() => answerWitness('yes')}>有</button>
                <button className="ghost-btn big" onClick={() => answerWitness('no')}>沒有</button>
                <button className="ghost-btn big" onClick={() => answerWitness('unsure')}>沒注意</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ===================== 事件清單（無 deep link 時） =====================
  return (
    <div className="page">
      <h2 className="headline">需要您協助確認的事件</h2>
      {events.length === 0 && <p className="muted">目前沒有待確認的事件。</p>}
      {events.map((ev) => (
        <button
          key={ev.id}
          className={`event-card ${ev.status === 'active' ? 'event-active' : 'event-candidate'}`}
          onClick={() => { setTarget(ev); setStep('location'); }}
        >
          <div className="event-title">
            {stationDisplayName(ev.stationId)} · {ev.typeLabel}
          </div>
          <div className="muted">
            {ev.status === 'candidate' ? '未經確認 — 需要現場回覆' : '已確認 — 歡迎補充回覆'}
            {' · '}回報 {ev.reportCount} 筆
          </div>
        </button>
      ))}
      <footer className="page-footer">
        <a href="#/situation">查看態勢卡 →</a>
      </footer>
    </div>
  );
}
