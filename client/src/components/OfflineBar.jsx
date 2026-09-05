/**
 * ============================================================================
 * OfflineBar.jsx —— 連線狀態與待送出回報
 * ============================================================================
 * 離線在這個 App 裡是常態而非錯誤，所以這條列的語氣是「告知」不是「警告」：
 * 重點在讓使用者知道「你的通報沒有消失」與「你看到的資訊有多舊」。
 * 完全正常時不顯示任何東西——不佔用恐慌情境下的注意力。
 */

import { useEffect, useState } from 'react';
import { subscribeOffline } from '../modules/offline.js';

export default function OfflineBar() {
  const [s, setS] = useState({ online: true, queued: 0, cardStale: false });
  useEffect(() => subscribeOffline(setS), []);

  if (s.online && s.queued === 0 && !s.cardStale) return null;

  return (
    <div className="offline-bar">
      {!s.online && <span>📴 目前離線——App 與疏散資訊仍可使用</span>}
      {s.queued > 0 && <span>📮 {s.queued} 筆通報已保存，恢復連線後自動送出</span>}
      {s.online && s.cardStale && <span>🕓 顯示的是上次取得的站況</span>}
    </div>
  );
}
