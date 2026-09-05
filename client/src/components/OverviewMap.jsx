/**
 * ============================================================================
 * OverviewMap.jsx —— 目前狀況的總覽地圖
 * ============================================================================
 * 【它回答的問題跟事件地圖不同】
 * IncidentMap 回答「我該往哪個出口走」——那是已經知道自己牽涉其中的人在看的。
 * 這張圖回答的是更前面的問題：**「哪邊有事？跟我有沒有關係？」**
 * 一個剛打開 App 的人需要先看到分布，才知道要不要往下讀。
 *
 * 條列式清單答不了這個問題：十個地名排成一列，看得出有十件事，
 * 看不出它們是集中在一站還是散在半個城市——而那個差別決定了要不要跑。
 *
 * 【設計取捨】
 * - 可拖曳、可縮放。這張圖是用來**探索**的，跟 IncidentMap 那張唯讀的不同
 * - 標記大小與顏色依警戒等級。一個地方有五件小事，不該看起來比另一個地方
 *   的一件火警嚴重（等級由 server 算好，見 situationCardService）
 * - 點標記會捲到對應的區塊——地圖是索引，不是替代品，文字仍然是主體
 * - 沒有座標的事件不畫。地圖上少一個點，好過標錯位置
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const TILE = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
};

/**
 * 警戒等級 → 呈現。
 *
 * 【為什麼不是圖釘】
 * 實心圖釘畫的是「一個點」，但事件影響的是**一片範圍**——而範圍正是
 * 讀圖的人要判斷的東西（跟我有多近、要不要繞開）。半透明的圓能同時
 * 表達位置與範圍，疊在圖磚上也不會把街廓遮掉。
 *
 * 半徑不是實測的影響範圍（那需要現場的樓層、通風與煙流資料，我們沒有），
 * 而是**警戒等級的視覺編碼**——高警戒的圓比較大，因為要繞得比較開。
 * 說明文字必須照這個意思寫，不能寫成「影響範圍 300 公尺」。
 */
const LEVEL = {
  high:       { radius: 260, color: '#c8102e', fill: 0.20, weight: 2 },
  medium:     { radius: 190, color: '#f2a900', fill: 0.18, weight: 2 },
  low:        { radius: 140, color: '#8a9298', fill: 0.14, weight: 1.5 },
  unverified: { radius: 140, color: '#f2a900', fill: 0.07, weight: 1.5 },
};

/** 事件數標籤。**不畫圖釘**，只放一個小標籤，讓圓本身是主角 */
function countLabel(group) {
  const n = group.events.length;
  const level = LEVEL[group.threatLevel] ?? LEVEL.unverified;
  return L.divIcon({
    className: '',
    html: `<div class="ov-label" style="--ov-c:${level.color}">`
      + `${group.stationName}${n > 1 ? ` ×${n}` : ''}</div>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

export default function OverviewMap({ groups, userFix, onPick }) {
  const hostRef = useRef(null);
  const mapRef = useRef(null);
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    if (!hostRef.current) return undefined;

    const points = groups
      .filter((g) => Number.isFinite(g.lat) && Number.isFinite(g.lon))
      .map((g) => ({ g, latlng: [g.lat, g.lon] }));

    if (points.length === 0) return undefined;

    const map = L.map(hostRef.current, { zoomControl: false, attributionControl: true });
    mapRef.current = map;
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.tileLayer(TILE.url, { attribution: TILE.attribution, maxZoom: TILE.maxZoom }).addTo(map);

    for (const { g, latlng } of points) {
      const level = LEVEL[g.threatLevel] ?? LEVEL.unverified;
      const circle = L.circle(latlng, {
        radius: level.radius,
        color: level.color,
        weight: level.weight,
        fillColor: level.color,
        fillOpacity: level.fill,
        // 未經確認用虛線邊：語氣的差別不能只靠透明度
        dashArray: g.threatLevel === 'unverified' ? '5 5' : null,
      }).addTo(map);
      circle.on('click', () => pickRef.current?.(g));

      // 圓心放一個小點，避免大範圍時看不出確切位置
      L.circleMarker(latlng, {
        radius: 4, color: '#fff', weight: 2, fillColor: level.color, fillOpacity: 1,
      }).addTo(map).on('click', () => pickRef.current?.(g));

      L.marker(latlng, { icon: countLabel(g), interactive: false }).addTo(map);
    }

    // 使用者位置：只有在真的拿得到時才畫。地下拿不到是常態，不是錯誤
    const all = points.map((p) => p.latlng);
    if (userFix) {
      L.circleMarker([userFix.lat, userFix.lon], {
        radius: 6, className: 'ov-user', interactive: false,
      }).addTo(map);
      all.push([userFix.lat, userFix.lon]);
    }

    /**
     * 視野依事件分布自動縮放。
     *
     * 上限 16 是因為再放大就只剩單一路口，看不出「事件之間的相對關係」——
     * 而那正是這張圖要回答的。單一事件時放寬到 16（那時候沒有相對關係要看，
     * 使用者要的是「這附近長什麼樣」）。
     */
    map.fitBounds(L.latLngBounds(all).pad(0.3), { maxZoom: points.length === 1 ? 16 : 15 });

    return () => { map.remove(); mapRef.current = null; };
  }, [groups, userFix]);

  const plottable = groups.filter((g) => Number.isFinite(g.lat)).length;
  if (plottable === 0) return null;

  return (
    <div className="overview-map">
      <div ref={hostRef} className="overview-map-canvas" />
      <p className="overview-map-note">
        圓的大小代表<b>警戒等級</b>，不是實測的影響範圍。
        {plottable < groups.length && `　另有 ${groups.length - plottable} 件沒有座標，只列在下方。`}
      </p>
    </div>
  );
}
