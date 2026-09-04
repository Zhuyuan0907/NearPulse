/**
 * ============================================================================
 * StationPicker.jsx —— L3 手選定位：路網圖點選（兩層樹狀）
 * ============================================================================
 * 設計原則的落實：
 *   - 零打字：點路線 → 點站，兩次點擊完成最終仲裁
 *   - 路線按官方順序（路網圖的共同記憶），不做個人化排序
 *   - 觸控目標大（≥56px）、單手可完成
 */

import { useState } from 'react';
import { LINES } from '../data/stations.js';

export default function StationPicker({ onPicked, onCancel }) {
  const [lineId, setLineId] = useState(null);
  const line = LINES.find((l) => l.id === lineId);

  return (
    <div className="picker">
      <h3>您在哪個車站？</h3>

      {/* 第一層：路線 */}
      <div className="picker-lines">
        {LINES.map((l) => (
          <button
            key={l.id}
            className={`chip ${lineId === l.id ? 'chip-active' : ''}`}
            style={{ borderColor: lineId === l.id ? l.color : undefined }}
            onClick={() => setLineId(l.id)}
          >
            {l.name}
          </button>
        ))}
      </div>

      {/* 第二層：站點（路網圖順序） */}
      {line && (
        <div className="picker-stations">
          {line.stations.map((s) => (
            <button
              key={s.id}
              className="station-btn"
              onClick={() => onPicked(s.id)}
            >
              <span className="station-id">{s.id}</span> {s.name}
            </button>
          ))}
        </div>
      )}

      <button className="ghost-btn" onClick={onCancel}>取消</button>
    </div>
  );
}
