/**
 * ============================================================================
 * Vite 設定
 * ============================================================================
 * dev 模式把 /api 代理到本地 server（:3000），
 * 客戶端程式碼 therefore 一律用相對路徑 `/api/...`，不需要 CORS 設定。
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
