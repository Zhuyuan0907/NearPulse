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
import { transcribeAudio } from './advisors/stt.js';
import { verifyPhoto } from './advisors/vision.js';
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
        event = createCandidateEvent(report, report.locationClaim.stationName);
        log(`[batch] 新事件 ${event.id}：${event.stationId} ${event.type}`);
      } else {
        event.reports.push(report);
      }

      event.updatedAt = now; // 有新訊號進來，重置凍結計時
      store.upsertEvent(event);

      // ---- 步驟 3：觸發 advisor（不 await——不在關鍵路徑上） ----
      runAdvisors(event, report);

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
    if (store.isCardDirty()) {
      const { card, etag, bytes } = buildSituationCard(store.listEvents(), now);
      store.setCard({ card, etag, bytes });
      if (bytes > config.situationCardTargetBytes) {
        log(`[warn] 態勢卡 ${bytes} bytes 超過 50KB 目標`);
      }
    }
  }
}

/**
 * 對一筆剛歸屬的回報觸發 AI advisor（fire-and-forget）。
 * 萃取結果只「補充」事件資訊（timeline / 標籤），永不影響狀態。
 */
function runAdvisors(event, report) {
  if (report.audio?.base64) {
    transcribeAudio(report.audio.base64, report.audio.mimeType)
      .then((res) => {
        if (!res.pending && res.text) {
          // TODO: 萃取文字併入 timeline（接入真實 STT 後啟用）
        }
      })
      .catch(() => {}); // advisor 失敗靜默——補充層失敗不是錯誤
  }
  if (report.photo?.base64) {
    verifyPhoto(report.photo.base64).catch(() => {});
  }
  // LLM 時間線敘事：每次有新回報都重產一次（stub 為確定性字串）
  llmNarrate(event)
    .then((res) => {
      event.timeline = res.summary;
    })
    .catch(() => {});
}
