import { spawn } from 'node:child_process';
import { createServer } from 'vite';

const vite = await createServer({
  server: { port: 5174 },
});

await vite.listen();
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
