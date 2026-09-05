/**
 * ============================================================================
 * SituationPage —— 讀取端：目前狀況
 * ============================================================================
 * 「弱網優先」的落實：
 *   - 內容是後端預先算好的 <50KB JSON，這頁只負責渲染，零業務邏輯
 *   - ETag 輪詢（12 秒）：304 時不重渲染；前台可見才輪詢
 *   - **不載入地圖**——讀取端要能在最差的網路下開起來
 *
 * 【呈現原則：給眼睛結構，給耳朵散文】
 * 初版把 server 回的整段疏散建議直接印出來，結果是一段塞了
 * 「警示 + 起點 + 兩個去處 + 地標 + 避開 + 程序說明」的長句——恐慌中讀不完。
 *
 * 現在 server 回結構化的 plan，這裡拆成可掃視的區塊：
 *   往這裡走 → 出口編號放最前面、字大
 *   不要走   → 明確分開，不與去處混在同一句
 * 編號放最前面，是因為**站內指標系統就是用編號導引的**——使用者抬頭就能接上。
 *
 * 語氣分級（已確認 vs 徵詢中）不只靠顏色：實線框 vs 虛線框 + 文字徽章，
 * 色盲使用者與強光下都必須一眼可分。
 *
 * 地下場域**不只有捷運站**——地下街、地下停車場同樣是服務對象，
 * 所以標題與分組用「場域」而非「站」的說法。
 */

import { useEffect, useState } from 'react';
import { startSituationPolling } from '../modules/api.js';
import { isSpeechSupported, speak } from '../modules/speech.js';
import OfflineBar from '../components/OfflineBar.jsx';

const THREAT_LABEL = {
  high: '高警戒',
  medium: '中警戒',
  low: '注意',
  unverified: '未經確認',
};

const KIND_ICON = { metro: '🚇', underground: '🏬', parking: '🅿️', retail: '🏢' };
const KIND_LABEL = {
  metro: '捷運站', underground: '地下街', parking: '地下停車場', retail: '百貨／商場',
};

const time = (ts) =>
  new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

/** 把結構化計畫組成一句話——只給語音，畫面上是排版好的區塊 */
function planToSpeech(ev, plan) {
  if (!plan) return ev.advice ?? '';
  const name = (e) => (e.landmark ? `${e.code} 出口，往${e.landmark}` : `${e.code} 出口`);
  if (plan.kind === 'shelter') return `${ev.advice}。${plan.reason}。${plan.action}`;
  const go = plan.go.map(name).join('、');
  const avoid = plan.avoid.length
    ? `，避開 ${plan.avoid.map((e) => `${e.code} 出口`).join('、')}`
    : '';
  return `${ev.advice}。往 ${go} 移動${avoid}`;
}

function ExitRow({ exit }) {
  return (
    <div className="exit-row">
      <span className="exit-code">{exit.code}</span>
      <span className="exit-where">{exit.landmark ? `往 ${exit.landmark}` : '出口'}</span>
    </div>
  );
}

/** 疏散計畫：拆成可掃視的區塊，而不是一整段字 */
function EvacPlan({ plan }) {
  if (!plan) return <p className="muted">依現場人員指示，使用最近可用出口。</p>;

  if (plan.kind === 'onTrain') {
    return (
      <div className="plan plan-shelter">
        <div className="plan-head plan-head-stop">🚃 你在車廂裡，沒有「出口」可去</div>
        <p className="plan-action">{plan.action}</p>
      </div>
    );
  }

  if (plan.kind === 'shelter') {
    return (
      <div className="plan plan-shelter">
        <div className="plan-head plan-head-stop">🛑 不要前往出口</div>
        <p className="plan-reason">{plan.reason}</p>
        <p className="plan-action">{plan.action}</p>
      </div>
    );
  }

  return (
    <div className="plan">
      <div className="plan-block plan-go">
        <div className="plan-head">往這裡走</div>
        {plan.go.map((e) => <ExitRow key={e.code} exit={e} />)}
      </div>

      {plan.avoid.length > 0 && (
        <div className="plan-block plan-avoid">
          <div className="plan-head">不要走</div>
          {plan.avoid.map((e) => <ExitRow key={e.code} exit={e} />)}
        </div>
      )}

      <p className="plan-note">
        {plan.note}
        {plan.unknownExits > 0 && `（另有 ${plan.unknownExits} 個出口無無障礙資訊）`}
      </p>
    </div>
  );
}

