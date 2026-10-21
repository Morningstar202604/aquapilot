import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    // 开发模式下把 API 与 WebSocket 转发到仿真服务，
    // 否则客户端连的是 5174 上的 Vite（既无 API 也无 WS）
    proxy: {
      '/api': { target: 'http://127.0.0.1:5173', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:5173', ws: true },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1400,
  },
});
