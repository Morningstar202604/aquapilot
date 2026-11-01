import { isIP } from 'node:net';

export interface ListenConfig {
  host: string;
  port: number;
}

function envNumber(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

export function isLoopbackHost(host: string): boolean {
  const value = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (value === 'localhost' || value === '::1') return true;
  if (isIP(value) === 4) {
    const first = Number(value.split('.')[0]);
    return first === 127;
  }
  return false;
}

export function hasConfiguredAccessToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.AQUAPILOT_TOKEN?.trim() || env.AQUAPILOT_OPERATOR_TOKEN?.trim() || env.AQUAPILOT_VIEWER_TOKEN?.trim(),
  );
}

export function resolveListenConfig(env: NodeJS.ProcessEnv = process.env): ListenConfig {
  const host = env.HOST?.trim() || '127.0.0.1';
  if (!isLoopbackHost(host) && !hasConfiguredAccessToken(env)) {
    throw new Error('非本机监听必须配置 AQUAPILOT_TOKEN、AQUAPILOT_OPERATOR_TOKEN 或 AQUAPILOT_VIEWER_TOKEN');
  }
  return { host, port: envNumber(env.PORT, 5173, 1, 65535) };
}
