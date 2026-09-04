/**
 * ============================================================================
 * cluster.js —— 分群與門檻的純邏輯（無副作用、無 I/O）
 * ============================================================================
 * 這個檔案實作架構中最核心的確定性規則：
 *
 *   1. 事件歸屬：新回報要併入既有事件，還是開新事件？
 *   2. 獨立性計數：「N 人確認」實際驗的是 N 個不同 session UUID
 *   3. 狀態轉移判斷：candidate 是否該升級 / 取消 / 凍結
 *
 * 刻意寫成純函式：輸入（事件列表、設定、時間）→ 輸出（決策），
 * 不直接改物件、不碰儲存層。實際的轉移執行在 eventService。
 */

/**
 * 依「站點 + 類型」比對既有進行中事件（candidate / active）。
 * 對應客戶端「附近有一則進行中的事件…… [同一件] [另一件]」的比對邏輯。
 */
export function findMatchingEvent(events, { stationId, type }) {
  return events.find(
    (ev) =>
      ev.stationId === stationId &&
      ev.type === type &&
      (ev.status === 'candidate' || ev.status === 'active')
  );
}

/**
 * 計算一個事件的「獨立正向訊號數」。
 * 正向來源有兩種（都算 1 人，但去重 session）：
 *   a. 併入此事件的回報——但位置聲明來源必須夠可信（gps / manual）
 *   b. 兩段式確認中「在場 + 有看到」的回覆
 */
export function countIndependentPositives(event) {
  const sessions = new Set();

  for (const rep of event.reports) {
    const src = rep.locationClaim?.source;
    if (src === 'gps' || src === 'manual' || src === 'session') {
      sessions.add(rep.sessionId);
    }
  }
  for (const c of event.confirmations) {
    if (c.step === 'witness' && c.atStation && c.witnessed === 'yes') {
      sessions.add(c.sessionId);
    }
  }
  return sessions.size;
}

/**
 * 計算「在場否證」數：第二問中「在場且沒看到」的獨立 session 數。
 * 未確認位置者（atStation=false）的「沒看到」不算——設計原則。
 */
export function countOnSiteNegatives(event) {
  const sessions = new Set();
  for (const c of event.confirmations) {
    if (c.step === 'witness' && c.atStation && c.witnessed === 'no') {
      sessions.add(c.sessionId);
    }
  }
  return sessions.size;
}

/**
 * 狀態轉移決策（純判斷，不執行）。
 * @returns 'promote' | 'cancel' | 'freeze' | 'expire' | 'stay'
 */
export function evaluateEvent(event, config, now = Date.now()) {
  const positives = countIndependentPositives(event);
  const negatives = countOnSiteNegatives(event);
  const threshold = config.eventTypes[event.type].threshold;

  // ---- 否證否決：在場否證 >= 門檻且多於正向 → 取消（推收尾通知） ----
  if (negatives >= config.cancelNegatives && negatives > positives) {
    return 'cancel';
  }

  if (event.status === 'candidate') {
    // 達門檻 → 升級為 active（警示語氣 + 上態勢卡）
    if (positives >= threshold) return 'promote';
    // candidate 超時無人補確認 → 過期取消
    if (now - event.updatedAt >= config.candidateTtlMinutes * 60_000) {
      return 'expire';
    }
    return 'stay';
  }

  if (event.status === 'active') {
    // 45 分鐘無新確認 → 凍結歸檔
    if (now - event.updatedAt >= config.freezeAfterMinutes * 60_000) {
      return 'freeze';
    }
    return 'stay';
  }

  return 'stay'; // cancelled / frozen 為終態
}
