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
  parsePlaceFromSpeech,
} from '../modules/api.js';
import { isSpeechSupported, speak, stopSpeaking } from '../modules/speech.js';
import { compressPhoto, cropCell } from '../modules/photoCompressor.js';
import VenuePicker from '../components/VenuePicker.jsx';
import OfflineBar from '../components/OfflineBar.jsx';
import PhotoRoiPicker from '../components/PhotoRoiPicker.jsx';
import Pictogram from '../components/Pictogram.jsx';
import { isDictationSupported, startDictation, dictationErrorText } from '../modules/dictate.js';
import {
  detectSensors, watchVerticalMotion, watchMagneticAnomaly,
  sensorEvidenceForReport,
} from '../modules/sensors.js';

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

/** 麥克風鈕底下那一行字：狀態要用講的，不能只靠顏色變化 */
const DICTATE_HINT = {
  idle: '點一下開始說',
  starting: '麥克風啟動中…',
  listening: '正在聽…再點一下結束',
};

/**
 * 語音輸入的狀態機（地點描述與補充各用一份）。
 *
 * **點一下開始、再點一下結束**——不是按住說話。
 * `SpeechRecognition.start()` 要 200~800ms 才真的開始收音，而一次自然的
 * 點按只有 100ms 上下；按住說話的寫法等於在麥克風開起來之前就把它關掉，
 * 講什麼都進不到輸入框。手指些微移出按鈕（pointerleave）也會中斷。
 * 完整理由見 `modules/dictate.js` 的檔頭。
 *
 * @param {(base: string, text: string) => void} applyText
 *        把辨識結果寫進欄位。`base` 是開始講話當下欄位裡已經有的字——
 *        接在後面而不是覆蓋掉，打了一半改用說的才不會被清空。
 */
function useDictation(applyText, { onFinal } = {}) {
  const [state, setState] = useState('idle'); // idle | starting | listening
  const [error, setError] = useState(null);
  const sessionRef = useRef(null);
  const baseRef = useRef('');
  const finalRef = useRef('');

  // 離開這一頁就把麥克風關掉——沒有人希望它在背景繼續聽
  useEffect(() => () => sessionRef.current?.stop(), []);

  const toggle = useCallback((base = '') => {
    if (sessionRef.current) {          // 第二次點擊 = 講完了
      sessionRef.current.stop();
      return;
    }
    setError(null);
    baseRef.current = base;
    finalRef.current = '';
    setState('starting');
    const session = startDictation({
      onStart: () => setState('listening'),
      onText: (text, isFinal) => {
        if (isFinal) finalRef.current = text; // 定稿的最後一句
        applyText(baseRef.current, text);
      },
      onError: (code) => setError(dictationErrorText(code)),
      onEnd: () => {
        sessionRef.current = null;
        setState('idle');
        if (finalRef.current) onFinal?.(finalRef.current);
      },
    });
    // 起不來時 startDictation 已經呼叫過 onError，這裡只要把狀態收回去
    if (!session) { setState('idle'); return; }
    sessionRef.current = session;
  }, [applyText, onFinal]);

  return { state, error, toggle };
}

