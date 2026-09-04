/**
 * ============================================================================
 * speech.js —— 疏散指示語音播報（離線、零 API、零成本）
 * ============================================================================
 * 【為什麼疏散資訊需要用唸的】
 * 濃煙中看不清螢幕；而且你正在移動、可能被推擠、手上可能還牽著人。
 * 「往 M7 出口，忠孝西路方向」這種資訊用聽的才真的接收得到。
 *
 * 【為什麼用瀏覽器內建而不是雲端 TTS】
 * 雲端 TTS 需要網路——而這個 App 的整個前提就是地下可能沒有網路。
 * `speechSynthesis` 用的是**裝置內建的語音**，離線可用、零延遲、零成本。
 * 技術上正確的選擇剛好也不需要任何 API 金鑰。
 *
 * 【平台限制】
 * - iOS 與部分瀏覽器要求**首次播放必須由使用者手勢觸發**；
 *   解鎖之後同一個 session 內就可以程式化播放
 * - Chrome 的 `getVoices()` 首次呼叫可能回空陣列，要等 `voiceschanged`
 * - 語音品質依裝置而異；沒有中文語音時退回系統預設（總比不出聲好）
 */

const PREFERRED_LANGS = ['zh-TW', 'zh-Hant', 'zh-HK', 'zh-CN', 'zh'];

export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/**
 * 取得最合適的中文語音。
 * Chrome 的語音清單是非同步載入的，首次呼叫常常是空的——所以這裡等一次
 * `voiceschanged`，而不是直接放棄。
 */
let voicesReady = null;
function loadVoices() {
  if (!isSpeechSupported()) return Promise.resolve([]);
  if (voicesReady) return voicesReady;

  voicesReady = new Promise((resolve) => {
    const got = speechSynthesis.getVoices();
    if (got.length > 0) return resolve(got);
    // 最多等 1 秒；等不到就用空清單，讓瀏覽器自己挑預設語音
    const timer = setTimeout(() => resolve(speechSynthesis.getVoices()), 1000);
    speechSynthesis.addEventListener(
      'voiceschanged',
      () => { clearTimeout(timer); resolve(speechSynthesis.getVoices()); },
      { once: true }
    );
  });
  return voicesReady;
}

function pickVoice(voices) {
  for (const lang of PREFERRED_LANGS) {
    const hit = voices.find((v) => v.lang?.replace('_', '-').startsWith(lang));
    if (hit) return hit;
  }
  return null; // 交給瀏覽器預設
}

/**
 * 唸出一段文字。會先中斷正在播的內容——疏散資訊會更新，
 * 排隊播放舊資訊比不播還糟。
 *
 * @param {string} text
 * @returns {Promise<boolean>} 是否真的播出來了
 */
export async function speak(text) {
  if (!isSpeechSupported() || !text) return false;
  try {
    speechSynthesis.cancel();
    const voices = await loadVoices();
    const utter = new SpeechSynthesisUtterance(String(text));
    const voice = pickVoice(voices);
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang ?? 'zh-TW';
    utter.rate = 0.95; // 略慢：恐慌中聽清楚比聽得快重要
    utter.pitch = 1;
    utter.volume = 1;
    speechSynthesis.speak(utter);
    return true;
  } catch {
    return false; // 播不出來不是錯誤——文字本來就還在螢幕上
  }
}

export function stopSpeaking() {
  if (isSpeechSupported()) speechSynthesis.cancel();
}
