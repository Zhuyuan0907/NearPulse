/**
 * ============================================================================
 * batchWorker —— 10 秒批次處理核心
 * ============================================================================
 * 對應架構圖中的「Cluster: 10 秒批次去重聚合」：
 *
 *   每 tick：
 *     1. 從佇列領出全部待處理回報（drain）
 *     2. 逐筆歸屬：attachToEventId（使用者點「同一件」）優先，
 *        其次依「站點+類型」自動比對既有 candidate/active 事件
 *     3. 觸發 advisor（STT / Vision / LLM 敘事）——非同步、不阻擋狀態機
 *     4. 對所有進行中事件跑狀態機判斷（升級/取消/凍結）
 *     5. 態勢卡有變動 → 重算快取與 ETag
 *
 * 注意：advisor 是 fire-and-forget——萃取結果晚一點回來再補進事件，
 * 事件狀態永遠由「確定性規則」推進，這就是「LLM 不在關鍵路徑上」。
 */

import { config } from '../config.js';
import {
  findMatchingEvent,
  evaluateEvent,
} from './cluster.js';
import {
  createCandidateEvent,
  applyTransition,
  appendObservation,
} from '../services/eventService.js';
import { buildSituationCard } from '../services/situationCardService.js';
import { findVenue, findExit } from '../services/venueService.js';
import { assessMotion } from '../services/threatMotion.js';
import { transcribeAudio } from './advisors/stt.js';
import { analyzePhoto, visionMode } from './advisors/vision.js';
import { resolveAnchors } from '../services/venueService.js';
import { llmNarrate } from './advisors/llm.js';

export function startBatchWorker(store, { log = console.log } = {}) {
  const timer = setInterval(tick, config.batchIntervalMs);
  tick(); // 啟動時立刻跑一次，讓空卡也能被 ETag 查詢
  return () => clearInterval(timer);

  function tick() {
    const now = Date.now();

    // ---- 步驟 1：領出待處理回報 ----
    const reports = store.drainPendingReports();

    // ---- 步驟 2：逐筆歸屬到事件 ----
    for (const report of reports) {
      let event = null;

      // 2a. 使用者明確指定「同一件」
      if (report.attachToEventId) {
        const target = store.getEvent(report.attachToEventId);
        if (target && (target.status === 'candidate' || target.status === 'active')) {
          event = target;
        }
      }

      // 2b. 自動比對：同站同類型的進行中事件。
      //     場域未知時改以座標鄰近或自由描述文字比對（見 cluster.js 的說明）
      if (!event) {
        const c = report.locationClaim;
        event = findMatchingEvent(store.listEvents(), {
          stationId: c.stationId,
          type: report.type,
          claimPoint:
            Number.isFinite(c.lat) && Number.isFinite(c.lon) ? { lat: c.lat, lon: c.lon } : null,
          placeText: c.place ?? null,
        });
      }

      // 2c. 都沒有 → 開新 candidate
      if (!event) {
        // 場域名稱由 server 的圖資解析，不再依賴 client 帶上來——
        // 站務台、報告書等非本 client 的消費端才拿得到可讀名稱。
        // client 若有帶名稱則作為未知場域的後備。
        const claim = report.locationClaim;
        const resolved = claim.stationId ? findVenue(claim.stationId) : null;
        event = createCandidateEvent(report, resolved?.name ?? claim.stationName);
        log(`[batch] 新事件 ${event.id}：${event.stationId ?? '（無場域）'} ${event.type}`);
      } else {
        event.reports.push(report);
        // 最新位置仍然更新（靜態事件用得到）……
        if (report.nearExitCode) event.nearExitCode = report.nearExitCode;
        if (report.incidentPoint) event.incidentPoint = report.incidentPoint;
        // 「有人需要協助」只累加不歸零——救援抵達前這個資訊都是有效的
        if (report.needsAssistance) {
          event.assistanceReports = (event.assistanceReports ?? 0) + 1;
        }
        if (report.onTrain) {
          event.onTrain = true;
          // 下一站以**最新一筆**指認為準：列車會前進，後來的人看到的是更新的站名
          if (report.nextVenueId) {
            event.nextVenueId = report.nextVenueId;
            event.departedAt = report.receivedAt;
          }
        }
      }

      // ……但**軌跡只追加不覆寫**：威脅會移動，只留最新位置會讓系統
      // 把人往威脅前進的方向趕。這是移動威脅追蹤的原料。
      appendObservation(event, { ...report, at: report.receivedAt });

      // 每次有新觀測就重算移動判定（純函式、確定性，不需要 AI）
      event.motion = assessMotion(event.track, now);

      event.updatedAt = now; // 有新訊號進來，重置凍結計時
      store.upsertEvent(event);

      /**
       * 保留一張可顯示的照片。
       *
       * 「位置待確認」單獨出現時，看的人完全無從判斷事情在哪——但通報者
       * 其實給了照片。把它存成可重複讀取的 ref 掛在事件上，態勢卡就能
       * 把「我拍到的東西」直接給其他人看，那往往比任何文字都有用。
       *
       * 只留第一張：後續回報的照片不覆蓋，避免態勢卡變成相簿。
       */
      if (!event.displayPhotoRef && report.photo?.base64) {
        event.displayPhotoRef = store.putPhoto(report.photo);
      }
      // 通報者的補充文字同樣是位置線索，尤其在沒有場域時
      if (!event.note && report.note) event.note = report.note;

      // ---- 步驟 3：觸發 advisor（不 await——不在關鍵路徑上） ----
      runAdvisors(store, event, report);

      store.markCardDirty();
    }

    // ---- 步驟 4：狀態機巡檢（升級/取消/凍結/過期） ----
    for (const event of store.listEvents()) {
      const decision = evaluateEvent(event, config, now);
      if (decision !== 'stay') {
        applyTransition(event, decision, now);
        store.upsertEvent(event);
        store.markCardDirty();
        log(`[batch] 事件 ${event.id} → ${event.status}（${decision}）`);
      }
    }

    // ---- 步驟 5：重算態勢卡（有變動才重算） ----
    // 包在 try 裡：卡片建構是純衍生的工作，它出錯不該讓**整個回報服務**停擺。
    // （實測過一次：疏散建議的一個 undefined 讓 batch worker 拋例外、
    //   Node 程序直接結束，連 POST /api/reports 都收不了。）
    if (store.isCardDirty()) {
      try {
        const { card, etag, bytes } = buildSituationCard(store.listEvents(), now);
        store.setCard({ card, etag, bytes });
        if (bytes > config.situationCardTargetBytes) {
          log(`[warn] 態勢卡 ${bytes} bytes 超過 50KB 目標`);
        }
      } catch (err) {
        // 沿用上一張卡（讀取端看到的是稍舊但正確的內容），並保持髒標記以便下輪重試
        log(`[error] 態勢卡建構失敗，沿用上一張：${err.message}`);
      }
    }
  }
}

