/**
 * WP4 第二阶段：仪表/执行机构/控制层/资产接入引擎的集成测试。
 *
 * 口径：默认仪表理想、执行机构直通、资产全部可用，既有基线数值零扰动；
 * 故障、联锁、ESD、备机自启只在本文件里单独注入，验证测量与真值分离、
 * 联锁动作落到真实物理量、快照与只读路由契约可见。
 */
import { describe, expect, it } from 'vitest';
import { createNetworkState, networkModel, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import { addInstrument, measure, readingOf, type InstrumentRegistry } from '../src/sim/instruments';
import {
  capacityFactorFor,
  injectFault,
  resetEsd as assetResetEsd,
  triggerEsd as assetTriggerEsd,
} from '../src/sim/assets';
import {
  createControlLayer,
  enableInterlocks,
  evaluateInterlocks,
  interlockActive,
  resetInterlock,
  setManualOutput,
} from '../src/sim/controlLayer';
import { instrumentsRoute } from '../src/server/routes/instruments';
import { createShadowPlant, summarizeBenchmark } from '../src/server/benchmark';
import { createSnapshotService, type SnapshotSource } from '../src/server/snapshotView';

function steadyState(seed = 7) {
  const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed }), PLANT_TOPOLOGY, 30);
  // 测试内不做概率性随机故障，避免干扰因子与 DO 断言；确定性注入走 injectFault
  if (s.assets) s.assets.defaults.enableProbabilisticFaults = false;
  return s;
}

const step = (s: ReturnType<typeof steadyState>, dt = 1) => stepNetwork(s, PLANT_TOPOLOGY, dt);

function makeService(net: ReturnType<typeof steadyState>) {
  const source: SnapshotSource = {
    topology: PLANT_TOPOLOGY,
    net,
    trend: [],
    speed: 1,
    paused: false,
    recommendation: null,
    forecastCache: { key: null, value: null },
    shadow: createShadowPlant(PLANT_TOPOLOGY, 5, 0),
  };
  return createSnapshotService({ source: () => source, forecastFor: () => null, summarizeBenchmark });
}

