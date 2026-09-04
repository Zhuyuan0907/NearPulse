/**
 * ============================================================================
 * VenueMap.jsx —— 真實 OpenStreetMap 地圖：確認事件位置
 * ============================================================================
 * 三種指定事件位置的方式，愈上面愈精確：
 *   1. 點出口圖釘 —— 視覺辨識讀到出口編號時會自動高亮，確認一下即可
 *   2. 點地圖任一處 —— 事件不在出口旁（月台中段、通道中間）時用
 *   3. GPS 定位 —— 訊號夠好時（地面層、出入口附近）一鍵採用
 *
 * 為什麼底圖用 CARTO 而非 tile.openstreetmap.org：
 * OSM 官方圖磚的使用政策明文不供應用程式正式流量使用。CARTO 的底圖同樣是
 * OpenStreetMap 資料（姓名標示照給），且深色版與本專案的深色 UI 一致，
 * 在地下昏暗環境也較不刺眼。要換回官方圖磚只需改 TILE 常數。
 *
 * 頻寬：圖磚只在使用者真的展開地圖時才載入，且縮放層級鎖在站體尺度，
 * 一次視野約 4~6 張圖磚。讀取端態勢卡完全不載入本元件。
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const TILE = {
  url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  attribution: '© OpenStreetMap contributors © CARTO',
  maxZoom: 20,
};

/** 出口圖釘：直接把編號寫在釘子上，不必點開才知道是幾號出口 */
function exitIcon(code, selected) {
  return L.divIcon({
    className: '',
    html: `<div class="map-exit${selected ? ' map-exit-on' : ''}">${code}</div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

const incidentIcon = L.divIcon({
  className: '',
  html: '<div class="map-incident">✕</div>',
  iconSize: [30, 30],
  iconAnchor: [15, 15],
});

export default function VenueMap({
  venue,
  selectedCode,
  incidentPoint,
  userFix,
  onSelectExit,
  onPickPoint,
}) {
  const hostRef = useRef(null);
  const mapRef = useRef(null);
  const layersRef = useRef({ exits: [], incident: null, user: null, accuracy: null });
  // onPickPoint 放進 ref，避免每次 render 都要重綁地圖事件
  const pickRef = useRef(onPickPoint);
  pickRef.current = onPickPoint;

  // ---- 建立地圖（只做一次） ----
  useEffect(() => {
    if (!hostRef.current || mapRef.current) return;
    const map = L.map(hostRef.current, {
      zoomControl: true,
      attributionControl: true,
      // 恐慌情境下雙指縮放不好操作，保留捲動縮放
      scrollWheelZoom: true,
    });
    L.tileLayer(TILE.url, { attribution: TILE.attribution, maxZoom: TILE.maxZoom }).addTo(map);
    map.on('click', (e) => pickRef.current?.({ lat: e.latlng.lat, lon: e.latlng.lng }));
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // ---- 場域換了：重畫出口、重新框定視野 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !venue) return;

    layersRef.current.exits.forEach((m) => m.remove());
    layersRef.current.exits = [];

    for (const e of venue.exits ?? []) {
      const marker = L.marker([e.lat, e.lon], {
        icon: exitIcon(e.code, e.code === selectedCode),
        keyboard: false,
      })
        .addTo(map)
        .bindTooltip(e.landmark ? `${e.code} 出口（${e.landmark}）` : `${e.code} 出口`)
        .on('click', (ev) => {
          L.DomEvent.stopPropagation(ev); // 別讓點擊穿透成「在地圖上選點」
          onSelectExit(e.code === selectedCode ? null : e.code);
        });
      layersRef.current.exits.push(marker);
    }

    const pts = (venue.exits ?? []).map((e) => [e.lat, e.lon]);
    if (pts.length > 1) map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 18 });
    else map.setView([venue.lat ?? pts[0]?.[0], venue.lon ?? pts[0]?.[1]], 17);
    // selectedCode 變動時只需換圖示，由下一個 effect 處理
  }, [venue]);

  // ---- 選取狀態變動：只換圖示，不動視野 ----
  useEffect(() => {
    (venue?.exits ?? []).forEach((e, i) => {
      layersRef.current.exits[i]?.setIcon(exitIcon(e.code, e.code === selectedCode));
    });
  }, [selectedCode, venue]);

  // ---- 自由選點的標記 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.incident?.remove();
    layersRef.current.incident = null;
    if (incidentPoint) {
      layersRef.current.incident = L.marker([incidentPoint.lat, incidentPoint.lon], {
        icon: incidentIcon,
      })
        .addTo(map)
        .bindTooltip('事件位置');
    }
  }, [incidentPoint]);

  // ---- GPS 位置與誤差圈 ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.user?.remove();
    layersRef.current.accuracy?.remove();
    layersRef.current.user = null;
    layersRef.current.accuracy = null;
    if (!userFix) return;

    layersRef.current.accuracy = L.circle([userFix.lat, userFix.lon], {
      radius: userFix.accuracy,
      className: 'map-accuracy',
    }).addTo(map);
    layersRef.current.user = L.circleMarker([userFix.lat, userFix.lon], {
      radius: 6,
      className: 'map-user',
    })
      .addTo(map)
      .bindTooltip(`你的位置（誤差約 ${Math.round(userFix.accuracy)}m）`);
  }, [userFix]);

  if (!venue) return null;

  return (
    <div className="venue-map">
      <div ref={hostRef} className="venue-map-canvas" />
      {!venue.exitsAvailable && (
        <p className="muted">
          OSM 沒有這個場域的出口圖資——請直接在地圖上點出事件位置。
        </p>
      )}
    </div>
  );
}
