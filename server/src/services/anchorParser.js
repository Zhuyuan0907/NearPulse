/**
 * ============================================================================
 * anchorParser —— 視覺錨點的文字解析（純函式）
 * ============================================================================
 * 「地下沒有 GPS，但有站名牌和出口編號牌」——那就是地下的地標系統。
 * 這個模組負責把「牌子上印的字」正規化成可比對的鍵。
 *
 * ⚠️ 本模組同時被兩邊使用，這是刻意的：
 *   - scripts/build-venues.mjs —— 建表時從 OSM 標籤抽出出口代碼
 *   - services/venueService.js —— 查表時從 OCR 文字抽出出口代碼
 * 兩邊必須用同一套規則，否則會出現「存的是 3、查的是 3號」這種安靜的比不中。
 */

/**
 * 站名正規化：異體字（臺/台）、空白、大小寫。
 * OCR 讀到「臺北車站」或「台北車站」都要能對上同一個場域。
 */
export function normalizeName(s) {
  return (s ?? '')
    .replace(/臺/g, '台')
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}

/**
 * 出口代碼的解析樣式。順序即優先序——帶字母前綴的最不歧義，先試。
 *
 * 實測台北車站同時存在三套編號：M1~M8（捷運）、Y9~Y22（地下街）、1~5（台鐵/高鐵）。
 * 日本的地下街規模更大也更依賴編號導引——大阪梅田周邊實測 191 個出入口
 * （台北車站複合體是 27 個），編號形如 `G-1a`、`C-49`、`H-80`、`4-A`，
 * 中間帶連字號。這些樣式必須一起支援，否則「用招牌當地下 GPS」的方法
 * 只在台灣成立。
 */
const CODE_PATTERNS = [
  /\b([A-Z]-?\d{1,3}[A-Z]?)\b/i,               // M3、Y22、R1、G-1a、C-49、H-80
  /\b(\d{1,3}-[A-Z])\b/i,                      // 4-A（大阪梅田常見）
  /(?:出口|出入口|exit)\s*([A-Z]?-?\d{1,3}[A-Z]?)/i, // 出口 3、Exit 6、出入口1
  /([A-Z]?\d{1,3}[A-Z]?)\s*號\s*出入?口/,        // 3號出入口、西門地下街1號出入口
  /^\s*([A-Z]?-?\d{1,3}[A-Z]?)\s*$/i,          // 牌子上只有一個裸編號
];

/**
 * 從一段文字抽出出口代碼。
 * @param {string} text - OCR 讀到的字串，或 OSM 的 name 標籤
 * @returns {string|null} 正規化（大寫）後的代碼
 */
export function parseExitCode(text) {
  const s = (text ?? '').trim();
  if (!s) return null;
  for (const re of CODE_PATTERNS) {
    const m = s.match(re);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

/**
 * 從 OSM 標籤抽出出口代碼：ref 優先，缺漏時退回解析 name。
 * 實測大量出口節點沒有 ref，編號藏在 name 裡（「Y22」「3號出入口」）。
 */
export function exitCodeFromTags(tags = {}) {
  const ref = (tags.ref ?? '').trim();
  // ref 帶分號代表多值（不是單一出口），不可信
  if (ref && ref.length <= 6 && !ref.includes(';')) return ref.toUpperCase();
  return parseExitCode(tags.name);
}

/**
 * 出口名稱裡的地標線索——括號內文字或 exit_to 標籤。
 * 「出口 6 (善導寺)」→ 善導寺。照片裡的招牌也可能讀到這些字。
 */
export function landmarkFromTags(tags = {}) {
  if (tags.exit_to) return tags.exit_to;
  const m = (tags.name ?? '').match(/[（(]([^）)]+)[）)]/);
  return m ? m[1] : null;
}
