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

/**
 * 建立一個新的 candidate 事件。
 * 由批次 worker 在「無既有事件可比對」時呼叫。
 */
export function createCandidateEvent(report, stationName) {
  return {
    id: `evt_${randomUUID().slice(0, 8)}`,
    type: report.type,
    stationId: report.locationClaim.stationId,
    stationName: stationName ?? report.locationClaim.stationId,
    status: 'candidate', // 事件狀態機初始態
    createdAt: Date.now(),
    updatedAt: Date.now(),
    /** 事件錨點：最接近的出口代碼（如 'M3'）。由照片辨識或使用者點選，
     *  再經 venueService 確定性查表得出——不是 AI 猜的座標。疏散建議的輸入。 */
    nearExitCode: report.nearExitCode ?? null,
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
      break;

    case 'cancel':
    case 'expire':
      event.status = 'cancelled';
      event.updatedAt = now;
      event.closingNotice =
        decision === 'expire'
          ? '此回報在時限內未獲得足夠確認，已自動結案。'
          : '經現場多方確認，查無此事件，已取消。';
      break;

    case 'freeze':
      event.status = 'frozen';
      event.updatedAt = now;
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
    status: event.status,
    severity: config.eventTypes[event.type]?.severity ?? 'low',
    nearExitCode: event.nearExitCode ?? null, // 場域錨點（疏散建議用）
    reportCount: event.reports.length,
    confirmationCount: event.confirmations.filter((c) => c.atStation).length,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    timeline: event.timeline,
    closingNotice: event.closingNotice,
    hasAudio: event.reports.some((r) => r.audio),
    hasPhoto: event.reports.some((r) => r.photo),
  };
}
