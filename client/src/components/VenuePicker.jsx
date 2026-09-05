/**
 * ============================================================================
 * VenuePicker.jsx —— 場域選擇（零打字為主、搜尋為後備）
 * ============================================================================
 * 全台有 500+ 個地下場域，硬列不可行，所以由 server 的 OSM 圖資動態收斂：
 *
 *   主路徑：粗略 GPS（±300~500m 就夠）→ /api/venues/nearby → 3~8 個點選目標
 *   降級一：拿不到定位 → 用**下樓前的最後定位**收斂（並誠實標示）
 *   降級二：連那個也沒有 → 列出**最近去過的場域**
 *   後備：  以上皆空時才只剩搜尋框
 *
 * 【為什麼要有兩層降級】
 * 舊版只有「有 GPS」與「搜尋框」兩種狀態。而拿不到 GPS 正是**這個專案的
 * 核心情境**——結果最可能發生的狀況，剛好是唯一需要打字的狀況，
 * 直接違反「零打字：打字永不是必要條件」這條硬性約束。實測（停用定位權限）
 * 看到的是一個搜尋框加一片空白，那在恐慌中是不可用的。
 *
 * 兩層降級都不需要新資料：GPS 不是憑空消失的，你三分鐘前在地面出入口還收得到；
 * 而通勤族每天進出的就是那兩三站。
 *
 * 這個元件也是**定位授權的詢問時機**：畫面上正寫著「附近的場域」，
 * 此時要求定位權限的理由是自明的。一開 App 就跳權限的話，使用者還不知道
 * 這是什麼就會拒絕，而拒絕之後整個 session 的定位都沒了。
 */

import { useEffect, useState } from 'react';
import { fetchNearbyVenues, searchVenues } from '../modules/api.js';
import { lastKnownFix, recentVenues } from '../modules/location.js';
import Pictogram from './Pictogram.jsx';



export default function VenuePicker({ fix, requestFix, onPicked, onCancel }) {
  // 'locating' 與 'nosignal' 必須分開：兩者都沒有清單，但對使用者的意義完全不同。
  // 舊版一律先顯示「沒有定位訊號」，等 GPS 回來才跳出清單——
  // 使用者看到的是「壞掉了 → 又好了」。
  // stale = 用下樓前的最後定位；recent = 連那個都沒有，只剩最近去過的場域
  const [phase, setPhase] = useState('locating'); // locating | ready | stale | recent | nosignal
  const [nearby, setNearby] = useState([]);
  const [staleFix, setStaleFix] = useState(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      // 父層已經有定位就直接用；沒有才在此刻要（理由自明的時機）
      const f = fix ?? (await requestFix());
      if (!alive) return;

      // 現場拿不到 → 退到下樓前的最後定位。走下樓梯不會讓你跑到別的城市，
      // 所以那筆座標對「你在哪一站」依然有效。
      const stale = f ? null : lastKnownFix();
      const use = f ?? stale;

      if (!use) {
        // 連最後定位都沒有：至少給最近去過的場域，仍然是點選而非打字
        const recent = recentVenues();
        setNearby(recent.map((v) => ({ ...v, kind: null, exitsAvailable: true, exitCount: null })));
        setPhase(recent.length > 0 ? 'recent' : 'nosignal');
        return;
      }

      const list = await fetchNearbyVenues(use.lat, use.lon);
      if (!alive) return;
      if (list.length === 0) {
        const recent = recentVenues();
        setNearby(recent.map((v) => ({ ...v, kind: null, exitsAvailable: true, exitCount: null })));
        setPhase(recent.length > 0 ? 'recent' : 'nosignal');
        return;
      }
      setNearby(list);
      setStaleFix(stale);
      setPhase(stale ? 'stale' : 'ready');
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
          <div className="notice">正在取得概略位置，用來列出附近的場域…</div>
        )}
        {!searchMode && phase === 'ready' && (
          <p className="muted">附近的場域——點一下即可，不必打字</p>
        )}
        {/* 誠實標示這份清單是**舊定位**推出來的：使用者有權知道它可能已經不對，
            但那仍遠好過一個空白的搜尋框。 */}
        {!searchMode && phase === 'stale' && (
          <div className="notice">
            這裡收不到定位（地下的常態）。以下依你<b>約 {staleFix?.ageMin} 分鐘前</b>
            在地面的位置列出——不對的話請用下方搜尋。
          </div>
        )}
        {!searchMode && phase === 'recent' && (
          <div className="notice">
            這裡收不到定位。以下是你<b>最近去過的場域</b>——不在其中請用下方搜尋。
          </div>
        )}
        {!searchMode && phase === 'nosignal' && (
          <div className="notice notice-warn">
            這裡收不到定位（地下的常態）。請用下方搜尋找到你所在的場域。
          </div>
        )}

        <div style={{ marginTop: 12 }}>
          {list.map((v) => (
            <button key={v.id} className="venue-btn" onClick={() => onPicked(v.id, v.name)}>
              <Pictogram name={v.kind ?? 'pin'} size={22} className="venue-kind" />
              <span className="venue-body">
                <span className="venue-name">{v.name}</span>
                <span className="venue-meta">
                  {v.exitCount == null
                    ? '最近去過'
                    : v.exitsAvailable ? `${v.exitCount} 個出口` : '無出口圖資'}
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