/**
 * 由照片補上位置：讀照片上的字 → 確定性查表 → 補場域與出口錨點。
 * 全程 fire-and-forget，任何一步失敗都只是「少一個位置」，不影響事件成立。
 *
 * 【為什麼這條路不能只在 deferred 模式跑】
 * 使用者實際回報：拍了一張月台照、上面清楚寫著站名，送出後卻顯示
 * 「位置待確認」。原因是這個函式原本有三道限制，三道都會踩到：
 *   1. `visionMode() === 'deferred'` 才執行——互動模式下根本不跑，
 *      而 client 端的辨識可能逾時、或因站名有歧義而**刻意不自動套用**
 *   2. 查表時綁死 `venueId: event.stationId`——事件沒有場域時就查不出東西
 *   3. `if (!top?.exitCode) return`——只認出站名、認不出出口就整個放棄，
 *      但「知道是土城站」已經比「位置待確認」有用太多了
 *
 * 現在：只要有照片、而且事件還缺位置，就再辨識一次。這是最後一道保險——
 * client 端沒成功的，server 端補上。
 */
async function anchorFromPhoto(store, event, report) {
  const res = await analyzePhoto({
    base64: report.photo.base64,
    mimeType: report.photo.mimeType ?? 'image/webp',
    stage: 'read',
    deferred: true, // 用較寬鬆的逾時：這裡沒有人在等
  });
  if (res.pending || !res.texts?.length) return;

  const { candidates } = resolveAnchors({
    // 事件已有場域就在該場域內找出口；沒有的話讓查表自己判斷是哪一站
    texts: res.texts,
    venueId: event.stationId ?? null,
    near: event.claimPoint ?? null,
  });
  if (!candidates?.length) return;

  const confident = candidates.filter((c) => c.confidence !== 'low');
  const top = confident[0];

  let changed = false;

  // ---- 補場域（原本完全做不到的事）----
  if (!event.stationId && top?.venueId) {
    /**
     * 解析出場域後要**回頭併案**。
     *
     * 分群發生在照片辨識之前，所以同一個地點的多筆照片通報會先各自成案，
     * 解析完才知道它們其實是同一站——實測三張相同的月台照產生了三個
     * 「土城」事件並排顯示。那在態勢卡上看起來像三起火警。
     */
    const sibling = store.listEvents().find(
      (e) => e.id !== event.id
        && e.stationId === top.venueId
        && e.type === event.type
        && (e.status === 'candidate' || e.status === 'active')
    );

    if (sibling) {
      sibling.reports.push(...event.reports);
      sibling.updatedAt = Date.now();
      if (!sibling.nearExitCode && top.exitCode) sibling.nearExitCode = top.exitCode;
      store.removeEvent(event.id);
      store.upsertEvent(sibling);
      store.markCardDirty();
      return; // 這個事件已經併走了，不要再改它
    }

    event.stationId = top.venueId;
    event.stationName = top.venueName;
    event.placeText = null; // 有正解了，不再用使用者的描述當標題
    changed = true;
  }

  // ---- 補出口錨點。使用者自己標的位置永遠優先 ----
  if (top?.exitCode && !event.nearExitCode && !event.incidentPoint) {
    event.nearExitCode = top.exitCode;
    // 這是一次遲到的觀測，時間仍以「回報當下」計，軌跡才不會被扭曲
    appendObservation(event, { ...report, nearExitCode: top.exitCode, at: Date.now() });
    event.motion = assessMotion(event.track, Date.now());
    changed = true;
  }

  /**
   * 只有低信心候選（照片裡出現多個站名，典型是月台指標帶上的前後站）→
   * **不猜**，但把候選記在事件上。態勢卡可以顯示「照片顯示可能在：土城／海山」，
   * 那仍然遠比「位置待確認」有用，而且沒有假裝我們確定。
   */
  if (!event.stationId && confident.length === 0) {
    event.photoVenueGuesses = candidates.slice(0, 3).map((c) => c.venueName);
    changed = true;
  }

  if (changed) {
    store.upsertEvent(event);
    store.markCardDirty();
  }
}

