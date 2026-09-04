/**
 * ============================================================================
 * ReportPage —— 回報頁（恐慌 3 秒流程 + 地下視覺定位）
 * ============================================================================
 * 流程（與設計原則一一對應）：
 *
 *   ┌─ 頂欄：場域聲明（L2 session 記憶 → [變更] 開場域選擇）
 *   ├─ 首屏：四顆事件大按鈕（狀態機選類型，1 次點擊）
 *   ├─ 歸屬確認：同場域同類型已有進行中事件 → [同一件] [另一件]
 *   ├─ 補充區（全選配）：🎤 按住說話 / ✍️ 文字補充 / 📷 拍照
 *   │   └─ 拍照後啟動【地下視覺定位】：
 *   │        1. 整張圖送 locate → AI 建議「哪一格有站名/出口牌」
 *   │        2. 使用者點該格（或自己改點）
 *   │        3. **從原圖裁那一格**送 read → 只讀字
 *   │        4. server 拿讀到的字確定性查表 → 場域 + 出口候選
 *   │        5. 示意圖上高亮，使用者一眼確認或改點別的出口
 *   └─ 送出：UUID 冪等 + 按鈕鎖定 → 樂觀 UI「已通報」
 *
 * 位置永遠不擋回報；整條視覺定位鏈路任一步失敗都靜默降級。
 */

import { useEffect, useRef, useState } from 'react';
import { resolveLocation, rememberStation, manualClaim, coarseFix } from '../modules/location.js';
import { postReport, fetchEventsContext, analyzePhoto, fetchVenue } from '../modules/api.js';
import { isVoiceSupported, createRecorder } from '../modules/voiceRecorder.js';
import { compressPhoto, cropCell } from '../modules/photoCompressor.js';
import VenuePicker from '../components/VenuePicker.jsx';
import PhotoRoiPicker from '../components/PhotoRoiPicker.jsx';
import VenueMap from '../components/VenueMap.jsx';

/** 四種事件類型（與 server config 對應；高嚴重度排前面） */
const TYPES = [
  { id: 'fire',    label: '火警', emoji: '🔥', cls: 'type-high' },
  { id: 'medical', label: '急救', emoji: '🚑', cls: 'type-high' },
  { id: 'crush',   label: '推擠', emoji: '👥', cls: 'type-medium' },
  { id: 'other',   label: '其他', emoji: '⚠️', cls: 'type-low' },
];

