/**
 * ============================================================================
 * photoCompressor.js —— 照片選配附件的客戶端壓縮
 * ============================================================================
 * 「有網路不代表頻寬夠」：地下基地台壅塞時上傳 5MB 原圖等於沒傳。
 * 目標：<200KB（長邊 1000px、JPEG q0.7），在 client 端 canvas 完成。
 * 照片是選配——壓縮失敗不影響回報成立。
 */

/**
 * @param {File} file - <input type="file" capture> 拿到的原圖
 * @returns {Promise<{base64}|null>} 失敗回 null（回報照送，只是沒圖）
 */
export async function compressPhoto(file, { maxDim = 1000, quality = 0.7 } = {}) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();

    // toDataURL 輸出 data:image/jpeg;base64,xxxx → 取逗號後的裸 base64
    const dataUrl = canvas.toDataURL('image/jpeg', quality);
    return { base64: dataUrl.split(',')[1] };
  } catch {
    return null; // 解碼失敗（格式怪異/瀏覽器限制）→ 安靜放棄，不擋回報
  }
}
