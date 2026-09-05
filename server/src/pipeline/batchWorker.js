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

      // 2b. 自動比對：同站同類型的進行中事件
      if (!event) {
        event = findMatchingEvent(store.listEvents(), {
          stationId: report.locationClaim.stationId,
          type: report.type,
        });
      }

      // 2c. 都沒有 → 開新 candidate
      if (!event) {
        // 場域名稱由 server 的圖資解析，不再依賴 client 帶上來——
        // 站務台、報告書等非本 client 的消費端才拿得到可讀名稱。
        // client 若有帶名稱則作為未知場域的後備。
        const claim = report.locationClaim;
        const resolved = findVenue(claim.stationId);
        event = createCandidateEvent(report, resolved?.name ?? claim.stationName);
        log(`[batch] 新事件 ${event.id}：${event.stationId} ${event.type}`);
      } else {
        event.reports.push(report);
        // 最新位置仍然更新（靜態事件用得到）……
        if (report.nearExitCode) event.nearExitCode = report.nearExitCode;
        if (report.incidentPoint) event.incidentPoint = report.incidentPoint;
        // 「有人需要協助」只累加不歸零——救援抵達前這個資訊都是有效的
        if (report.needsAssistance) {
          event.assistanceReports = (event.assistanceReports ?? 0) + 1;
        }
      }

      // ……但**軌跡只追加不覆寫**：威脅會移動，只留最新位置會讓系統
      // 把人往威脅前進的方向趕。這是移動威脅追蹤的原料。
      appendObservation(event, report);

      // 每次有新觀測就重算移動判定（純函式、確定性，不需要 AI）
      event.motion = assessMotion(event.track, now);

      event.updatedAt = now; // 有新訊號進來，重置凍結計時
      store.upsertEvent(event);

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
 * 延後辨識：讀照片上的字 → 確定性查表 → 補上出口錨點。
 * 全程 fire-and-forget，任何一步失敗都只是「少一個位置」，不影響事件成立。
 */
async function deferredAnchor(store, event, report) {
  const res = await analyzePhoto({
    base64: report.photo.base64,
    mimeType: report.photo.mimeType ?? 'image/webp',
    stage: 'read',
    deferred: true,
  });
  if (res.pending || !res.texts?.length) return;

  const { candidates } = resolveAnchors({
    texts: res.texts,
    venueId: event.stationId,
  });
  const top = candidates?.[0];
  if (!top?.exitCode) return;

  // 使用者自己標的位置永遠優先——辨識只補「還沒有位置」的事件
  if (!event.nearExitCode && !event.incidentPoint) {
    event.nearExitCode = top.exitCode;
    // 這是一次遲到的觀測，時間仍以「回報當下」計，軌跡才不會被扭曲
    appendObservation(event, { ...report, nearExitCode: top.exitCode });
    event.motion = assessMotion(event.track, Date.now());
    store.upsertEvent(event);
    store.markCardDirty();
  }
}

/**
 * 把一筆回報的位置資訊追加成一次「錨點觀測」。
 * 座標優先序與疏散一致：地圖選點（最精確）→ 出口錨點。兩者皆無就不記錄——
 * 沒有位置的回報無法貢獻軌跡，但它仍然是有效的回報（位置永遠不擋通報）。
 */
function appendObservation(event, report) {
  const point =
    report.incidentPoint ??
    (report.nearExitCode ? findExit(event.stationId, report.nearExitCode) : null);
  if (!point) return;

  event.track = event.track ?? [];
  event.track.push({
    lat: point.lat,
    lon: point.lon,
    at: report.receivedAt,
    sessionId: report.sessionId, // 移動判定要求觀測來自互相獨立的目擊者
    exitCode: report.nearExitCode ?? null,
  });
  // 軌跡不需要無限成長：判定只看最近的觀測
  if (event.track.length > 20) event.track = event.track.slice(-20);
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
  if (visionMode() === 'deferred' && report.photo?.base64 && !report.nearExitCode) {
    deferredAnchor(store, event, report).catch(() => {});
  }

  // LLM 時間線敘事：每次有新回報都重產一次（stub 為確定性字串）
  llmNarrate(event)
    .then((res) => {
      event.timeline = res.summary;
      store.markCardDirty(); // 敘事是非同步回來的，要讓下一輪重算卡片才看得到
    })
    .catch(() => {});
}