export default function ReportPage() {
  // ---- 定位 ----
  const [claim, setClaim] = useState(null);          // 場域位置聲明
  const [venueName, setVenueName] = useState(null);  // 顯示名（server 給）
  const [venue, setVenue] = useState(null);          // 出口清單 + 示意幾何
  const [nearExitCode, setNearExitCode] = useState(null); // 場域錨點（疏散的輸入）
  const [showPicker, setShowPicker] = useState(false);

  // ---- 回報狀態 ----
  const [selectedType, setSelectedType] = useState(null);
  const [matchEvent, setMatchEvent] = useState(null);
  const [attachChoice, setAttachChoice] = useState(null); // null | 'same' | 'separate'
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);

  // ---- 選配補充 ----
  const [note, setNote] = useState('');
  const [audioClip, setAudioClip] = useState(null);
  const [recording, setRecording] = useState(false);

  // ---- 照片與視覺定位 ----
  const [photo, setPhoto] = useState(null);          // 壓縮後的整張圖
  const [photoRef, setPhotoRef] = useState(null);    // server 暫存代號（免重傳）
  const [previewUrl, setPreviewUrl] = useState(null);
  const [roiCell, setRoiCell] = useState(null);      // 使用者選的影像格
  const [suggestedCell, setSuggestedCell] = useState(null); // AI 建議的影像格
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionOff, setVisionOff] = useState(false); // 供應商未啟用
  const [readTexts, setReadTexts] = useState([]);    // 讀到的字
  const [candidates, setCandidates] = useState([]);  // 查表得出的場域/出口候選

  const recorderRef = useRef(null);
  const photoInputRef = useRef(null);
  const rawFileRef = useRef(null);                   // 保留原圖，裁切要用

  const supplementOpen = Boolean(selectedType && claim && (!matchEvent || attachChoice));

  // ---- 啟動時解析位置（L2 → null） ----
  useEffect(() => {
    resolveLocation().then(({ claim }) => claim && applyVenue(claim.stationId, null, claim));
  }, []);

  // 預覽 URL 用完要釋放，否則連拍幾張就漏一堆記憶體
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  /** 設定當前場域：更新聲明、取出口圖資、寫入 L2 記憶 */
  async function applyVenue(venueId, name = null, existingClaim = null) {
    setClaim(existingClaim ?? manualClaim(venueId));
    setVenueName(name);
    setNearExitCode(null);
    rememberStation(venueId);
    const v = await fetchVenue(venueId);
    setVenue(v);
    if (v?.name) setVenueName(v.name);
  }

  /** 查同場域同類型是否已有進行中事件（「同一件/另一件」的資料來源） */
  async function refreshMatch(stationId, type) {
    if (!stationId || !type) return;
    const matches = await fetchEventsContext(stationId, type);
    setMatchEvent(matches.length > 0 ? matches[0] : null);
    setAttachChoice(null); // 換類型或換場域都要重新問一次歸屬
  }

  function handlePicked(venueId, name) {
    applyVenue(venueId, name);
    setShowPicker(false);
    // 「先點類型、後選場域」的順序若不補這一步，會整個跳過歸屬確認而永遠開新事件
    refreshMatch(venueId, selectedType);
  }

  async function handleType(type) {
    setSelectedType(type);
    setError(null);
    if (!claim) { setShowPicker(true); return; } // 類型已記住，選完場域由 handlePicked 續行
    await refreshMatch(claim.stationId, type);
  }

  // ===================== 地下視覺定位 =====================

  /** 拍完照：壓縮整張 → 背景問 AI「哪一格有地點標示」 */
  async function handlePhoto(file) {
    rawFileRef.current = file;
    setRoiCell(null);
    setSuggestedCell(null);
    setReadTexts([]);
    setCandidates([]);

    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));

    const compressed = await compressPhoto(file); // <50KB 或 null
    if (!compressed) return;
    setPhoto(compressed);
    setVisionBusy(true);

    const res = await analyzePhoto({ ...compressed, stage: 'locate' });
    setPhotoRef(res.photoRef);
    setVisionOff(!res.enabled);
    setSuggestedCell(res.result.roiCell);
    setVisionBusy(false);
  }

  /**
   * 選定影像格：從**原圖**裁那一格送去讀字。
   * 裁切是整個機制的關鍵——整張圖降到 512px 後出口牌的字只有 20~40px 高，
   * 裁切後同一塊牌子可達 120px 以上。
   */
  async function handleRoiPick(cell) {
    setRoiCell(cell);
    if (!cell || !rawFileRef.current) { setReadTexts([]); setCandidates([]); return; }

    setVisionBusy(true);
    const crop = await cropCell(rawFileRef.current, cell);
    if (!crop) { setVisionBusy(false); return; } // 裁切失敗 → 靜默放棄，不擋回報

    const fix = claim ? null : await coarseFix(); // 沒選場域時才需要位置線索收斂
    const res = await analyzePhoto({
      ...crop,
      stage: 'read',
      venueId: claim?.stationId ?? null,
      lat: fix?.lat,
      lon: fix?.lon,
    });

    setVisionOff(!res.enabled);
    setReadTexts(res.result.texts ?? []);
    setCandidates(res.candidates ?? []);

    // 最高信心的候選直接採用；使用者可在示意圖上改
    const top = res.candidates?.[0];
    if (top) {
      if (top.venueId !== claim?.stationId) await applyVenue(top.venueId, top.venueName);
      if (top.exitCode) setNearExitCode(top.exitCode);
    }
    setVisionBusy(false);
  }

  // ===================== 送出 =====================

  async function handleSubmit() {
    if (!claim || !selectedType) return;
    setSubmitting(true);
    try {
      await postReport({
        uuid: crypto.randomUUID(),          // 冪等鍵：連點重送 server 去重
        type: selectedType,
        locationClaim: { ...claim, timestamp: Date.now() },
        attachToEventId: attachChoice === 'same' ? matchEvent?.id ?? null : null,
        nearExitCode,
        photoRoi: roiCell,
        note: note.trim() || null,
        audio: audioClip,
        photo,
        photoRef,                            // 有 ref 就不重傳整張圖
      });
      setDone(true); // 樂觀 UI：不等 AI、不問結果
    } catch {
      setError('送出失敗，請再試一次');
    } finally {
      setSubmitting(false);
    }
  }

  function resetDraft() {
    setSelectedType(null); setMatchEvent(null); setAttachChoice(null);
    setNote(''); setAudioClip(null);
    setPhoto(null); setPhotoRef(null); setRoiCell(null); setSuggestedCell(null);
    setReadTexts([]); setCandidates([]); setNearExitCode(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null); rawFileRef.current = null;
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
    if (clip) setAudioClip(clip);
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
            <a className="primary-btn" href="#/situation">查看態勢卡（含疏散建議）</a>
            <button className="ghost-btn" onClick={() => { setDone(false); resetDraft(); }}>
              再回報一筆
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      {/* ===== 頂欄：場域位置聲明 ===== */}
      <header className="loc-bar">
        {claim ? (
          <>
            <span>📍 {venueName ?? claim.stationId}{nearExitCode && ` · 近 ${nearExitCode} 出口`}</span>
            <small className="loc-src">
              {claim.source === 'session' ? '（上次確認位置）' : '（已確認）'}
            </small>
          </>
        ) : (
          <span>📍 位置未確認</span>
        )}
        <button className="chip" onClick={() => setShowPicker(true)}>
          {claim ? '變更' : '選擇場域'}
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

      {/* ===== 歸屬確認 ===== */}
      {matchEvent && (
        <div className="match-box">
          <p>
            附近有一則進行中的事件：
            <b>【{matchEvent.stationName} {matchEvent.typeLabel}】</b>
          </p>
          <p className="muted">您要回報的是——</p>
          {/* 選完不直接送出：兩條路徑都往下走補充區，
              因為「補一筆到既有事件」往往正是最需要位置資訊的時候 */}
          <div className="match-actions">
            <button
              className={attachChoice === 'same' ? 'primary-btn' : 'ghost-btn'}
              disabled={submitting}
              onClick={() => setAttachChoice('same')}
            >
              同一件
            </button>
            <button
              className={attachChoice === 'separate' ? 'primary-btn' : 'ghost-btn'}
              disabled={submitting}
              onClick={() => setAttachChoice('separate')}
            >
              另一件
            </button>
          </div>
        </div>
      )}

      {/* ===== 補充區（全選配） ===== */}
      {supplementOpen && (
        <div className="supplement">
          <p className="muted">補充細節（全選配）</p>

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
            <p className="muted">（此瀏覽器不支援錄音，可改用文字補充）</p>
          )}
          {audioClip && <p className="ok-note">已收錄語音補充</p>}

          <textarea
            className="note-input"
            placeholder="或輸入文字補充（選配，140 字內）"
            maxLength={140}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => {
              if (e.target.files[0]) handlePhoto(e.target.files[0]);
              e.target.value = '';
            }}
          />
          <button className="ghost-btn" onClick={() => photoInputRef.current?.click()}>
            📷 拍照（可協助辨識你在哪個出口）
          </button>

          {/* ---- 地下視覺定位：影像九宮格 → 讀字 → 查表 ---- */}
          {previewUrl && (
            <PhotoRoiPicker
              previewUrl={previewUrl}
              cell={roiCell}
              suggested={suggestedCell}
              busy={visionBusy}
              onPick={handleRoiPick}
            />
          )}
          {previewUrl && visionOff && (
            <p className="muted">（視覺辨識未啟用——照片仍會附上，位置請用下方地圖確認）</p>
          )}
          {readTexts.length > 0 && (
            <p className="muted">
              讀到：{readTexts.map((t) => `${t.label}「${t.value}」`).join('、')}
            </p>
          )}
          {candidates.length > 1 && (
            <p className="muted">
              有 {candidates.length} 個可能的位置——請在地圖上點選正確的出口。
            </p>
          )}

          {/* ---- 場域示意圖：確認 / 更正出口 ---- */}
          {venue && (
            <VenueMap venue={venue} selectedCode={nearExitCode} onSelect={setNearExitCode} />
          )}

          <button className="primary-btn big" disabled={submitting} onClick={handleSubmit}>
            {submitting
              ? '送出中…'
              : attachChoice === 'same'
                ? '送出（補充到既有事件）'
                : '送出回報'}
          </button>
          {error && <p className="error-note">{error}</p>}
        </div>
      )}

      {/* ===== 場域選擇器 ===== */}
      {showPicker && (
        <VenuePicker onPicked={handlePicked} onCancel={() => setShowPicker(false)} />
      )}

      <footer className="page-footer">
        <a href="#/situation">查看態勢卡 →</a>
      </footer>
    </div>
  );
}
