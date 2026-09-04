/**
 * ============================================================================
 * SituationPage —— 讀取端：極輕量態勢卡
 * ============================================================================
 * 「弱網優先」的落實：
 *   - 內容由後端預先算好的 <50KB JSON，這頁只負責渲染，零業務邏輯
 *   - ETag 輪詢（12 秒）：304 時不重渲染；前台可見才輪詢
 *   - 兩個區塊：警示區（active）與徵詢區（candidate，未經確認標記）——
 *     語氣分級的呈現層
 */

import { useEffect, useState } from 'react';
import { startSituationPolling } from '../modules/api.js';

export default function SituationPage() {
  const [card, setCard] = useState(null);

  useEffect(() => {
    // 啟動 ETag 輪詢（內部已處理 304 與前景/背景切換）
    const poller = startSituationPolling(setCard, { intervalMs: 12_000 });
    return () => poller.stop();
  }, []);

  if (!card) {
    return <div className="page"><p className="muted">載入中…</p></div>;
  }

  const hasActive = card.stations.length > 0;

  return (
    <div className="page">
      <h2 className="headline">站況態勢卡</h2>
      <p className="muted">更新時間：{new Date(card.generatedAt).toLocaleTimeString('zh-TW')}</p>

      {/* ===== 警示區：已確認事件（active） ===== */}
      {!hasActive && (
        <div className="all-clear">
          <div className="done-icon">🟢</div>
          <p>目前沒有確認中的異常事件</p>
        </div>
      )}

      {card.stations.map((station) => (
        <div key={station.stationId} className="station-group">
          <h3 className="station-name">📍 {station.stationName}</h3>
          {station.events.map((ev) => (
            <div key={ev.id} className={`event-card ${ev.status === 'active' ? 'event-active' : 'event-candidate'}`}>
              <div className="event-title">
                {ev.typeLabel}
                {ev.nearExitCode && <span className="chip zone-chip">近 {ev.nearExitCode} 出口</span>}
                <span className={`threat threat-${ev.threatLevel}`}>
                  {ev.threatLevel === 'high' ? '高警戒' :
                   ev.threatLevel === 'medium' ? '中警戒' :
                   ev.threatLevel === 'low' ? '注意' : '未經確認'}
                </span>
              </div>
              <p className="advice">{ev.advice}</p>
              {/* 疏散向量由 server 依真實出口距離算好；無出口圖資時回 null */}
              <p className="evac-line">
                🧭 {ev.evacuation ?? '依現場人員指示，使用最近可用出口。'}
              </p>
              <p className="muted">
                {ev.reportCount} 筆回報 · {ev.independentSignals} 個獨立訊號 ·
                更新 {new Date(ev.updatedAt).toLocaleTimeString('zh-TW')}
              </p>
              {ev.timeline && <p className="muted timeline">「{ev.timeline}」</p>}
            </div>
          ))}
        </div>
      ))}

      {/* ===== 徵詢區：未經確認的回報（低調語氣） ===== */}
      {card.pending.length > 0 && (
        <div className="pending-section">
          <h3>徵詢中（未經確認）</h3>
          {card.pending.map((p) => (
            <button
              key={p.eventId}
              className="event-card event-candidate"
              onClick={() => { window.location.hash = `#/confirm?event=${p.eventId}`; }}
            >
              <div className="event-title">
                {p.stationName} · {p.typeLabel}
              </div>
              <div className="muted">{p.message}（點擊協助確認）</div>
            </button>
          ))}
        </div>
      )}

      <footer className="page-footer">
        <a href="#/">← 回報事件</a>
      </footer>
    </div>
  );
}
