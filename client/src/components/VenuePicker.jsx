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
 * 這個元件也是**定位授權的詢問時機**：畫面上正寫著「附近的場域」，
 * 此時要求定位權限的理由是自明的。一開 App 就跳權限的話，使用者還不知道
 * 這是什麼就會拒絕，而拒絕之後整個 session 的定位都沒了。
 */

import { useEffect, useState } from 'react';
import { fetchNearbyVenues, searchVenues } from '../modules/api.js';

const KIND_ICON = { metro: '🚇', underground: '🏬', parking: '🅿️' };

export default function VenuePicker({ fix, requestFix, onPicked, onCancel }) {
  // 'locating' 與 'nosignal' 必須分開：兩者都沒有清單，但對使用者的意義完全不同。
  // 舊版一律先顯示「沒有定位訊號」，等 GPS 回來才跳出清單——
  // 使用者看到的是「壞掉了 → 又好了」。
  const [phase, setPhase] = useState('locating'); // locating | ready | nosignal
  const [nearby, setNearby] = useState([]);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 父層已經有定位就直接用；沒有才在此刻要（理由自明的時機）
      const f = fix ?? (await requestFix());
      if (!alive) return;
      if (!f) { setPhase('nosignal'); return; }
      const list = await fetchNearbyVenues(f.lat, f.lon);
      if (!alive) return;
      setNearby(list);
      setPhase(list.length > 0 ? 'ready' : 'nosignal');
    })();
    return () => { alive = false; };
    // fix/requestFix 在父層是穩定的，這裡只需要在開啟時跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const list = searchMode ? results : nearby;

  return (
    <div className="sheet">
      <header className="sheet-head">
        <h3>你在哪個地下場域？</h3>
        <button className="chip" onClick={onCancel}>取消</button>
      </header>

      <div className="sheet-body">
        {!searchMode && phase === 'locating' && (
          <div className="notice">📡 正在取得概略位置，用來列出附近的場域…</div>
        )}
        {!searchMode && phase === 'ready' && (
          <p className="muted">附近的場域——點一下即可，不必打字</p>
        )}
        {!searchMode && phase === 'nosignal' && (
          <div className="notice notice-warn">
            這裡收不到定位（地下的常態）。請用下方搜尋找到你所在的場域。
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
