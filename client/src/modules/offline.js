/**
 * ============================================================================
 * offline.js —— 連線狀態與待送出回報的追蹤
 * ============================================================================
 * 這個 App 的預期使用環境就是「網路時有時無」，所以離線不是錯誤狀態，
 * 是**常態的一種**。UI 的責任不是報錯，而是誠實告訴使用者：
 *
 *   - 現在是離線的
 *   - 你的通報沒有消失，它在排隊
 *   - 你看到的態勢資訊是什麼時候的
 *
 * Service Worker 會在排隊數量變動時 postMessage 過來（見 public/sw.js）。
 */

let state = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  queued: 0,
  /** 態勢卡是不是來自離線快取（由 SW 加的 X-NearPulse-Offline 標頭判斷） */
  cardStale: false,
};

const listeners = new Set();

function emit() {
  const snapshot = { ...state };
  for (const fn of listeners) fn(snapshot);
}

export function getOfflineState() {
  return { ...state };
}

export function subscribeOffline(fn) {
  listeners.add(fn);
  fn(getOfflineState());
  return () => listeners.delete(fn);
}

/** 由 api.js 在收到態勢卡回應時呼叫 */
export function setCardStale(stale) {
  if (state.cardStale === stale) return;
  state = { ...state, cardStale: stale };
  emit();
}

if (typeof window !== 'undefined') {
  const setOnline = (online) => {
    if (state.online === online) return;
    state = { ...state, online };
    emit();
  };
  window.addEventListener('online', () => setOnline(true));
  window.addEventListener('offline', () => setOnline(false));

  navigator.serviceWorker?.addEventListener?.('message', (e) => {
    if (e.data?.type === 'queue') {
      state = { ...state, queued: e.data.count ?? 0 };
      emit();
    }
  });
}
