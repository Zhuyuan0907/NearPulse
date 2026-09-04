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
 *   nearExitCode?: string|null, // 事件最接近的出口代碼（如 'M3'），由照片辨識或使用者點選
 *   photoRoi?: 'A1'~'C3'|null,  // 照片九宮格中「有地點標示」的那一格（僅供追溯）
 *   note?: string,              // 文字補充（選配，≤140 字）
 *   attachToEventId?: string, // 使用者點了「同一件」時帶入
 *   audio?: { base64, mimeType },  // 選配：hold-to-talk 語音
 *   photo?: { base64, mimeType },   // 選配：1024px WebP（<50KB）
 *   photoRef?: string,          // 選配：/api/vision 已收下該圖時改帶 ref（免重傳）
 *   photoAnalysis?: object,     // 選配：client 已取得的 Vision 結果（免重複分析）
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

  // 出口代碼：正規化成大寫短字串；不存在的代碼由 venueService 查表時自然落空，
  // 這裡只擋形狀（不擋回報）
  if (typeof body.nearExitCode === 'string') {
    const code = body.nearExitCode.trim().toUpperCase();
    body.nearExitCode = code && code.length <= 6 ? code : null;
  } else if (body.nearExitCode != null) {
    body.nearExitCode = null;
  }

  // 照片九宮格：只是「哪一格有地點標示」的追溯資訊，不參與任何位置計算
  if (body.photoRoi != null && !/^[ABC][123]$/.test(body.photoRoi)) body.photoRoi = null;

  // 文字補充：超長截斷（不擋）
  if (typeof body.note === 'string' && body.note.length > 140) body.note = body.note.slice(0, 140);
  if (body.note != null && typeof body.note !== 'string') body.note = null;

  // photoRef：只接受字串，其餘收斂為 null（查無此 ref 由路由層靜默略過）
  if (body.photoRef != null && typeof body.photoRef !== 'string') body.photoRef = null;

  // photoAnalysis：只接受物件（client 已拿到的 Vision 結果），其餘丟棄
  if (body.photoAnalysis != null && typeof body.photoAnalysis !== 'object') {
    body.photoAnalysis = null;
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
    nearExitCode: body.nearExitCode ?? null, // 場域錨點（確定性查表得出）
    photoRoi: body.photoRoi ?? null,         // 照片九宮格（僅供追溯）
    note: body.note ?? null,                 // 文字補充（選配）
    attachToEventId: body.attachToEventId ?? null,
    audio: body.audio ?? null,
    photo: body.photo ?? null,
    /** client 已取得的 Vision 結果——有值就不必在 batch 端重複分析同一張圖 */
    photoAnalysis: body.photoAnalysis ?? null,
    receivedAt: Date.now(),
  };
}
