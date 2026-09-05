/**
 * ============================================================================
 * main.jsx —— 進入點與 Service Worker 註冊
 * ============================================================================
 * 註冊 SW 的理由不是「PWA 該有」，而是這個產品的前提：
 * 地下網路很差甚至沒有。沒有 SW 的話，App 在最需要它的時候打不開。
 *
 * 註冊放在 load 之後：SW 的安裝會抓取資源，不該和首屏渲染搶頻寬——
 * 恐慌情境下先讓畫面出來比先把快取建好重要。
 */

import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 註冊失敗（不支援、非 HTTPS、被使用者停用）不影響任何功能，
      // 只是失去離線能力——不該讓它擋住 App 啟動
    });
  });

  // 恢復連線時主動要求補送積壓的回報。
  // Background Sync 只有 Chromium 有，這條路徑是所有瀏覽器共通的後備。
  window.addEventListener('online', () => {
    navigator.serviceWorker.ready
      .then((reg) => reg.active?.postMessage({ type: 'flush' }))
      .catch(() => {});
  });
}
