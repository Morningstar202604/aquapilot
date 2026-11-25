/**
 * Freeze M2-2 oracle cases from the TypeScript implementation.
 *
 * The Rust ops crate must reproduce these exact decisions; this is a parity
 * fixture, not a second source of truth. Run: npx tsx scripts/gen-ops-cases.ts
 */
import { writeFileSync } from 'node:fs';
import { evaluateChecks, overallSeverity, type CheckInput } from '../src/server/watchdog';
import { decisionFingerprint, shouldRecordDecision } from '../src/server/decisionAudit';
import { createRateLimiter, freshClientState } from '../src/server/rateLimit';
import { assertSafeBaseUrl, ProviderError } from '../src/ai/providers';

const healthy: CheckInput = {
  tickErrors: 0,
  tickDelta: 2,
  lastTickMs: 12,
  simulationMinutes: 42,
  paused: false,
  wsActive: 1,
  llmCalls: 10,
  llmFallbacks: 1,
  persistence: 'enabled',
  persistenceErrors: 0,
  agentWarnings: 0,
  agentPermission: 'admin',
  hookFailures: 0,
  llmConfigured: true,
  configPath: '/nonexistent/agent-config.json',
  influentSource: undefined,
};

const watchdogInputs: CheckInput[] = [
  healthy,
  { ...healthy, tickErrors: 3 },
  { ...healthy, tickDelta: 0 },
  { ...healthy, tickDelta: 0, paused: true },
  { ...healthy, lastTickMs: 620 },
  { ...healthy, llmConfigured: false },
  { ...healthy, llmCalls: 8, llmFallbacks: 6 },
  { ...healthy, persistence: 'disabled' },
  { ...healthy, persistenceErrors: 2 },
  { ...healthy, agentWarnings: 2 },
  { ...healthy, hookFailures: 1 },
  { ...healthy, wsActive: 0 },
  {
    ...healthy,
    influentSource: { kind: 'csv', name: 'influent.csv', spanMin: 720, cycles: 2, points: 720 },
  },
  {
    ...healthy,
    influentSource: { kind: 'csv', name: 'fresh.csv', spanMin: 1440, cycles: 0, points: 1440 },
  },
];

const watchdog = watchdogInputs.map((input) => {
  const checks = evaluateChecks(input);
  return { input, checks, severity: overallSeverity(checks) };
});

const decisions: { last: { key: string; atMin: number } | null; fingerprint: string; atMin: number; force: boolean; windowMin: number; expected: boolean }[] = [];
const fp = decisionFingerprint({ action: 'hold', severity: 'critical', summary: 'same' });
for (const [last, atMin, force] of [
  [null, 100, false],
  [{ key: fp, atMin: 100 }, 120, false],
  [{ key: fp, atMin: 100 }, 160, false],
  [{ key: fp, atMin: 100 }, 101, true],
  [{ key: decisionFingerprint({ action: 'hold', severity: 'normal', summary: 'same' }), atMin: 100 }, 101, false],
] as const) {
  decisions.push({
    last,
    fingerprint: fp,
    atMin,
    force,
    windowMin: 60,
    expected: shouldRecordDecision(last, { action: 'hold', severity: 'critical', summary: 'same' }, atMin, { force }),
  });
}

const rate: { times: number[]; limited: boolean[]; notices: (string | null)[] }[] = [];
{
  const limiter = createRateLimiter({
    stateFor: () => state,
    saveState: (_, next) => (state = next),
    onLimited: () => undefined,
    now: () => now,
  });
  let state = freshClientState();
  let now = 1_700_000_000_000;
  const base = now;
  const times = [0, 250, 500, 900, 1200].map((offset) => base + offset);
  const limited: boolean[] = [];
  for (const t of times) {
    now = t;
    limited.push(limiter.limited({} as never, 'control'));
  }
  rate.push({ times, limited, notices: [] });
}
{
  const limiter = createRateLimiter({
    stateFor: () => state,
    saveState: (_, next) => (state = next),
    onLimited: () => undefined,
    now: () => now,
  });
  let state = freshClientState();
  let now = 1_700_000_000_000;
  const base = now;
  const times: number[] = [];
  const notices: (string | null)[] = [];
  for (let i = 0; i < 40; i++) {
    now = base + i * 25;
    times.push(now);
    let payload: string | null = null;
    limiter.notice({} as never, 'control', 'too fast', (body) => (payload = body));
    notices.push(payload);
  }
  now = base + 2_500;
  times.push(now);
  let payload: string | null = null;
  limiter.notice({} as never, 'control', 'too fast', (body) => (payload = body));
  notices.push(payload);
  rate.push({ times, limited: [], notices });
}

const urlCases = [
  'http://169.254.169.254/v1',
  'http://[::ffff:169.254.169.254]/v1',
  'http://100.100.100.200/v1',
  'http://metadata.google.internal./v1',
  'https://user:pass@example.com/v1',
  'file:///etc/passwd',
  'http://127.0.0.1:11434/v1',
  'http://10.0.0.8:8000/v1',
  'https://api.deepseek.com/v1',
].map((url) => {
  try {
    assertSafeBaseUrl(url);
    return { url, allowed: true };
  } catch (err) {
    return { url, allowed: false, reason: err instanceof ProviderError ? err.message : String(err) };
  }
});

const payload = {
  generatedBy: 'scripts/gen-ops-cases.ts',
  watchdog,
  decisions,
  rate,
  urlCases,
};
writeFileSync(new URL('../rust/golden/ops-cases.json', import.meta.url), JSON.stringify(payload, null, 2) + '\n');
console.log(`ops cases: watchdog=${watchdog.length} decisions=${decisions.length} rate=${rate.length} urls=${urlCases.length}`);
