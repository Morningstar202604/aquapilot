/**
 * 7×24 service soak harness (M2-3).
 *
 * It deliberately uses wall-clock time. `SOAK_MINUTES` is the only knob; a
 * short smoke run validates the harness but can never be reported as the
 * 24-hour acceptance. Samples RSS / threads / file descriptors from /proc,
 * probes HTTP health + snapshot, and opens a real WebSocket every fifth sample
 * to exercise hello/snapshot and disconnect handling.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const PORT = Number(process.env.SOAK_PORT ?? 5199);
const MINUTES = Number(process.env.SOAK_MINUTES ?? 24 * 60);
const INTERVAL_MS = Number(process.env.SOAK_INTERVAL_MS ?? 60_000);
const EXTERNAL_BASE = process.env.SOAK_BASE?.trim();
const TOKEN = process.env.SOAK_TOKEN ?? process.env.AQUAPILOT_TOKEN ?? '';
const BASE = EXTERNAL_BASE ?? `http://127.0.0.1:${PORT}`;
const authSuffix = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';
const OUT_DIR = resolve(process.env.SOAK_OUT ?? `soak/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const WARMUP_S = Number(process.env.SOAK_WARMUP_S ?? 60);
const BOOT_ID = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();

if (!Number.isFinite(MINUTES) || MINUTES <= 0) throw new Error('SOAK_MINUTES must be > 0');
mkdirSync(OUT_DIR, { recursive: true });
const csvPath = `${OUT_DIR}/samples.csv`;
if (existsSync(csvPath)) {
  throw new Error(
    `refusing to overwrite existing soak: ${csvPath}. A 24 h run is evidence, not a scratch file; use a new SOAK_OUT.`,
  );
}
writeFileSync(
  csvPath,
  'elapsed_s,rss_kb,threads,fds,health_ms,snapshot_ms,snapshot_bytes,time_min,ws_ms,status,error\n',
);
writeFileSync(
  `${OUT_DIR}/run.json`,
  `${JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      bootId: BOOT_ID,
      minutes: MINUTES,
      intervalMs: INTERVAL_MS,
      warmupS: WARMUP_S,
      base: BASE,
      external: Boolean(EXTERNAL_BASE),
      node: process.version,
      platform: process.platform,
    },
    null,
    2,
  )}\n`,
);

let child: ChildProcess | null = null;
let stopping = false;

function startServer(): ChildProcess {
  const proc = spawn(process.execPath, ['dist/server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      AQUAPILOT_PERSIST: '0',
      TICK_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', (chunk) => process.stdout.write(`[server] ${chunk}`));
  proc.stderr?.on('data', (chunk) => process.stderr.write(`[server:err] ${chunk}`));
  return proc;
}

async function waitForHealth(timeoutMs = 120_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`${BASE}/api/health${authSuffix}`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(1_000);
  }
  throw new Error('server did not become healthy');
}

function procMetrics(pid: number): { rssKb: number; threads: number; fds: number } {
  let rssKb = 0;
  let threads = 0;
  let fds = 0;
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    rssKb = Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0);
    threads = Number(/Threads:\s+(\d+)/.exec(status)?.[1] ?? 0);
  } catch {
    // process exited or /proc is unavailable; keep zero and let summary fail.
  }
  try {
    fds = readdirSync(`/proc/${pid}/fd`).length;
  } catch {
    // same
  }
  return { rssKb, threads, fds };
}

async function probeWs(): Promise<{ ms: number; timeMin: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ws = new WebSocket(`${BASE.replace(/^http/, 'ws')}/ws${authSuffix}`);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error('websocket hello timeout'));
    }, 10_000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello' })));
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as { type?: string; data?: { timeMin?: number } };
      if (message.type === 'snapshot') {
        clearTimeout(timer);
        ws.close();
        resolve({ ms: Date.now() - started, timeMin: Number(message.data?.timeMin ?? 0) });
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function sample(elapsedS: number, index: number): Promise<void> {
  let status = 0;
  let error = '';
  let healthMs = 0;
  let snapshotMs = 0;
  let snapshotBytes = 0;
  let timeMin = 0;
  let wsMs = 0;
  try {
    const t0 = Date.now();
    const health = await fetch(`${BASE}/api/health?deep=1${TOKEN ? `&token=${encodeURIComponent(TOKEN)}` : ''}`);
    healthMs = Date.now() - t0;
    status = health.status;
    if (!health.ok) throw new Error(`health ${health.status}`);

    const t1 = Date.now();
    const snapshot = await fetch(`${BASE}/api/snapshot${authSuffix}`);
    snapshotMs = Date.now() - t1;
    const body = await snapshot.text();
    snapshotBytes = Buffer.byteLength(body);
    if (!snapshot.ok) throw new Error(`snapshot ${snapshot.status}`);
    timeMin = Number((JSON.parse(body) as { timeMin?: number }).timeMin ?? 0);

    if (index % 5 === 0) {
      wsMs = (await probeWs()).ms;
    }
  } catch (err) {
    error = String(err).replaceAll('"', "'");
  }
  const metrics = child?.pid ? procMetrics(child.pid) : { rssKb: 0, threads: 0, fds: 0 };
  appendFileSync(
    csvPath,
    `${elapsedS.toFixed(1)},${metrics.rssKb},${metrics.threads},${metrics.fds},${healthMs},${snapshotMs},${snapshotBytes},${timeMin},${wsMs},${status},${error}\n`,
  );
}

interface Summary {
  durationMinutes: number;
  samples: number;
  errors: number;
  rssStartKb: number;
  rssEndKb: number;
  rssGrowthKb: number;
  rssGrowthPct: number;
  rssSlopeKbPerHour: number;
  fdStart: number;
  fdEnd: number;
  fdGrowth: number;
  threadsMax: number;
  bootId: string;
  hostRebooted: boolean;
  passed: boolean;
  note: string;
}

function summarize(durationMinutes: number): Summary {
  const rows = readFileSync(csvPath, 'utf8')
    .trim()
    .split('\n')
    .slice(1)
    .map((line) => line.split(','))
    .filter((row) => row.length >= 11);
  const numeric = rows.map((row) => ({
    t: Number(row[0]),
    rss: Number(row[1]),
    threads: Number(row[2]),
    fds: Number(row[3]),
    error: row[10],
  }));
  const warm = numeric.filter((row) => row.t >= WARMUP_S && row.rss > 0);
  const window = warm.length ? warm : numeric.filter((row) => row.rss > 0);
  const first = window[0];
  const last = window[window.length - 1];
  const rssGrowthKb = last && first ? last.rss - first.rss : 0;
  const rssGrowthPct = first && first.rss > 0 ? (rssGrowthKb / first.rss) * 100 : 0;
  const meanT = window.reduce((sum, row) => sum + row.t, 0) / Math.max(1, window.length);
  const meanRss = window.reduce((sum, row) => sum + row.rss, 0) / Math.max(1, window.length);
  const slope =
    window.reduce((sum, row) => sum + (row.t - meanT) * (row.rss - meanRss), 0) /
    Math.max(
      1,
      window.reduce((sum, row) => sum + (row.t - meanT) ** 2, 0),
    );
  const errors = rows.filter((row) => row[10] !== '').length;
  const fdGrowth = last && first ? last.fds - first.fds : 0;
  const threadsMax = Math.max(...numeric.map((row) => row.threads), 0);
  const currentBoot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const hostRebooted = currentBoot !== BOOT_ID;
  const passed =
    !hostRebooted &&
    durationMinutes >= 24 * 60 &&
    errors === 0 &&
    rssGrowthPct <= 10 &&
    slope * 3600 <= 1024 &&
    fdGrowth <= 2;
  return {
    durationMinutes,
    samples: rows.length,
    errors,
    rssStartKb: first?.rss ?? 0,
    rssEndKb: last?.rss ?? 0,
    rssGrowthKb,
    rssGrowthPct: Number(rssGrowthPct.toFixed(2)),
    rssSlopeKbPerHour: Number((slope * 3600).toFixed(2)),
    fdStart: first?.fds ?? 0,
    fdEnd: last?.fds ?? 0,
    fdGrowth,
    threadsMax,
    bootId: BOOT_ID,
    hostRebooted,
    passed,
    note: hostRebooted
      ? 'NOT ACCEPTED: host rebooted during the soak window; continuity is broken, start a new run'
      : passed
        ? '24 h wall-clock soak passed'
        : 'NOT ACCEPTED: requires >=24 h wall-clock, zero probe errors, RSS growth <=10%, slope <=1 MiB/h and FD growth <=2',
  };
}

async function main(): Promise<void> {
  if (!EXTERNAL_BASE) {
    child = startServer();
  }
  await waitForHealth();
  const started = Date.now();
  const totalS = MINUTES * 60;
  let index = 0;
  while (!stopping && (Date.now() - started) / 1000 < totalS) {
    const elapsed = (Date.now() - started) / 1000;
    await sample(elapsed, index);
    index += 1;
    await sleep(Math.min(INTERVAL_MS, Math.max(1_000, totalS * 1000 - elapsed * 1000)));
  }
  const durationMinutes = (Date.now() - started) / 60_000;
  const summary = summarize(durationMinutes);
  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (child) {
    child.kill('SIGTERM');
    await sleep(2_000);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  process.exitCode = summary.passed ? 0 : 1;
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true;
  });
}

main().catch((err) => {
  console.error(err);
  if (child) child.kill('SIGKILL');
  process.exitCode = 1;
});
