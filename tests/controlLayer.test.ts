import { describe, expect, it } from 'vitest';
import {
  createControlLayer,
  ESD_ACTIVE,
  enableInterlocks,
  evaluateInterlocks,
  INTERLOCK_TRIPPED,
  resetEsd,
  resetInterlock,
  setManualOutput,
  stepLoop,
  stepPid,
  switchPidMode,
  triggerEsd,
} from '../src/sim/controlLayer';

describe('通用 PID', () => {
  it('设定值阶跃后输出先升后回落，始终在限幅内', () => {
    const layer = createControlLayer();
    const loop = layer.loops.do;
    switchPidMode(loop.pid, loop.params, 'auto');

    // 测量持续低于设定值：输出上升并顶到上限
    const early = stepLoop(layer, 'do', 1.0, 1);
    expect(early.output).toBeGreaterThan(0);

    // 测量回到设定值附近：输出回落
    let late = early;
    for (let i = 0; i < 20; i += 1) late = stepLoop(layer, 'do', 2.0, 1);
    expect(late.output).toBeLessThan(early.output);
    expect(late.output).toBeGreaterThanOrEqual(loop.params.outMin);
    expect(late.output).toBeLessThanOrEqual(loop.params.outMax);
  });

  it('输出限幅期间积分项冻结不继续增长（抗积分饱和）', () => {
    const layer = createControlLayer();
    const loop = layer.loops.do;
    switchPidMode(loop.pid, loop.params, 'auto');

    // 测量持续远低于设定值，输出正饱和
    const r1 = stepPid(loop.pid, loop.params, 0.0, 1);
    const r2 = stepPid(loop.pid, loop.params, 0.0, 1);
    expect(r1.saturated).toBe(true);
    expect(r2.saturated).toBe(true);
    expect(r2.integral).toBe(r1.integral);
  });

  it('手动切自动无扰：输出不出现突跳', () => {
    const layer = createControlLayer();
    const loop = layer.loops.do;
    setManualOutput(layer, 'do', 0.6);
    switchPidMode(loop.pid, loop.params, 'auto');
    const r = stepPid(loop.pid, loop.params, 2.0, 1);
    expect(r.output).toBeCloseTo(0.6, 6);
  });
});

describe('联锁矩阵：锁存、回差与显式复位', () => {
  it('DO 低触发风机拉满并锁存；回差内恢复不自动解除，复位需条件退到回差外', () => {
    const layer = createControlLayer();
    enableInterlocks(layer, true);

    evaluateInterlocks(layer, { do: 0.5, nh: 20, blanket: 2, level: 3, fanFault: false, esd: false }, 1);
    const tripped = layer.interlocks.find((s) => s.conditionId === 'do-low');
    expect(tripped?.tripped).toBe(true);
    expect(tripped?.latched).toBe(true);

    // 联锁覆盖 DO 回路：风机拉满
    const loopOut = stepLoop(layer, 'do', 0.5, 1);
    expect(loopOut.source).toBe('interlock');
    expect(loopOut.output).toBeCloseTo(1, 6);

    // 回到 1.2：高于动作阈值 1.0，但未达复位阈值 1.0+0.3=1.3
    evaluateInterlocks(layer, { do: 1.2, nh: 20, blanket: 2, level: 3, fanFault: false, esd: false }, 1);
    expect(tripped?.armed).toBe(false);
    expect(resetInterlock(layer, 'do-low')).toBe(false);
    expect(tripped?.latched).toBe(true);

    // 回到 1.4：退到回差之外，允许显式复位
    evaluateInterlocks(layer, { do: 1.4, nh: 20, blanket: 2, level: 3, fanFault: false, esd: false }, 1);
    expect(tripped?.armed).toBe(true);
    expect(resetInterlock(layer, 'do-low')).toBe(true);
    expect(tripped?.latched).toBe(false);
  });

  it('风机故障跳闸锁存，布尔型故障不能靠信号自然复位', () => {
    const layer = createControlLayer();
    enableInterlocks(layer, true);
    evaluateInterlocks(layer, { do: 2, nh: 20, blanket: 2, level: 3, fanFault: true, esd: false }, 1);
    const trip = layer.interlocks.find((s) => s.conditionId === 'fan-fault');
    expect(trip?.tripped).toBe(true);
    evaluateInterlocks(layer, { do: 2, nh: 20, blanket: 2, level: 3, fanFault: false, esd: false }, 1);
    expect(trip?.armed).toBe(false);
    expect(resetInterlock(layer, 'fan-fault')).toBe(false);
  });
});

describe('ESD 与指令审计', () => {
  it('ESD 期间输出进安全位、拒绝手动指令并留审计；复位后恢复', () => {
    const layer = createControlLayer();
    triggerEsd(layer, 'plant');

    const rejected = setManualOutput(layer, 'do', 0.8);
    expect(rejected).toBe(false);
    const audit = layer.audit[layer.audit.length - 1];
    expect(audit.code).toBe(ESD_ACTIVE);
    expect(audit.status).toBe('rejected');

    const safety = stepLoop(layer, 'do', 1.5, 1);
    expect(safety.source).toBe('esd');
    expect(safety.output).toBeCloseTo(layer.loops.do.params.outMin, 6);

    resetEsd(layer);
    expect(setManualOutput(layer, 'do', 0.7)).toBe(true);
  });

  it('联锁跳闸期间手动指令被拒并记录 INTERLOCK_TRIPPED', () => {
    const layer = createControlLayer();
    enableInterlocks(layer, true);
    evaluateInterlocks(layer, { do: 2, nh: 20, blanket: 2, level: 3, fanFault: true, esd: false }, 1);
    expect(setManualOutput(layer, 'ras', 1.2)).toBe(false);
    expect(layer.audit.some((a) => a.code === INTERLOCK_TRIPPED && a.status === 'rejected')).toBe(true);
  });
});
