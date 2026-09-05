/**
 * ============================================================================
 * rateLimit —— 極簡固定視窗限流（零相依）
 * ============================================================================
 * 【為什麼非有不可】
 * `/api/vision` 沒有認證，而它會把請求轉發到**付費的** Vision API。
 * 公開部署等同對外開放一個免費的 Vision 代理——任何人拿到網址就能燒光額度，
 * 而且是拿別人的錢包。這在文件裡被列為 Phase 2 阻斷條件已久；
 * 接上真實金鑰的那一刻起，它就不能再延後。
 *
 * 【設計取捨】
 * 這不是要擋住有決心的攻擊者（沒有認證就做不到），而是要讓
 * 「路過的人隨手大量呼叫」與「腳本無限迴圈」不會在幾分鐘內把額度用完。
 * 對這個目的，固定視窗計數就夠了，不值得引入相依套件或 Redis。
 *
 * 兩層限制，用途不同：
 *   perIp    —— 擋單一來源的濫用。合理使用者一次回報最多兩次呼叫（locate + read）
 *   global   —— **保護錢包的最後一道**。分散式來源繞得過 perIp，但繞不過總量。
 *
 * 【被限流時回什麼：降級，不是錯誤】
 * 這是最重要的一點。視覺辨識是**選配的加值**，回報流程沒有它照樣走完。
 * 所以超限時回 200 + 與「AI 關掉」完全相同的降級形狀，而不是 429——
 * 呼叫端無從分辨、也不需要分辨，使用者的通報永遠不會因為限流而失敗。
 * 這與 advisor 層的鐵則一致：AI 相關的任何狀況都不得擋住通報。
 */

/** 視窗長度。太短擋不住迴圈，太長會誤傷同一個 NAT 後面的多個使用者 */
const WINDOW_MS = 60_000;

export function createRateLimiter({ perIp = 12, global = 120, windowMs = WINDOW_MS } = {}) {
  let windowStart = Date.now();
  let globalCount = 0;
  let counts = new Map();

  function rollIfNeeded(now) {
    if (now - windowStart < windowMs) return;
    windowStart = now;
    globalCount = 0;
    // 整個換掉而不是逐項清除：視窗一到就全部歸零，順帶回收記憶體
    counts = new Map();
  }

  /**
   * @returns {{allowed: boolean, reason: string|null}}
   */
  return function check(key) {
    const now = Date.now();
    rollIfNeeded(now);

    if (globalCount >= global) return { allowed: false, reason: 'global' };

    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    globalCount++;

    if (n > perIp) return { allowed: false, reason: 'per_ip' };
    return { allowed: true, reason: null };
  };
}

/**
 * 取得請求來源識別。
 *
 * 這個服務跑在 Cloudflare Tunnel 後面，`req.ip` 會是隧道的本機位址——
 * 對所有人都一樣，等於沒有 perIp。必須讀 `CF-Connecting-IP`。
 * 標頭可以偽造，但偽造者也就繞不過 global 那一層，這是刻意的分工。
 */
export function clientKey(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() ||
    req.ip ||
    'unknown'
  );
}
