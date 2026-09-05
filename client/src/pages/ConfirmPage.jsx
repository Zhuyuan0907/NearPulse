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
 *   第三問（僅答「有看到」者）：他現在在哪？ [出口大按鈕] [說不出來]
 *     └─ 寫進事件軌跡 → 移動方向判定 → 疏散建議會避開他前進的方向
 *
 * 【為什麼要有第三問】
 * 前兩問決定事件成不成立；第三問決定它**往哪裡去**。
 * 在此之前，移動軌跡只能靠「有人再送一次完整回報」累積——但一個剛答完
 * 「有，我看到了」的現場目擊者，明明是全系統最清楚歹徒位置的人，
 * 卻要重走一次回報流程才能說出來。那等於沒有管道。
 *
 * 它刻意設計成**可以答很多次**：歹徒會一直移動，一次目擊不是一張票，
 * 是一個時間點的觀測。同一個人的兩個點不會被當成移動證據
 *（server 的 threatMotion 會排除），所以重複回報是安全的。
 *
 * 入口：
 *   #/confirm?event=evt_xxx → 直接進該事件的兩段式流程
 *   #/confirm              → 列出徵詢中事件，讓使用者挑一件來確認
 *                             （MVP 的推播替代通道：搭配態勢卡的 pending 區塊）
 */

import { useEffect, useState } from 'react';
import { fetchEvents, fetchEvent, confirmEvent, fetchVenue } from '../modules/api.js';
import { resolveLocation } from '../modules/location.js';
import Pictogram from '../components/Pictogram.jsx';

/** 等距圓柱近似——站體尺度（<1km）下誤差可忽略，只用來排序 */
function roughDistM(a, b) {
  const k = 111_320;
  return Math.hypot(
    (a.lat - b.lat) * k,
    (a.lon - b.lon) * k * Math.cos((a.lat * Math.PI) / 180)
  );
}

/**
 * 把出口依「離威脅上次已知位置的距離」排序。
 *
 * 台北車站有 27 個出口，而且 1、2、3 號的地標全是「往市民大道」——
 * 平鋪成一長串時，恐慌中要捲過 27 個幾乎一樣的項目才找得到要點的那個。
 *
 * 但回報者要說的位置**多半就在歹徒上次出現的附近**（人不會瞬移）。
 * 用上次已知位置排序，常見情況就變成「第一個或第二個就是」。
 * 優先序：最近一次目擊 → 事件錨點出口 → 場域中心。
 */
function exitsNearestFirst(venue, event) {
  const exits = venue?.exits ?? [];
  const anchor =
    event?.motion?.to ??
    exits.find((e) => e.code === event?.nearExitCode) ??
    (venue ? { lat: venue.lat, lon: venue.lon } : null);
  if (!anchor || !Number.isFinite(anchor.lat)) return exits;

  return [...exits].sort((a, b) => roughDistM(anchor, a) - roughDistM(anchor, b));
}

