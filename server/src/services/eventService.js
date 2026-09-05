/**
 * ============================================================================
 * eventService —— 事件狀態機的執行層
 * ============================================================================
 * 狀態圖（與 doc/ARCHITECTURE.md 一致）：
 *
 *   回報 ──比對──▶ candidate ──正向達門檻──▶ active ──45min無更新──▶ frozen
 *                    │
 *                    └─場內否證佔多數 / 超時──▶ cancelled
 *
 * 本檔只做「執行轉移與記錄」；「要不要轉移」的判斷在 pipeline/cluster.js（純邏輯）。
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { findExit } from './venueService.js';

/**
 * 建立一個新的 candidate 事件。
 * 由批次 worker 在「無既有事件可比對」時呼叫。
 */
export function createCandidateEvent(report, stationName) {
  return {
    id: `evt_${randomUUID().slice(0, 8)}`,
    type: report.type,
    /**
     * 場域 id 可能是 null——使用者不知道自己在哪，或這個地方不在圖資裡。
     * 那種事件仍然成立，只是給不出出口層級的疏散建議（UI 會誠實說明）。
     */
    stationId: report.locationClaim.stationId ?? null,
    stationName:
      stationName ??
      report.locationClaim.stationId ??
      report.locationClaim.place ??
      '位置待確認',
    /** 使用者自己描述的地點（圖資查不到時的唯一位置資訊） */
    placeText: report.locationClaim.place ?? null,
    /** 通報當下恰好收得到的座標（地面層／出入口附近）——分群用 */
    claimPoint:
      Number.isFinite(report.locationClaim.lat) && Number.isFinite(report.locationClaim.lon)
        ? { lat: report.locationClaim.lat, lon: report.locationClaim.lon }
        : null,
    status: 'candidate', // 事件狀態機初始態
    createdAt: Date.now(),
    updatedAt: Date.now(),
    /** 事件錨點：最接近的出口代碼（如 'M3'）。由照片辨識或使用者點選，
     *  再經 venueService 確定性查表得出——不是 AI 猜的座標。疏散建議的輸入。 */
    nearExitCode: report.nearExitCode ?? null,
    /**
     * 錨點觀測序列。**不要覆寫，只能追加**——威脅會移動（無差別攻擊），
     * 只保留最新位置會讓系統把人往威脅前進的方向趕。見 threatMotion.js。
     */
    track: [],
    /** 事件座標（地圖選點）：比出口錨點更精確時的疏散原點 */
    incidentPoint: report.incidentPoint ?? null,
    /**
     * 現場有人無法自行疏散。這是**給救援方看的最高優先資訊**——
     * 知道哪裡有人需要協助，比知道事件本身更能決定資源怎麼派。
     */
    assistanceReports: report.needsAssistance ? 1 : 0,
    /**
     * 事件在列車上。這改變的不只是位置，是**建議的性質**——
     * 2014 年鄭捷案發生在龍山寺→江子翠的列車上，密閉車廂 4 分鐘無處可逃。
     * 對車廂裡的人講「往 3 號出口」毫無意義。
     */
    onTrain: report.onTrain === true,
    /**
     * 列車下一站，以及**離站時刻**。離站時刻取首筆回報的接收時間——
     * 通報者是在車上按下送出的，那一刻列車已經在兩站之間。這是我們能拿到
     * 最接近真相的時間基準，而且會低估剩餘時間（偏保守，對疏散有利）。
     */
    nextVenueId: report.nextVenueId ?? null,
    departedAt: report.onTrain ? report.receivedAt : null,
    /** 併入此事件的原始回報（含附件與補充） */
    reports: [report],
    /** 兩段式確認的回覆 */
    confirmations: [],
    /** 態勢卡顯示用的時間線敘事（LLM stub 產出） */
    timeline: null,
    /** 事件收尾時的公告文字（cancelled / frozen 時填入） */
    closingNotice: null,
  };
}

/**
 * 執行狀態轉移（由 batchWorker 依 evaluateEvent 的決策呼叫）。
 * 這裡是「唯一」改 event.status 的地方。
 */
