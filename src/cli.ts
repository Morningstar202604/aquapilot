/**
 * AquaPilot CLI —— `aquapilot <command>`。
 *
 * 设计原则：仿真/报表/校准/基准子命令纯本地计算，不碰网络、不碰数据库；
 * 只有 `serve` 才拉起完整服务端（WS + MCP + Prometheus 一个不少）。
 * 这让 headless 环境（CI、服务器、Node SEA 单文件 exe）都能零依赖使用。
 *
 * 打包：
 * - npm bin：esbuild 打包为 dist/cli.mjs（package.json "bin" 指向它）
 * - 单文件 exe：Node SEA 流程（scripts/build-exe.mjs），入口是本文件
 */
import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { PLANT_TOPOLOGY, validateTopology } from './model/topology';
import { exportTopology, importTopology } from './model/topologyExchange';
import { APP_VERSION } from './shared/version';
import { LIMITS, PLANT } from './sim/config';
import {
  createNetworkState,
  spinUpNetwork,
  stepNetwork,
  startNetworkScenario,
  qualityScoreOf,
} from './sim/networkEngine';
import { SCENARIOS, type ScenarioType } from './sim/scenarios';
import { checkRunReadiness } from './sim/topologyEngine';
import { CONTROL_BOUNDS, type ControlSettings } from './sim/config';

interface SimOptions {
  days: number;
  scenario?: ScenarioType;
  controls: Partial<ControlSettings>;
  csvPath?: string;
}

function parseControls(list: string[] | undefined): Partial<ControlSettings> {
  const out: Record<string, number> = {};
  for (const item of list ?? []) {
    const [k, v] = item.split('=');
    if (!k || v === undefined || !(k in CONTROL_BOUNDS)) {
      throw new Error(`无效控制量 "${item}"（应为 键=值，可用键：${Object.keys(CONTROL_BOUNDS).join(', ')}）`);
    }
    const num = Number(v);
    if (!Number.isFinite(num)) throw new Error(`控制量 ${k} 不是数字：${v}`);
    const bound = CONTROL_BOUNDS[k as keyof typeof CONTROL_BOUNDS];
    out[k as keyof ControlSettings] = Math.min(bound.max, Math.max(bound.min, num));
  }
  return out;
}

interface Sample {
  day: number;
  hour: number;
  cod: number;
  nh: number;
  tn: number;
  tp: number;
  ss: number;
  do: number;
  score: number;
}

function runSimulation(opts: SimOptions): { samples: Sample[]; totals: { inflowM3: number; energyKwh: number } } {
  let state = spinUpNetwork(
    createNetworkState(PLANT_TOPOLOGY, { seed: 20261019, controls: opts.controls }),
    PLANT_TOPOLOGY,
    5,
  );
  if (opts.scenario) startNetworkScenario(state, opts.scenario);
  const samples: Sample[] = [];
  const totalMin = opts.days * 1440;
  let elapsed = 0;
  while (elapsed < totalMin) {
    state = stepNetwork(state, PLANT_TOPOLOGY, 1);
    elapsed += 1;
    if (elapsed % 30 === 0) {
      samples.push({
        day: Math.floor(elapsed / 1440),
        hour: Math.floor((elapsed % 1440) / 60),
        cod: state.effluent.cod,
        nh: state.effluent.nh,
        tn: state.effluent.tn,
        tp: state.effluent.tp,
        ss: state.effluent.ss,
        do: state.reactors.find((t) => t.kind === 'aerobic')?.doLevel ?? 0,
        score: qualityScoreOf(state.effluent),
      });
    }
  }
  return { samples, totals: { inflowM3: state.totals.inflowM3, energyKwh: state.totals.energyKwh } };
}

function worstOf(samples: Sample[], key: 'cod' | 'nh' | 'tn' | 'tp' | 'ss'): number {
  return Math.max(...samples.map((s) => s[key]));
}