/** 麥克風圓鈕 + 狀態字 + 失敗原因。兩個欄位共用同一個外觀與行為 */
function MicButton({ dictation, base, size = 30, className = '', label }) {
  const { state, error, toggle } = dictation;
  const on = state === 'listening';
  return (
    <>
      <span className="where-say-row">
        <button
          type="button"
          className={`holdtalk-btn ${className}${on ? ' holdtalk-rec' : ''}${state === 'starting' ? ' holdtalk-wait' : ''}`}
          aria-label={on ? '結束語音輸入' : label}
          aria-pressed={on}
          onClick={() => toggle(base)}
        >
          <Pictogram name="mic" size={size} />
        </button>
        <span className={`holdtalk-state${on ? ' holdtalk-state-rec' : ''}`}>
          {DICTATE_HINT[state]}
        </span>
      </span>
      {/* 用 span 而非 p：地點描述那張卡是把它放在 <span> 裡面的 */}
      {error && <span className="dictate-err">{error}</span>}
    </>
  );
}

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

  // ---- 語音輸入：地點描述與補充各一份，互不干擾 ----
  const applyPlaceText = useCallback((base, text) => {
    setPlaceText(`${base}${base ? ' ' : ''}${text}`.slice(0, 60));
  }, []);
  const applyNoteText = useCallback((base, text) => {
    setNote(`${base}${base ? ' ' : ''}${text}`.slice(0, 140));
  }, []);

  /**
   * 地點語音講完 → 自動把整句縮成乾淨的地點名稱（MiniMax）。
   *
   * 「你好我現在在京站地下街」查不到任何東西；「京站地下街」查得到。
   * 解析結果直接**取代**欄位內容——語音的最終目的就是填這個欄，
   * 逐字稿不是。解析失敗（無金鑰／逾時／無網路）就保留原句，
   * 使用者自己看到句子也可以手動刪。
   */
  const onPlaceSpoken = useCallback(async (finalText) => {
    const parsed = await parsePlaceFromSpeech(finalText);
    if (parsed) setPlaceText(parsed.slice(0, 60));
  }, []);
  const placeDictation = useDictation(applyPlaceText, { onFinal: onPlaceSpoken });
  const noteDictation = useDictation(applyNoteText);

  const photoInputRef = useRef(null);
  const rawFileRef = useRef(null);

  // ---- 感測器旁證（漸進增強：有就用、沒有就 null，流程完全不受影響）----
  // 加速度計的下樓模式 + 磁力計的磁場異常都是「在地下」的旁證，
  // 收集後附在回報上（server 可用可不用）。氣壓計沒有 Web API——
  // 樓層估計只存在於 android/ 原生模組，WebView 情境經 native bridge 餵入。
  const [verticalState, setVerticalState] = useState(null);
  const [magneticAnomaly, setMagneticAnomaly] = useState(null);
  const verticalRef = useRef(null);
  const magneticRef = useRef(null);

  useEffect(() => {
    const caps = detectSensors();
    if (caps.motion) {
      verticalRef.current = watchVerticalMotion(setVerticalState); // iOS 未授權時回 null，靜默退場
    }
    if (caps.orientation) {
      magneticRef.current = watchMagneticAnomaly(setMagneticAnomaly);
    }
    return () => {
      verticalRef.current?.stop();
      magneticRef.current?.stop();
    };
  }, []);

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
    // GPS 已授權 → 靜默取定位。夠準（≤60m）就**直接當事件位置**，
    // 「GPS 定位」按鈕沒有存在的理由——已經拿到東西了還要人按確認，
    // 是多餘的一步。地下取不到或誤差大 → fix 為 null 或精度不足，
    // 使用者看到的就只有拍照定位，與原本行為一致。
    geolocationPermission().then((state) => {
      if (state !== 'granted') return;
      coarseFix().then((f) => {
        if (!f) return;
        setFix(f);
        if (f.accuracy <= GPS_USABLE_ACCURACY_M) {
          setIncidentPoint({ lat: f.lat, lon: f.lon });
        }
      });
    });
  }, [applyVenue]);

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
  // GPS 定位已在啟動 effect 自動套用（誤差 ≤60m 時直接當事件位置），
  // 不再有手動「GPS 定位」按鈕——拍照定位是唯一需要使用者主動做的定位動作。

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
      // 感測器旁證：有多少收集多少，沒有就是 null（附加欄位，不擋流程）
      const sensorEvidence = sensorEvidenceForReport({
        gpsOk: fix ? true : null,
        vertical: verticalState,
        magnetic: magneticAnomaly,
      });
      await postReport({
        uuid: crypto.randomUUID(),
        type: selectedType,
        sensorEvidence,
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

                  {/* 自己描述：輸入框與麥克風包在**同一個邊框卡**裡——
                      邊框延伸到麥克風，視覺上宣告「這兩個都是描述地點的方式」。

                      這裡刻意**不是** <label>：label 會把內部任何點擊
                      都導到它包住的 <input>，按麥克風時鍵盤會跳出來、
                      版面一位移手指就離開按鈕，語音等於按不到。 */}
                  <div className="where-opt where-freeform where-say">
                    <Pictogram name="map" size={24} />
                    <span>
                      <b>自己描述</b>
                      <span className="where-input-row">
                        <input
                          className="note-input where-input"
                          type="text"
                          inputMode="text"
                          maxLength={60}
                          aria-label="地點描述"
                          placeholder="例：京站地下街 B1"
                          value={placeText}
                          onChange={(e) => setPlaceText(e.target.value)}
                        />
                      </span>
                      {/* 用說的——大麥克風圓鈕，與第 2 頁同款。
                          恐慌中打字是懲罰，說一句只要兩秒。 */}
                      {isDictationSupported() && (
                        <MicButton
                          dictation={placeDictation}
                          base={placeText.trim()}
                          className="holdtalk-sm"
                          label="用說的說出地點"
                        />
                      )}
                    </span>
                  </div>
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

              {/* 已有場域：只留拍照定位。
                  GPS 已授權的話定位早就自動套用了（見啟動 effect），
                  再給一顆「GPS 定位」按鈕是重複動作；地下取不到定位時
                  那顆按鈕按了也只會失敗。一顆按鈕，一個動作。 */}
              {claim && (
                <button className="ghost-btn btn-lg btn-block" onClick={() => photoInputRef.current?.click()}>
                  <Pictogram name="photo" size={18} />
                  拍照定位
                </button>
              )}

              {/* GPS 自動套用的回饋：一行，不佔空間。
                  看得到「已定位」就不會有人去按按鈕重複確認。 */}
              {incidentPoint && !nearExitCode && (
                <p className="ok-note gps-ok">
                  <Pictogram name="pin" size={14} />
                  已用 GPS 自動定位
                </p>
              )}
              {fix && fix.accuracy > GPS_USABLE_ACCURACY_M && (
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

          {/* 用說的：大麥克風圓鈕。點一下開始、再點一下結束。
              沒有語音支援的手機（budget 機、iOS Safari）看不到它，
              直接看到「不補充也可以，直接送出」——永遠有最短路徑。 */}
          {isDictationSupported() ? (
            <div className="holdtalk">
              <MicButton
                dictation={noteDictation}
                base={note.trim()}
                size={40}
                label="用說的補充"
              />
            </div>
          ) : (
            <p className="muted" style={{ textAlign: 'center', margin: '4px 0 8px' }}>
              不補充也可以，直接送出
            </p>
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