export default function SituationPage() {
  const [card, setCard] = useState(null);
  // 無障礙偏好與回報端共用同一個 sessionStorage 鍵——
  // 需要的人在回報頁勾過，來看狀況時不必再勾一次
  const [stepFree, setStepFree] = useState(() => sessionStorage.getItem('np_step_free') === '1');

  useEffect(() => {
    const poller = startSituationPolling(setCard, { intervalMs: 12_000 });
    return () => poller.stop();
  }, []);

  function toggleStepFree() {
    const next = !stepFree;
    setStepFree(next);
    sessionStorage.setItem('np_step_free', next ? '1' : '0');
  }

  if (!card) {
    return <div className="page"><p className="muted">載入中…</p></div>;
  }

  return (
    <div className="page">
      <OfflineBar />

      <div className="card-head">
        <h1 className="headline" style={{ margin: 0 }}>目前狀況</h1>
        <span className="card-time">更新於 {time(card.generatedAt)}</span>
      </div>

      <button
        className={`chip${stepFree ? ' chip-active' : ''}`}
        style={{ marginTop: 10 }}
        onClick={toggleStepFree}
      >
        ♿ {stepFree ? '無台階路線（已開啟）' : '我需要無台階路線'}
      </button>

      {/* 鄰近場域警示：事件不在這裡，但離得夠近。
          2025 年那起攻擊跨越了兩個站與一間百貨——下一個場域的人現在就該知道。 */}
      {card.nearbyAlerts?.length > 0 && (
        <section className="station-group">
          <h2 className="section-title">附近場域的警示</h2>
          {card.nearbyAlerts.map((a) => (
            <div key={a.venueId} className="nearby-alert">
              <span className="nearby-icon">{KIND_ICON[a.kind] ?? '📍'}</span>
              <span>
                <b>{a.venueName}</b> 約 {a.distanceM}m 外的
                <b>{a.fromVenue}</b> 有進行中的<b>{a.typeLabel}</b>事件
                {a.moving && <span className="nearby-move"> · 且正在移動</span>}
              </span>
            </div>
          ))}
        </section>
      )}

      {card.stations.length === 0 && card.nearbyAlerts?.length === 0 && (
        <div className="empty-state">
          <div className="empty-icon">🟢</div>
          <p>目前沒有確認中的異常事件</p>
        </div>
      )}

      {card.stations.map((venue) => (
        <section key={venue.stationId} className="station-group">
          <h2 className="venue-head">
            <span className="venue-head-icon">{KIND_ICON[venue.kind] ?? '📍'}</span>
            <span className="venue-head-name">{venue.stationName}</span>
            {venue.kind && <span className="venue-head-kind">{KIND_LABEL[venue.kind]}</span>}
          </h2>

          {venue.events.map((ev) => {
            const plan = stepFree ? ev.planStepFree : ev.plan;
            return (
              <article
                key={ev.id}
                className={`event-card ${ev.status === 'active' ? 'event-active' : 'event-candidate'}`}
              >
                {/* ---- 一行看懂：類型 + 警戒 ---- */}
                <div className="event-top">
                  <span className="event-type">{ev.typeLabel}</span>
                  <span className={`threat threat-${ev.threatLevel}`}>
                    {THREAT_LABEL[ev.threatLevel] ?? '未經確認'}
                  </span>
                </div>
                <div className="event-where">
                  {ev.nearExitCode ? `近 ${ev.nearExitCode} 出口` : '位置未確認'}
                  {` · ${ev.independentSignals} 個獨立訊號 · ${time(ev.updatedAt)}`}
                </div>

                {/* ---- 需要最先看到的兩件事 ---- */}
                {ev.motion?.moving && (
                  <div className="flag flag-move">
                    {ev.motion.reason === 'erratic'
                      ? '多處回報位置不一致 — 可能不只一處'
                      : `威脅移動中${ev.motion.compass ? ` · 往${ev.motion.compass}方` : ''}`}
                    {ev.motion.confidence === 'low' && ' · 方向待確認'}
                  </div>
                )}
                {ev.assistanceReports > 0 && (
                  <div className="flag flag-assist">
                    有人無法自行疏散 · {ev.assistanceReports} 筆回報
                  </div>
                )}

                {ev.onTrain && <div className="flag flag-train">事件在列車上</div>}

                {/* ---- 疏散：結構化，不是一整段字 ---- */}
                <EvacPlan plan={plan} />

                <p className="advice">{ev.advice}</p>

                <div className="event-foot">
                  {isSpeechSupported() && (
                    <button className="chip" onClick={() => speak(planToSpeech(ev, plan))}>
                      🔊 唸出來
                    </button>
                  )}
                  <span className="muted">
                    {ev.reportCount} 筆回報
                    {ev.hasPhoto && ' · 📷'}
                    {ev.hasAudio && ' · 🎤'}
                  </span>
                </div>
              </article>
            );
          })}
        </section>
      ))}

      {/* ===== 徵詢區：未經確認的回報（語氣刻意克制） ===== */}
      {card.pending.length > 0 && (
        <section className="station-group">
          <h2 className="section-title">徵詢中 — 需要現場的人協助確認</h2>
          {card.pending.map((p) => (
            <button
              key={p.eventId}
              className="pending-btn"
              onClick={() => { window.location.hash = `#/confirm?event=${p.eventId}`; }}
            >
              <div className="event-top">
                <span className="event-type" style={{ fontSize: '1rem' }}>
                  {p.stationName} · {p.typeLabel}
                </span>
              </div>
              <div className="muted">{p.message} →</div>
            </button>
          ))}
        </section>
      )}

      <footer className="page-footer">
        <a href="#/">← 我要回報事件</a>
      </footer>
    </div>
  );
}
