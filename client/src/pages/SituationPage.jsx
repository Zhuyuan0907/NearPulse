/**
 * ============================================================================
 * SituationPage —— 讀取端：目前狀況
 * ============================================================================
 * 「弱網優先」的落實：
 *   - 內容是後端預先算好的 <50KB JSON，這頁只負責渲染，零業務邏輯
 *   - ETag 輪詢（12 秒）：304 時不重渲染；前台可見才輪詢
 *   - **預設不載入地圖**——讀取端要能在最差的網路下開起來。
 *     地圖改為每則事件可個別展開（React.lazy），文字敘述任何情況下都先到。
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

import { lazy, Suspense, useEffect, useState } from 'react';
import { startSituationPolling } from '../modules/api.js';
import { isSpeechSupported, speak } from '../modules/speech.js';
import OfflineBar from '../components/OfflineBar.jsx';
import { etaOf } from '../modules/train.js';
import { coarseFix, lastKnownFix, resolveLocation } from '../modules/location.js';
import { wordingFor } from '../modules/incidentWording.js';
import Pictogram from '../components/Pictogram.jsx';

/**
 * 地圖**動態載入**：leaflet 與圖磚加起來遠超過整張態勢卡的預算。
 * 這頁必須在最差的網路下開得起來，所以地圖是點開才付費的補充資訊。
 */
const IncidentMap = lazy(() => import('../components/IncidentMap.jsx'));
/** 總覽地圖同樣動態載入，與事件地圖共用同一個 leaflet chunk */
const OverviewMap = lazy(() => import('../components/OverviewMap.jsx'));

const THREAT_LABEL = {
  high: '高警戒',
  medium: '中警戒',
  low: '注意',
  unverified: '未經確認',
};

const KIND_LABEL = {
  metro: '捷運站', underground: '地下街', parking: '地下停車場', retail: '百貨／商場',
};

/** 事件類型 → 標示圖標。與回報頁共用同一組形狀，使用者只需要學一次 */
const TYPE_PICT = { 火警: 'fire', 攻擊: 'attack', 急救: 'medical', 推擠: 'crush' };
const pictOf = (typeLabel) => TYPE_PICT[typeLabel] ?? 'other';

/**
 * 距離範圍選項。
 *
 * 「全部」放最後而不是預設：一個剛進來的人要看的是**跟他有關**的事，
 * 而不是全台灣（含關西）所有通報排成一列。但如果拿不到位置，
 * 就只能是全部——那時候「附近」是個答不出來的問題。
 */
const RANGES = [
  { id: 1000, label: '1 公里內' },
  { id: 5000, label: '5 公里內' },
  { id: 0, label: '全部' },
];

/** 等距圓柱近似——這裡只用來排序與篩選，不顯示數字 */
function roughDistM(a, b) {
  const k = 111_320;
  return Math.hypot(
    (a.lat - b.lat) * k,
    (a.lon - b.lon) * k * Math.cos((a.lat * Math.PI) / 180)
  );
}

/** 由場域 id 取路線代碼（TPE-BL13 → BL）。取不到就不上色，不硬湊。 */
function lineOf(venueId) {
  const m = /^[A-Z]{3}-([A-Z]{1,2})\d/.exec(venueId ?? '');
  return m ? m[1] : null;
}

const time = (ts) =>
  new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });

/** 把結構化計畫組成一句話——只給語音，畫面上是排版好的區塊 */
function planToSpeech(ev, plan) {
  // 句尾標點交給這裡統一處理，避免把「…勿使用電梯。」接上「。往 M7」變成雙句號
  const sentence = (t) => String(t ?? '').trim().replace(/[。．.]+$/, '');
  const join = (...parts) => parts.filter(Boolean).map(sentence).join('。') + '。';

  if (!plan) return join(ev.advice);
  const name = (e) => (e.landmark ? `${e.code} 出口，往${e.landmark}` : `${e.code} 出口`);

  if (plan.kind === 'shelter') return join(ev.advice, plan.reason, plan.action);
  if (plan.kind === 'onTrain') return join(plan.action, ev.advice);

  /**
   * **可執行的先唸。**
   * 濃煙中聽的人只會接收到前幾秒——「往 M7 出口」必須排在
   * 「依站務人員指示疏散」這種一般性建議之前。
   */
  const go = plan.go.map(name).join('、');
  const avoid = plan.avoid.length
    ? `避開 ${plan.avoid.map((e) => `${e.code} 出口`).join('、')}`
    : '';
  return join(`往 ${go} 移動`, avoid, ev.advice);
}

