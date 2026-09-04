/**
 * ============================================================================
 * SituationPage —— 讀取端：極輕量態勢卡
 * ============================================================================
 * 「弱網優先」的落實：
 *   - 內容是後端預先算好的 <50KB JSON，這頁只負責渲染，零業務邏輯
 *   - ETag 輪詢（12 秒）：304 時不重渲染；前台可見才輪詢
 *   - **不載入地圖**——讀取端要能在最差的網路下開起來
 *
 * 版面的語氣分級是設計核心：
 *   已確認事件  實線左框 + 警戒徽章，語氣直接
 *   徵詢中      虛線左框 + 「未經確認」，語氣克制且明確標示需要協助確認
 * 兩者的差別不能只靠顏色——色盲使用者與強光下都必須一眼可分。
 */

import { useEffect, useState } from 'react';
import { startSituationPolling } from '../modules/api.js';
import { isSpeechSupported, speak } from '../modules/speech.js';

const THREAT_LABEL = {
  high: '高警戒',
  medium: '中警戒',
  low: '注意',
  unverified: '未經確認',
};

const time = (ts) => new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

export default function SituationPage() {
  const [card, setCard] = useState(null);

  useEffect(() => {
    // ETag 輪詢（內部已處理 304 與前景/背景切換）
    const poller = startSituationPolling(setCard, { intervalMs: 12_000 });
    return () => poller.stop();
  }, []);

  if (!card) {
    return <div className="page"><p className="muted">載入中…</p></div>;
  }

  const hasActive = card.stations.length > 0;

  return (
    <div className="page">
      <div className="card-head">
        <h1 className="headline" style={{ margin: 0 }}>站況</h1>
        <span className="card-time">更新於 {time(card.generatedAt)}</span>
      </div>

      {/* ===== 警示區：已確認事件 ===== */}
      {!hasActive && (
        <div className="empty-state">
          <div className="empty-icon">🟢</div>
          <p>目前沒有確認中的異常事件</p>
        </div>
      )}

      {card.stations.map((station) => (
        <section key={station.stationId} className="station-group">
          <h2 className="station-name">📍 {station.stationName}</h2>
          {station.events.map((ev) => (
            <article
              key={ev.id}
              className={`event-card ${ev.status === 'active' ? 'event-active' : 'event-candidate'}`}
            >
              <div className="event-title">
                <span>{ev.typeLabel}</span>
                <span className={`threat threat-${ev.threatLevel}`}>
                  {THREAT_LABEL[ev.threatLevel] ?? '未經確認'}
                </span>
                {ev.nearExitCode && <span className="chip zone-chip">近 {ev.nearExitCode} 出口</span>}
              </div>

              <p className="advice">{ev.advice}</p>

              {/* 疏散向量由 server 依真實出口距離算好；無出口圖資時退回通用文字 */}
              <p className="evac-line">
                🧭 {ev.evacuation ?? '依現場人員指示，使用最近可用出口。'}
              </p>

              {/* 用聽的：移動中、濃煙中、或視力不便時，螢幕上的字是接收不到的。
                  瀏覽器內建語音，離線可用。 */}
              {isSpeechSupported() && (
                <button
                  className="chip"
                  style={{ marginTop: 10 }}
                  onClick={() => speak([ev.advice, ev.evacuation].filter(Boolean).join('。'))}
                >
                  🔊 唸出來
                </button>
              )}

              {ev.timeline && <p className="muted timeline">「{ev.timeline}」</p>}

              <p className="event-meta">
                {ev.reportCount} 筆回報 · {ev.independentSignals} 個獨立訊號 · 更新 {time(ev.updatedAt)}
                {ev.hasPhoto && ' · 📷'}
                {ev.hasAudio && ' · 🎤'}
              </p>
            </article>
          ))}
        </section>
      ))}

      {/* ===== 徵詢區：未經確認的回報（語氣刻意克制） ===== */}
      {card.pending.length > 0 && (
        <section className="station-group">
          <h2 className="section-title">徵詢中 —— 需要現場的人協助確認</h2>
          {card.pending.map((p) => (
            <button
              key={p.eventId}
              className="pending-btn"
              onClick={() => { window.location.hash = `#/confirm?event=${p.eventId}`; }}
            >
              <div className="event-title" style={{ fontSize: '1rem' }}>
                {p.stationName} · {p.typeLabel}
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