function printSummary(opts: SimOptions, samples: Sample[], totals: { inflowM3: number; energyKwh: number }): void {
  const checks: [string, number, number][] = [
    ['COD', worstOf(samples, 'cod'), LIMITS.cod],
    ['NH₃-N', worstOf(samples, 'nh'), LIMITS.nh],
    ['TN', worstOf(samples, 'tn'), LIMITS.tn],
    ['TP', worstOf(samples, 'tp'), LIMITS.tp],
    ['SS', worstOf(samples, 'ss'), LIMITS.ss],
  ];
  const avg = (k: 'cod' | 'nh' | 'tn' | 'tp' | 'ss') => samples.reduce((s, x) => s + x[k], 0) / samples.length;
  console.log('\n── 出水水质（GB 18918-2002 一级 A）──────────────');
  for (const [name, worst, lim] of checks) {
    const status = worst <= lim ? '✓ 达标' : '✗ 超标';
    console.log(
      `  ${name.padEnd(6)} 峰值 ${worst.toFixed(3).padStart(8)} / 限值 ${lim.toString().padEnd(5)} ${status}`,
    );
  }
  console.log('\n── 均值 ────────────────────────────────────────');
  console.log(
    `  COD ${(avg('cod') ?? 0).toFixed(1)}  NH₃-N ${(avg('nh') ?? 0).toFixed(2)}  TN ${(avg('tn') ?? 0).toFixed(1)}  TP ${(avg('tp') ?? 0).toFixed(3)}  SS ${(avg('ss') ?? 0).toFixed(1)}  (mg/L)`,
  );
  console.log(`  出水评分（均值） ${(samples.reduce((s, x) => s + x.score, 0) / samples.length).toFixed(0)}/100`);
  console.log('\n── 运行量 ──────────────────────────────────────');
  console.log(
    `  处理水量 ${totals.inflowM3.toFixed(0)} m³   电耗 ${totals.energyKwh.toFixed(0)} kWh   吨水电耗 ${(totals.energyKwh / Math.max(1, totals.inflowM3)).toFixed(3)} kWh/m³`,
  );
  if (opts.scenario) {
    console.log(`  场景：${SCENARIOS[opts.scenario].label}`);
  }
}

function writeCsv(path: string, samples: Sample[]): void {
  const header = 'day,hour,cod_mgl,nh_mgl,tn_mgl,tp_mgl,ss_mgl,do_mgl,score';
  const rows = samples.map((s) =>
    [
      s.day,
      s.hour,
      s.cod.toFixed(3),
      s.nh.toFixed(3),
      s.tn.toFixed(3),
      s.tp.toFixed(4),
      s.ss.toFixed(2),
      s.do.toFixed(3),
      s.score.toFixed(0),
    ].join(','),
  );
  writeFileSync(path, [header, ...rows].join('\n'), 'utf8');
}

