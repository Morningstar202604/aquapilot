import { spawn } from 'node:child_process';
import { createServer } from 'vite';

// 显式指定 configFile，并固定 host 为 127.0.0.1：
// 只写 server.port 时 Vite 会与配置文件里的 server 字段合并，
// 在部分环境下 listen 后会绑定到 IPv6 通配或延迟，导致 5174 实际不可访问。
const vite = await createServer({
  configFile: 'vite.config.ts',
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
});

await vite.listen();
const info = vite.httpServer?.address();
console.log(`[dev] Vite listening on`, info);
vite.printUrls();

const server = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
  stdio: 'inherit',
  env: { ...process.env, PORT: '5173' },
  shell: false,
});

process.on('SIGINT', () => {
  server.kill();
  void vite.close();
  process.exit(0);
});

server.on('exit', (code) => {
  void vite.close();
  process.exit(code ?? 0);
});
