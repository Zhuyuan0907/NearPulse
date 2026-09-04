/**
 * ============================================================================
 * STT advisor（語音轉文字）—— stub 實作
 * ============================================================================
 * 架構原則：「LLM 不站在生命安全資訊的關鍵路徑上」。
 * stub 失敗或未接真實 API 時，系統照常運作——語音只是補充層，不擋回報。
 */

/**
 * STT：語音 → 結構化補充描述
 * @param {string} audioBase64 - 客戶端 MediaRecorder 錄製的音檔（base64）
 * @param {string} mimeType    - 如 'audio/webm' 或 'audio/mp4'（iOS）
 * @returns {Promise<{text: string, confidence: number, pending: boolean}>}
 *          pending=true 表示尚未接入真實 STT，萃取結果不可用。
 */
export async function transcribeAudio(audioBase64, mimeType) {
  // TODO: 接 OpenAI Whisper API（或自架 whisper.cpp）
  //   POST /v1/audio/transcriptions，語言設 zh，回傳 text。
  // 注意：噪音環境（列車進站、警報器）預期只能降級萃取片段，
  // 呼叫端必須容忍空結果——語音附屬於回報，不作為獨立事件來源。
  return { text: '', confidence: 0, pending: true, receivedBytes: audioBase64?.length ?? 0, mimeType };
}
