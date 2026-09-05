/**
 * ============================================================================
 * dictate.js —— 語音輸入（瀏覽器內建辨識）
 * ============================================================================
 * 【為什麼是這裡需要語音，而不是別的地方】
 * 「自己描述這是哪裡」是整個流程中唯一非打字不可的欄位——而恐慌中打字很慢，
 * 手也可能在抖。講一句「京站地下街 B1 星巴克前」只要兩秒。
 *
 * 這跟「錄一段現場語音當附件」是不同的問題：那個需要伺服器端的 STT
 * （目前仍是 stub），而這個用瀏覽器內建的 `SpeechRecognition` 就夠了，
 * 零 API、零金鑰、零成本——與 TTS 用 `speechSynthesis` 是同一個取捨。
 *
 * 【誠實的限制】
 * Chrome 的 `SpeechRecognition` **會把音訊送到 Google 的伺服器**，
 * 所以它需要網路。而這個 App 的前提就是地下可能沒有網路。
 * 因此語音輸入永遠是**加速器，不是必經路徑**：
 *   - 不支援（iOS Safari 至今沒有）→ 按鈕不出現，打字照常
 *   - 有支援但辨識失敗／沒網路 → 靜默回到打字，不跳錯誤打斷使用者
 *
 * 辨識結果一律填進輸入框讓使用者過目，**不會自動送出**——
 * 語音辨識在吵雜的月台上本來就會出錯，而這個欄位決定別人往哪裡找。
 */

const Recognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition ?? window.webkitSpeechRecognition
    : null;

export function isDictationSupported() {
  return Boolean(Recognition);
}

/**
 * 開始一次語音輸入。
 *
 * @param {object} handlers
 * @param {(text: string, isFinal: boolean) => void} handlers.onText
 *        每次有結果就呼叫。`isFinal=false` 是講到一半的暫定結果——
 *        即時顯示出來，使用者才知道系統有在聽。
 * @param {() => void} [handlers.onEnd]
 * @returns {{stop: () => void} | null} 不支援時回 null
 */
export function startDictation({ onText, onEnd } = {}) {
  if (!Recognition) return null;

  let rec;
  try {
    rec = new Recognition();
  } catch {
    return null;
  }

  rec.lang = 'zh-TW';
  // 一句話就好——這個欄位是地點描述，不是逐字稿
  rec.continuous = false;
  // 講到一半就先顯示：兩秒的空白會讓人以為壞了
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onresult = (event) => {
    let text = '';
    let isFinal = false;
    for (const result of event.results) {
      text += result[0]?.transcript ?? '';
      if (result.isFinal) isFinal = true;
    }
    onText?.(text.trim(), isFinal);
  };

  // 沒網路、沒授權、沒聽到聲音——都不是要打斷使用者的事，靜默收尾即可
  rec.onerror = () => onEnd?.();
  rec.onend = () => onEnd?.();

  try {
    rec.start();
  } catch {
    return null;
  }

  return {
    stop() {
      try { rec.stop(); } catch { /* 已經結束了 */ }
    },
  };
}