/**
 * 對一筆剛歸屬的回報觸發 AI advisor（fire-and-forget）。
 * 萃取結果只「補充」事件資訊（timeline / 標籤 / 區域建議），永不影響狀態。
 */
function runAdvisors(store, event, report) {
  if (report.audio?.base64) {
    transcribeAudio(report.audio.base64, report.audio.mimeType)
      .then((res) => {
        if (!res.pending && res.text) {
          // TODO: 萃取文字併入 timeline（接入真實 STT 後啟用）
        }
      })
      .catch(() => {}); // advisor 失敗靜默——補充層失敗不是錯誤
  }
  // ---- 延後視覺辨識 ----
  // 快的供應商（gpt-4o-mini 約 1~2 秒）在回報端就跑完了，結果以 nearExitCode
  // 隨回報帶上來，這裡不必再付一次錢。
  //
  // 但慢的供應商（opencode 免費層實測 34.5 秒）無法互動式使用——若在回報端等，
  // 使用者要盯著轉圈半分鐘。延後模式改成：回報立刻成立，辨識在這裡非同步跑，
  // 錨點稍後補上。這正是「advisor fire-and-forget、永不擋回報」的原始設計。
  //
  // ⚠️ 補上的是**讀到的字經查表得出的出口代碼**，不是 AI 給的座標。
  // v0.2 曾讓 Vision 回傳的格位直接寫進事件並驅動疏散方向，而那個格位
  // 其實是影像座標——位置一律走「讀字 → 確定性查表」這條路。
  // 只要有照片、而且事件還缺位置（沒有場域，或有場域但沒有出口錨點），
  // 就在背景再辨識一次。不再限定 deferred 模式——見 anchorFromPhoto 的說明。
  if (report.photo?.base64 && (!event.stationId || !event.nearExitCode)) {
    anchorFromPhoto(store, event, report).catch((e) => {
      // 失敗只是「少一個位置」，不影響事件——但要留下痕跡，否則除錯時看不見
      console.warn('[batch] 照片補位置失敗:', e?.message ?? e);
    });
  }

  // LLM 時間線敘事：每次有新回報都重產一次（stub 為確定性字串）
  llmNarrate(event)
    .then((res) => {
      event.timeline = res.summary;
      store.markCardDirty(); // 敘事是非同步回來的，要讓下一輪重算卡片才看得到
    })
    .catch(() => {});
}
