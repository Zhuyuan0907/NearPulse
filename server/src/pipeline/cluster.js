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
/** 兩筆「沒有場域」的通報要多近才算同一件事。站距普遍 >300m，取 250m 保守些 */
const FREEFORM_MERGE_M = 250;

const normPlace = (t) => String(t ?? '').trim().replace(/\s+/g, '').toLowerCase();

function roughDistM(a, b) {
  const k = 111_320;
  return Math.hypot(
    (a.lat - b.lat) * k,
    (a.lon - b.lon) * k * Math.cos((a.lat * Math.PI) / 180)
  );
}

/**
 * 找出同一件事的既有事件。
 *
 * 場域已知時就是「同場域 + 同類型」。
 *
 * 場域未知時（使用者不知道自己在哪，或這個地方不在圖資裡）**不能**把所有
 * 無場域的通報併成一件——那會把台北的火警和高雄的推擠混為一談。
 * 只在有明確理由時才併：
 *   - 兩邊都有座標且相距 <250m
 *   - 或兩邊的自由描述文字一致（「京站地下街B1星巴克前」）
 * 兩者皆無就各自成案。**寧可分開兩件，也不要錯併成一件**——
 * 錯併會讓兩個不同地點的人收到彼此的疏散指示。
 */
export function findMatchingEvent(events, { stationId, type, claimPoint, placeText }) {
  const open = (ev) => ev.status === 'candidate' || ev.status === 'active';

  if (stationId) {
    return events.find((ev) => open(ev) && ev.type === type && ev.stationId === stationId);
  }

  return events.find((ev) => {
    if (!open(ev) || ev.type !== type || ev.stationId) return false;
    if (claimPoint && ev.claimPoint) {
      return roughDistM(claimPoint, ev.claimPoint) <= FREEFORM_MERGE_M;
    }
    const a = normPlace(placeText);
    return a.length > 0 && a === normPlace(ev.placeText);
  });
}

/**
 * 計算一個事件的「獨立正向訊號數」。
 * 正向來源有兩種（都算 1 人，但去重 session）：
 *   a. 併入此事件的回報——但位置聲明來源必須夠可信（gps / manual）
 *   b. 兩段式確認中「在場 + 有看到」的回覆
 */
export function countIndependentPositives(event) {
  const sessions = new Set();

  /**
   * ⚠️ **所有被受理的回報都算數，不再依 source 過濾。**
   *
   * 這個過濾原本是為了擋掉「沒有有效位置聲明」的回報。但那道關卡已經移到
   * 驗證層了——現在 server 要求每筆回報至少有一種位置線索（場域／自己描述／
   * 座標／照片），過不了的根本進不來。
   *
   * 留著舊的白名單會造成一個很難察覺的後果：用「自己描述地點」或「只拍照」
   * 通報的事件，`source` 是 `freeform`／`unknown`，**永遠不計入門檻**——
   * 再多人回報也升不上去，事件會一直停在「未經確認」直到過期。
   * 而那兩條路正是給「不知道自己在哪」的人用的，也就是最需要幫助的人。
   */
  for (const rep of event.reports) {
    if (rep.sessionId) sessions.add(rep.sessionId);
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
  // cancelled / frozen 是終態——先擋掉，否則否證規則會讓已取消的事件
  // 每個 batch tick 都再「取消」一次（log 洗版 + 態勢卡每輪被判髒重算）。
  if (event.status === 'cancelled' || event.status === 'frozen') return 'stay';

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
