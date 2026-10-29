import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 手工分包。
 *
 * 实测未分包时单文件 906 kB / gzip 294 kB，其中 ECharts 占一半以上，
 * 但首屏只需要「工艺画布 + 关键指标」，趋势图要滚动到下方才出现。
 * 分包后 ECharts 变成可缓存的独立 chunk：升级业务代码时浏览器不必
 * 重新下载图表库，首屏 JS 也明显变小。
 */
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('echarts') || id.includes('zrender')) return 'vendor-echarts';
  if (id.includes('react') || id.includes('scheduler')) return 'vendor-react';
  return 'vendor';
}

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
    rollupOptions: {
      output: { manualChunks },
    },
  },
});
