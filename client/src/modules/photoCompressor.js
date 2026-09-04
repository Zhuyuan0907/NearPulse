/**
 * ============================================================================
 * photoCompressor.js —— 照片壓縮與九宮格裁切
 * ============================================================================
 * 「有網路不代表頻寬夠」：3G/壅塞環境必須在 client 端把原圖壓到極小。
 *
 * 兩個出口，用途不同：
 *
 *   compressPhoto(file)        整張照片，最長邊 1024px、WebP、量到 <50KB 為止
 *                              → 附在回報上，也給 Vision 的「定位」階段用
 *
 *   cropCell(file, cell)       九宮格裁切，**從原圖裁**再縮到 1024px
 *                              → 給 Vision 的「讀字」階段用
 *
 * 【為什麼裁切是整個機制的技術核心】
 * 整張 1024px 圖送進 detail:low 會被降到 512px，一塊佔畫面九分之一的出口牌
 * 只剩約 170px 寬，字高 20~40px——OCR 是臨界可讀。
 * 改從**原圖**裁那一格（4000px 的原圖 → 該格約 1333px）再縮到 1024px，
 * 同一塊牌子變成約 1024px 寬、字高 120px 以上，穩穩可讀。
 * 九宮格不只是標註，它是讓低成本 OCR 真的讀得到字的前提。
 *
 * 照片與裁切都是選配——任一步失敗都不影響回報成立。
 */

/** 目標大小 50KB。base64 會比原始位元組膨脹約 4/3，換算成字元數上限 */
const TARGET_BYTES = 50_000;
const TARGET_BASE64_LEN = Math.ceil((TARGET_BYTES * 4) / 3);

const QUALITY_LADDER = [0.6, 0.45, 0.35];
const FALLBACK_DIM = 800;

/** 裁切時往外多留一點邊，避免文字剛好卡在格線上被切斷 */
const CROP_MARGIN = 0.08;

/**
 * 解碼成 bitmap，並盡可能套用 EXIF 方向。
 * 手機直式拍攝若不轉正，送進 Vision 是躺著的——而柱號、站名、出口編號全是文字，
 * 旋轉 90° 對 OCR 是災難性的。`imageOrientation` 較新，不支援時退回預設解碼。
 */
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return await createImageBitmap(file);
  }
}

/** 把 bitmap 的指定矩形畫到 canvas（省略 rect 即整張），並縮到最長邊 maxDim */
function drawRegion(bitmap, maxDim, rect = null) {
  const sx = rect?.sx ?? 0;
  const sy = rect?.sy ?? 0;
  const sw = rect?.sw ?? bitmap.width;
  const sh = rect?.sh ?? bitmap.height;

  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/**
 * 以 WebP 編碼；瀏覽器不支援時 toDataURL 會靜默回退成 PNG（前綴可判別），
 * 此時改用 JPEG——PNG 對照片是最糟的選擇（無損、體積暴增）。
 */
function encode(canvas, quality) {
  const webp = canvas.toDataURL('image/webp', quality);
  if (webp.startsWith('data:image/webp')) {
    return { base64: webp.split(',')[1], mimeType: 'image/webp' };
  }
  const jpeg = canvas.toDataURL('image/jpeg', quality);
  return { base64: jpeg.split(',')[1], mimeType: 'image/jpeg' };
}

/** 逐級降品質直到達標；仍超標就縮尺寸再壓一次 */
function encodeUnderBudget(bitmap, maxDim, rect) {
  const canvas = drawRegion(bitmap, maxDim, rect);
  let best = null;
  for (const q of QUALITY_LADDER) {
    best = encode(canvas, q);
    if (best.base64.length <= TARGET_BASE64_LEN) return best;
  }
  // 品質已到底仍超標（極高細節場景）→ 縮小尺寸再來一次
  const smaller = encode(drawRegion(bitmap, FALLBACK_DIM, rect), QUALITY_LADDER.at(-1));
  // 即使仍略超標也照送——有圖永遠好過沒圖
  return smaller.base64.length < best.base64.length ? smaller : best;
}

/**
 * 整張照片壓縮。
 * @param {File} file - <input type="file" capture> 拿到的原圖
 * @returns {Promise<{base64, mimeType}|null>} 失敗回 null（回報照送，只是沒圖）
 */
export async function compressPhoto(file, { maxDim = 1024 } = {}) {
  try {
    const bitmap = await decode(file);
    const out = encodeUnderBudget(bitmap, maxDim, null);
    bitmap.close?.();
    return out;
  } catch {
    return null; // 解碼失敗（格式怪異/瀏覽器限制）→ 安靜放棄，不擋回報
  }
}

/** 'B3' → { row: 1, col: 2 }（0 起算）；非法值回 null */
export function cellToRC(cell) {
  const row = 'ABC'.indexOf(String(cell ?? '')[0]);
  const col = Number(String(cell ?? '')[1]) - 1;
  if (row < 0 || !Number.isInteger(col) || col < 0 || col > 2) return null;
  return { row, col };
}

/**
 * 裁出九宮格的其中一格——**從原圖裁**，把整個解析度預算花在有字的那一塊。
 * @param {File} file
 * @param {string} cell - 'A1'~'C3'
 * @returns {Promise<{base64, mimeType}|null>}
 */
export async function cropCell(file, cell, { maxDim = 1024 } = {}) {
  const rc = cellToRC(cell);
  if (!rc) return null;
  try {
    const bitmap = await decode(file);
    const cw = bitmap.width / 3;
    const ch = bitmap.height / 3;
    const mx = cw * CROP_MARGIN;
    const my = ch * CROP_MARGIN;

    // 外擴後夾回影像範圍內，避免邊角格子取到負座標
    const sx = Math.max(0, rc.col * cw - mx);
    const sy = Math.max(0, rc.row * ch - my);
    const sw = Math.min(bitmap.width - sx, cw + mx * 2);
    const sh = Math.min(bitmap.height - sy, ch + my * 2);

    const out = encodeUnderBudget(bitmap, maxDim, { sx, sy, sw, sh });
    bitmap.close?.();
    return out;
  } catch {
    return null; // 裁切失敗 → 呼叫端退回用整張圖，機制降級但不中斷
  }
}
