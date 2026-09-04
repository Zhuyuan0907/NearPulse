/**
 * ============================================================================
 * App.jsx —— 極簡 hash 路由
 * ============================================================================
 * 三個入口（刻意不引入 react-router， walking skeleton 夠用）：
 *   #/          → 回報頁（恐慌 3 秒流程的主入口）
 *   #/situation → 態勢卡（讀取端，ETag 輪詢，刻意與回報端分頁共處但未來可拆獨立 bundle）
 *   #/confirm   → 兩段式確認頁（未來 Web Push 的 deep link 目標，?event=evt_xxx）
 */

import { useEffect, useState } from 'react';
import ReportPage from './pages/ReportPage.jsx';
import SituationPage from './pages/SituationPage.jsx';
import ConfirmPage from './pages/ConfirmPage.jsx';

/** 解析目前 hash → { path, params }（例：#/confirm?event=evt_1） */
function parseHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  return {
    path: path || '',
    params: new URLSearchParams(query),
  };
}

export default function App() {
  const [route, setRoute] = useState(parseHash);

  useEffect(() => {
    const onChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  switch (route.path) {
    case 'situation':
      return <SituationPage />;
    case 'confirm':
      return <ConfirmPage eventId={route.params.get('event')} />;
    default:
      return <ReportPage />;
  }
}
