/**
 * ============================================================================
 * IncidentMap.jsx —— 態勢卡上的事件地圖（唯讀）
 * ============================================================================
 * 和 VenueMap 的差別：那個是**選位置**用的互動地圖（回報端），這個是
 * **看懂狀況**用的唯讀地圖（讀取端）。兩者的取捨完全不同，所以不共用元件。
 *
 * 【為什麼是點開才載入】
 * 態勢卡的設計前提是「弱網優先」：整張卡壓在 50KB 以內，讀取端在最差的
 * 網路下也要開得起來。一個地圖視野是 4~9 張圖磚、100~400KB，加上 leaflet
 * 本身約 150KB——直接內建會讓這頁在最需要它的時候打不開。
 *
 * 所以：預設收合，使用者點「展開地圖」才用 React.lazy 動態載入，
 * leaflet 不進主 bundle。文字敘述在任何情況下都先到、且獨立可用——
 * 地圖是**補充**，不是替代。
 *
 * 【圓圈代表什麼，以及它不代表什麼】
 * 圓圈畫的是「系統建議避開的範圍」——半徑內的出口不會被列為去處。
 * 它**不是**對煙霧、火勢或攻擊者實際影響範圍的宣稱：那需要現場的
 * 樓層、通風與煙流資料，我們一樣都沒有。說明文字必須照這個意思寫，
 * 不能寫成「影響範圍」，那是我們給不出的保證。
 *
 * 同理，畫面上不顯示任何公尺數。地下通道的實際步行距離與地面直線距離
 * 可以差上兩三倍——地圖呈現相對關係，數字則會造成假精確。
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const TILE = {
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution: '© OpenStreetMap contributors',
  maxZoom: 19,
};

const incidentIcon = L.divIcon({
  className: '',
  html: '<div class="map-incident">✕</div>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

/** 去處與避開用不同的圖釘。**不只靠顏色**——形狀與符號也不同，色盲可辨。 */
function exitIcon(code, mode) {
  return L.divIcon({
    className: '',
    html: `<div class="map-plan-exit map-plan-${mode}">`
      + `<span class="map-plan-mark">${mode === 'go' ? '↑' : '✕'}</span>`
      + `<span class="map-plan-code">${code}</span></div>`,
    iconSize: [46, 26],
    iconAnchor: [23, 13],
  });
}

export default function IncidentMap({ plan, incidentPoint }) {
  const hostRef = useRef(null);
  const mapRef = useRef(null);

  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;

    const origin = incidentPoint ?? plan?.origin;
    if (!origin) return;

    const map = L.map(hostRef.current, {
      zoomControl: false,
      attributionControl: true,
      // 唯讀：關掉所有會讓使用者「不小心把地圖滑走」的互動。
      // 這頁的人正在緊急狀況下單手操作，地圖跑掉是純粹的傷害。
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      keyboard: false,
    });
    mapRef.current = map;

    L.tileLayer(TILE.url, { attribution: TILE.attribution, maxZoom: TILE.maxZoom }).addTo(map);

    const points = [[origin.lat, origin.lon]];

    // 避開範圍圓（見檔頭說明：這是系統的篩選半徑，不是危害範圍宣稱）
    if (plan?.avoidRadiusM) {
      L.circle([origin.lat, origin.lon], {
        radius: plan.avoidRadiusM,
        color: '#ff6b6b',
        weight: 1.5,
        fillColor: '#ff6b6b',
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
    }

    L.marker([origin.lat, origin.lon], { icon: incidentIcon, interactive: false }).addTo(map);

    for (const [mode, list] of [['go', plan?.go ?? []], ['avoid', plan?.avoid ?? []]]) {
      for (const e of list) {
        if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
        L.marker([e.lat, e.lon], { icon: exitIcon(e.code, mode), interactive: false }).addTo(map);
        points.push([e.lat, e.lon]);
      }
    }

    // 視野涵蓋事件點與所有建議出口。上限 18 是因為再放大就只剩單一路口，
    // 反而看不出「往哪個方向離開」——那才是這張圖要回答的問題。
    map.fitBounds(L.latLngBounds(points).pad(0.35), { maxZoom: 18 });

    return () => { map.remove(); mapRef.current = null; };
  }, [plan, incidentPoint]);

  const origin = incidentPoint ?? plan?.origin;
  if (!origin) return null;

  return (
    <div className="incident-map">
      <div ref={hostRef} className="incident-map-canvas" />
      <p className="incident-map-note">
        ✕ 為回報的事件位置，紅圈是<b>系統建議避開的範圍</b>
        （不代表實際影響範圍）。地下通道的走法與地面路線不同，請以站內指標為準。
      </p>
    </div>
  );
}
