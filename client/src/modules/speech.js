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
 * 【平台限制，以及一個踩過的坑】
 * iOS Safari 與新版 Chrome 要求 `speechSynthesis.speak()` **在使用者手勢的
 * 同一個 tick 內同步呼叫**。初版是 `async function speak()`，而且在 speak 之前
 * 先 `await loadVoices()`——一旦 await，手勢脈絡就失效，瀏覽器**靜默不發聲、
 * 也不報錯**。實際回報的症狀就是「按了沒聲音」。首次點擊時 `getVoices()`
 * 常常是空的，還要再等最多一秒，更是必定失效。
 *
 * 所以現在：**先發聲，再談語音品質**。
 *   - `speak()` 是同步的，第一件事就是把 utterance 送出去
 *   - 語音清單有就用，沒有就交給瀏覽器挑預設——出聲永遠優先於挑到最好的聲音
 *   - 清單在背景預熱，下一次就選得到中文語音
 *
 * 其餘：語音品質依裝置而異；沒有中文語音時退回系統預設（總比不出聲好）。
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
let cachedVoices = [];

/**
 * 在背景把語音清單準備好。
 *
 * **不會被 speak() 等待**——它的用途是讓「下一次」選得到中文語音，
 * 而不是讓「這一次」慢一秒然後靜默失敗。
 */
function warmVoices() {
  if (!isSpeechSupported()) return;
  const got = speechSynthesis.getVoices();
  if (got.length > 0) { cachedVoices = got; return; }
  speechSynthesis.addEventListener(
    'voiceschanged',
    () => { cachedVoices = speechSynthesis.getVoices(); },
    { once: true }
  );
}

if (typeof window !== 'undefined' && isSpeechSupported()) warmVoices();

const PICK = (voices) => {
  for (const lang of PREFERRED_LANGS) {
    const hit = voices.find((v) => v.lang?.replace('_', '-').startsWith(lang));
    if (hit) return hit;
  }
  return null; // 交給瀏覽器預設
};

/**
 * 唸出一段文字。**同步**——必須在使用者手勢的同一個 tick 內完成，
 * 否則 iOS 與新版 Chrome 會靜默拒絕（見檔頭）。
 *
 * 會先中斷正在播的內容：疏散資訊會更新，排隊播放舊資訊比不播還糟。
 *
 * @param {string} text
 * @returns {boolean} 是否送出了播放請求（不保證裝置真的有聲音）
 */
export function speak(text) {
  if (!isSpeechSupported() || !text) return false;
  try {
    speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(String(text));
    // 清單還沒好就直接不指定 voice，讓瀏覽器依 lang 自己挑——
    // 這是「有聲音」與「沒聲音」的差別，不是音色好壞的差別
    const voice = PICK(cachedVoices.length > 0 ? cachedVoices : speechSynthesis.getVoices());
    if (voice) utter.voice = voice;
    utter.lang = voice?.lang ?? 'zh-TW';
    utter.rate = 0.95; // 略慢：恐慌中聽清楚比聽得快重要
    utter.pitch = 1;
    utter.volume = 1;

    speechSynthesis.speak(utter);

    // 順手補一次預熱，下次就選得到中文語音
    if (cachedVoices.length === 0) warmVoices();
    return true;
  } catch {
    return false; // 播不出來不是錯誤——文字本來就還在螢幕上
  }
}

export function stopSpeaking() {
  if (isSpeechSupported()) speechSynthesis.cancel();
}
