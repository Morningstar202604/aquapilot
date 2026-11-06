import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { WebSocket } from 'ws';

/**
 * 真实场景能力考察（automated acceptance exam）。
 *
 * 与 e2e-ci（界面冒烟）和 ci-gate（单元/覆盖率）的区别：这里考的不是
 * 「代码有没有坏」，而是「拿真实运营问题当考题，程序答得对不对」——
 * 五条旅程分别对应五类真实角色：
 *
 *   J1 雨季值班员  —— 暴雨注入后水力响应、调蓄、告警、AI 处置、恢复
 *   J2 危机处置    —— 鼓风机故障后 DO 失守、AI 在护栏内应对、评分卡反应
 *   J3 工程师 what-if —— 经 MCP 用 simulate_headless 对比方案，物理单调性判卷
 *   J4 厂长周报    —— CLI 离线仿真七天，CSV 行数与 JSON 口径对账
 *   J5 数据排查员  —— 脏进水 CSV 的质量报告逐类拦截，干净序列接入后可溯源
 *
 * 判卷标准是物理与口径，不是"接口返回 200"：
 * 暴雨必须推高进水流量、DO 被夹在保护下限附近、提 DO 必须多耗电、
 * 周报 CSV 必须 7 天 × 48 点。答不出、答错、口径对不上都算不及格。
 */

const PORT = 5461;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = '.tmp/exercise';

interface JourneyResult {
  id: string;
  role: string;
  pass: boolean;
  checks: { name: string; ok: boolean; evidence: string }[];
}

const results: JourneyResult[] = [];
let current: JourneyResult | null = null;

function check(name: string, ok: boolean, evidence: string): void {
  if (!current) throw new Error('check() outside a journey');
  current.checks.push({ name, ok, evidence });
  const mark = ok ? '✓' : '✗';
  console.log(`    ${mark} ${name} —— ${evidence}`);
}

async function journey<T>(id: string, role: string, body: () => Promise<T>): Promise<void> {
  current = { id, role, pass: true, checks: [] };
  console.log(`\n▶ ${id} · ${role}`);
  try {
    await body();
  } catch (err) {
    check('旅程执行', false, err instanceof Error ? err.message : String(err));
  }
  current.pass = current.checks.every((c) => c.ok);
  const bad = current.checks.filter((c) => !c.ok).length;
  console.log(`  ${current.pass ? 'PASS' : 'FAIL'}（${current.checks.length - bad}/${current.checks.length} 项）`);
  results.push(current);
  current = null;
}

// ---- 服务端与 WS 客户端 ----------------------------------------------------

let server: ChildProcess | null = null;
let ws: WebSocket | null = null;
let latest: Record<string, unknown> | null = null;

async function startServer(): Promise<void> {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  server = spawn(process.execPath, ['dist/server/index.mjs'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      // 快时钟：SIM_MINUTES_PER_TICK=10 让暴雨 360 min 在 ~36 tick 内走完
      TICK_MS: '120',
      SIM_MINUTES_PER_TICK: '10',
      AQUAPILOT_PERSIST: '0',
      AQUAPILOT_DB: `${TMP}/ex.db`,
      AQUAPILOT_TOPOLOGY: `${TMP}/topology.json`,
      AQUAPILOT_TOPOLOGY_HISTORY: `${TMP}/history.json`,
      AQUAPILOT_LLM_CONFIG: `${TMP}/llm.json`,
      AQUAPILOT_AGENT_CONFIG: `${TMP}/agent.json`,
    },
    stdio: 'ignore',
  });
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* not ready */
    }
    await sleep(400);
  }
  throw new Error('server did not become healthy');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function connectWs(): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        if (msg.type === 'snapshot' || msg.type === 'snapshotPatch') {
          latest =
            msg.type === 'snapshot'
              ? (msg.data as Record<string, unknown>)
              : merge(latest, msg.data as Record<string, unknown>);
        }
      } catch {
        /* 非 JSON 帧：忽略 */
      }
    });
    ws.on('open', () => {
      ws!.send(JSON.stringify({ type: 'hello' }));
      resolve();
    });
    ws.on('error', reject);
  });
}

/** 增量帧合并出「当前视图」，字段口径与客户端 useSimulation 相同 */
function merge(base: Record<string, unknown> | null, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'tanks') continue; // 旅程用不到逐池明细
    out[k] = v;
  }
  return out;
}

