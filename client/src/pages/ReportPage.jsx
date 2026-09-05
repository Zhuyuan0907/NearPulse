/**
 * ============================================================================
 * ReportPage —— 回報頁（分頁式流程）
 * ============================================================================
 * 一頁一個問題，按下去就跳到下一頁——不捲動、不解鎖、不回頭找。
 *
 *   第 0 頁  發生什麼事（五顆大按鈕）
 *   第 1 頁  這是哪裡（拍照 / 附近場域 / 自己描述；也可先按下一步跳過）
 *   第 2 頁  補充（按住說話 + 打字；送出）
 *   完成頁   已通報 + 疏散指示
 *
 * 恐慌的人一次只能回答一個問題。原本「一路滑動、依序解鎖」的長頁，
 * 會讓人邊滑邊讀一大串字；分頁把每一步縮成一行大標題 + 幾顆大按鈕。
 *
 * 邏輯完全不變：狀態、API 呼叫、送出條件都與舊版相同，只是重排。
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveLocation, rememberStation, manualClaim, coarseFix, geolocationPermission,
} from '../modules/location.js';
import {
  postReport, fetchEventsContext, analyzePhoto, fetchVenue, fetchEvacuation,
} from '../modules/api.js';
import { isSpeechSupported, speak, stopSpeaking } from '../modules/speech.js';
import { compressPhoto, cropCell } from '../modules/photoCompressor.js';
import VenuePicker from '../components/VenuePicker.jsx';
import OfflineBar from '../components/OfflineBar.jsx';
import PhotoRoiPicker from '../components/PhotoRoiPicker.jsx';
import Pictogram from '../components/Pictogram.jsx';
import { isDictationSupported, startDictation } from '../modules/dictate.js';

const VenueMap = lazy(() => import('../components/VenueMap.jsx'));

const TYPES = [
  { id: 'fire',    label: '火警', cls: 'type-high',   hint: '煙、火、燒焦味' },
  { id: 'attack',  label: '攻擊', cls: 'type-high',   hint: '持械、傷人、有人逃竄' },
  { id: 'medical', label: '急救', cls: 'type-high',   hint: '有人倒下、受傷' },
  { id: 'crush',   label: '推擠', cls: 'type-medium', hint: '人潮擠壓、動線堵塞' },
  { id: 'other',   label: '其他', cls: 'type-low',    hint: '積水、異味、可疑物' },
];

/** GPS 誤差小於這個值才值得拿來當事件位置（否則只用於收斂場域清單） */
const GPS_USABLE_ACCURACY_M = 60;