/** 車廂內的到站倒數：站名要大，那是他抬頭核對顯示器的東西 */
function ArrivalCountdown({ arrival }) {
  const eta = useEta(arrival.arriveAt);
  if (!eta) return null;
  return (
    <div className="arrival">
      <span className="arrival-eta">{eta.text}</span>
      <span className="arrival-station">{arrival.name}</span>
      <span className="arrival-towards">往{arrival.towards}</span>
    </div>
  );
}

/**
 * 指標列：`[編號色塊] ↑ 目的地`。
 *
 * 這是站內出口指標的排版——編號是最大的元素，箭頭是資訊（方向）而不是裝飾，
 * 地標跟在箭頭後面。使用者抬頭看到的牌子就長這樣，介面照抄可以省掉一次轉譯。
 */
function ExitRow({ exit, mode = 'go' }) {
  return (
    <div className="exit-row">
      <span className={`exit-code exit-code-${mode}`}>{exit.code}</span>
      <span className="exit-arrow" aria-hidden="true">{mode === 'go' ? '↑' : '⤫'}</span>
      <span className="exit-where">
        {/* 方位優先、門牌降級。
            門牌號碼回答的是「我出去之後會在哪」，不是「我在站內該往哪走」——
            而站在地下室的人問的是後者。站體方位是我們算得出來的，
            而且對應得上地下最基本的空間感。 */}
        {exit.side && <span className="exit-side">站體{exit.side}側</span>}
        {exit.landmark && (
          <span className="exit-surface">
            {exit.side ? '出去是 ' : ''}{exit.landmark}
          </span>
        )}
        {!exit.side && !exit.landmark && '出口'}
      </span>
    </div>
  );
}

/** 疏散計畫：拆成可掃視的區塊，而不是一整段字 */
function EvacPlan({ plan, arrival, offMap }) {
  if (!plan) {
    return (
      <p className="plan-none">
        {offMap ? '此地點無出口資料——請依現場逃生標示行動。' : '此場域無出口資料——請依現場逃生標示行動。'}
      </p>
    );
  }

  if (plan.kind === 'onTrain') {
    return (
      <div className="plan plan-shelter">
        <div className="plan-head plan-head-stop">你在車廂裡，沒有「出口」可去</div>
        {arrival && <ArrivalCountdown arrival={arrival} />}

        {arrival?.doorSide?.label && (
          <div className="door-side">
            <Pictogram name="door" size={22} />
            <span>
              下一站<b>{arrival.doorSide.label}開門</b>——先移到那一側
            </span>
          </div>
        )}

        <p className="plan-action">{plan.action}</p>

        {arrival && (
          <p className="plan-note">
            已通知 <b>{arrival.name}</b> 月台讓開車門。
            {plan.stepFree && arrival.wheelchairCars?.length > 0 && (
              <>{' '}輪椅席：第 {arrival.wheelchairCars.join('、')} 節。</>
            )}
          </p>
        )}
      </div>
    );
  }

  if (plan.kind === 'shelter') {
    return (
      <div className="plan plan-shelter">
        <div className="plan-head plan-head-stop">不要前往出口</div>
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
          {plan.avoid.map((e) => <ExitRow key={e.code} exit={e} mode="avoid" />)}
        </div>
      )}

      <p className="plan-note">
        {plan.anchored === false
          ? '事件位置未確認——以下是此場域出口，依現場狀況選擇。'
          : plan.note}
        {plan.unknownExits > 0 && `（${plan.unknownExits} 個出口無無障礙資訊）`}
      </p>
    </div>
  );
}

/** 事故列車即將進站——月台上的人是唯一能改變車廂內結果的那群人 */
function InboundAlert({ alert }) {
  const eta = useEta(alert.arriveAt);
  if (!eta) return null;
  return (
    <div className="inbound-alert">
      <div className="inbound-head">
        {eta.arrived ? '事故列車應已進站' : '事故列車即將進站'}
        <span className="inbound-eta">{eta.text}</span>
      </div>
      <div className="inbound-where">
        <b>{alert.venueName}</b>（{alert.lineNo} 線 · 往{alert.towards}）
      </div>
      <div className="inbound-what">車上有<b>{alert.typeLabel}</b>事件</div>
      <p className="inbound-action">{eta.action}</p>
    </div>
  );
}