export function applyTransition(event, decision, now = Date.now()) {
  switch (decision) {
    case 'promote':
      event.status = 'active';
      event.updatedAt = now;
      // 記住它曾經成立過。事件結束時，「警報解除」與「查無此事」對讀的人
      // 是完全不同的兩件事，而 status 到那時已經同樣是 cancelled/frozen。
      event.wasActive = true;
      break;

    case 'cancel':
    case 'expire':
      event.status = 'cancelled';
      event.updatedAt = now;
      /**
       * 結案時刻。**與 updatedAt 分開存**：updatedAt 之後仍可能被其他流程改動，
       * 而「解除警報要顯示多久」必須從真正結案的那一刻算起。
       */
      event.closedAt = now;
      /** 結案前是否曾經成立——決定要不要跟使用者說「警報解除」還是「查無此事」 */
      event.wasActive = event.wasActive || false;
      event.closingNotice =
        decision === 'expire'
          ? '此回報在時限內未獲得足夠確認，已自動結案。'
          : '經現場多方確認，查無此事件，已取消。';
      break;

    case 'freeze':
      event.status = 'frozen';
      event.updatedAt = now;
      event.closedAt = now;
      event.closingNotice = '此事件已超過 45 分鐘無新確認，凍結歸檔。';
      break;

    case 'stay':
    default:
      break; // 無轉移
  }
  return event;
}

/** 事件摘要（給 API 回應用，不含附件大 blob——避免響應暴肥） */
export function toEventSummary(event) {
  return {
    id: event.id,
    type: event.type,
    typeLabel: config.eventTypes[event.type]?.label ?? event.type,
    stationId: event.stationId,
    stationName: event.stationName,
    placeText: event.placeText ?? null,
    /** 照片讀到多個站名、無從消歧時的候選（不是結論，UI 要照這個語氣呈現） */
    photoVenueGuesses: event.photoVenueGuesses ?? null,
    status: event.status,
    severity: config.eventTypes[event.type]?.severity ?? 'low',
    nearExitCode: event.nearExitCode ?? null, // 場域錨點（疏散建議用）
    motion: event.motion ?? null,             // 移動威脅判定（threatMotion）
    incidentPoint: event.incidentPoint ?? null, // 事件座標（地圖顯示用）
    assistanceReports: event.assistanceReports ?? 0, // 回報「有人需要協助」的筆數
    onTrain: event.onTrain === true,
    nextVenueId: event.nextVenueId ?? null,
    departedAt: event.departedAt ?? null,
    reportCount: event.reports.length,
    confirmationCount: event.confirmations.filter((c) => c.atStation).length,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    timeline: event.timeline,
    closingNotice: event.closingNotice,
    closedAt: event.closedAt ?? null,
    wasActive: event.wasActive === true,
    hasAudio: event.reports.some((r) => r.audio),
    hasPhoto: event.reports.some((r) => r.photo),
  };
}

/**
 * 把一次「在某時、某錨點看到」追加進事件軌跡。
 *
 * 座標優先序與疏散一致：地圖選點（最精確）→ 出口錨點。兩者皆無就不記錄——
 * 沒有位置的觀測無法貢獻軌跡，但它仍然是有效的回報／確認
 *（位置永遠不擋通報，這是專案的硬性原則）。
 *
 * **兩條路徑都會呼叫這裡**：新回報（batchWorker），以及現場目擊者在確認頁
 * 回答「他現在在哪」（events 路由）。移動判定的品質完全取決於這兩條路徑
 * 餵進來的觀測數量，所以它必須是共用的一份實作，不能各寫一份。
 */
export function appendObservation(event, { incidentPoint, nearExitCode, sessionId, at }) {
  const point =
    incidentPoint ??
    (nearExitCode ? findExit(event.stationId, nearExitCode) : null);
  if (!point) return false;

  event.track = event.track ?? [];
  event.track.push({
    lat: point.lat,
    lon: point.lon,
    at: at ?? Date.now(),
    sessionId, // 移動判定要求觀測來自互相獨立的目擊者
    exitCode: nearExitCode ?? null,
  });
  // 軌跡不需要無限成長：判定只看最近的觀測
  if (event.track.length > 20) event.track = event.track.slice(-20);
  return true;
}
