/**
 * ============================================================================
 * ReportPage —— 回報頁（恐慌 3 秒流程）
 * ============================================================================
 * 流程（與設計原則一一對應）：
 *
 *   ┌─ 頂欄：位置聲明（L2 session 記憶 → [變更] 開 L3 手選）
 *   ├─ 首屏：四顆事件大按鈕（狀態機選類型，1 次點擊）
 *   ├─ 補充區（選配）：🎤 按住說話（補充層）、📷 拍照（canvas 壓縮 <200KB）
 *   ├─ 歸屬確認：同站同類型已有進行中事件 → [同一件] [另一件]
 *   └─ 送出：UUID 冪等 + 按鈕鎖定 → 樂觀 UI「已通報」
 *
 * 位置永遠不擋回報：沒有位置時點類型 → 直接開手選器（類型已先記住，不浪費時間）。
 */

import { useEffect, useRef, useState } from 'react';
import { getSessionId } from '../modules/session.js';
import { resolveLocation, rememberStation, manualClaim } from '../modules/location.js';
import { postReport, fetchEventsContext } from '../modules/api.js';
import { isVoiceSupported, createRecorder } from '../modules/voiceRecorder.js';
import { compressPhoto } from '../modules/photoCompressor.js';
import StationPicker from '../components/StationPicker.jsx';
import { stationDisplayName } from '../data/stations.js';

/** 四種事件類型（與 server config 對應；高嚴重度排前面） */
const TYPES = [
  { id: 'fire',    label: '火警', emoji: '🔥', cls: 'type-high' },
  { id: 'medical', label: '急救', emoji: '🚑', cls: 'type-high' },
  { id: 'crush',   label: '推擠', emoji: '👥', cls: 'type-medium' },
  { id: 'other',   label: '其他', emoji: '⚠️', cls: 'type-low' },
];

