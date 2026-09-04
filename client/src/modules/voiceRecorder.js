/**
 * ============================================================================
 * voiceRecorder.js —— hold-to-talk 語音錄音（補充層輸入）
 * ============================================================================
 * 設計原則：「粗粒度用點的、細粒度用說的、永遠不用打的」。
 * 這個模組是回報的「選配補充」，錄音失敗絕不影響回報成立。
 *
 * 網頁平台現實（已在設計內化）：
 *   - iOS Safari 無 SpeechRecognition → 錄音上傳、server 端 STT（架構方案 B）
 *   - MediaRecorder iOS 14.3+ 支援；mimeType 用 isTypeSupported 動態偵測
 *   - 上限 30 秒：恐慌口述不應超過，也控制音檔大小
 */

const MAX_MS = 30_000;

/** 此瀏覽器是否支援錄音（不支援時 UI 隱藏語音按鈕） */
export function isVoiceSupported() {
  return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

/**
 * 建立 hold-to-talk 錄音器。
 * 用法：
 *   const rec = createRecorder();
 *   await rec.start();      // pointerdown
 *   const clip = rec.stop(); // pointerup → { base64, mimeType } | null
 */
export function createRecorder() {
  let mediaRecorder = null;
  let chunks = [];
  let timer = null;

  return {
    async start() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType =
        ['audio/webm;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';

      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunks = [];
      mediaRecorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
      mediaRecorder.start();

      // 30 秒上限：防止忘記放開、控制上傳大小
      timer = setTimeout(() => mediaRecorder.state === 'recording' && mediaRecorder.stop(), MAX_MS);
    },

    /** @returns {{base64, mimeType}|null} 失敗（太短/瀏覽器不支援）回 null */
    async stop() {
      clearTimeout(timer);
      if (!mediaRecorder) return null;

      const stream = mediaRecorder.stream;
      const done = new Promise((resolve) => {
        mediaRecorder.onstop = () => resolve(new Blob(chunks, { type: mediaRecorder.mimeType }));
        if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
        else resolve(new Blob(chunks));
      });
      const blob = await done;
      stream.getTracks().forEach((t) => t.stop()); // 釋放麥克風

      if (blob.size < 1200) return null; // 太短（<0.1s）視為誤觸
      return { base64: await blobToBase64(blob), mimeType: blob.type || 'audio/webm' };
    },
  };
}

/** Blob → base64（不帶 data: 前綴，server 只收裸 base64） */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
