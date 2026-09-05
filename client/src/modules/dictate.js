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
 * 【為什麼是「點一下開始／再點一下結束」而不是「按住說話」】
 * `SpeechRecognition.start()` 是**非同步**的：要開麥克風、要跟辨識服務
 * 建連線，`onstart` 通常在 200~800ms 之後才發生。按住說話的寫法是
 * pointerdown 開始、pointerup 結束——而一次自然的點按只有 100ms 上下，
 * 等於在麥克風真正開起來以前就把它關掉了，結果永遠是空的。
 * 手指稍微移出按鈕（pointerleave）也會中斷，講到一半就沒了。
 *
 * 所以這裡改成明確的兩次點擊，並且：
 *   - 在 `onstart` 之前收到 stop，先記下來，等真的開起來再停（不會空手而回）
 *   - `continuous = true` + 自動接回：Chrome 會在一段靜默後自己結束，
 *     使用者還沒喊停就把它接起來，否則「呃……在……B1」中間停一下就斷線
 *   - 失敗有原因可講：沒權限、沒網路、非 HTTPS 是完全不同的三件事，
 *     一律靜默的話使用者只會覺得「這功能壞了」
 *
 * 【誠實的限制】
 * Chrome 的 `SpeechRecognition` **會把音訊送到 Google 的伺服器**，
 * 所以它需要網路。而這個 App 的前提就是地下可能沒有網路。
 * 因此語音輸入永遠是**加速器，不是必經路徑**：不支援、沒權限、沒網路，
 * 都只是回到打字，不擋任何人通報。
 *
 * 辨識結果一律填進輸入框讓使用者過目，**不會自動送出**——
 * 語音辨識在吵雜的月台上本來就會出錯，而這個欄位決定別人往哪裡找。
 */

const Recognition =
  typeof window !== 'undefined'
    ? window.SpeechRecognition ?? window.webkitSpeechRecognition
    : null;

/** 單次語音輸入的上限。地點描述講不到這麼久，超過就是忘了按停止 */
const MAX_MS = 25_000;

/** 自動接回的次數上限：無聲時 Chrome 會一直結束，不能無限接下去 */
const MAX_RESTARTS = 8;

export function isDictationSupported() {
  return Boolean(Recognition);
}

/**
 * 給使用者看的錯誤說法。
 * 每一句都要能回答「那我現在該做什麼」——所以每一句結尾都是打字。
 */
export function dictationErrorText(code) {
  switch (code) {
    case 'insecure':
      return '語音輸入需要 HTTPS 連線，這個網址不支援——請直接打字。';
    case 'not-allowed':
    case 'service-not-allowed':
      return '麥克風權限被拒絕——請在瀏覽器設定允許，或直接打字。';
    case 'audio-capture':
      return '找不到可用的麥克風——請直接打字。';
    case 'network':
      return '語音辨識需要網路，現在連不上——請直接打字。';
    case 'no-speech':
      return '沒有聽到聲音——再試一次，或直接打字。';
    default:
      return '語音辨識沒有成功——請直接打字。';
  }
}

/**
 * 開始一次語音輸入。
 *
 * @param {object} handlers
 * @param {(text: string, isFinal: boolean) => void} handlers.onText
 *        每次有結果就呼叫。`isFinal=false` 是講到一半的暫定結果——
 *        即時顯示出來，使用者才知道系統有在聽。
 * @param {() => void} [handlers.onStart]  麥克風真的開起來了（不是按下去那一刻）
 * @param {(code: string) => void} [handlers.onError]
 * @param {() => void} [handlers.onEnd]
 * @returns {{stop: () => void} | null} 起不來時回 null（onError 已經被呼叫過）
 */
export function startDictation({ onText, onStart, onError, onEnd } = {}) {
  if (!Recognition) {
    onError?.('unsupported');
    return null;
  }
  // 非安全來源（http://192.168.x.x 這種）下 SpeechRecognition 物件存在，
  // 但 start() 會直接吐 not-allowed。先擋下來才講得出原因。
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    onError?.('insecure');
    return null;
  }

  let rec;
  try {
    rec = new Recognition();
  } catch {
    onError?.('unsupported');
    return null;
  }

  rec.lang = 'zh-TW';
  // 講到一半的停頓不該被當成講完了——中斷後自己接回去（見 onend）
  rec.continuous = true;
  // 講到一半就先顯示：兩秒的空白會讓人以為壞了
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  let listening = false;      // onstart 已經發生
  let stopRequested = false;  // 使用者（或逾時）要求停止
  let finished = false;       // 已經收尾，不再接回
  let restarts = 0;
  let finalText = '';         // 跨越多次 restart 累積的定稿
  let timer = null;

  const safeStop = () => { try { rec.stop(); } catch { /* 已經停了 */ } };

  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    onEnd?.();
  };

  rec.onstart = () => {
    listening = true;
    onStart?.();
    // 使用者在麥克風開起來以前就按了停止——現在才真的停得掉
    if (stopRequested) safeStop();
  };

  rec.onresult = (event) => {
    let interim = '';
    // 只看這次事件帶來的新結果；已經定稿的累積在 finalText，
    // 這樣 restart 之後（results 會重來）也不會把前半句弄丟
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = result[0]?.transcript ?? '';
      if (result.isFinal) finalText += text;
      else interim += text;
    }
    onText?.(`${finalText}${interim}`.trim(), interim === '');
  };

  rec.onerror = (event) => {
    const code = event?.error ?? 'unknown';
    // 這兩個不是「壞了」：no-speech 是還沒開口，aborted 是我們自己停的。
    // 交給 onend 判斷要不要接回去。
    if (code === 'no-speech' || code === 'aborted') return;
    onError?.(code);
    stopRequested = true;
    finish();
  };

  rec.onend = () => {
    listening = false;
    // 使用者還沒喊停 → 這是引擎自己斷的，接回去繼續聽
    if (!stopRequested && !finished && restarts < MAX_RESTARTS) {
      restarts += 1;
      try {
        rec.start();
        return;
      } catch { /* 起不來就收尾 */ }
    }
    // 一路接回到上限卻一個字都沒聽到——那不是「講完了」，是沒收到聲音。
    // 不講的話畫面只會默默變回原狀，跟壞掉一模一樣。
    if (!stopRequested && !finalText) onError?.('no-speech');
    finish();
  };

  try {
    rec.start();
  } catch {
    onError?.('unknown');
    return null;
  }

  // 忘了按停止的保險絲
  timer = setTimeout(() => {
    stopRequested = true;
    if (listening) safeStop(); else finish();
  }, MAX_MS);

  return {
    stop() {
      stopRequested = true;
      clearTimeout(timer);
      // 還沒 onstart 的話停不掉——記下來，等 onstart 再停（見上方）
      if (listening) safeStop();
    },
  };
}
