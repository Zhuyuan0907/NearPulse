/**
 * ============================================================================
 * reportService —— 回報 ingest 驗證與前處理
 * ============================================================================
 * 職責（在進入批次佇列「之前」就要做完）：
 *   1. 驗證欄位形狀（type 合法、stationId 合理、位置聲明結構正確）
 *   2. 附件大小上限檢查
 *   3. 附加伺服器時間戳
 *
 * 驗證是「寬鬆而防呆」的：MVP 不設站點白名單（任何字串站點都收），
 * 因為客戶端的站點資料（路網圖 subset）與伺服器不同步不應擋回報。
 */

import { config } from '../config.js';

/** 回報 payload 應有的形狀（客戶端送出前的契約）：
 * {
 *   uuid: string,             // 客戶端產生，冪等鍵（防連點）
 *   sessionId: string,        // 本次造訪的 session UUID（獨立性計數用）
 *   type: 'fire'|'medical'|'crush'|'other',
 *   locationClaim: { source: 'gps'|'manual'|'session', stationId, confidence, timestamp },
 *   attachToEventId?: string, // 使用者點了「同一件」時帶入
 *   audio?: { base64, mimeType },  // 選配：hold-to-talk 語音
 *   photo?: { base64 },            // 選配：壓縮後照片
 * }
 */
export function validateReport(body) {
  const errors = [];

  if (!body.uuid || typeof body.uuid !== 'string') errors.push('缺少 uuid（冪等鍵）');
  if (!body.sessionId || typeof body.sessionId !== 'string') errors.push('缺少 sessionId');
  if (!config.eventTypes[body.type]) errors.push(`不支援的事件類型: ${body.type}`);

  const claim = body.locationClaim;
  if (!claim || typeof claim.stationId !== 'string' || claim.stationId.length === 0) {
    errors.push('缺少位置聲明（locationClaim.stationId）');
  }
  if (claim && !['gps', 'manual', 'session'].includes(claim.source)) {
    errors.push(`無效的位置聲明來源: ${claim.source}`);
  }

  // 附件大小防呆（base64 字元數）
  if (body.audio?.base64 && body.audio.base64.length > config.limits.maxAudioBase64) {
    errors.push('音檔過大');
  }
  if (body.photo?.base64 && body.photo.base64.length > config.limits.maxPhotoBase64) {
    errors.push('照片過大');
  }

  return { ok: errors.length === 0, errors };
}

/** 驗證通過後，補上伺服器時間戳、整理成佇列內部格式 */
export function normalizeReport(body) {
  return {
    uuid: body.uuid,
    sessionId: body.sessionId,
    type: body.type,
    locationClaim: body.locationClaim,
    attachToEventId: body.attachToEventId ?? null,
    audio: body.audio ?? null,
    photo: body.photo ?? null,
    receivedAt: Date.now(),
  };
}
