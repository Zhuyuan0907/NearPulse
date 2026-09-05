/**
 * ============================================================================
 * placeParse advisor —— 語音地點描述 → 乾淨的地點名稱
 * ============================================================================
 * 【要解決的問題】
 * 語音輸入「你好我現在在京站地下街」整句進了地點欄。那不是地點名稱，
 * 是一句話——拿去查 OSM 會查不到，印在畫面上也像逐字稿。
 *
 * 這裡用 LLM 把句子縮成地點名稱。**AI 永遠不在關鍵路徑上**：
 *   - 失敗／逾時／無金鑰 → 回 null，呼叫端照用原句
 *   - 原句本來就短（≤12 字）→ 視為已經是地點，不花這次呼叫
 *   - 解析結果比原句長 → 明顯是模型幻覺，丟棄用原句
 *
 * 這是繼 vision 之後，AI 在本專案出現的第二個（也是最後一個）地方：
 * AI 只做「讀與縮」，位置仍然由確定性查表決定——解析出的名稱會走
 * venueService 查表／Nominatim 搜尋，查得到才成立，查不到就只是文字。
 */

const ENDPOINT = process.env.GMI_BASE_URL ?? 'https://api.gmi-serving.com/v1/chat/completions';
const MODEL = process.env.PLACE_LLM_MODEL ?? process.env.VISION_MODEL ?? 'MiniMaxAI/MiniMax-M3';
const TIMEOUT_MS = 8000;

/** 原句短於這個值就不值得花一次 LLM 呼叫——多半本來就是地名 */
const MIN_LEN_TO_PARSE = 12;
/** 解析結果比原句還長 → 模型在添字，不是在縮句 */
const MAX_RESULT_RATIO = 1.2;

/**
 * 把語音描述縮成地點名稱。
 *
 * @param {string} raw - 語音輸入的原句（例：「你好我現在在京站地下街 B1」）
 * @returns {Promise<string|null>} 乾淨的地點名稱；null = 用原句
 */
export async function parsePlaceFromSpeech(raw) {
  const text = String(raw ?? '').trim();
  if (!process.env.GMI_API_KEY) return null;
  if (text.length < MIN_LEN_TO_PARSE) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GMI_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 60,
        messages: [
          {
            role: 'user',
            content:
              '從這句話抽出「地點名稱」，輸出 JSON {"place":"..."}。'
              + '只保留場所名與樓層／區域（B1、3號出口、星巴克前），'
              + '去掉招呼語、動作、方向詞。查無地點就輸出 {"place":""}。'
              + `句子：${text}`,
          },
        ],
      }),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    // 寬鬆抽 JSON：模型可能在外圍包字
    const m = content.match(/\{\s*"place"\s*:\s*"([^"]*)"\s*\}/);
    const place = m?.[1]?.trim();
    if (!place) return null;
    // 幻覺保險：結果比原句長代表模型在創作，不是在抽取
    if (place.length > text.length * MAX_RESULT_RATIO) return null;
    return place;
  } catch {
    return null; // 逾時／無網路——原句照用，流程不受影響
  } finally {
    clearTimeout(timer);
  }
}
