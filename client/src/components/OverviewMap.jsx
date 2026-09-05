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

/** 警戒等級 → 標記樣式。**大小也編碼嚴重度**，不只靠顏色（色盲可辨） */
const LEVEL = {
  high:       { cls: 'ov-high',   size: 34 },
  medium:     { cls: 'ov-medium', size: 30 },
  low:        { cls: 'ov-low',    size: 26 },
  unverified: { cls: 'ov-unverified', size: 26 },
};

function markerIcon(group) {
  const style = LEVEL[group.threatLevel] ?? LEVEL.unverified;
  const n = group.events.length;
  return L.divIcon({
    className: '',
    html: `<div class="ov-pin ${style.cls}">${n > 1 ? n : ''}</div>`,
    iconSize: [style.size, style.size],
    iconAnchor: [style.size / 2, style.size / 2],
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
      L.marker(latlng, { icon: markerIcon(g), title: g.stationName })
        .addTo(map)
        .on('click', () => pickRef.current?.(g));
    }

    // 使用者位置：只有在真的拿得到時才畫。地下拿不到是常態，不是錯誤
    const all = points.map((p) => p.latlng);
    if (userFix) {
      L.circleMarker([userFix.lat, userFix.lon], {
        radius: 6, className: 'ov-user', interactive: false,
      }).addTo(map);
      all.push([userFix.lat, userFix.lon]);
    }

    // 事件可能散在整個台灣（甚至含關西）——上限 15 才不會縮到看不出街廓
    map.fitBounds(L.latLngBounds(all).pad(0.25), { maxZoom: 15 });

    return () => { map.remove(); mapRef.current = null; };
  }, [groups, userFix]);

  const plottable = groups.filter((g) => Number.isFinite(g.lat)).length;
  if (plottable === 0) return null;

  return (
    <div className="overview-map">
      <div ref={hostRef} className="overview-map-canvas" />
      {plottable < groups.length && (
        <p className="overview-map-note">
          有 {groups.length - plottable} 件事件沒有座標，只列在下方。
        </p>
      )}
    </div>
  );
}