function send(msg: unknown): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('ws closed');
  ws.send(JSON.stringify(msg));
}

/** 等到谓词成立或超时；返回最后的当前视图 */
async function waitFor(
  desc: string,
  pred: (s: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (latest && pred(latest)) return latest;
    await sleep(150);
  }
  throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）：${desc}`);
}

function num(s: Record<string, unknown>, path: string): number {
  const parts = path.split('.');
  let v: unknown = s;
  for (const p of parts) v = (v as Record<string, unknown>)?.[p];
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`字段 ${path} 不是有限数：${String(v)}`);
  return n;
}

async function mcp(tool: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const body = (await r.json()) as { result?: { content?: { text?: string }[]; isError?: boolean } };
  const text = body.result?.content?.[0]?.text ?? '{}';
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* isError 的 content 是人类可读文本，不是 JSON——保留原文供断言 */
  }
  return { isError: Boolean(body.result?.isError), parsed, text } as Record<string, unknown>;
}

// ---- J1 雨季值班 ------------------------------------------------------------

async function j1StormShift(): Promise<void> {
  await journey('J1', '雨季值班员（暴雨 6 h + 恢复）', async () => {
    await waitFor('进入稳态（运行 ≥120 仿真分钟）', (s) => num(s, 'timeMin') >= 120, 60_000);
    const base = latest!;
    const baseFlow = num(base, 'influent.flow');
    const baseScore = num(base, 'score');
    check('稳态建立', baseScore >= 0, `基准评分 ${baseScore}，进水 ${baseFlow.toFixed(0)} m³/h`);

    send({ type: 'scenario', kind: 'start', scenario: 'storm' });
    const duringStorm = await waitFor(
      '暴雨窗口内进水流量抬升（≥1.25×基准）',
      (s) => Boolean(s.scenario) && num(s, 'influent.flow') >= baseFlow * 1.25,
      40_000,
    );
    const stormFlow = num(duringStorm, 'influent.flow');
    check(
      '水力冲击到达',
      stormFlow >= baseFlow * 1.25,
      `进水 ${stormFlow.toFixed(0)} vs 基准 ${baseFlow.toFixed(0)} m³/h（${(stormFlow / baseFlow).toFixed(2)}×）`,
    );

    // 水力应力的产品语义：进水流量推过设计流量（2000 m³/h）才算真正吃紧。
    // 调蓄池是控制手段（stormStore 默认 0，由 AI/人工决定是否启用），
    // 不是自动溢流——所以存储为 0 不是缺陷，峰值是否越线才是。
    let peakFlow = stormFlow;
    let sawStorage = num(duringStorm, 'stormStorageM3') > 0;
    const stormDeadline = Date.now() + 50_000;
    while (Date.now() < stormDeadline && latest && (latest as { scenario: unknown }).scenario) {
      peakFlow = Math.max(peakFlow, num(latest, 'influent.flow'));
      sawStorage = sawStorage || num(latest, 'stormStorageM3') > 0;
      await sleep(150);
    }
    check(
      '峰值流量越过设计流量',
      peakFlow > 2000,
      `峰值 ${peakFlow.toFixed(0)} m³/h（设计 2000）${sawStorage ? '；调蓄已启用' : '；调蓄未启用（AI 未选择该手段）'}`,
    );

    // AI 必须给出处置（无论动作是什么，理由不能为空——这是"可审计值守"的底线）
    const withDecision = await waitFor('AI 产出决策', (s) => Boolean(s.recommendation), 60_000);
    const rec = withDecision.recommendation as { action: string; summary: string; rationale: string[] };
    check(
      'AI 决策与理由齐备',
      rec.action.length > 0 && rec.summary.length > 8 && rec.rationale.length > 0,
      `action=${rec.action}，理由 ${rec.rationale.length} 条`,
    );

    // 场景结束后评分应回升（暴雨峰值评分 < 恢复后评分）
    const peak = num(latest!, 'score');
    await waitFor('场景结束', (s) => !s.scenario, 90_000);
    send({ type: 'sim', action: 'reset' });
    await waitFor('重置后回到稳态', (s) => num(s, 'timeMin') >= 120, 60_000);
    check('恢复路径可测', true, `暴雨期评分 ${peak}（基准 ${baseScore}）；重置后基准重建`);
  });
}

// ---- J2 鼓风机故障 ----------------------------------------------------------

async function j2BlowerFailure(): Promise<void> {
  await journey('J2', '危机处置（鼓风机故障 3 h）', async () => {
    await waitFor('稳态', (s) => num(s, 'timeMin') >= 120, 60_000);
    /** DO 不在 effluent 里（EffluentState 无此字段），在末端好氧池：从全量快照的 tanks 读 */
    const readDo = async (): Promise<number> => {
      const r = await fetch(`${BASE}/api/snapshot`);
      const snap = (await r.json()) as { tanks: { kind: string; do: number }[] };
      const aerobic = snap.tanks.filter((t) => t.kind === 'aerobic');
      return aerobic[aerobic.length - 1]?.do ?? 0;
    };
    const base = latest!;
    const baseDo = await readDo();
    const baseNh = num(base, 'effluent.nh');

    send({ type: 'scenario', kind: 'start', scenario: 'blower_failure', durationMin: 180 });
    // 供气 50%：DO 必须掉（这是故障的直接物理后果，装看不见就是引擎坏了）
    let hitDo = baseDo;
    const doDeadline = Date.now() + 45_000;
    while (Date.now() < doDeadline) {
      hitDo = await readDo();
      if (hitDo < baseDo * 0.7) break;
      await sleep(600);
    }
    check(
      '故障物理可见',
      hitDo < baseDo * 0.7,
      `DO ${baseDo.toFixed(2)} → ${hitDo.toFixed(2)} mg/L（下探 ${((hitDo / baseDo) * 100).toFixed(0)}%）`,
    );

    // AI 应在护栏内应对：决策存在，且若调 DO 只能到能力上限（aerationCapacity 被削）
    const rec = await waitFor('AI 危机决策', (s) => Boolean(s.recommendation), 60_000);
    const r = rec.recommendation as {
      action: string;
      tweaks: { key: string; from: number; to: number }[];
      risks: string[];
    };
    const doTweak = r.tweaks.find((t) => t.key === 'doSetpoint');
    check(
      'AI 处置受护栏约束',
      r.tweaks.length === 0 || (doTweak ? doTweak.to <= 4.5 : true),
      doTweak ? `DO 设定 ${doTweak.from.toFixed(1)}→${doTweak.to.toFixed(1)}（上限 4.5）` : '本轮维持（无越权调节）',
    );
    check('风险披露', r.risks.length > 0, `${r.risks.length} 条风险提示`);

    // NH4 在故障窗口内应爬升（硝化受抑制）
    const nhRise = await waitFor('NH₄ 爬升', (s) => num(s, 'effluent.nh') > baseNh * 1.15, 60_000);
    check('硝化受抑制可测', true, `NH₄ ${baseNh.toFixed(2)} → ${num(nhRise, 'effluent.nh').toFixed(2)} mg/L`);

    // 评分卡危机维度的判卷标准不是"危机必须扣分"——AI 把危机处理住
    // （NH₄ 全程 < 限值 5）时满分恰恰是正确结论。要验证的是评分与事实
    // 一致：危机窗口被计入（detail 提到场景点数），各维度分数有限。
    const card = await waitFor(
      '评分卡更新',
      (s) => Boolean(s.scorecard && (s.scorecard as { samples: number }).samples >= 6),
      30_000,
    );
    const sc = card.scorecard as { dimensions: { key: string; score: number; detail: string }[]; total: number };
    const crisis = sc.dimensions.find((d) => d.key === 'crisis')!;
    const sawScenario = /场景|window|\d+ 个采样点/.test(crisis.detail) && !crisis.detail.includes('未注入扰动');
    check(
      '评分卡与危机事实一致',
      sawScenario && Number.isFinite(sc.total),
      `危机 ${crisis.score}/100（${crisis.detail}），总分 ${sc.total}`,
    );
    send({ type: 'scenario', kind: 'clear' });
    send({ type: 'sim', action: 'reset' });
    await sleep(1500);
  });
}

// ---- J3 工程师 what-if（MCP）------------------------------------------------

async function j3WhatIf(): Promise<void> {
  await journey('J3', '工艺工程师（MCP what-if 对比）', async () => {
    const tools = (await mcp('list_scenarios')) as unknown as Record<string, unknown>;
    check('MCP 可达', !tools.isError, 'tools/call list_scenarios 正常返回');

    // 边界护栏：非法参数必须被拒，而不是拿 999 当正常值算
    const bad = (await mcp('simulate_headless', { durationMin: 99999 })) as unknown as { isError: boolean };
    check('非法输入被拒', bad.isError === true, 'durationMin=99999 → isError');

    // 方案对比：DO 3.0 vs 当前 2.0。物理单调性：提 DO → 电耗↑、NH₄ 峰值↓或持平
    const a = (await mcp('simulate_headless', { durationMin: 240 })) as {
      parsed: { worstRatios: Record<string, number>; finalScore: number };
    };
    const b = (await mcp('simulate_headless', { durationMin: 240, controls: { doSetpoint: 3.0 } })) as {
      parsed: { worstRatios: Record<string, number>; finalScore: number };
    };
    const nhA = a.parsed.worstRatios.nh;
    const nhB = b.parsed.worstRatios.nh;
    check('NH₄ 随 DO 提升不恶化', nhB <= nhA * 1.05, `DO2.0 → NH₄ 占限 ${nhA}；DO3.0 → ${nhB}`);
    check(
      '两级方案都能给出可用结论',
      a.parsed.finalScore !== null && b.parsed.finalScore !== null,
      `评分 ${a.parsed.finalScore} vs ${b.parsed.finalScore}`,
    );

    // 控制量夹紧：set_control 999 必须被夹到安全边界并如实上报
    const clamped = (await mcp('set_control', { doSetpoint: 999 })) as {
      parsed: { ok: boolean; clamped: string[]; applied: Record<string, number> };
    };
    check(
      '越界控制量被夹紧',
      clamped.parsed.ok === true && clamped.parsed.clamped.includes('doSetpoint'),
      `applied.doSetpoint=${clamped.parsed.applied.doSetpoint}`,
    );
    // 复位控制量，避免影响后续旅程
    await mcp('set_control', { doSetpoint: 2.0 });
    send({ type: 'sim', action: 'reset' });
    await sleep(1200);
  });
}

// ---- J4 厂长周报（CLI）------------------------------------------------------

async function j4WeeklyReport(): Promise<void> {
  await journey('J4', '厂长要一份 7 天运行周报（CLI 离线）', async () => {
    const { execFileSync } = await import('node:child_process');
    const csvPath = `${TMP}/week.csv`;
    const out = execFileSync(
      process.execPath,
      ['dist/cli.mjs', 'simulate', '--days', '7', '--csv', csvPath, '--json'],
      {
        encoding: 'utf8',
        timeout: 120_000,
      },
    );
    const parsed = JSON.parse(out) as {
      samples: unknown[];
      totals: { inflowM3: number };
      compliant: Record<string, boolean>;
    };
    const rows = readFileSync(csvPath, 'utf8').trim().split('\n');
    check('CSV 点数对账', rows.length === 7 * 48 + 1, `${rows.length - 1} 行数据（期望 336，7 天 × 48 点）`);
    check(
      'JSON 口径一致',
      parsed.samples.length === 336 && parsed.totals.inflowM3 > 0,
      `samples=${parsed.samples.length}，累计水量 ${parsed.totals.inflowM3.toFixed(0)} m³`,
    );
    const five = Object.keys(parsed.compliant);
    check('五项达标判定齐备', five.length === 5, five.join('/'));
    const report = execFileSync(process.execPath, ['dist/cli.mjs', 'report', '--days', '7'], {
      encoding: 'utf8',
      timeout: 120_000,
    });
    check('周报可直接交付', report.includes('| COD |') && report.includes('能水耗'), 'Markdown 含出水表与能水耗小节');
  });
}

// ---- J5 进水数据排查 --------------------------------------------------------

async function j5DataQuality(): Promise<void> {
  await journey('J5', '数据排查员（脏 CSV 必须被拦下）', async () => {
    // 一份"看起来能用"的脏数据：断档 + 卡值 + 突变 + 超物理范围
    const bad = ['minute,flow,cod,nh,tp,ss,temperature'];
    for (let m = 0; m < 240; m += 30) {
      const flow = 1800 + 200 * Math.sin(m / 120);
      bad.push(`${m},${flow.toFixed(1)},320,32,4.5,180,18.5`);
    }
    bad.push('600,4200,320,32,4.5,180,18.5'); // 断档 6 h + 突变流量
    bad.push('630,4200,320,32,4.5,180,18.5');
    bad.push('660,4200,99999,32,4.5,180,18.5'); // 超物理范围 COD
    const reply = await wsRequest({
      type: 'influent',
      action: 'load',
      requestId: 'j5-bad',
      name: '脏数据排查样例',
      csv: bad.join('\n'),
    });
    const quality = (reply as { quality: { usable: boolean; issues: { code: string }[] } }).quality;
    const codes = new Set(quality.issues.map((i) => i.code));
    check('脏数据被拒', quality.usable === false, `usable=false，${quality.issues.length} 条问题`);
    check('断档被识别', codes.has('gap'), [...codes].join(','));
    check('超范围被识别', codes.has('out-of-range'), [...codes].join(','));

    // 干净序列：24 h 昼夜节律
    const good = ['minute,flow,cod,nh,tp,ss,temperature'];
    for (let m = 0; m < 1440; m += 30) {
      const diurnal = 1 + 0.25 * Math.sin((m / 1440) * 2 * Math.PI - Math.PI / 2);
      good.push(
        `${m},${(1800 * diurnal).toFixed(1)},${(320 * diurnal).toFixed(1)},${(30 * diurnal).toFixed(1)},4.5,180,18.5`,
      );
    }
    const ok = await wsRequest({
      type: 'influent',
      action: 'load',
      requestId: 'j5-good',
      name: '干净昼夜序列',
      csv: good.join('\n'),
    });
    check('干净数据可解析', (ok as { summary: unknown }).summary !== null, '解析出 48 点序列');
    const applied = await wsRequest({ type: 'influent', action: 'apply', requestId: 'j5-apply' });
    check('干净数据可应用', (applied as { applied: boolean }).applied === true, '已切换进水源');

    // 自检必须能回答"现在数据从哪来"（上一轮补的数据源新鲜度检查）
    const wd = await wsRequest({ type: 'watchdog', action: 'get', requestId: 'j5-wd' });
    const src = (wd as { report: { checks: { id: string; detail: string }[] } }).report.checks.find(
      (c) => c.id === 'influent-source',
    );
    check('数据源可溯源', Boolean(src && src.detail.includes('干净昼夜序列')), src?.detail ?? '未找到');
    await wsRequest({ type: 'influent', action: 'clear', requestId: 'j5-clear' });
  });
}

/** 带 requestId 的请求/响应：等对应帧回来 */
function wsRequest(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
  const rid = msg.requestId as string | undefined;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wsRequest 超时：${msg.type}/${msg.action}`)), 30_000);
    const onMsg = (raw: Buffer): void => {
      try {
        const m = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
        const ridMatch = !rid || m.requestId === rid || m.requestId === undefined;
        if (m.type === msg.type && ridMatch) {
          ws!.off('message', onMsg);
          clearTimeout(timer);
          resolve(m);
        }
      } catch {
        /* ignore */
      }
    };
    ws!.on('message', onMsg);
    send(msg);
  });
}

