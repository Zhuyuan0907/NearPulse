/**
 * ============================================================================
 * PhotoRoiPicker.jsx —— 照片九宮格：標出「看得到這是哪裡」的那一格
 * ============================================================================
 * 照片裡大部分是牆面、地板、人群，沒有定位資訊。真正有用的是站名牌、
 * 出口編號牌、逃生燈箱、店家招牌——通常只佔畫面一小塊。
 *
 * 標出那一格之後，系統會**從原圖裁那一格**再送去辨識。整張 1024px 圖在
 * detail:low 會被降到 512px，出口牌上的字只剩 20~40px 高；裁切後同一塊牌子
 * 可達 120px 以上。所以這個九宮格不只是標註，它是讓辨識真的讀得到字的前提。
 *
 * 互動優先序（零打字）：
 *   使用者點選為主 —— 即時、不必等網路
 *   AI 建議為輔   —— 背景跑完後預先高亮，使用者可直接採用或改點別格
 *
 * ⚠️ 這裡的 A1~C3 是**影像座標**，只描述「在照片的哪個位置」。
 *    它不是場域平面座標，也永遠不參與疏散方向計算——
 *    場域位置一律由讀到的字經 venueService 查表得出。
 */

const CELLS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3', 'C1', 'C2', 'C3'];

export default function PhotoRoiPicker({ previewUrl, cell, suggested, busy, onPick }) {
  return (
    <div className="roi-picker">
      <p className="muted">
        照片裡哪一格看得到<b>站名或出口編號</b>？（點一下，讓辨識放大那一塊）
      </p>

      <div className="roi-frame">
        {previewUrl && <img className="roi-photo" src={previewUrl} alt="剛拍的照片" />}
        <div className="roi-grid">
          {CELLS.map((c) => {
            const isPicked = cell === c;
            const isSuggested = !cell && suggested === c;
            return (
              <button
                key={c}
                type="button"
                className={`roi-cell${isPicked ? ' roi-picked' : ''}${isSuggested ? ' roi-suggested' : ''}`}
                onClick={() => onPick(isPicked ? null : c)}
                aria-label={`第 ${c} 格${isSuggested ? '（AI 建議）' : ''}`}
              >
                {isPicked ? '✓' : isSuggested ? '★' : ''}
              </button>
            );
          })}
        </div>
      </div>

      {busy && <p className="muted">辨識中…</p>}
      {!busy && suggested && !cell && (
        <p className="muted">★ 是 AI 建議的位置——直接點它，或自己選一格。</p>
      )}
    </div>
  );
}
