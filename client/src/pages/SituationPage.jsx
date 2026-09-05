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
import Pictogram from '../components/Pictogram.jsx';

/**
 * 地圖**動態載入**：leaflet 與圖磚加起來遠超過整張態勢卡的預算。
 * 這頁必須在最差的網路下開得起來，所以地圖是點開才付費的補充資訊。
 */
const IncidentMap = lazy(() => import('../components/IncidentMap.jsx'));

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
      <span className="exit-where">{exit.landmark ?? '出口'}</span>
    </div>
  );
}

/** 疏散計畫：拆成可掃視的區塊，而不是一整段字 */
function EvacPlan({ plan, arrival, offMap }) {
  if (!plan) {
    return (
      <p className="plan-none">
        {offMap
          ? '這個地方不在我們的圖資裡，給不出出口層級的指引。請依現場逃生標示與人員指示行動。'
          : '這個場域沒有出口圖資，給不出往哪個出口走。請依現場逃生標示與人員指示行動。'}
      </p>
    );
  }

  if (plan.kind === 'onTrain') {
    return (
      <div className="plan plan-shelter">
        <div className="plan-head plan-head-stop">你在車廂裡，沒有「出口」可去</div>
        {/* 車廂內唯一有意義的「進度」：還要撐多久門才會開。
            秒數來自 TDX 官方站間行車時間，不是估的。 */}
        {arrival && <ArrivalCountdown arrival={arrival} />}

        {/* 開門側。**這是「哪一節車廂」問題的可行替代**——車廂↔樓梯的對應
            沒有任何開放資料（日本的乗換案内是向民間購買人工實測資料），
            但開門側是官方公開的，而且不需要知道車廂編號就能執行：
            到站前先移動到會開門的那一側，門一開就出得去。 */}
        {arrival?.doorSide?.label && (
          <div className="door-side">
            <Pictogram name="door" size={22} />
            <span>
              下一站是<b>{arrival.doorSide.label}開門</b>——
              現在就往{arrival.doorSide.label}車門移動
            </span>
          </div>
        )}

        <p className="plan-action">{plan.action}</p>

        {arrival && (
          <p className="plan-note">
            已通知 <b>{arrival.name}</b> 月台的人讓開車門動線。
            {plan.stepFree && arrival.wheelchairCars?.length > 0 && (
              <>{' '}輪椅席位於第 {arrival.wheelchairCars.join('、')} 節車廂。</>
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
        {plan.note}
        {plan.unknownExits > 0 && `（另有 ${plan.unknownExits} 個出口無無障礙資訊）`}
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
        <span className="muted">　由 {alert.fromVenue} 方向駛來</span>
      </div>
      <div className="inbound-what">車上有進行中的<b>{alert.typeLabel}</b>事件</div>
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
        展開地圖看位置<span className="muted">（會用到額外流量）</span>
      </button>
    );
  }

  return (
    <>
      <Suspense fallback={<div className="incident-map-loading">地圖載入中…</div>}>
        <IncidentMap plan={plan} incidentPoint={incidentPoint} />
      </Suspense>
      <button className="chip map-toggle" onClick={() => setOpen(false)}>收合地圖</button>
    </>
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
        <Pictogram name="stepFree" size={18} />
        {stepFree ? '無台階路線（已開啟）' : '我需要無台階路線'}
      </button>

      {/* 事故列車即將進站。
          放在所有區塊之前，是因為這則警示的**時效最短**——月台上的人
          只有幾十秒可以反應，而他們讓不讓開，決定車廂裡的人出不出得來。 */}
      {card.inboundAlerts?.length > 0 && (
        <section className="station-group">
          {card.inboundAlerts.map((a) => (
            <InboundAlert key={`${a.venueId}-${a.fromVenue}`} alert={a} />
          ))}
        </section>
      )}

      {/* 鄰近場域警示：事件不在這裡，但離得夠近。
          2025 年那起攻擊跨越了兩個站與一間百貨——下一個場域的人現在就該知道。 */}
      {card.nearbyAlerts?.length > 0 && (
        <section className="station-group">
          <h2 className="section-title">附近場域的警示</h2>
          {card.nearbyAlerts.map((a) => (
            <div key={a.venueId} className="nearby-alert">
              <Pictogram name={a.kind ?? 'pin'} size={20} className="nearby-icon" />
              <span>
                <b>{a.venueName}</b> 約 {a.distanceM}m 外的
                <b>{a.fromVenue}</b> 有進行中的<b>{a.typeLabel}</b>事件
                {a.moving && <span className="nearby-move"> · 且正在移動</span>}
              </span>
            </div>
          ))}
        </section>
      )}

      {/* 已解除：語氣與警示明確區隔——這是讓人放鬆的訊息，
          不能長得像另一則警報，所以用低飽和的綠、不用紅框、不置頂。 */}
      {card.resolved?.length > 0 && (
        <section className="station-group">
          {card.resolved.map((r) => (
            <div key={r.id} className="resolved-item">
              <div className="resolved-head">
                {r.wasActive ? '警報解除' : '查無此事件'}
                <span className="resolved-where">{r.stationName}　{r.typeLabel}</span>
              </div>
              <p className="resolved-notice">{r.notice}</p>
            </div>
          ))}
        </section>
      )}

      {card.stations.length === 0 && card.nearbyAlerts?.length === 0
        && card.inboundAlerts?.length === 0 && card.resolved?.length === 0 && (
        <div className="empty-state">
          <p className="empty-line">目前沒有確認中的異常事件</p>
        </div>
      )}

      {card.stations.map((venue) => (
        <section key={venue.stationId} className="station-group">
          {/* 站名帶：抄自月台牆上的那條。左側色帶用**真實路線色**——
              使用者本來就靠顏色認線，不需要再學一套。 */}
          <h2 className="venue-band" data-line={lineOf(venue.stationId)}>
            <Pictogram name={venue.kind ?? 'pin'} size={20} className="venue-band-icon" />
            <span className="venue-band-name">{venue.stationName}</span>
            {/* 圖資查不到的地方要標明白：這個名稱是通報者自己打的，
                不是查證過的場域。看的人有權知道這個差別。 */}
            <span className="venue-band-kind">
              {venue.offMap ? '通報者描述的位置' : KIND_LABEL[venue.kind] ?? ''}
            </span>
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
                  <Pictogram name={pictOf(ev.typeLabel)} size={26} className="event-pict" />
                  <span className="event-type">{ev.typeLabel}</span>
                  <span className={`threat threat-${ev.threatLevel}`}>
                    {THREAT_LABEL[ev.threatLevel] ?? '未經確認'}
                  </span>
                </div>
                {/* 中間點串接的 meta 字串（A · B · C）讀起來像系統日誌。
                    拆成有欄位名的小格，掃視時眼睛知道每個數字是什麼。 */}
                <dl className="event-meta">
                  <div><dt>位置</dt><dd>{ev.nearExitCode ? `近 ${ev.nearExitCode} 出口` : '未確認'}</dd></div>
                  <div><dt>獨立訊號</dt><dd>{ev.independentSignals}</dd></div>
                  <div><dt>更新</dt><dd>{time(ev.updatedAt)}</dd></div>
                </dl>

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
                <EvacPlan plan={plan} arrival={ev.arrival} offMap={venue.offMap} />

                <p className="advice">{ev.advice}</p>

                {/* 地圖預設對**已確認的高警戒事件**展開——那正是「往哪個方向離開」
                    最需要看見空間關係的時候，而且值得那 190KB。其餘事件維持收合，
                    弱網預算留給真正緊急的那一則。
                    無論展開與否都是動態載入，leaflet 不進主 bundle。 */}
                <EventMapToggle
                  plan={plan}
                  incidentPoint={ev.incidentPoint}
                  defaultOpen={ev.status === 'active' && ev.threatLevel === 'high'}
                />

                {/* 目擊回報入口。
                    移動威脅的軌跡靠的是「不同人、不同時間、不同位置」的觀測，
                    而態勢卡是現場的人最常盯著的畫面——入口放這裡，
                    看到歹徒移動的人才有地方說。只對進行中的高警戒事件顯示：
                    低嚴重度事件不需要追蹤軌跡，多一顆按鈕只是雜訊。 */}
                {ev.status === 'active' && ev.threatLevel === 'high' && (
                  <a className="chip sighting-cta" href={`#/confirm?event=${ev.id}`}>
                    <Pictogram name="sighting" size={18} />
                    我看到他往哪走了
                  </a>
                )}

                <div className="event-foot">
                  {isSpeechSupported() && (
                    <button className="chip" onClick={() => speak(planToSpeech(ev, plan))}>
                      <Pictogram name="speak" size={18} />
                      唸出來
                    </button>
                  )}
                  <span className="muted">
                    {ev.reportCount} 筆回報
                    {ev.hasPhoto && <Pictogram name="photo" size={15} className="foot-pict" />}
                    {ev.hasAudio && <Pictogram name="mic" size={15} className="foot-pict" />}
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
              <div className="muted">{p.message}</div>
            </button>
          ))}
        </section>
      )}

      <footer className="page-footer">
        <a href="#/">回報事件</a>
      </footer>
    </div>
  );
}
