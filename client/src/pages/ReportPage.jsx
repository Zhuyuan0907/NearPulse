/**
 * ============================================================================
 * ReportPage —— 回報頁
 * ============================================================================
 * 版面順序刻意等同「恐慌時的思考順序」：
 *
 *   ① 我在哪    頂欄一行，已知就不必動它
 *   ② 發生什麼  四顆大按鈕，一次點擊即完成一筆有效回報
 *   ③ （選配）補充細節：位置更精確、語音、文字、照片
 *   ④ 送出      固定在畫面底部的拇指區，隨時可按
 *
 * 三種指定事件位置的方式，能用哪個就用哪個，全部失敗也不擋回報：
 *   GPS 定位   訊號好時（地面層、出入口附近）一鍵採用
 *   照片辨識   拍照 → 標出有站名/出口牌的那格 → 裁切放大讀字 → 查表
 *   地圖點選   在真實 OpenStreetMap 上直接點出事件位置
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveLocation, rememberStation, manualClaim, coarseFix, geolocationPermission,
} from '../modules/location.js';
import {
  postReport, fetchEventsContext, analyzePhoto, fetchVenue, fetchEvacuation,
} from '../modules/api.js';
import { isSpeechSupported, speak, stopSpeaking } from '../modules/speech.js';
import { isVoiceSupported, createRecorder } from '../modules/voiceRecorder.js';
import { compressPhoto, cropCell } from '../modules/photoCompressor.js';
import VenuePicker from '../components/VenuePicker.jsx';
import OfflineBar from '../components/OfflineBar.jsx';
import PhotoRoiPicker from '../components/PhotoRoiPicker.jsx';

/**
 * 地圖動態載入：Leaflet 加圖磚樣式約 150KB，但只有展開「補充細節」的人才需要。
 * 首屏（位置列 + 四顆類型按鈕 + 送出）是恐慌路徑，必須維持輕量——
 * 一次點擊就完成的回報，不該為了一張可能沒人打開的地圖付這個代價。
 */
const VenueMap = lazy(() => import('../components/VenueMap.jsx'));

/**
 * 事件類型（與 server config 對應；高嚴重度排前面）。
 *
 * 「攻擊」是依真實案例補上的——台北捷運 11 年來發生 5 起持械攻擊，
 * 原本只能歸到「其他」（門檻 3、嚴重度 low），那是嚴重的錯誤分類。
 */
const TYPES = [
  { id: 'fire',    label: '火警', emoji: '🔥', cls: 'type-high',   hint: '煙、火、燒焦味' },
  { id: 'attack',  label: '攻擊', emoji: '🔪', cls: 'type-high',   hint: '持械、傷人、有人逃竄' },
  { id: 'medical', label: '急救', emoji: '🚑', cls: 'type-high',   hint: '有人倒下、受傷' },
  { id: 'crush',   label: '推擠', emoji: '👥', cls: 'type-medium', hint: '人潮擠壓、動線堵塞' },
  { id: 'other',   label: '其他', emoji: '⚠️', cls: 'type-low',    hint: '積水、異味、可疑物' },
];

/** GPS 誤差小於這個值才值得拿來當事件位置（否則只用於收斂場域清單） */
const GPS_USABLE_ACCURACY_M = 60;