export default function ReportPage() {
  // ---- 定位狀態 ----
  const [claim, setClaim] = useState(null);        // 當前位置聲明
  const [showPicker, setShowPicker] = useState(false);

  // ---- 回報狀態 ----
  const [selectedType, setSelectedType] = useState(null);
  const [matchEvent, setMatchEvent] = useState(null); // 進行中事件（歸屬確認用）
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  // ---- 選配附件 ----
  const [audioClip, setAudioClip] = useState(null);
  const [photo, setPhoto] = useState(null);
  const [recording, setRecording] = useState(false);
  const recorderRef = useRef(null);
  const photoInputRef = useRef(null);

  // ---- 啟動時解析位置（L2 → null） ----
  useEffect(() => {
    resolveLocation().then(({ claim }) => claim && setClaim(claim));
  }, []);

  /** 手選完成（L3 最終仲裁）：更新聲明 + L2 記憶 */
  function handlePicked(stationId) {
    const newClaim = manualClaim(stationId);
    rememberStation(stationId);
    setClaim(newClaim);
    setShowPicker(false);
  }

  /** 點選事件類型：主流程推進 */
  async function handleType(type) {
    setSelectedType(type);
    setError(null);

    // 沒有位置 → 先開手選器（類型已記住，選完站直接續行）
    if (!claim) {
      setShowPicker(true);
      return;
    }

    // 有位置 → 檢查同站同類型是否已有進行中事件（「同一件/另一件」）
    const matches = await fetchEventsContext(claim.stationId, type);
    if (matches.length > 0) {
      setMatchEvent(matches[0]);
    } else {
      setMatchEvent(null);
      // 無既有事件 → 附件區展開，使用者可直接送出
    }
  }

  /** 送出（帶冪等 UUID；送出後鎖定按鈕防連點） */
  async function handleSubmit(attachToEventId = null) {
    if (!claim || !selectedType) return;
    setSubmitting(true);
    try {
      await postReport({
        uuid: crypto.randomUUID(),          // 冪等鍵：連點重送 server 去重
        type: selectedType,
        locationClaim: { ...claim, timestamp: Date.now() },
        attachToEventId,
        audio: audioClip,
        photo,
      });
      setDone(true); // 樂觀 UI：不等 AI、不問結果，顯示「已通報」
    } catch (e) {
      setError('送出失敗，請再試一次');
    } finally {
      setSubmitting(false);
    }
  }

  // ---- hold-to-talk：按下開錄、放開即停 ----
  async function handleMicDown() {
    if (!isVoiceSupported() || recording) return;
    try {
      recorderRef.current = createRecorder();
      await recorderRef.current.start();
      setRecording(true);
    } catch {
      // 麥克風授權失敗（恐慌中最常見）→ 安靜放棄，語音只是補充層
    }
  }
  async function handleMicUp() {
    if (!recorderRef.current) return;
    setRecording(false);
    const clip = await recorderRef.current.stop();
    recorderRef.current = null;
    if (clip) setAudioClip(clip); // 太短/失敗＝null，不影響任何事
  }

  // ---- 照片：壓縮後保存 ----
  async function handlePhoto(file) {
    const compressed = await compressPhoto(file); // <200KB 或 null
    if (compressed) setPhoto(compressed);
  }

  // ===================== 送出成功畫面 =====================
  if (done) {
    return (
      <div className="page">
        <div className="done-box">
          <div className="done-icon">✅</div>
          <h2>已通報</h2>
          <p>已記錄您的回報。若現場有其他人確認，事件將升級並顯示在態勢卡上。</p>
          <div className="done-actions">
            <a className="primary-btn" href="#/situation">查看態勢卡</a>
            <button className="ghost-btn" onClick={() => { setDone(false); setSelectedType(null); setAudioClip(null); setPhoto(null); setMatchEvent(null); }}>
              再回報一筆
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {/* ===== 頂欄：位置聲明 ===== */}
      <header className="loc-bar">
        {claim ? (
          <>
            <span>📍 {stationDisplayName(claim.stationId)}</span>
            <small className="loc-src">
              {claim.source === 'session' ? '（上次確認位置）' : '（已確認）'}
            </small>
          </>
        ) : (
          <span>📍 位置未確認</span>
        )}
        <button className="chip" onClick={() => setShowPicker(true)}>
          {claim ? '變更' : '選擇車站'}
        </button>
      </header>

      {/* ===== 首屏：事件類型大按鈕 ===== */}
      <h2 className="headline">發生什麼事？</h2>
      <div className="type-grid">
        {TYPES.map((t) => (
          <button
            key={t.id}
            className={`type-btn ${t.cls} ${selectedType === t.id ? 'type-selected' : ''}`}
            onClick={() => handleType(t.id)}
          >
            <span className="type-emoji">{t.emoji}</span>
            {t.label}
          </button>
        ))}
      </div>

      {/* ===== 歸屬確認：同站同類型已有進行中事件 ===== */}
      {matchEvent && (
        <div className="match-box">
          <p>
            附近有一則進行中的事件：
            <b>【{stationDisplayName(matchEvent.stationId)} {matchEvent.typeLabel}】</b>
          </p>
          <p className="muted">您要回報的是——</p>
          <div className="match-actions">
            <button
              className="primary-btn"
              disabled={submitting}
              onClick={() => handleSubmit(matchEvent.id)}
            >
              同一件
            </button>
            <button
              className="ghost-btn"
              disabled={submitting}
              onClick={() => { setMatchEvent(null); }}
            >
              另一件
            </button>
          </div>
        </div>
      )}

      {/* ===== 補充區（選配）：語音 + 照片 + 送出 ===== */}
      {selectedType && !matchEvent && claim && (
        <div className="supplement">
          <p className="muted">補充細節（選配）</p>

          {isVoiceSupported() ? (
            <button
              className={`mic-btn ${recording ? 'mic-recording' : ''}`}
              onPointerDown={handleMicDown}
              onPointerUp={handleMicUp}
              onPointerLeave={handleMicUp}
            >
              {recording ? '🔴 放開送出' : '🎤 按住說話'}
            </button>
          ) : (
            <p className="muted">（此瀏覽器不支援錄音）</p>
          )}
          {audioClip && <p className="ok-note">已收錄語音補充</p>}

          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => e.target.files[0] && handlePhoto(e.target.files[0])}
          />
          <button className="ghost-btn" onClick={() => photoInputRef.current?.click()}>
            📷 拍照（選配）
          </button>
          {photo && <p className="ok-note">已附照片</p>}

          <button
            className="primary-btn big"
            disabled={submitting}
            onClick={() => handleSubmit(null)}
          >
            {submitting ? '送出中…' : '送出回報'}
          </button>
          {error && <p className="error-note">{error}</p>}
        </div>
      )}

      {/* ===== 位置不足時的手選器 ===== */}
      {showPicker && (
        <StationPicker
          onPicked={handlePicked}
          onCancel={() => setShowPicker(false)}
        />
      )}

      <footer className="page-footer">
        <a href="#/situation">查看態勢卡 →</a>
      </footer>
    </div>
  );
}
