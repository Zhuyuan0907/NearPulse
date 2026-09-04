/**
 * ============================================================================
 * VenueMap.jsx —— 場域示意圖：確認「我在哪個出口」
 * ============================================================================
 * 刻意不用真實圖磚地圖。一個圖磚視野 4~9 張、100~400KB，是整張態勢卡預算
 * （50KB）的 8 倍，在壅塞的地下網路上違反本專案的核心原則；OSM 官方圖磚
 * 也有使用政策限制。而對「確認我在哪個出口」這個用途，街道幾何不增加資訊。
 *
 * 改由 server 回傳正規化後的示意幾何（出口投影到 0~1，主軸已對齊），
 * 這裡畫成幾 KB 的 SVG。client 不持有任何圖資、不做幾何運算。
 *
 * 用途有二：
 *   1. 確認 —— 辨識出的出口高亮，使用者一眼看出對不對
 *   2. 更正 —— 認錯了就點別的出口；出口編號歧義時也在這裡化解
 */

const PAD = 0.1; // 邊界留白，避免出口點被畫到框線上

export default function VenueMap({ venue, selectedCode, onSelect }) {
  if (!venue) return null;

  if (!venue.exitsAvailable || venue.exits.length === 0) {
    return (
      <p className="muted">
        {venue.name}：OSM 沒有這個場域的出口圖資，只能記錄到場域層級。
      </p>
    );
  }

  // 0~1 正規化座標 → SVG viewBox 座標
  const px = (v) => (PAD + v * (1 - PAD * 2)) * 100;

  return (
    <div className="venue-map">
      <p className="muted">
        {venue.name} · {venue.exits.length} 個出口
        {venue.spanM?.along > 0 && ` · 約 ${venue.spanM.along}m`}
        {selectedCode ? ` · 已選 ${selectedCode}` : ' —— 點一下確認你在哪個出口附近'}
      </p>

      <svg className="venue-map-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
        {/* 場域範圍示意（不是真實輪廓，只是給出口一個參考框） */}
        <rect x={px(0)} y={px(0)} width={px(1) - px(0)} height={px(1) - px(0)}
              className="venue-map-bounds" rx="3" />

        {venue.exits.map((e) => {
          const on = e.code === selectedCode;
          return (
            <g key={e.code} className={`venue-exit${on ? ' venue-exit-on' : ''}`}
               onClick={() => onSelect(on ? null : e.code)}>
              <title>{e.landmark ? `${e.code}（${e.landmark}）` : e.code}</title>
              {/* 放大的透明點擊區——手指比圓點大得多 */}
              <circle cx={px(e.x)} cy={px(e.y)} r="7" className="venue-exit-hit" />
              <circle cx={px(e.x)} cy={px(e.y)} r={on ? 4 : 2.6} className="venue-exit-dot" />
              <text x={px(e.x)} y={px(e.y) - 5.5} className="venue-exit-label">{e.code}</text>
            </g>
          );
        })}
      </svg>

      {selectedCode && (
        <p className="ok-note">
          {(() => {
            const e = venue.exits.find((x) => x.code === selectedCode);
            return e?.landmark ? `${e.code} 出口（${e.landmark}）` : `${selectedCode} 出口`;
          })()}
        </p>
      )}
      <p className="attribution">{venue.attribution}</p>
    </div>
  );
}