export default function ReportPage() {
  // ---- 定位 ----
  const [claim, setClaim] = useState(null);
  const [venueName, setVenueName] = useState(null);
  const [venue, setVenue] = useState(null);
  const [nearExitCode, setNearExitCode] = useState(null);
  const [incidentPoint, setIncidentPoint] = useState(null);
  const [fix, setFix] = useState(null);          // 目前的 GPS 定位
  const [showPicker, setShowPicker] = useState(false);

  // ---- 回報狀態 ----
  const [selectedType, setSelectedType] = useState(null);
  const [matchEvent, setMatchEvent] = useState(null);
  const [attachChoice, setAttachChoice] = useState(null); // null | 'same' | 'separate'
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(null);
  const [evac, setEvac] = useState(null); // 送出後立刻取得的疏散指示

  // ---- 選配補充 ----
  const [note, setNote] = useState('');
  // 無障礙偏好記在 sessionStorage：需要的人不必每次重選，但關頁即滅（不留個資）
  const [stepFree, setStepFree] = useState(() => sessionStorage.getItem('np_step_free') === '1');
  const [needsAssistance, setNeedsAssistance] = useState(false);
  // 在列車上：疏散建議完全不同——車廂裡沒有「出口」可去
  const [onTrain, setOnTrain] = useState(false);
  // 使用者指認的下一站——通知該站月台的依據
  const [nextVenueId, setNextVenueId] = useState(null);
  const [audioClip, setAudioClip] = useState(null);
  const [recording, setRecording] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [gpsBusy, setGpsBusy] = useState(false);

  // ---- 照片與視覺定位 ----
  const [photo, setPhoto] = useState(null);
  const [photoRef, setPhotoRef] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [roiCell, setRoiCell] = useState(null);
  const [suggestedCell, setSuggestedCell] = useState(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionOff, setVisionOff] = useState(false);
  const [visionMode, setVisionMode] = useState('off'); // interactive | deferred | off
  const [readTexts, setReadTexts] = useState([]);
  const [candidates, setCandidates] = useState([]);

  const recorderRef = useRef(null);
  const photoInputRef = useRef(null);
  const rawFileRef = useRef(null); // 保留原圖：裁切要從原圖裁才有解析度紅利

  const readyToSubmit = Boolean(claim && selectedType && (!matchEvent || attachChoice));
  /**
   * 這個場域可能有列車嗎。地下街、百貨、地下停車場都不在捷運路網上，
   * 對它們顯示「事件發生在列車上」只是雜訊。
   */
  const canBeOnTrain = venue?.kind === 'metro' && venue.nextStations?.length > 0;

  /** 設定當前場域：更新聲明、取出口圖資、寫入 session 記憶 */
  const applyVenue = useCallback(async (venueId, name = null, existingClaim = null) => {
    setClaim(existingClaim ?? manualClaim(venueId));
    setVenueName(name);
    setNearExitCode(null);
    setIncidentPoint(null);
    // 換場域後舊的列車狀態必然失效（新場域可能根本不在路網上）
    setOnTrain(false);
    setNextVenueId(null);
    rememberStation(venueId, name);
    const v = await fetchVenue(venueId);
    setVenue(v);
    if (v?.name) { setVenueName(v.name); rememberStation(venueId, v.name); }
  }, []);

  // ---- 啟動 ----
  useEffect(() => {
    // session 記憶連場域名一起存，頂欄才不會先閃站碼（BL13）再變「善導寺」
    resolveLocation().then(({ claim, stationName }) => {
      if (claim) applyVenue(claim.stationId, stationName, claim);
    });
    // **只有已經授權過的人才靜默取定位**。沒授權過的留到打開場域選擇器時再問——
    // 那時畫面上正寫著「附近的場域」，理由自明。一開 App 就跳權限，
    // 使用者還不知道這是什麼就會拒絕，而拒絕之後整個 session 的定位就沒了。
    geolocationPermission().then((state) => {
      if (state === 'granted') coarseFix().then(setFix);
    });
  }, [applyVenue]);

  /** 需要定位時才實際去要（場域選擇器與 GPS 按鈕共用） */
  const ensureFix = useCallback(async () => {
    const f = await coarseFix();
    setFix(f);
    return f;
  }, []);

  // 預覽 URL 用完要釋放，否則連拍幾張就漏一堆記憶體
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

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
    // 「先點類型、後選場域」的順序若不補這一步，會跳過歸屬確認而永遠開新事件
    refreshMatch(venueId, selectedType);
  }

  async function handleType(type) {
    setSelectedType(type);
    setError(null);
    if (!claim) { setShowPicker(true); return; }
    await refreshMatch(claim.stationId, type);
  }

  // ===================== 位置精確化 =====================

  /** GPS 夠準時直接當事件位置。地下多半失敗，那是設計中的常態 */
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

    // 延後模式（慢速供應商，實測 34 秒）：不在這裡等。
    // 照片會隨回報送出，辨識在批次端非同步跑，位置稍後自動補上。
    if (res.mode === 'deferred') { setVisionBusy(false); return; }

    // 互動模式：AI 已經指出是哪一格，不該再要使用者點一下確認——直接接著讀字。
    if (res.result.roiCell) await runRead(res.result.roiCell, file);
    else setVisionBusy(false);
  }

  /**
   * 從**原圖**裁出指定格送去讀字。
   * 整張圖降到 512px 後出口牌的字只有 20~40px 高；裁切後可達 120px 以上。
   */
  async function runRead(cell, file) {
    setRoiCell(cell);
    setVisionBusy(true);
    const crop = await cropCell(file, cell);
    if (!crop) { setVisionBusy(false); return; }

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

    const top = res.candidates?.[0];
    if (top) {
      if (top.venueId !== claim?.stationId) await applyVenue(top.venueId, top.venueName);
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
        uuid: crypto.randomUUID(),          // 冪等鍵：連點重送 server 去重
        type: selectedType,
        locationClaim: { ...claim, timestamp: Date.now() },
        attachToEventId: attachChoice === 'same' ? matchEvent?.id ?? null : null,
        nearExitCode,
        incidentPoint,
        photoRoi: roiCell,
        needsAssistance,
        onTrain,
        nextVenueId: onTrain ? nextVenueId : null,
        note: note.trim() || null,
        audio: audioClip,
        photo,
        photoRef,
      });
      setDone(true); // 樂觀 UI：不等批次、不等 AI

      // 疏散指示要**現在**就給——態勢卡要等下一個批次 tick，但人已經在逃了
      fetchEvacuation({
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
    setNote(''); setAudioClip(null); setShowDetails(false); setOnTrain(false); setNextVenueId(null); setNeedsAssistance(false);
    setPhoto(null); setPhotoRef(null); setRoiCell(null); setSuggestedCell(null);
    setReadTexts([]); setCandidates([]); setNearExitCode(null); setIncidentPoint(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null); rawFileRef.current = null;
    setEvac(null); stopSpeaking();
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

  // ===================== 送出完成 =====================
  if (done) {
    // 播報的內容 = 螢幕上看到的內容。濃煙中看不到螢幕、人又在移動，
    // 用聽的才真的接收得到；瀏覽器內建語音是離線的，不需要網路。
    // 有勾無障礙就顯示／播報無障礙版本——那是性質不同的答案，不是同一句話的變體
    const evacText = stepFree ? (evac?.evacuationStepFree ?? evac?.evacuation) : evac?.evacuation;
    const spoken = [evac?.advice, evacText].filter(Boolean).join('。');
    return (
      <div className="page">
        <div className="done-box">
          <div className="done-icon">✅</div>
          <h2>已通報</h2>

          {evacText ? (
            <>
              <p className="advice">{evac.advice}</p>
              <p className="evac-line">🧭 {evacText}</p>
              {isSpeechSupported() && (
                <button
                  className="primary-btn btn-block btn-lg"
                  style={{ marginTop: 14 }}
                  onClick={() => speak(spoken)}
                >
                  🔊 唸出疏散指示
                </button>
              )}
            </>
          ) : (
            <p className="muted">
              已記錄你的回報。若現場有其他人確認，事件會升級並顯示在態勢卡上。
            </p>
          )}

          <div className="done-actions">
            <a className="primary-btn" href="#/situation">查看態勢卡</a>
            <button className="ghost-btn" onClick={() => { setDone(false); resetDraft(); }}>
              再回報一筆
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- 位置摘要文字 ----
  const locSub = !claim
    ? '點此選擇你所在的場域'
    : [
        nearExitCode && `近 ${nearExitCode} 出口`,
        incidentPoint && !nearExitCode && '已在地圖上標記位置',
        claim.source === 'session' && '上次確認的位置',
      ].filter(Boolean).join(' · ') || '已確認';

  return (
    <div className={`page${selectedType ? ' page-with-dock' : ''}`}>
      <OfflineBar />

      {/* ===== ① 我在哪 ===== */}
      <button
        className={`loc-bar${claim ? '' : ' loc-unset'}`}
        onClick={() => setShowPicker(true)}
      >
        <span className="loc-pin">📍</span>
        <span className="loc-body">
          <span className="loc-title">{venueName ?? (claim ? claim.stationId : '尚未選擇場域')}</span>
          <span className="loc-sub">{locSub}</span>
        </span>
        <span className="loc-action">{claim ? '變更' : '選擇'}</span>
      </button>

      {/* ===== ② 發生什麼事 ===== */}
      <h1 className="headline">發生什麼事？</h1>
      <p className="subhead">點一下就完成通報，其他都是選配。</p>
      <div className="type-grid">
        {TYPES.map((t) => (
          <button
            key={t.id}
            className={`type-btn ${t.cls}${selectedType === t.id ? ' type-selected' : ''}`}
            onClick={() => handleType(t.id)}
          >
            <span className="type-emoji">{t.emoji}</span>
            {t.label}
            <span className="type-hint">{t.hint}</span>
          </button>
        ))}
      </div>

      {/* ===== 歸屬確認：同場域同類型已有進行中事件 ===== */}
      {matchEvent && (
        <>
          <h2 className="section-title">附近已有一則進行中的事件</h2>
          <div className="card card-warn">
            <b>{matchEvent.stationName} · {matchEvent.typeLabel}</b>
            <p className="muted" style={{ margin: '4px 0 0' }}>
              已有 {matchEvent.reportCount} 筆回報。你要回報的是——
            </p>
            {/* 選完不直接送出：兩條路徑都往下走補充區，
                因為「補一筆到既有事件」往往正是最需要位置資訊的時候 */}
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
        </>
      )}

      {/* ===== ③ 定位：拍照是主要動作，不藏在收合區裡 ===== */}
      {/* 拍照辨識是整個系統的核心能力，把它埋在「＋加上補充」後面等於沒有。
          它跟送出並列，才是它應得的層級。語音／文字才是真正的選配。 */}
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

      {readyToSubmit && (
        <>
          <h2 className="section-title">事件在哪裡？（愈精確，疏散建議愈有用）</h2>

          {/* 在列車上時，「哪個出口」是無意義的問題——2014 年鄭捷案就發生在
              行進中的車廂裡，乘客 4 分鐘無處可逃。勾了之後建議會整個換掉。

              **只有在路網上的捷運場域才問這件事**：在百貨公司、地下街或
              地下停車場裡沒有列車，這個選項出現只會佔掉版面並讓人困惑。
              判斷依據是 server 回的 nextStations（空陣列＝不在路網上）。 */}
          {canBeOnTrain && (
            <button
              className={`chip${onTrain ? ' chip-active' : ''}`}
              style={{ width: '100%', minHeight: 48, marginBottom: 10 }}
              onClick={() => { setOnTrain(!onTrain); setNextVenueId(null); }}
            >
              🚃 {onTrain ? '已標記：事件在列車上' : '事件發生在列車上'}
            </button>
          )}

          {/* 下一站是哪一站。
              **刻意不問「往哪個方向」**——恐慌中那是個抽象問題（往東？上行？）。
              「下一站」是車廂顯示器正在跑的字、廣播正在唸的詞，抬頭就能回答，
              而在捷運路網上它唯一決定了方向，資訊量完全相同。

              答了之後，下一站月台上的人會收到「事故列車即將進站，請讓開車門」——
              能讓車廂裡的人出得來的，是月台上的那群人。 */}
          {onTrain && canBeOnTrain && (
            <div className="next-station" style={{ marginBottom: 10 }}>
              <div className="next-station-q">下一站是？<span className="muted">（看車廂顯示器）</span></div>
              <div className="next-station-opts">
                {venue.nextStations.map((s) => (
                  <button
                    key={s.venueId}
                    className={`chip${nextVenueId === s.venueId ? ' chip-active' : ''}`}
                    style={{ flex: '1 1 40%', minHeight: 52, flexDirection: 'column', gap: 2 }}
                    onClick={() => setNextVenueId(nextVenueId === s.venueId ? null : s.venueId)}
                  >
                    <span style={{ fontWeight: 700 }}>{s.name}</span>
                    <span className="muted" style={{ fontSize: '.75rem' }}>往{s.towards}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* 無障礙路線：一鍵切換，不需帳號、不留紀錄（關頁即滅）。
              勾選後疏散建議會改成「無台階可通行」的版本——
              火災時電梯不可用，所以那往往是完全不同的答案。 */}
          <div className="supp-row" style={{ marginBottom: 10 }}>
            <button
              className={`chip${stepFree ? ' chip-active' : ''}`}
              style={{ flex: 1, minHeight: 48 }}
              onClick={() => {
                const next = !stepFree;
                setStepFree(next);
                sessionStorage.setItem('np_step_free', next ? '1' : '0');
              }}
            >
              ♿ {stepFree ? '已選：需要無台階路線' : '我需要無台階路線'}
            </button>
            <button
              className={`chip${needsAssistance ? ' chip-active' : ''}`}
              style={{ flex: 1, minHeight: 48 }}
              onClick={() => setNeedsAssistance(!needsAssistance)}
            >
              🆘 {needsAssistance ? '已標記：有人需協助' : '有人無法自行疏散'}
            </button>
          </div>

          <div className="supp-row">
            <button className="ghost-btn btn-lg" onClick={() => photoInputRef.current?.click()}>
              📷 拍照定位
            </button>
            <button className="ghost-btn btn-lg" disabled={gpsBusy} onClick={useGps}>
              {gpsBusy ? '定位中…' : '🛰️ GPS 定位'}
            </button>
          </div>

          {gpsBusy && <p className="muted">正在取得定位（最多 5 秒）…</p>}
          {!gpsBusy && fix && fix.accuracy > GPS_USABLE_ACCURACY_M && (
            <div className="notice notice-warn" style={{ marginTop: 10 }}>
              GPS 誤差約 {Math.round(fix.accuracy)}m，不足以定位到出口——這是地下的常態。
              請改用拍照定位，或直接在地圖上點。
            </div>
          )}

          {/* --- 照片九宮格：拍完立刻出現，AI 建議的那格會自動送去讀字 --- */}
          {previewUrl && (
            <div className="card" style={{ marginTop: 12 }}>
              <PhotoRoiPicker
                previewUrl={previewUrl}
                cell={roiCell}
                suggested={suggestedCell}
                busy={visionBusy}
                onPick={handleRoiPick}
              />
              {visionOff && (
                <p className="muted">（視覺辨識未啟用——照片仍會附上，位置請用地圖確認）</p>
              )}
              {visionMode === 'deferred' && (
                <p className="muted">
                  照片已收下。辨識在背景進行（約 30 秒），位置會自動補上——
                  你現在就可以直接送出，不必等。
                </p>
              )}
              {readTexts.length > 0 && (
                <p className="ok-note">
                  讀到：{readTexts.map((t) => `${t.label}「${t.value}」`).join('、')}
                </p>
              )}
              {candidates.length > 1 && (
                <p className="muted">
                  有 {candidates.length} 個可能的位置——請在下方地圖點選正確的出口。
                </p>
              )}
            </div>
          )}

          {/* --- 地圖：確認或更正 --- */}
          {venue && (
            <div style={{ marginTop: 12 }}>
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
              <p className="muted" style={{ marginTop: 6 }}>
                點出口圖釘，或直接點地圖上事件發生的位置。
              </p>
            </div>
          )}

          {/* ===== ④ 真正選配的補充：語音與文字 ===== */}
          <h2 className="section-title">補充描述（選配）</h2>
          {!showDetails ? (
            <button className="ghost-btn btn-block" onClick={() => setShowDetails(true)}>
              ＋ 加上語音或文字說明
            </button>
          ) : (
            <div className="card stack">
              {isVoiceSupported() ? (
                <button
                  className={`mic-btn${recording ? ' mic-recording' : ''}`}
                  onPointerDown={handleMicDown}
                  onPointerUp={handleMicUp}
                  onPointerLeave={handleMicUp}
                >
                  {recording ? '🔴 放開送出' : '🎤 按住說話'}
                </button>
              ) : (
                <p className="muted">（此瀏覽器不支援錄音，可改用文字）</p>
              )}
              {audioClip && <p className="ok-note">已收錄語音補充</p>}
              <textarea
                className="note-input"
                placeholder="輸入文字（140 字內）"
                maxLength={140}
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>
          )}
        </>
      )}

      {error && <p className="error-note" style={{ marginTop: 12 }}>{error}</p>}

      <footer className="page-footer">
        <a href="#/situation">查看態勢卡 →</a>
        {venue?.attribution && <p className="attribution">{venue.attribution}</p>}
      </footer>

      {/* ===== ④ 送出：固定在拇指區 ===== */}
      {selectedType && (
        <div className="dock">
          <div className="dock-inner">
            <button
              className="primary-btn btn-block btn-lg"
              disabled={submitting || !readyToSubmit}
              onClick={handleSubmit}
            >
              {submitting
                ? '送出中…'
                : !claim
                  ? '請先選擇場域'
                  : matchEvent && !attachChoice
                    ? '請先選「同一件／另一件」'
                    : attachChoice === 'same'
                      ? '送出（補充到既有事件）'
                      : '送出回報'}
            </button>
          </div>
        </div>
      )}

      {showPicker && (
        <VenuePicker
          fix={fix}
          requestFix={ensureFix}
          onPicked={handlePicked}
          onCancel={() => setShowPicker(false)}
        />
      )}
    </div>
  );
}
