/**
 * ============================================================================
 * session.js —— 無身份的「本次造訪」識別
 * ============================================================================
 * 系統不認識任何使用者（零帳號、零持久側寫），session = 一組 page 開啟時
 * 產生的隨機 UUID，存在 sessionStorage（關頁即滅）。三個用途：
 *   1. 回報冪等之外的「人」維度去重：3 票 = 3 個不同 session
 *   2. 同 session 重複確認同一事件 → server 一票擋重複
 *   3. L2 位置記憶也掛在同一把 key 上
 */

const KEY = 'np_session';

export function getSessionId() {
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}
