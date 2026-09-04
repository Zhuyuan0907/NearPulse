/**
 * ============================================================================
 * VenuePicker.jsx —— 場域選擇（零打字為主、搜尋為後備）
 * ============================================================================
 * 全台有 500+ 個地下場域，硬列不可行，所以由 server 的 OSM 圖資動態收斂：
 *
 *   主路徑：粗略 GPS（±300~500m 就夠）→ /api/venues/nearby → 3~8 個點選目標
 *   後備：  沒有定位訊號時才顯示搜尋框
 *
 * 「零打字」的原則沒有放寬——打字仍然永遠不是必要條件，只是在完全沒有
 * 定位訊號時提供一條出路。
 *
 * 版面採全螢幕面板而非行內展開：恐慌中要選的是「我在哪」這件唯一的事，
 * 畫面上不該同時有別的東西競爭注意力。
 */

import { useEffect, useState } from 'react';
import { fetchNearbyVenues, searchVenues } from '../modules/api.js';

const KIND_ICON = { metro: '🚇', underground: '🏬', parking: '🅿️' };

export default function VenuePicker({ fix, onPicked, onCancel }) {
  const [nearby, setNearby] = useState(null); // null = 尚未有結果
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!fix) { setNearby([]); return; }
    fetchNearbyVenues(fix.lat, fix.lon).then((v) => alive && setNearby(v));
    return () => { alive = false; };
  }, [fix]);

  // 搜尋去抖：恐慌中連打不該每個字送一次請求
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      setResults(await searchVenues(q));
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const searchMode = Boolean(query.trim());
  const list = searchMode ? results : (nearby ?? []);

  return (
    <div className="sheet">
      <header className="sheet-head">
        <h3>你在哪個地下場域？</h3>
        <button className="chip" onClick={onCancel}>取消</button>
      </header>

      <div className="sheet-body">
        {!searchMode && nearby === null && <p className="muted">正在取得概略位置…</p>}
        {!searchMode && nearby?.length > 0 && (
          <p className="muted">附近的場域——點一下即可，不必打字</p>
        )}
        {!searchMode && nearby?.length === 0 && (
          <div className="notice notice-warn">
            沒有定位訊號（地下常態）。請用下方搜尋找到你所在的場域。
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          {list.map((v) => (
            <button key={v.id} className="venue-btn" onClick={() => onPicked(v.id, v.name)}>
              <span className="venue-kind">{KIND_ICON[v.kind] ?? '📍'}</span>
              <span className="venue-body">
                <span className="venue-name">{v.name}</span>
                <span className="venue-meta">
                  {v.exitsAvailable ? `${v.exitCount} 個出口` : '無出口圖資'}
                </span>
              </span>
              {typeof v.distanceM === 'number' && (
                <span className="venue-dist">{v.distanceM} m</span>
              )}
            </button>
          ))}
          {searchMode && !searching && results.length === 0 && (
            <p className="muted">查無相符場域</p>
          )}
        </div>

        {/* 後備路徑：只在沒有定位訊號、或想找別的地方時才會用到 */}
        <input
          className="note-input"
          style={{ minHeight: 52, marginTop: 16 }}
          type="search"
          placeholder="找不到？輸入場域名稱搜尋"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
    </div>
  );
}
