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
    await confirmEvent(target.id, { step: 'location', atStation });
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
            <a className="primary-btn btn-lg" href="#/situation">查看態勢卡</a>
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
              <div className="done-icon">📍</div>
              <h2>你現在在 {target.stationName} 嗎？</h2>
              <p className="muted">有人回報這裡疑似發生【{target.typeLabel}】。</p>
              <div className="confirm-actions">
                <button className="primary-btn btn-lg" onClick={() => answerLocation(true)}>在</button>
                <button className="ghost-btn btn-lg" onClick={() => answerLocation(false)}>不在</button>
              </div>
              <p className="muted" style={{ marginTop: 16 }}>
                不在現場的回覆不會計入驗證——這是為了讓「沒看到」真的有意義。
              </p>
            </>
          )}
          {step === 'witness' && (
            <>
              <div className="done-icon">👀</div>
              <h2>你有看到【{target.typeLabel}】嗎？</h2>
              <p className="muted">你的回覆會直接影響這則事件是否成立。</p>
              <div className="confirm-actions" style={{ flexDirection: 'column' }}>
                <button className="primary-btn btn-lg btn-block" onClick={() => answerWitness('yes')}>
                  有，我看到了
                </button>
                <button className="ghost-btn btn-lg btn-block" onClick={() => answerWitness('no')}>
                  沒有，現場正常
                </button>
                <button className="ghost-btn btn-block" onClick={() => answerWitness('unsure')}>
                  不確定 / 沒注意
                </button>
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
      <h1 className="headline">需要現場的人協助確認</h1>
      <p className="subhead">只有在場的人，回答才會被計入。</p>
      {events.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">🟢</div>
          <p>目前沒有待確認的事件</p>
        </div>
      )}
      {events.map((ev) => (
        <button
          key={ev.id}
          className="pending-btn"
          onClick={() => { setTarget(ev); setStep('location'); }}
        >
          <div className="event-title" style={{ fontSize: '1rem' }}>
            {ev.stationName} · {ev.typeLabel}
            <span className={`threat threat-${ev.status === 'active' ? 'high' : 'unverified'}`}>
              {ev.status === 'candidate' ? '未經確認' : '已確認'}
            </span>
          </div>
          <div className="muted">
            {ev.status === 'candidate' ? '需要現場回覆' : '歡迎補充回覆'} · 回報 {ev.reportCount} 筆 →
          </div>
        </button>
      ))}
      <footer className="page-footer">
        <a href="#/situation">查看態勢卡 →</a>
      </footer>
    </div>
  );
}