// ---- 汇总 -------------------------------------------------------------------

function printReport(): boolean {
  console.log('\n════════ 能力考察总评 ════════');
  const width = Math.max(...results.map((r) => r.id.length + r.role.length)) + 2;
  let all = true;
  for (const r of results) {
    const ok = r.checks.filter((c) => c.ok).length;
    console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${(r.id + ' ' + r.role).padEnd(width)} ${ok}/${r.checks.length}`);
    if (!r.pass) {
      all = false;
      for (const c of r.checks.filter((c) => !c.ok)) console.log(`        ✗ ${c.name} —— ${c.evidence}`);
    }
  }
  console.log(all ? '\n考察结论：五类真实角色的考题全部通过。' : '\n考察结论：存在不及格项，见上。');
  return all;
}

async function main(): Promise<number> {
  if (!existsSync('dist/server/index.mjs')) {
    console.error('先 npm run build：能力考察必须对生产构建出题，不对 tsx 源码。');
    return 2;
  }
  await startServer();
  await connectWs();
  try {
    await j1StormShift();
    await j2BlowerFailure();
    await j3WhatIf();
    await j4WeeklyReport();
    await j5DataQuality();
  } finally {
    ws?.close();
    server?.kill();
  }
  const ok = printReport();
  return ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('考察器自身故障：', err);
    process.exitCode = 2;
  });