export default function ConfirmPage({ eventId }) {
  const [events, setEvents] = useState([]);
  const [target, setTarget] = useState(null); // 目前確認中的事件
  const [step, setStep] = useState(null);      // 'location' | 'witness' | 'sighting' | 'done'
  const [finishedMsg, setFinishedMsg] = useState(null);
  const [venue, setVenue] = useState(null);    // 第三問的出口按鈕來源
  const [sightingMsg, setSightingMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notFound, setNotFound] = useState(false);

  // ---- 載入：deep link 直接指名事件，否則列清單 ----
  useEffect(() => {
    (async () => {
      // deep link 直接查那一則事件——不從清單裡撈。
      // 清單依「你目前所在場域」過濾，而要你協助確認的事件通常在別站。
      if (eventId) {
        const found = await fetchEvent(eventId);
        if (found) {
          setTarget(found);
          setStep('location');
          fetchVenue(found.stationId).then(setVenue);
          return;
        }
        // 查無此事件（可能已經結案）——落回清單，並說明原因
        setNotFound(true);
      }

      const { claim } = await resolveLocation();
      let list = await fetchEvents(claim?.stationId ?? null);
      // 依所在場域過濾後空了，就改列全部：一個神祕的空畫面比一份較長的清單糟
      if (list.length === 0 && claim?.stationId) list = await fetchEvents(null);
      setEvents(list);
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

    if (res.alreadyVoted) setFinishedMsg('您已經回覆過這個事件了，感謝。');
    else if (res.event?.status === 'active') setFinishedMsg('感謝確認！事件已顯示在態勢卡上。');
    else setFinishedMsg('感謝回覆。');

    // 只有「有看到」的人才問位置。答「沒看到」的人問他歹徒在哪是沒有意義的，
    // 而且會把一個乾淨的否證票變成一次可疑的觀測。
    if (witnessed === 'yes' && venue?.exits?.length > 0) {
      setStep('sighting');
      return;
    }
    setStep('done');
  }

  /**
   * 第三問答案：目擊到的位置。
   * 送出後**不離開這一頁**——歹徒會繼續移動，使用者可能要連續回報好幾次。
   */
  async function answerSighting(nearExitCode) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await confirmEvent(target.id, {
        step: 'sighting', atStation: true, nearExitCode,
      });
      const m = res.motion;
      setSightingMsg(
        !res.recorded
          ? '收到。'
          : m?.moving
            ? `已記錄。系統判定威脅移動中${m.compass ? `，往${m.compass}方` : ''}——疏散建議已避開該方向。`
            : '已記錄。還需要另一位目擊者在不同位置回報，才能判定移動方向。'
      );
    } finally {
      setBusy(false);
    }
  }

  // ===================== 完成畫面 =====================
  if (step === 'done') {
    return (
      <div className="page">
        <div className="done-box">
          <div className="done-icon done-icon-ok">✓</div>
          <h2>{finishedMsg}</h2>
          <div className="done-actions">
            <a className="primary-btn btn-lg" href="#/situation">查看目前狀況</a>
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
              <Pictogram name="pin" size={40} className="done-icon" />
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
          {step === 'sighting' && (
            <>
              <Pictogram name="pin" size={40} className="done-icon" />
              <h2>他現在在哪？</h2>
              <p className="muted">
                點最接近的出口就好。這會決定其他人的疏散方向要避開哪一邊。
                <br />
                <span className="muted-2">出口依「離他上次出現的位置」由近而遠排列。</span>
              </p>
              {/* 出口編號放最前面、字大——站內指標系統就是用編號導引的，
                  使用者抬頭就能接上。與態勢卡的疏散區塊刻意用同一套呈現。 */}
              <div className="sighting-exits">
                {exitsNearestFirst(venue, target).map((e) => (
                  <button
                    key={e.code}
                    className="sighting-exit"
                    disabled={busy}
                    onClick={() => answerSighting(e.code)}
                  >
                    <span className="sighting-code">{e.code}</span>
                    <span className="sighting-where">
                      {e.landmark ? `往 ${e.landmark}` : '出口'}
                    </span>
                  </button>
                ))}
              </div>

              {sightingMsg && <p className="sighting-msg">{sightingMsg}</p>}

              <p className="muted" style={{ marginTop: 14 }}>
                他移動了就再點一次——可以回報多次。
              </p>
              <div className="confirm-actions" style={{ flexDirection: 'column', marginTop: 10 }}>
                <button className="ghost-btn btn-block" onClick={() => setStep('done')}>
                  說不出是哪個出口 / 完成
                </button>
              </div>
            </>
          )}
          {step === 'witness' && (
            <>
              <Pictogram name="sighting" size={40} className="done-icon" />
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
      {notFound && (
        <div className="notice notice-warn">
          那則事件已經結案或不存在了。以下是目前還需要確認的事件。
        </div>
      )}
      {events.length === 0 && (
        <div className="empty-state">
          <p className="empty-line">目前沒有待確認的事件</p>
        </div>
      )}
      {events.map((ev) => (
        <button
          key={ev.id}
          className="pending-btn"
          onClick={() => {
            setTarget(ev);
            setStep('location');
            // 先抓場域圖資：使用者答到第三問時出口按鈕已經在了
            fetchVenue(ev.stationId).then(setVenue);
          }}
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
        <a href="#/situation">查看目前狀況</a>
      </footer>
    </div>
  );
}
