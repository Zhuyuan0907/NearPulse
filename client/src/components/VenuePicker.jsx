/**
 * ============================================================================
 * VenuePicker.jsx —— L3 場域選擇（零打字為主、搜尋為後備）
 * ============================================================================
 * 舊版是寫死的兩層樹（路線 → 站）。全台有 500+ 個地下場域，硬列不可行，
 * 所以改由 server 的 OSM 圖資動態收斂：
 *
 *   主路徑：粗略 GPS（±300~500m 就夠）→ /api/venues/nearby → 3~8 個點選目標
 *   後備：  沒有定位訊號時才顯示搜尋框
 *
 * 「零打字」的原則沒有放寬——打字仍然永遠不是必要條件，只是在
 * 完全沒有定位訊號時提供一條出路。
 */

import { useEffect, useState } from 'react';
import { fetchNearbyVenues, searchVenues } from '../modules/api.js';
import { coarseFix } from '../modules/location.js';

export default function VenuePicker({ onPicked, onCancel }) {
  const [nearby, setNearby] = useState(null); // null = 定位中
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  // 進場即嘗試定位；失敗不是錯誤，只是改走搜尋
  useEffect(() => {
    let alive = true;
    (async () => {
      const fix = await coarseFix();
      if (!alive) return;
      setNearby(fix ? await fetchNearbyVenues(fix.lat, fix.lon) : []);
    })();
    return () => { alive = false; };
  }, []);

  // 搜尋去抖：恐慌中連打不該每個字送一次請求
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      setResults(await searchVenues(q));
      setSearching(false);
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const list = query.trim() ? results : (nearby ?? []);

  return (
    <div className="picker">
      <h3>您在哪個地下場域？</h3>

      {nearby === null && <p className="muted">正在取得概略位置…</p>}
      {nearby !== null && nearby.length === 0 && !query.trim() && (
        <p className="muted">沒有定位訊號——請用下方搜尋，或直接輸入場域名稱。</p>
      )}
      {nearby !== null && nearby.length > 0 && !query.trim() && (
        <p className="muted">附近的場域（點選即可，不必打字）</p>
      )}

      <div className="picker-venues">
        {list.map((v) => (
          <button key={v.id} className="station-btn" onClick={() => onPicked(v.id, v.name)}>
            <span className="venue-name">{v.name}</span>
            <span className="venue-meta">
              {typeof v.distanceM === 'number' && `${v.distanceM} m · `}
              {v.exitsAvailable ? `${v.exitCount} 個出口` : '無出口圖資'}
            </span>
          </button>
        ))}
        {query.trim() && !searching && results.length === 0 && (
          <p className="muted">查無相符場域</p>
        )}
      </div>

      {/* 後備路徑：只有在沒有定位訊號、或使用者主動想找別的地方時才會用到 */}
      <input
        className="note-input venue-search"
        type="search"
        placeholder="找不到？輸入場域名稱搜尋"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <button className="ghost-btn" onClick={onCancel}>取消</button>
    </div>
  );
}
