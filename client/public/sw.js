/**
 * ============================================================================
 * sw.js —— Service Worker：離線殼與回報排隊
 * ============================================================================
 * 【為什麼這個專案特別需要它】
 * 整個產品的前提就是「地下網路很差甚至沒有」。在那之前的版本卻假設有網路——
 * 這是設計與實作互相矛盾的地方。
 *
 * 三件事：
 *   1. **App 開得起來**：完全沒網路時仍能載入（殼與資源走快取）
 *   2. **仍看得到疏散資訊**：上次的態勢卡與場域出口資料留在快取裡
 *   3. **回報不會消失**：送不出去的回報存進 IndexedDB，恢復連線後自動補送
 *
 * 快取策略依資料的「新鮮度需求」分開處理——不是全部一視同仁：
 *   殼與靜態資源   cache-first     （檔名有 hash，變更即換檔名）
 *   /api/venues/*  stale-while-revalidate（圖資極少變，先給快取再背景更新）
 *   /api/situation network-first   （必須新鮮；離線才退回上次內容並標記）
 *   POST /api/reports              （送不出去就排隊，絕不丟掉）
 *
 * ⚠️ 刻意不快取 /api/vision：那是一次性的分析請求，重放沒有意義。
 */

const VERSION = 'np-v2'; // 版本號一改，舊快取自動清除
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL_ASSETS = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

// ---------------------------------------------------------------------------
// 安裝 / 啟用
// ---------------------------------------------------------------------------

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // 個別資源失敗不該讓整個安裝失敗（例如 icon 還沒部署）
      .then((c) => Promise.allSettled(SHELL_ASSETS.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
      .then(flushQueue) // 版本更新時順手把積壓的回報送出去
  );
});

// ---------------------------------------------------------------------------
// 回報排隊（IndexedDB）
// ---------------------------------------------------------------------------
// 為什麼不是 localStorage：Service Worker 拿不到 localStorage。
// 為什麼不是只放記憶體：SW 隨時會被瀏覽器回收，排隊必須落地。

const DB_NAME = 'nearpulse';
const STORE = 'queued_reports';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'uuid' }); // uuid = 冪等鍵，天然去重
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const result = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

async function enqueue(body) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.put({ uuid: body.uuid, body, at: Date.now() }));
  // 有 Background Sync 就登記；沒有的話靠 online 事件與下次開頁補送
  if ('sync' in self.registration) {
    try { await self.registration.sync.register('flush-reports'); } catch { /* 忽略 */ }
  }
  await notifyClients();
}

async function queuedCount() {
  const db = await openDb();
  return tx(db, 'readonly', (s) => s.count());
}

/**
 * 把積壓的回報送出去。
 * 因為 payload 帶著 client 產生的 UUID，server 端本來就會冪等去重——
 * 所以重送是安全的，不需要額外的「已送出」狀態機。
 */
async function flushQueue() {
  let db;
  try { db = await openDb(); } catch { return; }
  const all = await tx(db, 'readonly', (s) => s.getAll());
  const items = all?.result ?? all ?? [];

  for (const item of items) {
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(item.body),
      });
      // 4xx 代表這筆本身有問題，重送幾次也不會成功——移除避免永遠卡住佇列
      if (res.ok || res.status === 202 || (res.status >= 400 && res.status < 500)) {
        await tx(db, 'readwrite', (s) => s.delete(item.uuid));
      }
    } catch {
      return; // 還是沒網路：留著，下次再試
    }
  }
  await notifyClients();
}

async function notifyClients() {
  const n = await queuedCount().catch(() => 0);
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: 'queue', count: n });
}

self.addEventListener('sync', (event) => {
  if (event.tag === 'flush-reports') event.waitUntil(flushQueue());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'flush') event.waitUntil(flushQueue());
});

// ---------------------------------------------------------------------------
// 攔截
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // 圖磚等跨網域資源交給瀏覽器

  // ---- 回報：送不出去就排隊，絕不讓使用者的通報消失 ----
  if (request.method === 'POST' && url.pathname === '/api/reports') {
    event.respondWith(
      request
        .clone()
        .json()
        .then((body) =>
          fetch(request.clone()).catch(async () => {
            await enqueue(body);
            // 對前端回一個「已收下」的成功回應——使用者不需要知道它還在排隊，
            // 只需要知道通報有效。UI 另外會顯示待送出的筆數。
            return new Response(
              JSON.stringify({
                ok: true, received: true, queued: true,
                message: '目前沒有網路，已離線保存。恢復連線後會自動送出。',
              }),
              { status: 202, headers: { 'Content-Type': 'application/json' } }
            );
          })
        )
        .catch(() => fetch(request))
    );
    return;
  }

  if (request.method !== 'GET') return;

  // ---- 鄰近查詢／搜尋：network-first ----
  // 這兩個是**位置相關**的：快取一份舊的鄰近清單，會讓使用者在新地點看到
  // 舊地點的場域。離線時才退回快取（總比沒有清單好，且會標示）。
  if (url.pathname === '/api/venues/nearby' || url.pathname === '/api/venues/search') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) caches.open(DATA_CACHE).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(async () => (await caches.match(request)) ?? new Response(
          '{"ok":false,"offline":true,"venues":[]}',
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ))
    );
    return;
  }

  // ---- 單一場域圖資：stale-while-revalidate（內容極少變，先給快取最快） ----
  if (url.pathname.startsWith('/api/venues/')) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
          .catch(() => null);
        return cached ?? (await network) ?? new Response('{"ok":false,"offline":true}', {
          status: 503, headers: { 'Content-Type': 'application/json' },
        });
      })
    );
    return;
  }

  // ---- 態勢卡：network-first（必須新鮮），離線退回上次內容 ----
  if (url.pathname === '/api/situation') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) caches.open(DATA_CACHE).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (!cached) throw new Error('offline, no cached card');
          // 標記這是離線快取——前端據此顯示「離線，以下為上次取得的資訊」
          const headers = new Headers(cached.headers);
          headers.set('X-NearPulse-Offline', '1');
          return new Response(await cached.blob(), { status: 200, headers });
        })
    );
    return;
  }

  if (url.pathname.startsWith('/api/')) return; // 其餘 API 一律走網路

  // ---- 導覽：network-first，離線退回殼 ----
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/index.html').then((r) => r ?? caches.match('/')))
    );
    return;
  }

  // ---- 靜態資源：cache-first（檔名帶 hash，內容不會變） ----
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((res) => {
          if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(request, res.clone()));
          return res;
        })
    )
  );
});