function usage(): string {
  return `AquaPilot —— AI 操作的污水厂仿真器（命令行）

用法：aquapilot <command> [options]

命令：
  serve                          启动完整服务端（Web UI + WS + MCP /mcp + Prometheus /api/metrics）
  simulate                       离线仿真标准厂（A²/O 五池 + 二沉池），打印出水达标汇总
    --days <n>                   仿真天数（默认 1）
    --scenario <kind>            注入扰动场景：${Object.keys(SCENARIOS).join(' | ')}
    --control <k=v>              设置控制量（可重复），如 --control doSetpoint=2.5 --control wasRatio=0.02
    --csv <path>                 每 30 分钟一条采样，输出 CSV
    --json                       以 JSON 输出（供脚本消费，不打印人类可读文本）
  report                         生成 Markdown 运营报告到 stdout
    （同 simulate 的 --days/--scenario/--control）
  bench                          BSM1 Table 6 基准对照（Christoulou et al. 2024 数值）
  calibrate                      对合成目标跑参数辨识 + 坐标下降校准，打印辨识结果
  topology <validate|export>     校验拓扑 JSON 文件，或导出标准厂拓扑
    --file <path>                拓扑 JSON 文件（validate 必填）
  version                        显示版本号
  help                           显示本帮助

环境变量：
  AQUAPILOT_TOKEN / AQUAPILOT_OPERATOR_TOKEN / AQUAPILOT_VIEWER_TOKEN
                                  serve 的访问令牌（分级权限）

示例：
  aquapilot simulate --days 7 --csv week.csv
  aquapilot simulate --days 2 --scenario storm --control doSetpoint=3 --json
  aquapilot topology validate --file my-plant.json
  aquapilot topology export > standard.json
  aquapilot serve --port 8080`;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(usage());
    return 0;
  }

  const parsed = parseArgs({
    args: rest,
    options: {
      days: { type: 'string', default: '1' },
      scenario: { type: 'string' },
      control: { type: 'string', multiple: true },
      csv: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      /** 机器可读输出：CI 与脚本消费，不带任何装饰文本 */
      json: { type: 'boolean', default: false },
      /** topology 子命令的输入文件 */
      file: { type: 'string' },
    },
    strict: false,
  });
  const days = Number(parsed.values.days ?? '1');
  if (!Number.isFinite(days) || days <= 0 || days > 365) throw new Error('--days 必须在 1–365 之间');
  const scenario = parsed.values.scenario as ScenarioType | undefined;
  if (scenario !== undefined && !(scenario in SCENARIOS)) {
    throw new Error(`未知场景 ${scenario}（可用：${Object.keys(SCENARIOS).join(', ')}）`);
  }
  const opts: SimOptions = {
    days,
    scenario,
    controls: parseControls(parsed.values.control as string[] | undefined),
    csvPath: parsed.values.csv as string | undefined,
  };

  switch (command) {
    case 'version': {
      console.log(APP_VERSION);
      return 0;
    }
    case 'topology': {
      /**
       * 拓扑校验 / 导出。
       *
       * 校验用的是服务端同一套 sanitize + 结构校验（`importTopology`），
       * 所以「CLI 说能导入」等价于「Web 编辑器里能导入」——两处不会漂移。
       * 导出走标准厂拓扑，可作为手写 JSON 的起点。
       */
      const sub = rest[0];
      if (sub === 'export') {
        const json = exportTopology(PLANT_TOPOLOGY, APP_VERSION);
        process.stdout.write(json);
        return 0;
      }
      if (sub === 'validate') {
        const file = typeof parsed.values.file === 'string' ? parsed.values.file : undefined;
        if (!file) throw new Error('topology validate 需要 --file <path>');
        const text = readFileSync(file, 'utf8');
        const result = importTopology(text);
        if (!result.ok) {
          console.error(`✗ 校验失败：${result.error}`);
          return 1;
        }
        const t = result.topology;
        const issues = validateTopology(t).filter((i) => i.severity === 'error');
        const readiness = checkRunReadiness(t, PLANT.designFlowM3h);
        if (parsed.values.json) {
          console.log(
            JSON.stringify(
              {
                ok: issues.length === 0,
                units: t.units.length,
                connections: t.connections.length,
                train: t.train.length,
                errors: issues.map((i) => i.message),
                ready: readiness.ready,
                blockers: readiness.blockers,
                source: result.meta,
              },
              null,
              2,
            ),
          );
        } else {
          console.log(`✓ 结构合法：${t.units.length} 单元 / ${t.connections.length} 物流 / 主序列 ${t.train.length}`);
          if (result.meta.appVersion) console.log(`  导出自 v${result.meta.appVersion}（${result.meta.exportedAt}）`);
          if (issues.length > 0) for (const i of issues) console.log(`  ✗ ${i.message}`);
          console.log(
            readiness.ready
              ? '✓ 可运行（满足进水/曝气/二沉池等最低运行条件）'
              : `✗ 不可运行：${readiness.blockers.join('；')}`,
          );
        }
        return issues.length === 0 && readiness.ready ? 0 : 1;
      }
      console.error(`未知子命令：${sub ?? '(空)'}\n用法：aquapilot topology <validate|export> --file <path>`);
      return 1;
    }
    case 'simulate': {
      if (!parsed.values.json) console.log(`AquaPilot 离线仿真：${days} 天（预热 5 天稳态后开始计时）…`);
      const { samples, totals } = runSimulation(opts);
      if (parsed.values.json) {
        /**
         * JSON 输出只给结构化事实，不带任何中文说明段落。
         * 供 CI 断言与外部调度系统消费；字段名与 WS 协议保持一致。
         */
        const avg = (k: 'cod' | 'nh' | 'tn' | 'tp' | 'ss') => samples.reduce((s, x) => s + x[k], 0) / samples.length;
        const worst = {
          cod: worstOf(samples, 'cod'),
          nh: worstOf(samples, 'nh'),
          tn: worstOf(samples, 'tn'),
          tp: worstOf(samples, 'tp'),
          ss: worstOf(samples, 'ss'),
        };
        console.log(
          JSON.stringify(
            {
              days,
              scenario: opts.scenario ?? null,
              controls: opts.controls,
              samples,
              peak: worst,
              mean: {
                cod: Number(avg('cod').toFixed(3)),
                nh: Number(avg('nh').toFixed(3)),
                tn: Number(avg('tn').toFixed(3)),
                tp: Number(avg('tp').toFixed(4)),
                ss: Number(avg('ss').toFixed(3)),
              },
              compliant: {
                cod: worst.cod <= LIMITS.cod,
                nh: worst.nh <= LIMITS.nh,
                tn: worst.tn <= LIMITS.tn,
                tp: worst.tp <= LIMITS.tp,
                ss: worst.ss <= LIMITS.ss,
              },
              totals: {
                inflowM3: Number(totals.inflowM3.toFixed(1)),
                energyKwh: Number(totals.energyKwh.toFixed(1)),
                kwhPerM3: Number((totals.energyKwh / Math.max(1, totals.inflowM3)).toFixed(4)),
              },
              score: Number((samples.reduce((s, x) => s + x.score, 0) / samples.length).toFixed(1)),
            },
            null,
            2,
          ),
        );
      } else {
        printSummary(opts, samples, totals);
      }
      if (opts.csvPath) {
        writeCsv(opts.csvPath, samples);
        if (!parsed.values.json) console.log(`\n采样序列已写入 ${opts.csvPath}`);
      }
      return 0;
    }
    case 'report': {
      const { samples, totals } = runSimulation(opts);
      const lines = [
        `# AquaPilot 运营报告（离线仿真 ${days} 天）`,
        '',
        `- 生成时间：${new Date().toISOString()}`,
        opts.scenario ? `- 场景：${SCENARIOS[opts.scenario].label}` : '- 场景：常态进水',
        '',
        '## 出水达标情况',
        '',
        '| 指标 | 峰值 (mg/L) | 限值 | 结论 |',
        '|---|---|---|---|',
        `| COD | ${worstOf(samples, 'cod').toFixed(1)} | ${LIMITS.cod} | ${worstOf(samples, 'cod') <= LIMITS.cod ? '达标' : '超标'} |`,
        `| NH₃-N | ${worstOf(samples, 'nh').toFixed(2)} | ${LIMITS.nh} | ${worstOf(samples, 'nh') <= LIMITS.nh ? '达标' : '超标'} |`,
        `| TN | ${worstOf(samples, 'tn').toFixed(1)} | ${LIMITS.tn} | ${worstOf(samples, 'tn') <= LIMITS.tn ? '达标' : '超标'} |`,
        `| TP | ${worstOf(samples, 'tp').toFixed(3)} | ${LIMITS.tp} | ${worstOf(samples, 'tp') <= LIMITS.tp ? '达标' : '超标'} |`,
        `| SS | ${worstOf(samples, 'ss').toFixed(1)} | ${LIMITS.ss} | ${worstOf(samples, 'ss') <= LIMITS.ss ? '达标' : '超标'} |`,
        '',
        '## 能水耗',
        '',
        `- 处理水量：${totals.inflowM3.toFixed(0)} m³`,
        `- 电耗：${totals.energyKwh.toFixed(0)} kWh（吨水 ${(totals.energyKwh / Math.max(1, totals.inflowM3)).toFixed(3)} kWh/m³）`,
        `- 出水评分均值：${(samples.reduce((s, x) => s + x.score, 0) / samples.length).toFixed(0)}/100`,
        '',
      ];
      console.log(lines.join('\n'));
      return 0;
    }
    case 'bench': {
      // BSM1 开环稳态 vs 技术报告 Table 6 公开值（与 tests/bsm1-benchmark.test.ts 同源）
      const { runBsm1OpenLoopSteady, BSM1_TABLE6_EFFLUENT, tssOf, bsm1Asm1Params } = await import('./sim/bsm1');
      console.log('运行 BSM1 开环稳态（官方初始化，至稳态判据收敛）…');
      const result = runBsm1OpenLoopSteady({ params: bsm1Asm1Params(), maxDays: 200 });
      console.log(`\nBSM1 Table 6 对照（稳态 ${result.steadyDays} 天，收敛=${result.converged ? '是' : '否'}）\n`);
      // 关键红线：S_S / S_NO ±10%，S_NH ±25%，S_ALK ±10%，S_O ±20%（与回归测试同阈值）
      const checks: [string, number, number, number][] = [
        ['S_S', result.effluent.S_S, BSM1_TABLE6_EFFLUENT.S_S, 0.1],
        ['S_NO', result.effluent.S_NO, BSM1_TABLE6_EFFLUENT.S_NO, 0.1],
        ['S_NH', result.effluent.S_NH, BSM1_TABLE6_EFFLUENT.S_NH, 0.25],
        ['S_ALK', result.effluent.S_ALK, BSM1_TABLE6_EFFLUENT.S_ALK, 0.1],
        ['S_O', result.effluent.S_O, BSM1_TABLE6_EFFLUENT.S_O, 0.2],
      ];
      let pass = true;
      for (const [metric, actual, reference, gate] of checks) {
        const dev = Math.abs(actual - reference) / reference;
        if (dev > gate) pass = false;
        console.log(
          `  ${metric.padEnd(6)} 本仿真 ${actual.toFixed(3).padStart(9)}   参考 ${String(reference).padStart(9)}   ${dev <= gate ? '✓' : '✗'} (±${(gate * 100).toFixed(0)}%)`,
        );
      }
      const tss = tssOf(result.effluent);
      console.log(
        `  ${'tss'.padEnd(6)} 本仿真 ${tss.toFixed(3).padStart(9)}   参考 ${String(BSM1_TABLE6_EFFLUENT.tss).padStart(9)}   （对照，不设红线）`,
      );
      console.log(pass ? '\n关键指标全部落在容差内。' : '\n存在超出容差的红线指标，请检查参数或初始化。');
      return pass ? 0 : 1;
    }
    case 'calibrate': {
      const { calibrate, bsm1Predictor, bsm1SyntheticTarget } = await import('./sim/calibration');
      console.log('对合成目标运行参数辨识 + 坐标下降校准（BSM1 稳态预测器，带缓存）…');
      const result = calibrate(bsm1Predictor(), bsm1SyntheticTarget(), {});
      console.log('\n拟合参数：');
      for (const k of result.fitted) {
        console.log(`  ${k.padEnd(12)} ${(result.params[k as keyof typeof result.params] as number).toFixed(4)}`);
      }
      console.log('\n沿用文献值的参数：');
      console.log(`  ${result.fixed.join(', ')}`);
      console.log(
        `\n目标函数 ${result.objectiveBefore.toFixed(4)} → ${result.objectiveAfter.toFixed(4)}（改善 ${result.improvementPct.toFixed(1)}%）`,
      );
      return 0;
    }
    case 'serve': {
      // serve 才引入服务端（index.ts import 即启动），其余子命令零依赖
      if (parsed.values.port) process.env.PORT = String(parsed.values.port);
      if (parsed.values.host) process.env.HOST = String(parsed.values.host);
      await import('./server/index');
      return 0;
    }
    default:
      console.error(`未知命令：${command}\n`);
      console.log(usage());
      return 1;
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    console.error(`错误：${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