describe('WP4 引擎接线', () => {
  it('默认初始化仪表/控制层/资产三个子系统，风机组因子为 1', () => {
    const s = steadyState();
    expect(s.instruments).toBeDefined();
    expect(s.controlLayer).toBeDefined();
    expect(s.assets).toBeDefined();
    expect(s.instruments!.registry.instruments.length).toBeGreaterThan(10);
    // 无故障时因子接近 1；健康度随运行时长轻微衰减属资产模块既有口径
    expect(capacityFactorFor(s.assets!, 'blower:blower')).toBeGreaterThan(0.9);
  });

  it('理想仪表读数与真值逐位一致，质量码全 good', () => {
    const s = steadyState();
    for (const r of s.instruments!.readings) {
      if (r.measured === null) continue;
      const truth = s.instruments!.truth[r.sensorId];
      expect(r.quality, r.sensorId).toBe('good');
      expect(r.measured, r.sensorId).toBeCloseTo(truth, 9);
    }
  });

  it('全量帧与增量帧都带 instruments / controlLayer / assets 三字段', () => {
    const s = steadyState();
    const service = makeService(s);
    const snap = service.buildSnapshot();
    expect(snap).toHaveProperty('instruments');
    expect(snap).toHaveProperty('controlLayer');
    expect(snap).toHaveProperty('assets');

    const [patch] = service.buildPatches([{ lastTrendT: -1 }]);
    expect(patch).toHaveProperty('instruments');
    expect(patch).toHaveProperty('controlLayer');
    expect(patch).toHaveProperty('assets');
  });

  it('stuck 探头读数冻结、质量码 bad，真值变化不带动读数', () => {
    const s = steadyState();
    const inst = s.instruments!.registry.instruments.find((i) => i.spec.id === 'aerobic1:do')!;
    inst.spec.fault = 'stuck';
    inst.stuckValue = null;

    step(s);
    const r1 = readingOf(s.instruments!, 'aerobic1:do')!;
    const frozen = r1.measured!;
    for (let i = 0; i < 4; i += 1) step(s);
    const r2 = readingOf(s.instruments!, 'aerobic1:do')!;

    expect(r1.quality).toBe('bad');
    expect(r2.quality).toBe('bad');
    expect(r2.measured).toBeCloseTo(frozen, 9);
  });

  it('漂移累积 120 min 后正偏差落在漂移率折算区间内', () => {
    const s = steadyState();
    const inst = s.instruments!.registry.instruments.find((i) => i.spec.id === 'aerobic1:nh')!;
    inst.spec.fault = 'drift';
    inst.spec.driftPerDay = 0.2;
    inst.spec.noiseStd = 0;
    inst.spec.tauMin = 0;
    inst.spec.deadTimeMin = 0;
    inst.driftOffset = 0;

    for (let i = 0; i < 120; i += 1) step(s, 1);
    const reading = readingOf(s.instruments!, 'aerobic1:nh')!;
    const truth = s.instruments!.truth['aerobic1:nh'];
    const bias = reading.measured! - truth;
    // 期望偏差 = 0.2 单位/天 × 120/1440 天 ≈ 0.0167
    expect(bias).toBeGreaterThan(0.01);
    expect(bias).toBeLessThan(0.03);
  });

  it('死时间内阶跃不响应，到期后才跟随（注册表挂接口径）', () => {
    const registry: InstrumentRegistry = { seed: 1, timeMin: 0, instruments: [] };
    addInstrument(registry, {
      id: 'test:do',
      unitId: 'test',
      variable: 'do',
      min: 0,
      max: 12,
      tauMin: 0,
      deadTimeMin: 2,
      noiseStd: 0,
      driftPerDay: 0,
      fault: 'none',
    });

    measure(registry, { 'test:do': 2 }, 1);
    measure(registry, { 'test:do': 2 }, 1);
    // 阶跃到 6：死时间 2 min，前两步读数保持 2
    const r3 = measure(registry, { 'test:do': 6 }, 1)[0];
    const r4 = measure(registry, { 'test:do': 6 }, 1)[0];
    expect(r3.measured).toBeCloseTo(2, 6);
    expect(r4.measured).toBeCloseTo(2, 6);
    const r5 = measure(registry, { 'test:do': 6 }, 1)[0];
    expect(r5.measured).toBeCloseTo(6, 6);
  });

  it('DO 低联锁触发后风机拉满、锁存，后续曝气把 DO 托回', () => {
    const s = steadyState();
    enableInterlocks(s.controlLayer!, true);
    for (const r of s.reactors) if (r.kind === 'aerobic') r.doLevel = 0.4;

    step(s);
    const layer = s.controlLayer!;
    const inter = layer.interlocks.find((i) => i.conditionId === 'do-low')!;

    expect(inter.tripped).toBe(true);
    expect(inter.latched).toBe(true);
    expect(interlockActive(layer, 'fanMax')).toBe(true);
    expect(layer.outputs.do).toBeCloseTo(1, 6);
    expect(s.aerationCapacity).toBeGreaterThan(0.9);

    const beforeDo = s.reactors[s.reactors.length - 1]!.doLevel;
    for (let i = 0; i < 10; i += 1) step(s);
    const afterDo = s.reactors[s.reactors.length - 1]!.doLevel;
    expect(afterDo).toBeGreaterThan(beforeDo);
  });

  it('联锁回差内拒绝复位，退到回差之外才允许显式复位', () => {
    const layer = createControlLayer();
    enableInterlocks(layer, true);
    evaluateInterlocks(layer, { do: 0.8, nh: 20, blanket: 1, level: 1, fanFault: false, esd: false }, 1);
    const inter = layer.interlocks.find((i) => i.conditionId === 'do-low')!;
    expect(inter.tripped).toBe(true);

    // DO=1.2 仍在动作阈值 1.0 与复位阈值 1.3 之间，未出回差
    evaluateInterlocks(layer, { do: 1.2, nh: 20, blanket: 1, level: 1, fanFault: false, esd: false }, 1);
    expect(resetInterlock(layer, 'do-low')).toBe(false);
    expect(inter.latched).toBe(true);

    // DO=1.4 ≥ 1.3，出回差，允许显式复位
    evaluateInterlocks(layer, { do: 1.4, nh: 20, blanket: 1, level: 1, fanFault: false, esd: false }, 1);
    expect(resetInterlock(layer, 'do-low')).toBe(true);
    expect(inter.tripped).toBe(false);
  });

  it('风机主机故障降容使 DO 回落，备机 5 min 自启后因子恢复', () => {
    const s = steadyState();
    const baseDo = s.reactors[s.reactors.length - 1]!.doLevel;

    expect(injectFault(s.assets!, 'blower-blower-1', 'MOTOR_OVERLOAD')).toBe(true);
    // 故障瞬间：主机停一台，备机尚未自启，可用能力约减半
    expect(capacityFactorFor(s.assets!, 'blower:blower')).toBeLessThan(0.7);

    for (let i = 0; i < 3; i += 1) step(s, 1);
    const factorFault = capacityFactorFor(s.assets!, 'blower:blower');
    const faultDo = s.reactors[s.reactors.length - 1]!.doLevel;
    expect(factorFault).toBeLessThan(0.7);
    expect(faultDo).toBeLessThanOrEqual(baseDo + 1e-9);

    // 备机延时 5 min 已过，自启后两台运行，因子回到 0.8 以上
    for (let i = 0; i < 12; i += 1) step(s, 1);
    expect(capacityFactorFor(s.assets!, 'blower:blower')).toBeGreaterThan(0.8);
  });

  it('ESD 触发后执行机构进安全位，手动指令被拒绝并写审计', () => {
    const s = steadyState();
    assetTriggerEsd(s.assets!, {});
    step(s);

    const layer = s.controlLayer!;
    expect(layer.esd.active).toBe(true);
    expect(layer.outputs.do).toBeCloseTo(0, 6);
    expect(s.aerationCapacity).toBeCloseTo(0, 6);

    const rejected = setManualOutput(layer, 'do', 0.8);
    expect(rejected).toBe(false);
    const esdAudit = layer.audit.filter((a) => a.code === 'ESD_ACTIVE');
    expect(esdAudit.length).toBeGreaterThan(0);

    assetResetEsd(s.assets!);
  });

  it('/api/instruments 与 /api/control/interlocks 路由返回 200 与契约字段，未知参数 404', () => {
    const s = steadyState();

    const instReply = instrumentsRoute('/api/instruments', new URL('http://x/api/instruments'), { state: s });
    expect(instReply!.status).toBe(200);
    const instBody = instReply!.body as { count: number; readings: unknown[] };
    expect(instBody.count).toBeGreaterThan(0);
    expect(instBody.readings.length).toBe(instBody.count);

    const badSensor = instrumentsRoute('/api/instruments', new URL('http://x/api/instruments?sensor=nope:sensor'), {
      state: s,
    });
    expect(badSensor!.status).toBe(404);

    const ctrlReply = instrumentsRoute('/api/control/interlocks', new URL('http://x/api/control/interlocks'), {
      state: s,
    });
    expect(ctrlReply!.status).toBe(200);
    const ctrlBody = ctrlReply!.body as {
      outputs: Record<string, number>;
      interlocks: unknown[];
      audit: unknown[];
      esd: { active: boolean };
    };
    expect(ctrlBody.interlocks.length).toBe(6);
    expect(Array.isArray(ctrlBody.audit)).toBe(true);
    expect(ctrlBody.outputs).toHaveProperty('do');
    expect(ctrlBody.esd.active).toBe(false);

    const badCond = instrumentsRoute(
      '/api/control/interlocks',
      new URL('http://x/api/control/interlocks?condition=nope'),
      { state: s },
    );
    expect(badCond!.status).toBe(404);
  });

  it('预测推演克隆子系统，不污染实时状态（JSON 深比较）', () => {
    const s = steadyState();
    const before = JSON.stringify(s);
    networkModel(PLANT_TOPOLOGY, s).predict(s.controls, 20, 5);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('spin-up 把主时钟与仪表/控制层时钟一起归零，快照时间轴不错位', () => {
    const s = spinUpNetwork(createNetworkState(PLANT_TOPOLOGY, { seed: 11 }), PLANT_TOPOLOGY, 2);
    expect(s.timeMin).toBe(0);
    expect(s.instruments?.registry.timeMin).toBe(0);
    expect(s.controlLayer?.timeMin).toBe(0);
  });
});
