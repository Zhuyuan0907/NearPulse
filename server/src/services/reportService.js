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
 *   incidentPoint?: {lat, lon}, // 使用者在地圖上點的事件位置（比出口更精確時）
 *   needsAssistance?: boolean,  // 現場有人無法自行疏散（行動不便／受困）
 *   onTrain?: boolean,          // 事件發生在列車上（不在站內）
 *   nextVenueId?: string|null,  // 列車下一站的場域 id（僅 onTrain 時有效）
 *   note?: string,              // 文字補充（選配，≤140 字）
 *   attachToEventId?: string, // 使用者點了「同一件」時帶入
 *   audio?: { base64, mimeType },  // 選配：hold-to-talk 語音
 *   photo?: { base64, mimeType },   // 選配：1024px WebP（<50KB）
 *   photoRef?: string,          // 選配：/api/vision 已收下該圖時改帶 ref（免重傳）
 * }
 */
export function validateReport(body) {
  const errors = [];

  if (!body.uuid || typeof body.uuid !== 'string') errors.push('缺少 uuid（冪等鍵）');
  if (!body.sessionId || typeof body.sessionId !== 'string') errors.push('缺少 sessionId');
  if (!config.eventTypes[body.type]) errors.push(`不支援的事件類型: ${body.type}`);

  /**
   * 位置聲明。
   *
   * ⚠️ **場域 id 不再是必填。**
   * 舊版沒有 `stationId` 就整筆退回——但「我在一個陌生的地下空間、不知道
   * 自己在哪」正是這個 App 存在的理由。要求使用者先說出地點名稱才能通報，
   * 等於把最需要幫助的人擋在門外。
   *
   * 而且圖資永遠不會完整：836 個場域裡百貨只有 58 個，出口圖資只涵蓋 279 個。
   * 隨便一間商場、一條連通道、一間店面，很可能查無此地。
   *
   * 現在只要求「至少提供一種位置線索」，三選一即可：
   *   stationId  查得到的場域（最好）
   *   place      使用者自己描述的地點（「京站地下街 B1 星巴克前」）
   *   lat/lon    地面上恰好收得到的座標
   * 三者皆無仍然收下，只是標記為位置未知——通報本身永遠比位置重要。
   */
  const claim = body.locationClaim;
  if (!claim || typeof claim !== 'object') {
    errors.push('缺少位置聲明（locationClaim）');
  } else {
    if (typeof claim.stationId !== 'string' || claim.stationId.length === 0) {
      claim.stationId = null;
    }
    // 自由描述：截斷不擋。這是「圖資查不到」時唯一的位置資訊，不能因為太長就丟
    if (typeof claim.place === 'string') {
      claim.place = claim.place.trim().slice(0, 60) || null;
    } else {
      claim.place = null;
    }
    const okCoord =
      Number.isFinite(claim.lat) && Number.isFinite(claim.lon) &&
      Math.abs(claim.lat) <= 90 && Math.abs(claim.lon) <= 180;
    if (!okCoord) { claim.lat = null; claim.lon = null; }

    if (!['gps', 'manual', 'session', 'freeform', 'unknown'].includes(claim.source)) {
      errors.push(`無效的位置聲明來源: ${claim.source}`);
    }
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

  // 事件座標：形狀不合就丟掉（不擋回報）。範圍檢查避免明顯的髒資料進入距離計算
  const pt = body.incidentPoint;
  const validPoint =
    pt && Number.isFinite(pt.lat) && Number.isFinite(pt.lon) &&
    Math.abs(pt.lat) <= 90 && Math.abs(pt.lon) <= 180;
  body.incidentPoint = validPoint ? { lat: pt.lat, lon: pt.lon } : null;

  // 需要協助：布林值以外一律當成 false（寧可漏報也不要誤報成有人受困）
  body.needsAssistance = body.needsAssistance === true;

  // 在列車上：疏散建議完全不同（車廂內沒有「出口」可去）
  body.onTrain = body.onTrain === true;

  // 使用者指認的下一站（車廂顯示器上的站名）。不在列車上就沒有意義，
  // 一律清掉——避免舊狀態殘留造成錯誤的到站預告。
  if (!body.onTrain || typeof body.nextVenueId !== 'string') body.nextVenueId = null;

  // 文字補充：超長截斷（不擋）
  if (typeof body.note === 'string' && body.note.length > 140) body.note = body.note.slice(0, 140);
  if (body.note != null && typeof body.note !== 'string') body.note = null;

  // photoRef：只接受字串，其餘收斂為 null（查無此 ref 由路由層靜默略過）
  if (body.photoRef != null && typeof body.photoRef !== 'string') body.photoRef = null;

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
    incidentPoint: body.incidentPoint ?? null, // 地圖選點（最精確的事件位置）
    needsAssistance: body.needsAssistance === true, // 有人無法自行疏散
    onTrain: body.onTrain === true,                 // 事件在列車上
    nextVenueId: body.nextVenueId ?? null,          // 列車的下一站（到站預告用）
    note: body.note ?? null,                 // 文字補充（選配）
    attachToEventId: body.attachToEventId ?? null,
    audio: body.audio ?? null,
    photo: body.photo ?? null,
    receivedAt: Date.now(),
  };
}