export default function ReportPage() {
  // ---- 頁面步驟：type → where → detail ----
  const [step, setStep] = useState(0);

  // ---- 定位 ----
  const [claim, setClaim] = useState(null);
  const [venueName, setVenueName] = useState(null);
  const [venue, setVenue] = useState(null);
  const [nearExitCode, setNearExitCode] = useState(null);
  const [incidentPoint, setIncidentPoint] = useState(null);
  const [fix, setFix] = useState(null);
  const [showPicker, setShowPicker] = useState(false);

  // ---- 回報狀態 ----
  const [selectedType, setSelectedType] = useState(null);
  const [matchEvent, setMatchEvent] = useState(null);
  const [attachChoice, setAttachChoice] = useState(null); // null | 'same' | 'separate'
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [evac, setEvac] = useState(null);

  // ---- 選配補充 ----
  const [note, setNote] = useState('');
  const [stepFree, setStepFree] = useState(() => sessionStorage.getItem('np_step_free') === '1');
  const [needsAssistance, setNeedsAssistance] = useState(false);
  const [onTrain, setOnTrain] = useState(false);
  const [nextVenueId, setNextVenueId] = useState(null);
  const [noteDictating, setNoteDictating] = useState(false);
  const noteDictationRef = useRef(null);
  const [gpsBusy, setGpsBusy] = useState(false);

  // ---- 照片與視覺定位 ----
  const [photo, setPhoto] = useState(null);
  const [photoRef, setPhotoRef] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [roiCell, setRoiCell] = useState(null);
  const [suggestedCell, setSuggestedCell] = useState(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionOff, setVisionOff] = useState(false);
  const [visionMode, setVisionMode] = useState('off');
  const [readTexts, setReadTexts] = useState([]);
  const [candidates, setCandidates] = useState([]);
  const [venueSwitchedTo, setVenueSwitchedTo] = useState(null);
  const [placeText, setPlaceText] = useState('');
  const [dictating, setDictating] = useState(false);
  const dictationRef = useRef(null);

  const photoInputRef = useRef(null);
  const rawFileRef = useRef(null);

  const hasLocationClue = Boolean(
    claim?.stationId || placeText.trim() || fix || photo || photoRef
  );

  const readyToSubmit = Boolean(
    selectedType && hasLocationClue && (!matchEvent || attachChoice)
  );

  const canBeOnTrain = venue?.kind === 'metro' && venue.nextStations?.length > 0;
  const venueChoices = [...new Map(candidates.map((c) => [c.venueId, c])).values()];

  /** 設定當前場域：更新聲明、取出口圖資、寫入 session 記憶 */
  const applyVenue = useCallback(async (venueId, name = null, existingClaim = null) => {
    setClaim(existingClaim ?? manualClaim(venueId));
    setVenueName(name);
    setNearExitCode(null);
    setIncidentPoint(null);
    setOnTrain(false);
    setNextVenueId(null);
    rememberStation(venueId, name);
    const v = await fetchVenue(venueId);
    setVenue(v);
    if (v?.name) { setVenueName(v.name); rememberStation(venueId, v.name); }
  }, []);

  // ---- 啟動 ----
  useEffect(() => {
    resolveLocation().then(({ claim, stationName }) => {
      if (claim) applyVenue(claim.stationId, stationName, claim);
    });
    geolocationPermission().then((state) => {
      if (state === 'granted') coarseFix().then(setFix);
    });
  }, [applyVenue]);

  /** 補充描述的語音輸入（按住說話） */
  function toggleNoteDictation() {
    if (noteDictationRef.current) {
      noteDictationRef.current.stop();
      noteDictationRef.current = null;
      setNoteDictating(false);
      return;
    }
    const base = note.trim();
    const session = startDictation({
      onText: (text) => setNote(`${base}${base ? ' ' : ''}${text}`.slice(0, 140)),
      onEnd: () => { noteDictationRef.current = null; setNoteDictating(false); },
    });
    if (!session) return;
    noteDictationRef.current = session;
    setNoteDictating(true);
  }

  /** 語音輸入地點描述：開始／停止 */
  function toggleDictation() {
    if (dictationRef.current) {
      dictationRef.current.stop();
      dictationRef.current = null;
      setDictating(false);
      return;
    }
    const session = startDictation({
      onText: (text) => setPlaceText(text.slice(0, 60)),
      onEnd: () => { dictationRef.current = null; setDictating(false); },
    });
    if (!session) return;
    dictationRef.current = session;
    setDictating(true);
  }

  /** 需要定位時才實際去要（場域選擇器與 GPS 按鈕共用） */
  const ensureFix = useCallback(async () => {
    const f = await coarseFix();
    setFix(f);
    return f;
  }, []);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  /** 查同場域同類型是否已有進行中事件 */
  async function refreshMatch(stationId, type) {
    if (!stationId || !type) return;
    const matches = await fetchEventsContext(stationId, type);
    setMatchEvent(matches.length > 0 ? matches[0] : null);
    setAttachChoice(null);
  }

  function handlePicked(venueId, name) {
    applyVenue(venueId, name);
    setShowPicker(false);
    refreshMatch(venueId, selectedType);
  }

  /** 點類型 → 進入「這是哪裡」頁 */
  async function handleType(type) {
    setSelectedType(type);
    setError(null);
    setStep(1);
    if (!claim) return;
    await refreshMatch(claim.stationId, type);
  }

  // ===================== 位置精確化 =====================

  /** GPS 夠準時直接當事件位置 */
  async function useGps() {
    setGpsBusy(true);
    const f = await ensureFix();
    setGpsBusy(false);
    if (f && f.accuracy <= GPS_USABLE_ACCURACY_M) {
      setIncidentPoint({ lat: f.lat, lon: f.lon });
      setNearExitCode(null);
    }
  }

  /** 拍完照：壓縮整張 → 背景問 AI「哪一格有地點標示」 */
  async function handlePhoto(file) {
    rawFileRef.current = file;
    setRoiCell(null); setSuggestedCell(null); setReadTexts([]); setCandidates([]);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));

    const compressed = await compressPhoto(file);
    if (!compressed) return;
    setPhoto(compressed);
    setVisionBusy(true);

    const res = await analyzePhoto({ ...compressed, stage: 'locate' });
    setPhotoRef(res.photoRef);
    setVisionOff(!res.enabled);
    setVisionMode(res.mode);
    setSuggestedCell(res.result.roiCell);

    if (res.mode === 'deferred') { setVisionBusy(false); return; }

    await runRead(res.result.roiCell ?? null, file, compressed);
  }

  /** 從原圖裁出指定格送去讀字 */
  async function runRead(cell, file, wholeImage = null) {
    setRoiCell(cell);
    setVisionBusy(true);

    const payload = cell ? await cropCell(file, cell) : wholeImage;
    if (!payload) { setVisionBusy(false); return; }

    const res = await analyzePhoto({
      ...payload,
      stage: 'read',
      venueId: claim?.stationId ?? null,
      lat: fix?.lat,
      lon: fix?.lon,
    });

    setVisionOff(!res.enabled);
    setReadTexts(res.result.texts ?? []);
    setCandidates(res.candidates ?? []);

    const top = res.candidates?.[0];
    if (top && top.confidence !== 'low') {
      if (top.venueId !== claim?.stationId) {
        await applyVenue(top.venueId, top.venueName);
        setVenueSwitchedTo(top.venueName);
      }
      if (top.exitCode) { setNearExitCode(top.exitCode); setIncidentPoint(null); }
    }
    setVisionBusy(false);
  }

  /** 使用者手動改格（AI 判斷錯時） */
  async function handleRoiPick(cell) {
    if (!cell || !rawFileRef.current) {
      setRoiCell(null); setReadTexts([]); setCandidates([]);
      return;
    }
    await runRead(cell, rawFileRef.current);
  }

  // ===================== 送出 =====================

  async function handleSubmit() {
    if (!readyToSubmit) return;
    setSubmitting(true);
    try {
      await postReport({
        uuid: crypto.randomUUID(),
        type: selectedType,
        locationClaim: claim
          ? { ...claim, timestamp: Date.now() }
          : {
            source: placeText.trim() ? 'freeform' : fix ? 'gps' : 'unknown',
            stationId: null,
            place: placeText.trim() || null,
            lat: fix?.lat ?? null,
            lon: fix?.lon ?? null,
            timestamp: Date.now(),
          },
        attachToEventId: attachChoice === 'same' ? matchEvent?.id ?? null : null,
        nearExitCode,
        incidentPoint,
        photoRoi: roiCell,
        needsAssistance,
        onTrain,
        nextVenueId: onTrain ? nextVenueId : null,
        note: note.trim() || null,
        photo,
        photoRef,
      });
      setDone(true);

      if (claim?.stationId) fetchEvacuation({
        venueId: claim.stationId,
        exitCode: nearExitCode,
        point: incidentPoint,
        type: selectedType,
        mobility: stepFree ? 'stepFree' : null,
        onTrain,
      }).then(setEvac);
    } catch {
      setError('送出失敗，請再試一次');
    } finally {
      setSubmitting(false);
    }
  }

  function resetDraft() {
    setSelectedType(null); setMatchEvent(null); setAttachChoice(null);
    setNote(''); setOnTrain(false); setNextVenueId(null); setNeedsAssistance(false);
    setPhoto(null); setPhotoRef(null); setRoiCell(null); setSuggestedCell(null);
    setReadTexts([]); setCandidates([]); setVenueSwitchedTo(null); setPlaceText('');
    setNearExitCode(null); setIncidentPoint(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null); rawFileRef.current = null;
    setEvac(null); stopSpeaking(); setStep(0);
  }


  // ===================== 完成頁 =====================
  if (done) {
    const evacText = stepFree ? (evac?.evacuationStepFree ?? evac?.evacuation) : evac?.evacuation;
    const spoken = [evac?.advice, evacText].filter(Boolean).join('。');
    return (
      <div className="page">
        <div className="done-box">
          <div className="done-icon done-icon-ok">✓</div>
          <h2>已通報</h2>

          {evacText ? (
            <>
              <p className="advice">{evac.advice}</p>
              <p className="evac-line">{evacText}</p>
              {isSpeechSupported() && (
                <button
                  className="primary-btn btn-block btn-lg"
                  style={{ marginTop: 14 }}
                  onClick={() => speak(spoken)}
                >
                  <Pictogram name="speak" size={20} />
                  唸出疏散指示
                </button>
              )}
            </>
          ) : (
            <p className="muted">
              已記錄你的回報。若現場有其他人確認，事件會升級並顯示在態勢卡上。
            </p>
          )}

          <div className="done-actions">
            <a className="primary-btn" href="#/situation">查看目前狀況</a>
            <button className="ghost-btn" onClick={() => { setDone(false); resetDraft(); }}>
              再回報一筆
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- 位置摘要 ----
  const locSub = !claim
    ? '點此選擇你所在的場域'
    : [
        nearExitCode && `近 ${nearExitCode} 出口`,
        incidentPoint && !nearExitCode && '已在地圖上標記位置',
        claim.source === 'session' && '上次確認的位置',
      ].filter(Boolean).join(' · ') || '已確認';

  const typeInfo = TYPES.find((t) => t.id === selectedType);

  return (
    <div className="page page-step">
      <OfflineBar />

      {/* ===== 頂部：步驟指示 + 回上一步 ===== */}
      {step > 0 && (
        <div className="step-top">
          <button className="step-back" onClick={() => setStep(step - 1)} aria-label="回上一步">
            <Pictogram name="back" size={20} />
          </button>
          <div className="step-dots" aria-hidden="true">
            <span className={`step-dot${step === 0 ? ' step-dot-on' : ''}`} />
            <span className={`step-dot${step === 1 ? ' step-dot-on' : ''}`} />
            <span className={`step-dot${step === 2 ? ' step-dot-on' : ''}`} />
          </div>
        </div>
      )}

      {/* ===== 第 0 頁：發生什麼事 ===== */}
      {step === 0 && (
        <div className="step-view">
          <h1 className="headline">發生什麼事？</h1>
          <p className="subhead">點一下就好</p>
          <div className="type-grid">
            {TYPES.map((t) => (
              <button
                key={t.id}
                className={`type-btn ${t.cls}${selectedType === t.id ? ' type-selected' : ''}`}
                onClick={() => handleType(t.id)}
              >
                <Pictogram name={t.id} size={34} className="type-pict" />
                {t.label}
                <span className="type-hint">{t.hint}</span>
              </button>
            ))}
          </div>

          <a className="situation-cta" href="#/situation">
            <Pictogram name="map" size={22} />
            <span className="situation-cta-body">
              <b>查看目前狀況</b>
              <span className="situation-cta-sub">附近有什麼事、往哪個出口走</span>
            </span>
            <span className="situation-cta-go" aria-hidden="true">→</span>
          </a>
        </div>
      )}

      {/* ===== 第 1 頁：這是哪裡 ===== */}
      {step === 1 && (
        <div className="step-view">
          {/* 已選類型回顧：一行，點了可回去換 */}
          {typeInfo && (
            <button className="step-recap" onClick={() => setStep(0)}>
              <Pictogram name={typeInfo.id} size={18} className="step-recap-pict" />
              <b>{typeInfo.label}</b>
              <span className="step-recap-edit">改</span>
            </button>
          )}

          {/* 附近已有事件 → 先答歸屬再繼續 */}
          {matchEvent && !attachChoice ? (
            <>
              <h1 className="headline">附近已有一則事件</h1>
              <p className="subhead">{matchEvent.stationName} · {matchEvent.typeLabel}（{matchEvent.reportCount} 筆回報）</p>
              <div className="big-choice">
                <button className="big-choice-btn same" onClick={() => setAttachChoice('same')}>
                  同一件
                </button>
                <button className="big-choice-btn" onClick={() => setAttachChoice('separate')}>
                  另一件
                </button>
              </div>
            </>
          ) : (
            <>
              <h1 className="headline">這是哪裡？</h1>
              <p className="subhead">做一個就好，也可以先跳過</p>

              {/* 位置狀態列（整條可點） */}
              <button
                className={`loc-bar${claim ? '' : ' loc-unset'}`}
                onClick={() => setShowPicker(true)}
              >
                <Pictogram name="pin" size={20} className="loc-pin" />
                <span className="loc-body">
                  <span className="loc-title">{venueName ?? (claim ? claim.stationId : '尚未選擇場域')}</span>
                  <span className="loc-sub">{locSub}</span>
                </span>
                <span className="loc-action">{claim ? '變更' : '選擇'}</span>
              </button>

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

              {!claim && (
                <div className="where-panel">
                  <button className="where-opt" onClick={() => photoInputRef.current?.click()}>
                    <Pictogram name="photo" size={24} />
                    <span>
                      <b>拍附近的牌子</b>
                      <span className="where-sub">站名牌、出口牌都行</span>
                    </span>
                  </button>

                  <button className="where-opt" onClick={() => setShowPicker(true)}>
                    <Pictogram name="pin" size={24} />
                    <span>
                      <b>從附近場域挑一個</b>
                      <span className="where-sub">點一下就好</span>
                    </span>
                  </button>

                  <label className="where-opt where-freeform">
                    <Pictogram name="map" size={24} />
                    <span>
                      <b>自己描述</b>
                      <span className="where-input-row">
                        <input
                          className="note-input where-input"
                          type="text"
                          inputMode="text"
                          maxLength={60}
                          placeholder="例：京站地下街 B1"
                          value={placeText}
                          onChange={(e) => setPlaceText(e.target.value)}
                        />
                        {isDictationSupported() && (
                          <button
                            type="button"
                            className={`dictate-btn${dictating ? ' dictate-on' : ''}`}
                            aria-label={dictating ? '停止語音輸入' : '用說的'}
                            onClick={toggleDictation}
                          >
                            <Pictogram name="mic" size={20} />
                          </button>
                        )}
                      </span>
                      {dictating && <span className="where-sub">正在聽…</span>}
                    </span>
                  </label>
                </div>
              )}

              {/* 在列車上（僅路網上的捷運場域） */}
              {claim && canBeOnTrain && (
                <button
                  className={`chip chip-block${onTrain ? ' chip-active' : ''}`}
                  onClick={() => { setOnTrain(!onTrain); setNextVenueId(null); }}
                >
                  <Pictogram name="train" size={18} />
                  {onTrain ? '已標記：在列車上' : '事件發生在列車上'}
                </button>
              )}

              {onTrain && canBeOnTrain && (
                <div className="next-station">
                  <div className="next-station-q">下一站是？</div>
                  <div className="next-station-opts">
                    {venue.nextStations.map((s) => (
                      <button
                        key={s.venueId}
                        className={`chip${nextVenueId === s.venueId ? ' chip-active' : ''}`}
                        onClick={() => setNextVenueId(nextVenueId === s.venueId ? null : s.venueId)}
                      >
                        <b>{s.name}</b>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* 無障礙／需協助 */}
              <div className="supp-col">
                <button
                  className={`chip chip-block${stepFree ? ' chip-active' : ''}`}
                  onClick={() => {
                    const next = !stepFree;
                    setStepFree(next);
                    sessionStorage.setItem('np_step_free', next ? '1' : '0');
                  }}
                >
                  <Pictogram name="stepFree" size={18} />
                  {stepFree ? '已選：無台階路線' : '需要無台階路線'}
                </button>
                <button
                  className={`chip chip-block${needsAssistance ? ' chip-active' : ''}`}
                  onClick={() => setNeedsAssistance(!needsAssistance)}
                >
                  <Pictogram name="assist" size={18} />
                  {needsAssistance ? '已標記：有人需協助' : '有人無法自行疏散'}
                </button>
              </div>

              {/* 已有場域：拍照定位 / GPS */}
              {claim && (
                <div className="supp-row">
                  <button className="ghost-btn btn-lg" onClick={() => photoInputRef.current?.click()}>
                    <Pictogram name="photo" size={18} />
                    拍照定位
                  </button>
                  <button className="ghost-btn btn-lg" disabled={gpsBusy} onClick={useGps}>
                    {gpsBusy ? '定位中…' : 'GPS 定位'}
                  </button>
                </div>
              )}

              {gpsBusy && <p className="muted">正在取得定位（最多 5 秒）…</p>}
              {!gpsBusy && fix && fix.accuracy > GPS_USABLE_ACCURACY_M && (
                <div className="notice notice-warn">
                  GPS 誤差約 {Math.round(fix.accuracy)}m，定位不到出口。
                  請改用拍照定位，或直接在地圖上點。
                </div>
              )}

              {/* 照片九宮格 */}
              {previewUrl && (
                <div className="card">
                  <PhotoRoiPicker
                    previewUrl={previewUrl}
                    cell={roiCell}
                    suggested={suggestedCell}
                    busy={visionBusy}
                    onPick={handleRoiPick}
                  />
                  {visionOff && (
                    <p className="muted">（視覺辨識未啟用——照片仍會附上）</p>
                  )}
                  {visionMode === 'deferred' && (
                    <p className="muted">照片已收下，辨識在背景進行——可直接送出。</p>
                  )}
                  {readTexts.length > 0 && (
                    <p className="ok-note">
                      讀到：{readTexts.map((t) => `${t.label}「${t.value}」`).join('、')}
                    </p>
                  )}
                  {venueSwitchedTo && (
                    <p className="ok-note">
                      依照片把場域改為 <b>{venueSwitchedTo}</b>——不對的話請點上方變更。
                    </p>
                  )}
                  {venueChoices.length > 1 && (
                    <div className="venue-choice">
                      <p className="venue-choice-q">
                        照片裡有多個站名——<b>你在哪一站？</b>
                      </p>
                      <div className="venue-choice-opts">
                        {venueChoices.map((c) => (
                          <button
                            key={c.venueId}
                            className={`chip${claim?.stationId === c.venueId ? ' chip-active' : ''}`}
                            onClick={() => {
                              applyVenue(c.venueId, c.venueName);
                              setVenueSwitchedTo(null);
                            }}
                          >
                            {c.venueName}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {venueChoices.length <= 1 && candidates.length > 1 && (
                    <p className="muted">有多個可能位置——請在地圖上點正確的出口。</p>
                  )}
                </div>
              )}

              {/* 地圖 */}
              {venue && (
                <div>
                  <Suspense fallback={<p className="muted">載入地圖…</p>}>
                    <VenueMap
                      venue={venue}
                      selectedCode={nearExitCode}
                      incidentPoint={incidentPoint}
                      userFix={fix}
                      onSelectExit={(code) => { setNearExitCode(code); setIncidentPoint(null); }}
                      onPickPoint={(p) => { setIncidentPoint(p); setNearExitCode(null); }}
                    />
                  </Suspense>
                  <div className="anchor-row">
                    <button
                      className={`chip${!nearExitCode && !incidentPoint ? ' chip-active' : ''}`}
                      onClick={() => { setNearExitCode(null); setIncidentPoint(null); }}
                    >
                      不確定在站內哪裡
                    </button>
                    {(nearExitCode || incidentPoint) && (
                      <span className="anchor-current">
                        已標記：{nearExitCode ? `${nearExitCode} 出口附近` : '地圖上的選點'}
                      </span>
                    )}
                  </div>
                  <p className="muted">
                    知道大概位置，點地圖即可；不確定就別點。
                  </p>
                </div>
              )}

              {error && <p className="error-note">{error}</p>}

              <button className="primary-btn btn-lg btn-block step-next" onClick={() => setStep(2)}>
                下一步
                <Pictogram name="next" size={20} />
              </button>
            </>
          )}
        </div>
      )}

      {/* ===== 第 2 頁：補充 + 送出 ===== */}
      {step === 2 && (
        <div className="step-view">
          <h1 className="headline">要補充什麼嗎？</h1>
          <p className="subhead">不補也可以，直接送出</p>

          {/* 按住說話：大麥克風圓鈕（倣 dev-zhuyuan 版樣式） */}
          <div className="holdtalk">
            <button
              className={`holdtalk-btn${noteDictating ? ' holdtalk-rec' : ''}`}
              aria-label="按住說話"
              onPointerDown={(e) => { e.preventDefault(); if (!noteDictating) toggleNoteDictation(); }}
              onPointerUp={() => { if (noteDictationRef.current) noteDictationRef.current.stop(); }}
              onPointerLeave={() => { if (noteDictationRef.current) noteDictationRef.current.stop(); }}
            >
              <Pictogram name="mic" size={40} />
            </button>
            <div className={`holdtalk-state${noteDictating ? ' holdtalk-state-rec' : ''}`}>
              {noteDictating ? '正在聽…放開結束' : '按住說話'}
            </div>
          </div>

          {!isDictationSupported() && (
            <p className="muted" style={{ textAlign: 'center' }}>（此瀏覽器不支援語音輸入，請用打字）</p>
          )}

          <textarea
            className="note-input"
            placeholder="輸入文字（140 字內）"
            maxLength={140}
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />

          {/* 未答歸屬時回來補答 */}
          {matchEvent && !attachChoice && (
            <div className="card card-warn">
              <b>{matchEvent.stationName} · {matchEvent.typeLabel}</b>
              <p className="muted" style={{ margin: '4px 0 0' }}>是同一件嗎？</p>
              <div className="match-actions">
                <button
                  className={attachChoice === 'same' ? 'primary-btn' : 'ghost-btn'}
                  onClick={() => setAttachChoice('same')}
                >
                  同一件
                </button>
                <button
                  className={attachChoice === 'separate' ? 'primary-btn' : 'ghost-btn'}
                  onClick={() => setAttachChoice('separate')}
                >
                  另一件
                </button>
              </div>
            </div>
          )}

          {error && <p className="error-note">{error}</p>}

          {/* 摘要：一行講清楚將送出什麼 */}
          <div className="send-summary">
            <Pictogram name={typeInfo?.id ?? 'other'} size={18} />
            <b>{typeInfo?.label}</b>
            <span className="muted">
              {venueName ?? claim?.stationId ?? (placeText.trim() || '位置稍後確認')}
            </span>
          </div>
        </div>
      )}

      {/* ===== 送出列：固定拇指區 ===== */}
      {step === 2 && (
        <div className="dock">
          <div className="dock-inner">
            <button
              className="primary-btn btn-block btn-lg"
              disabled={submitting || !readyToSubmit}
              onClick={handleSubmit}
            >
              {submitting
                ? '送出中…'
                : !hasLocationClue
                  ? '請先拍張照片或告訴我們位置'
                  : matchEvent && !attachChoice
                    ? '請先選「同一件／另一件」'
                    : '送出'}
            </button>
          </div>
        </div>
      )}

      {showPicker && (
        <VenuePicker
          onPickedPlace={(pl) => {
            setPlaceText(pl.name);
            setFix({ lat: pl.lat, lon: pl.lon, accuracy: 100 });
            setShowPicker(false);
          }}
          fix={fix}
          requestFix={ensureFix}
          onPicked={handlePicked}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
