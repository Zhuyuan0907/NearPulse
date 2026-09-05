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
import { compressPhoto, cropCell } from '../modules/photoCompressor.js';
import VenuePicker from '../components/VenuePicker.jsx';
import OfflineBar from '../components/OfflineBar.jsx';
import PhotoRoiPicker from '../components/PhotoRoiPicker.jsx';
import Pictogram from '../components/Pictogram.jsx';
import { isDictationSupported, startDictation } from '../modules/dictate.js';

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
  { id: 'fire',    label: '火警', cls: 'type-high',   hint: '煙、火、燒焦味' },
  { id: 'attack',  label: '攻擊', cls: 'type-high',   hint: '持械、傷人、有人逃竄' },
  { id: 'medical', label: '急救', cls: 'type-high',   hint: '有人倒下、受傷' },
  { id: 'crush',   label: '推擠', cls: 'type-medium', hint: '人潮擠壓、動線堵塞' },
  { id: 'other',   label: '其他', cls: 'type-low',    hint: '積水、異味、可疑物' },
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
  const [noteDictating, setNoteDictating] = useState(false);
  const noteDictationRef = useRef(null);
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
  // 照片把場域換掉時記下來——這件事必須讓使用者看得見
  const [venueSwitchedTo, setVenueSwitchedTo] = useState(null);
  /** 使用者自己描述的地點——圖資查不到時唯一的位置資訊 */
  const [placeText, setPlaceText] = useState('');
  const [dictating, setDictating] = useState(false);
  const dictationRef = useRef(null);

  const photoInputRef = useRef(null);
  const rawFileRef = useRef(null); // 保留原圖：裁切要從原圖裁才有解析度紅利

  /**
   * 位置線索。**四選一，至少要有一個。**
   *
   * 不要求「查得到的場域」——那會把不認得這個地方的人擋在門外，
   * 而那正是這個 App 存在的理由；圖資也永遠不會完整（百貨只涵蓋 58 個）。
   *
   * 但也不能完全不要位置：一則沒有任何位置的通報，沒有人能行動、
   * 也沒有人能確認，它只會成為態勢卡上的雜訊。
   *
   * 之所以「擇一」不算門檻，是因為其中兩條**完全不需要你知道自己在哪**：
   * 拍照只要把鏡頭對著牆，GPS 只要授權。照片就算 AI 讀不出來也算數——
   * 站務人員與其他在場的人看得懂那張照片。
   */
  const hasLocationClue = Boolean(
    claim?.stationId || placeText.trim() || fix || photo || photoRef
  );

  const readyToSubmit = Boolean(
    selectedType && hasLocationClue && (!matchEvent || attachChoice)
  );
  /**
   * 這個場域可能有列車嗎。地下街、百貨、地下停車場都不在捷運路網上，
   * 對它們顯示「事件發生在列車上」只是雜訊。
   */
  const canBeOnTrain = venue?.kind === 'metro' && venue.nextStations?.length > 0;
  /**
   * 候選裡有幾個**不同的場域**。跨站歧義要用站名按鈕解決，
   * 不能叫使用者「在地圖上點」——地圖一次只畫得出一個場域。
   */
  const venueChoices = [...new Map(candidates.map((c) => [c.venueId, c])).values()];

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

  /**
   * 補充描述的語音輸入。
   *
   * 與地點描述共用同一個模組，但**寫進 note 而不是 placeText**。
   * 一樣不會自動送出——辨識在吵雜的月台上會出錯，而這段文字會被
   * 其他人讀到，必須讓使用者過目。
   */
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
    if (!session) return; // 不支援或啟動失敗——打字照常，不打斷使用者
    dictationRef.current = session;
    setDictating(true);
  }

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
    // 刻意**不**強制跳出場域選擇器：不知道自己在哪的人也要能繼續往下走。
    // 位置改由「拍照辨識 / 選附近場域 / 直接送出」三條路並行提供。
    if (!claim) return;
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

    /**
     * 互動模式：AI 已經指出是哪一格，不該再要使用者點一下確認——直接接著讀字。
     *
     * **答不出是哪一格時就讀整張圖。**
     * 舊版在這裡直接停手（`else setVisionBusy(false)`），等於整張照片
     * 從來沒有被讀過——使用者拍了一張清楚的站名照，系統卻什麼都沒做。
     * 讀整張圖比較慢、小字也比較容易漏（實測整圖 5.2s vs 裁切 1.8s），
     * 但那是「有機會認出來」與「保證認不出來」的差別。
     * 使用者仍然可以事後點某一格重讀，那會用原圖的高解析度裁切。
     */
    await runRead(res.result.roiCell ?? null, file, compressed);
  }

  /**
   * 從**原圖**裁出指定格送去讀字。
   * 整張圖降到 512px 後出口牌的字只有 20~40px 高；裁切後可達 120px 以上。
   */
  async function runRead(cell, file, wholeImage = null) {
    setRoiCell(cell);
    setVisionBusy(true);

    // cell 為 null＝讀整張圖（AI 指不出格位時的後備，見 handlePhoto 的說明）
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
    /**
     * **低信心一律不自動套用。**
     *
     * 低信心的意思是「照片裡出現多個站名，系統無從消歧」——月台的指標帶上
     * 本來就同時印著前後站（拍土城的月台會讀到海山、永寧、往頂埔）。
     * 自動套用會直接給出**另一座車站**的疏散指示，而使用者不會察覺。
     * 這是實際回報過的 bug，寧可多要一次點擊。
     */
    if (top && top.confidence !== 'low') {
      if (top.venueId !== claim?.stationId) {
        await applyVenue(top.venueId, top.venueName);
        // 讓「照片把場域換掉了」這件事看得見——靜默切換正是出事的原因
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
        uuid: crypto.randomUUID(),          // 冪等鍵：連點重送 server 去重
        type: selectedType,
        // 沒有場域也送得出去——server 只要求「至少一種位置線索」，
        // 三者皆無也照收，只是標記為位置待確認
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
      setDone(true); // 樂觀 UI：不等批次、不等 AI

      // 疏散指示要**現在**就給——態勢卡要等下一個批次 tick，但人已經在逃了
      // 沒有場域就沒有出口圖資，疏散建議這條路直接略過（UI 會誠實說明）
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
    setNote(''); setShowDetails(false); setOnTrain(false); setNextVenueId(null); setNeedsAssistance(false);
    setPhoto(null); setPhotoRef(null); setRoiCell(null); setSuggestedCell(null);
    setReadTexts([]); setCandidates([]); setVenueSwitchedTo(null); setPlaceText('');
    setNearExitCode(null); setIncidentPoint(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null); rawFileRef.current = null;
    setEvac(null); stopSpeaking();
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
          <div className="done-icon done-icon-ok">✓</div>
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
            <a className="primary-btn" href="#/situation">查看目前狀況</a>
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
        <Pictogram name="pin" size={20} className="loc-pin" />
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
            <Pictogram name={t.id} size={30} className="type-pict" />
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

      {/* ⚠️ 這一段的顯示條件是 selectedType，**不能**是 readyToSubmit。
          readyToSubmit 現在要求「至少一種位置線索」，而提供位置線索的
          就是這一段——用 readyToSubmit 當條件會造成死鎖：
          使用者永遠看不到輸入位置的地方，因此永遠湊不齊送出條件。 */}
      {selectedType && (!matchEvent || attachChoice) && (
        <>
          <h2 className="section-title">這是哪裡？</h2>

          {/* 位置是**加分項，不是通行證**。
              三條路並行，隨便走一條都行，一條都不走也能送出——
              不知道自己在哪的人，正是最需要通報的人。 */}
          {!claim && (
            <div className="where-panel">
              <p className="where-lead">
                <b>三個裡面做一個就好。</b>不知道這裡叫什麼也沒關係——
                拍一張附近的牌子就行，系統自己讀。
              </p>

              <button className="where-opt" onClick={() => photoInputRef.current?.click()}>
                <Pictogram name="photo" size={22} />
                <span>
                  <b>拍附近的牌子　最省事</b>
                  <span className="where-sub">
                    站名牌、出口牌、柱號都行。就算讀不出來，照片本身也幫得上忙
                  </span>
                </span>
              </button>

              <button className="where-opt" onClick={() => setShowPicker(true)}>
                <Pictogram name="pin" size={22} />
                <span>
                  <b>從附近場域挑一個</b>
                  <span className="where-sub">需要定位訊號，或用搜尋</span>
                </span>
              </button>

              {/* 圖資永遠不會完整：836 個場域裡百貨只有 58 個。
                  查不到的地方（某間店、某條連通道）只能靠使用者自己講。 */}
              <label className="where-opt where-freeform">
                <Pictogram name="map" size={22} />
                <span>
                  <b>自己描述這是哪裡</b>
                  <span className="where-input-row">
                    <input
                      className="note-input where-input"
                      type="text"
                      inputMode="text"
                      maxLength={60}
                      placeholder="例：京站地下街 B1 星巴克前"
                      value={placeText}
                      onChange={(e) => setPlaceText(e.target.value)}
                    />
                    {/* 恐慌中打字很慢、手也可能在抖。講一句只要兩秒。
                        辨識結果填進輸入框讓使用者過目，**不會自動送出**——
                        吵雜的月台上辨識本來就會出錯，而這個欄位決定別人往哪裡找。
                        不支援的瀏覽器（iOS Safari）不顯示這顆，打字照常。 */}
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
                  {dictating && <span className="where-sub">聽著呢——說出你看到的地方</span>}
                </span>
              </label>
            </div>
          )}

          {/* 在列車上時，「哪個出口」是無意義的問題——2014 年鄭捷案就發生在
              行進中的車廂裡，乘客 4 分鐘無處可逃。勾了之後建議會整個換掉。

              **只有在路網上的捷運場域才問這件事**：在百貨公司、地下街或
              地下停車場裡沒有列車，這個選項出現只會佔掉版面並讓人困惑。
              判斷依據是 server 回的 nextStations（空陣列＝不在路網上）。 */}
          {claim && canBeOnTrain && (
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
              <Pictogram name="stepFree" size={18} />
              {stepFree ? '已選：需要無台階路線' : '我需要無台階路線'}
            </button>
            <button
              className={`chip${needsAssistance ? ' chip-active' : ''}`}
              style={{ flex: 1, minHeight: 48 }}
              onClick={() => setNeedsAssistance(!needsAssistance)}
            >
              🆘 {needsAssistance ? '已標記：有人需協助' : '有人無法自行疏散'}
            </button>
          </div>

          {/* 已經有場域時才顯示這排——沒有場域時上方的「這是哪裡？」
              已經提供同樣的兩條路，重複出現只會讓人不確定該按哪個 */}
          {claim && <div className="supp-row">
            <button className="ghost-btn btn-lg" onClick={() => photoInputRef.current?.click()}>
              <Pictogram name="photo" size={18} />
              拍照定位
            </button>
            <button className="ghost-btn btn-lg" disabled={gpsBusy} onClick={useGps}>
              {gpsBusy ? '定位中…' : '🛰️ GPS 定位'}
            </button>
          </div>}

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
              {/* 照片自動換掉了場域：明確講出來。使用者可能只是忘了改場域
                  （那就對了），也可能是照片讀到了鄰站（那就錯了）——
                  無論哪種，他都必須看得到這件事發生過。 */}
              {venueSwitchedTo && (
                <p className="ok-note">
                  依照片把場域改為 <b>{venueSwitchedTo}</b>——不對的話請點上方變更。
                </p>
              )}

              {/* 跨站的歧義**不能**用「點地圖」解決：地圖只畫得出一個場域的出口。
                  月台指標帶上同時印著前後站，這是很常見的情況。 */}
              {venueChoices.length > 1 && (
                <div className="venue-choice">
                  <p className="venue-choice-q">
                    照片裡出現多個站名——<b>你在哪一站？</b>
                  </p>
                  <div className="venue-choice-opts">
                    {venueChoices.map((c) => (
                      <button
                        key={c.venueId}
                        className={`chip${claim?.stationId === c.venueId ? ' chip-active' : ''}`}
                        style={{ minHeight: 48 }}
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
              {/* 【不要逼人瞎點】
                  知道自己在善導寺、但不知道在站體哪一邊，是很正常的事——
                  地下空間本來就難定向。舊版只寫「點出口圖釘」，等於暗示
                  一定要點；而隨手點一個出口會讓系統把它當成事件位置，
                  進而把**其他出口標成「不要走」**，可能把人推向錯的方向。
                  server 端已經改成沒有錨點就不產生「不要走」清單，
                  這裡把選擇權明確交還給使用者。 */}
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
                知道大概位置的話，點出口圖釘或地圖上的位置。
                <br />
                <span className="muted-2">
                  不確定就別點——猜錯會讓別人避開錯的出口。只寫「在善導寺」也很有用。
                </span>
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
              {/* 【從「錄音附件」改成「語音轉文字」】
                  舊版是按住說話、放開送出，錄下一段音檔附在回報上。
                  兩個問題：
                    1. 按住不放在手機上很脆弱——手指稍微移動觸發 onPointerLeave
                       就取消了，而點一下則是開了立刻關，什麼都沒發生
                    2. **那段音檔沒有人讀得到**。stt.js 從頭到尾是 stub，
                       也沒有播放介面，等於錄了丟進黑洞
                  現在改用瀏覽器內建辨識，點一下開始、再點一次結束，
                  結果直接寫進下面的文字欄讓使用者過目再送出。 */}
              {isDictationSupported() ? (
                <button
                  className={`mic-btn${noteDictating ? ' mic-recording' : ''}`}
                  onClick={toggleNoteDictation}
                >
                  <Pictogram name="mic" size={18} />
                  {noteDictating ? '聽著呢——再點一次結束' : '用說的（會轉成文字）'}
                </button>
              ) : (
                <p className="muted">（此瀏覽器不支援語音輸入，請用打字）</p>
              )}
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

      {/* 這不是頁尾連結，是**另一半的功能**。
          回報與查看是兩個對等的入口，把其中一個做成一行小字，
          等於告訴使用者它不重要——而事實上多數人打開 App 是為了「看發生什麼事」，
          不是為了通報。 */}
      <a className="situation-cta" href="#/situation">
        <Pictogram name="map" size={22} />
        <span className="situation-cta-body">
          <b>查看目前狀況</b>
          <span className="situation-cta-sub">附近有什麼事、往哪個出口走</span>
        </span>
        <span className="situation-cta-go" aria-hidden="true">→</span>
      </a>

      <footer className="page-footer">
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
              {/* 缺什麼就講什麼，並且指向最省事的那條路 */}
              {submitting
                ? '送出中…'
                : !hasLocationClue
                  ? '請先拍張照片或告訴我們位置'
                  : matchEvent && !attachChoice
                    ? '請先選「同一件／另一件」'
                    : attachChoice === 'same'
                      ? '送出（補充到既有事件）'
                      : claim?.stationId
                        ? '送出回報'
                        : '送出回報'}
            </button>
          </div>
        </div>
      )}

      {showPicker && (
        <VenuePicker
          onPickedPlace={(pl) => {
            // OSM 上的地點沒有出口資料——當成「使用者描述的地點」處理，
            // 帶上名稱與座標，但不設 venueId（否則會假裝我們有它的圖資）
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