/**
 * 到站倒數：每秒重算一次。
 *
 * 計時器只在**還沒到站時**存在——到站後就沒有東西需要更新了，
 * 讓它繼續跑只是白白耗電。這頁的使用者多半在地下、電量寶貴。
 */
function useEta(arriveAt) {
  const [eta, setEta] = useState(() => (arriveAt ? etaOf(arriveAt) : null));

  useEffect(() => {
    if (!arriveAt) { setEta(null); return undefined; }

    const first = etaOf(arriveAt);
    setEta(first);
    // 已經到站就不要開計時器：畫面停在「應已進站」，不需要每秒更新。
    // 這頁的使用者多半在地下、電量寶貴，能不跑的迴圈就不跑。
    if (first.arrived) return undefined;

    const id = setInterval(() => {
      const next = etaOf(arriveAt);
      setEta(next);
      if (next.arrived) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [arriveAt]);

  return eta;
}

/**
 * 地圖開關。收合是預設值，而且**不記憶**——每次進來都從最省流量的狀態開始。
 * 沒有座標時整個按鈕不出現（地下停車場這類只有場域級資料的地方）。
 */
function EventMapToggle({ plan, incidentPoint, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  const hasGeo = Boolean(incidentPoint ?? plan?.origin);
  if (!hasGeo) return null;

  if (!open) {
    return (
      <button className="chip map-toggle" onClick={() => setOpen(true)}>
        <Pictogram name="map" size={18} />
        展開地圖
      </button>
    );
  }

  return (
    <>
      <Suspense fallback={<div className="incident-map-loading">地圖載入中…</div>}>
        <IncidentMap plan={plan} incidentPoint={incidentPoint} />
      </Suspense>
      <button className="chip map-toggle" onClick={() => setOpen(false)}>收合</button>
    </>
  );
}

export default function SituationPage() {
  const [card, setCard] = useState(null);
  // 無障礙偏好與回報端共用同一個 sessionStorage 鍵——
  // 需要的人在回報頁勾過，來看狀況時不必再勾一次
  const [stepFree, setStepFree] = useState(() => sessionStorage.getItem('np_step_free') === '1');
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [fix, setFix] = useState(() => lastKnownFix());
  // 沒有位置就沒有「附近」可言，預設只能是全部
  const [range, setRange] = useState(() => (lastKnownFix() ? 5000 : 0));
  // 地圖預設**收合**——進頁面先看文字（任何網路都到得了），
  // 空間分佈是想看才開的補充視角，不該與事件卡的地圖搶注意力。
  const [mapOpen, setMapOpen] = useState(false);
  /** 你在哪——決定了「附近」是什麼意思 */
  const [here, setHere] = useState(null);
  /** 警示/雜項區塊的收合——平時只佔一行摘要 */
  const [alertsOpen, setAlertsOpen] = useState(false);
  /** 目前顯示第幾則事件（分頁式：一屏一卡，不縱向堆疊） */
  const [eventIndex, setEventIndex] = useState(0);

  useEffect(() => {
    const poller = startSituationPolling(setCard, { intervalMs: 12_000 });
    return () => poller.stop();
  }, []);

  // 上次確認過的場域（回報頁選的那個）——讓「附近」有具體的參照
  useEffect(() => {
    resolveLocation().then(({ claim, stationName }) => {
      if (claim) setHere({ id: claim.stationId, name: stationName ?? claim.stationId });
    });
  }, []);

  // 靜默試一次定位：拿得到就能篩「附近」，拿不到就維持全部（地下的常態）
  useEffect(() => {
    let alive = true;
    coarseFix().then((f) => {
      if (!alive || !f) return;
      setFix(f);
      setRange((r) => (r === 0 ? 5000 : r));
    });
    return () => { alive = false; };
  }, []);

  function toggleMap() {
    setMapOpen(!mapOpen);
  }

  /** 捲到某個事件卡——總覽地圖的錨點。分頁式之後地圖點擊直接跳到那一頁 */
  function scrollToGroup(group) {
    const idx = flatEvents.findIndex(
      (it) => it.venue.stationId === group.stationId
        || it.venue.stationName === group.stationName
    );
    if (idx >= 0) setEventIndex(idx);
  }

  function toggleStepFree() {
    const next = !stepFree;
    setStepFree(next);
    sessionStorage.setItem('np_step_free', next ? '1' : '0');
  }

  if (!card) {
    return <div className="page"><p className="muted">載入中…</p></div>;
  }

  /**
   * 套用搜尋與距離篩選。
   *
   * 距離篩選只在**拿得到位置**且事件**有座標**時生效——
   * 沒有座標的事件（使用者自己描述的地點）永遠留著，
   * 因為我們無從判斷它遠不遠，而把它藏起來等於讓它消失。
   */
  const q = query.trim().toLowerCase();
  const groups = card.stations.filter((g) => {
    if (q && !g.stationName.toLowerCase().includes(q)) return false;
    if (!range || !fix) return true;
    if (!Number.isFinite(g.lat)) return true;
    return roughDistM(fix, g) <= range;
  });
  const hiddenCount = card.stations.length - groups.length;
  // 徵詢中的清單套用同一組篩選——只篩事件卻不篩徵詢，會出現
  // 「上面說範圍內沒事、下面卻列著五則徵詢」的矛盾畫面
  const visibleIds = new Set(groups.flatMap((g) => g.events.map((e) => e.id)));

  /**
   * 範圍篩選要**套用到整頁**，不只事件區塊。
   *
   * 使用者選了「5 公里內」，卻在警示區看到半個城市外的地方，那個選擇
   * 等於沒有作用——而雜訊正是他要擺脫的東西。沒有座標的項目一律留著：
   * 我們無從判斷它遠不遠，藏起來等於讓它消失。
   */
  const inRange = (x) => {
    if (!range || !fix) return true;
    if (!Number.isFinite(x?.lat) || !Number.isFinite(x?.lon)) return true;
    return roughDistM(fix, x) <= range;
  };
  const nearbyAlerts = (card.nearbyAlerts ?? []).filter(inRange);
  const resolved = (card.resolved ?? []).filter(inRange);
  const inboundAlerts = (card.inboundAlerts ?? []).filter(
    (a) => visibleIds.size === 0 || groups.some((g) => g.stationId === a.venueId)
      || card.stations.some((g) => g.stationName === a.fromVenue && groups.includes(g))
  );

  /**
   * 所有事件**展平成一列**：一次只顯示一張卡，左右切換。
   *
   * 舊版把每個場域的事件全部縱向堆疊——2~3 個事件就得上下拖半天，
   * 恐慌中「拖動網頁找重點」是最危險的操作。分頁把「掃全部」變成
   * 「按一下下一則」，每張卡獨占視線，沒有相鄰事件的雜訊。
   */
  const flatEvents = groups.flatMap((venue) =>
    venue.events.map((ev) => ({ venue, ev }))
  );
  const current = flatEvents[Math.min(eventIndex, flatEvents.length - 1)];
  const alertCount = inboundAlerts.length + nearbyAlerts.length + resolved.length;
  // 沒有一個場域有座標就畫不出總覽地圖（只有場域級資料的地下停車場等）
  const hasOverview = groups.some((g) => Number.isFinite(g.lat));

  return (
    <div className="page">
      <OfflineBar />

      <div className="card-head">
        <h1 className="headline" style={{ margin: 0 }}>目前狀況</h1>
        <span className="card-time">更新於 {time(card.generatedAt)}</span>
      </div>

      {/* ===================================================================
          控制面板：一個框，內部用細線分列
          -------------------------------------------------------------------
          舊版把「你在哪」「無台階」「範圍篩選」「展開地圖」「周邊訊息」
          各做成一張有邊框的卡——五層框疊在事件之前，每一層都在喊
          「我是一個獨立區塊」，結果是真正的主體（事件卡）被擠到第二屏，
          而每一個框看起來都一樣重要。
          這些其實是同一類東西：**看事件之前的設定**。所以合成一張面板，
          外框只有一層，列與列之間用 1px 細線分開就夠了。
          =================================================================== */}
      <section className="sit-panel">
        {/* 【你在哪】
            這一頁通篇在講「附近」——1 公里內、5 公里內、鄰近場域警示——
            但先前從來沒說過「附近」是相對於哪裡。使用者不知道基準點，
            那些篩選就等於在猜。
            三種基準，語氣依可信度遞減：手選的場域 → 定位 → 收不到。 */}
        <div className="sit-row sit-here">
          <Pictogram name="pin" size={18} className="here-icon" />
          {here ? (
            <span className="here-body">
              <b>{here.name}</b>
              <span className="here-sub">上次確認的位置</span>
            </span>
          ) : fix ? (
            <span className="here-body">
              <b>依目前定位</b>
              <span className="here-sub">誤差約 {Math.round(fix.accuracy)}m</span>
            </span>
          ) : (
            <span className="here-body">
              <b>不知道你在哪</b>
              <span className="here-sub">僅顯示全部事件</span>
            </span>
          )}
          <a className="here-action" href="#/">變更</a>
        </div>

        {/* 無台階開關：它決定每張事件卡的疏散內容（電梯火災不可用 →
            答案整個不同），屬於「閱讀偏好」而不是「篩選條件」，
            所以自成一列、給滿寬、當下狀態一眼可分。 */}
        <button
          className={`sit-row sit-acc${stepFree ? ' acc-on' : ''}`}
          role="switch"
          aria-checked={stepFree}
          onClick={toggleStepFree}
        >
          <Pictogram name="stepFree" size={20} className="acc-pict" />
          <span className="acc-body">
            <b>無台階路線</b>
            <span className="acc-sub">{stepFree ? '已開啟——疏散指示將避開樓梯' : '輪椅、嬰兒車、行動不便時開啟'}</span>
          </span>
          <span className="acc-knob" aria-hidden="true" />
        </button>

        {/* ---- 範圍篩選：只留距離 chips，搜尋收合進「找特定地點」 ----
            搜尋框對多數人是雜訊（他們要的是「附近有沒有大事」，不是找某站），
            但趕著確認家人所在站的人需要它——所以收合成一顆按鈕，
            要的人才展開，不要的人永遠不會看到輸入框。 */}
        {card.stations.length > 1 && (
          <div className="sit-row sit-filter">
            <div className="filter-ranges">
              {RANGES.map((r) => (
                <button
                  key={r.id}
                  className={`chip${range === r.id ? ' chip-active' : ''}`}
                  disabled={r.id !== 0 && !fix}
                  onClick={() => setRange(r.id)}
                >
                  {r.label}
                </button>
              ))}
              {!searchOpen && (
                <button className="filter-more" onClick={() => setSearchOpen(true)}>
                  找特定地點
                </button>
              )}
            </div>
            {searchOpen && (
              <div className="filter-search-row">
                <input
                  className="note-input filter-search"
                  type="search"
                  placeholder="輸入場域名稱"
                  value={query}
                  autoFocus
                  onChange={(e) => setQuery(e.target.value)}
                />
                <button className="chip" onClick={() => { setSearchOpen(false); setQuery(''); }}>
                  取消
                </button>
              </div>
            )}
            {!fix && (
              <p className="muted-2">收不到定位，無法依距離篩選。</p>
            )}
            {hiddenCount > 0 && (
              <p className="muted-2">{hiddenCount} 件在範圍外。</p>
            )}
          </div>
        )}

        {/* ---- 補充視角：總覽地圖與周邊訊息併成同一列 ----
            兩者性質相同（「還想多看一點」的入口），而且都預設收合——
            各給一張卡是把兩個次要入口撐成兩個主要區塊。
            地圖預設收合的理由不變：進頁面先看文字，任何網路都到得了。 */}
        {(hasOverview || alertCount > 0) && (
          <div className="sit-row sit-links">
            {hasOverview && (
              <button className="sit-link" onClick={toggleMap} aria-expanded={mapOpen}>
                <Pictogram name="map" size={16} />
                <span className="sit-link-text">總覽地圖<span className="sit-link-sub">{groups.length} 個地點</span></span>
                <span className="sit-link-arrow" aria-hidden="true">{mapOpen ? '▲' : '▼'}</span>
              </button>
            )}
            {alertCount > 0 && (
              <button
                className="sit-link"
                onClick={() => setAlertsOpen(!alertsOpen)}
                aria-expanded={alertsOpen}
              >
                <Pictogram name="sighting" size={16} />
                <span className="sit-link-text">周邊訊息<span className="sit-link-sub">{alertCount} 則</span></span>
                <span className="sit-link-arrow" aria-hidden="true">{alertsOpen ? '▲' : '▼'}</span>
              </button>
            )}
          </div>
        )}
      </section>

      {hasOverview && mapOpen && (
        <Suspense fallback={<div className="incident-map-loading">地圖載入中…</div>}>
          <OverviewMap groups={groups} userFix={fix} onPick={scrollToGroup} />
        </Suspense>
      )}

      {/* 周邊訊息展開：**一個框裝完**，列與列之間只用細線。
          原本三種訊息（進站警示／鄰近警示／已解除）各是一張帶左側色條的卡，
          展開後就是一疊框。只有進站警示保留實心紅牌——那是時效以秒計的事，
          其餘兩種是背景資訊，不該長得像另一則警報。 */}
      {alertCount > 0 && alertsOpen && (
        <div className="alerts-detail">
          {inboundAlerts.map((a) => (
            <InboundAlert key={`${a.venueId}-${a.fromVenue}`} alert={a} />
          ))}
          {nearbyAlerts.map((a) => (
            <div key={a.venueId} className="nearby-alert">
              <Pictogram name={a.kind ?? 'pin'} size={20} className="nearby-icon" />
              <span>
                <b>{a.venueName}</b> 約 {a.distanceM}m 外的
                <b>{a.fromVenue}</b> 有<b>{a.typeLabel}</b>事件
                {a.moving && <span className="nearby-move"> · 移動中</span>}
              </span>
            </div>
          ))}
          {resolved.map((r) => (
            <div key={r.id} className="resolved-item">
              <div className="resolved-head">
                {r.wasActive ? '警報解除' : '查無此事件'}
                <span className="resolved-where">{r.stationName}　{r.typeLabel}</span>
              </div>
              <p className="resolved-notice">{r.notice}</p>
            </div>
          ))}
        </div>
      )}

      {flatEvents.length === 0 && alertCount === 0 && (
        <div className="empty-state">
          <p className="empty-line">目前沒有進行中的事件</p>
        </div>
      )}

      {/* ---- 事件分頁：一屏一卡，左右切換 ---- */}
      {current && (
        <>
          {/* ---- 事件頁籤：**要看得懂是哪一件事** ----
              舊版一個頁籤只有一個 16px 的圖標。火警與攻擊在那個尺寸下
              形狀差異幾乎消失，而且完全看不出是哪一個場域——使用者只能
              一個一個點開才知道自己在看什麼，等於把「掃一眼」變成「試誤」。
              現在每個頁籤直接寫出「類型 + 場域」，圖標退為輔助；
              當前那一則用實心標示牌強調，未確認的用虛線框（不只靠顏色）。 */}
          {flatEvents.length > 1 && (
            <div className="ev-switch">
              <div className="ev-switch-head">
                目前有 <b>{flatEvents.length}</b> 件事——你在看第 <b>{eventIndex + 1}</b> 件
              </div>
              <div className="ev-tabs" role="tablist" aria-label="事件清單">
                {flatEvents.map(({ venue, ev }, i) => (
                  <button
                    key={ev.id}
                    role="tab"
                    aria-selected={i === eventIndex}
                    className={`ev-tab ev-tab-${ev.status}${i === eventIndex ? ' ev-tab-on' : ''}`}
                    onClick={() => setEventIndex(i)}
                  >
                    <Pictogram name={pictOf(ev.typeLabel)} size={18} className="ev-tab-pict" />
                    <span className="ev-tab-text">
                      <b className="ev-tab-type">{ev.typeLabel}</b>
                      <span className="ev-tab-where">{venue.stationName}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <EventCard
            key={current.ev.id}
            venue={current.venue}
            ev={current.ev}
            plan={stepFree ? current.ev.planStepFree : current.ev.plan}
            stepFree={stepFree}
          />

          {/* 上一則/下一則大按鈕：拇指區，方向明確 */}
          {flatEvents.length > 1 && (
            <div className="ev-nav">
              <button
                className="ghost-btn"
                disabled={eventIndex === 0}
                onClick={() => setEventIndex(Math.max(0, eventIndex - 1))}
              >
                ← 上一則
              </button>
              <button
                className="ghost-btn"
                disabled={eventIndex >= flatEvents.length - 1}
                onClick={() => setEventIndex(Math.min(flatEvents.length - 1, eventIndex + 1))}
              >
                下一則 →
              </button>
            </div>
          )}
        </>
      )}

      <footer className="page-footer">
        <a href="#/">回報事件</a>
      </footer>
    </div>
  );
}

/** 單一事件卡：獨占一屏的完整呈現 */
function EventCard({ venue, ev, plan, stepFree }) {
  return (
    <article className={`event-card ${ev.status === 'active' ? 'event-active' : 'event-candidate'}`}>
      {/* 站名帶：真實路線色，使用者本來就靠顏色認線 */}
      <h2 className="venue-band" data-line={lineOf(venue.stationId)}>
        <Pictogram name={venue.kind ?? 'pin'} size={20} className="venue-band-icon" />
        <span className="venue-band-name">{venue.stationName}</span>
      </h2>

      {/* ---- 一行看懂：類型（大字）+ 警戒徽章 ---- */}
      <div className="event-top">
        <Pictogram name={pictOf(ev.typeLabel)} size={30} className="event-pict" />
        <span className="event-type">{ev.typeLabel}</span>
        <span className={`threat threat-${ev.threatLevel}`}>
          {THREAT_LABEL[ev.threatLevel] ?? '未經確認'}
        </span>
      </div>

      {/* 位置一行——meta 表格佔空間且恐慌中讀不進去，一行帶過 */}
      <p className="ev-loc">
        {ev.nearExitCode ? `近 ${ev.nearExitCode} 出口` : '位置未確認'}
      </p>

      {/* ---- 需要最先看到的旗標 ---- */}
      {ev.motion?.moving && (
        <div className="flag flag-move">
          {ev.motion.reason === 'erratic'
            ? '可能不只一處'
            : `${wordingFor(ev.typeLabel).moving}${ev.motion.compass ? ` · 往${ev.motion.compass}方` : ''}`}
        </div>
      )}
      {ev.assistanceReports > 0 && (
        <div className="flag flag-assist">有人需協助 · {ev.assistanceReports} 筆</div>
      )}
      {ev.onTrain && <div className="flag flag-train">事件在列車上</div>}

      {/* ---- 疏散：這張卡的主體，放最顯眼 ---- */}
      <EvacPlan plan={plan} arrival={ev.arrival} offMap={venue.offMap} />
      {!plan && <p className="advice">{ev.advice}</p>}

      {/* 通報者證據：照片比文字有用，有照片才顯示 */}
      {ev.photoUrl && (
        <div className={`evidence${venue.offMap ? ' evidence-key' : ''}`}>
          <a className="evidence-photo" href={ev.photoUrl} target="_blank" rel="noreferrer">
            <img src={ev.photoUrl} alt="通報者拍攝的現場照片" loading="lazy" />
          </a>
          <div className="evidence-body">
            {ev.note && <p className="evidence-note">「{ev.note}」</p>}
            {venue.offMap && (
              <a className="chip identify-cta" href={`#/confirm?event=${ev.id}`}>
                <Pictogram name="pin" size={16} />
                我認得這裡 · 幫忙指認
              </a>
            )}
          </div>
        </div>
      )}

      {/* 地圖：收合預設，動態載入 */}
      <EventMapToggle
        plan={plan}
        incidentPoint={ev.incidentPoint}
        defaultOpen={ev.status === 'active' && ev.threatLevel === 'high'}
      />

      {/* 目擊回報入口 */}
      {ev.status === 'candidate' ? (
        <a className="chip sighting-cta cta-verify" href={`#/confirm?event=${ev.id}`}>
          <Pictogram name="sighting" size={18} />
          你在現場嗎？幫忙確認
        </a>
      ) : ev.threatLevel === 'high' ? (
        <a className="chip sighting-cta" href={`#/confirm?event=${ev.id}`}>
          <Pictogram name="sighting" size={18} />
          {wordingFor(ev.typeLabel).cta}
        </a>
      ) : null}

      {/* 次要資訊：一行收尾（唸出來 + 回報數 + 更新時間） */}
      <div className="event-foot">
        {isSpeechSupported() && (
          <button className="chip" onClick={() => speak(planToSpeech(ev, plan))}>
            <Pictogram name="speak" size={18} />
            唸出來
          </button>
        )}
        <span className="muted">
          {ev.reportCount} 筆 · {time(ev.updatedAt)}
        </span>
      </div>
    </article>
  );
}
