/**
 * ============================================================================
 * Vision advisor（照片驗證）—— stub 實作
 * ============================================================================
 * 職責：驗證照片與回報類型的相符性、萃取場景特徵標籤（煙、人群、設備…）。
 * 同 STT 原則：萃取失敗不影響回報成立，照片以附件形式保存於事件時間線。
 */

/**
 * @param {string} photoBase64 - 客戶端 canvas 壓縮後的 JPEG（<200KB，base64）
 * @returns {Promise<{verified: boolean, pending: boolean, tags: string[]}>}
 *          v0.1 一律回 pending（未驗證），等真實 Vision 接入後開始計分。
 */
export async function verifyPhoto(photoBase64) {
  // TODO: 接 GPT-4o-mini Vision——
  //   1. 驗證照片場景是否與 type 相符（防亂拍）
  //   2. 萃取標籤；抽不到就空標籤，不擋流程
  return { verified: false, pending: true, tags: [], receivedBytes: photoBase64?.length ?? 0 };
}
