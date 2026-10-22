import { describe, expect, it } from 'vitest';
import {
  sanitizeBoolean,
  sanitizeChatText,
  sanitizeControlPatch,
  sanitizeMessage,
  sanitizeRange,
  sanitizeSpeed,
} from '../src/server/validation';
import { BSM1_SETTLER, createSettler, stepSettler } from '../src/sim/takacs';

/**
 * 健壮性回归测试。
 *
 * 每一条都对应一个真实修复过的崩溃/挂死点（由独立工程审计复现）。
 * 这些测试的目的不是覆盖率，而是防止同类输入再次打穿服务端。
 */

describe('消息形状校验', () => {
  it('拒绝 null / 数组 / 基本类型', () => {
    expect(sanitizeMessage(null)).toBeNull();
    expect(sanitizeMessage([])).toBeNull();
    expect(sanitizeMessage('string')).toBeNull();
    expect(sanitizeMessage(42)).toBeNull();
  });

  it('拒绝缺少 type 或 type 非字符串', () => {
    expect(sanitizeMessage({})).toBeNull();
    expect(sanitizeMessage({ type: 123 })).toBeNull();
    expect(sanitizeMessage({ type: '' })).toBeNull();
  });

  it('接受合法消息', () => {
    expect(sanitizeMessage({ type: 'hello' })).not.toBeNull();
    expect(sanitizeMessage({ type: 'control', patch: {} })).not.toBeNull();
  });
});

describe('控制量校验', () => {
  it('拒绝 null / 非对象', () => {
    expect(sanitizeControlPatch(null).ok).toBe(false);
    expect(sanitizeControlPatch([]).ok).toBe(false);
    expect(sanitizeControlPatch('x').ok).toBe(false);
  });

  it('拒绝 null / NaN / Infinity 数值', () => {
    expect(sanitizeControlPatch({ doSetpoint: null }).ok).toBe(false);
    expect(sanitizeControlPatch({ doSetpoint: NaN }).ok).toBe(false);
    expect(sanitizeControlPatch({ doSetpoint: Infinity }).ok).toBe(false);
    expect(sanitizeControlPatch({ rasRatio: 'abc' }).ok).toBe(false);
  });

  it('拒绝超出物理范围的数值', () => {
    expect(sanitizeControlPatch({ doSetpoint: 1e9 }).ok).toBe(false);
    expect(sanitizeControlPatch({ rasRatio: -5 }).ok).toBe(false);
    expect(sanitizeControlPatch({ wasRatio: 1e9 }).ok).toBe(false);
    expect(sanitizeControlPatch({ pacDose: 1e6 }).ok).toBe(false);
  });

  it('接受合法值并只保留已知键', () => {
    const r = sanitizeControlPatch({ doSetpoint: 2.5, unknownKey: 99 });
    expect(r.ok).toBe(true);
    expect(r.value?.doSetpoint).toBe(2.5);
    expect(r.value && 'unknownKey' in r.value).toBe(false);
  });

  it('空补丁合法（无操作）', () => {
    expect(sanitizeControlPatch({}).ok).toBe(true);
  });
});

describe('倍速 / 布尔 / 文本校验', () => {
  it('倍速拒绝非数值与越界', () => {
    expect(sanitizeSpeed('abc')).toBeNull();
    expect(sanitizeSpeed(NaN)).toBeNull();
    expect(sanitizeSpeed(0)).toBeNull();
    expect(sanitizeSpeed(100)).toBeNull();
    expect(sanitizeSpeed(2)).toBe(2);
  });

  it('布尔拒绝非布尔', () => {
    expect(sanitizeBoolean('true')).toBeNull();
    expect(sanitizeBoolean(1)).toBeNull();
    expect(sanitizeBoolean(true)).toBe(true);
  });

  it('文本拒绝空与超长', () => {
    expect(sanitizeChatText('')).toBeNull();
    expect(sanitizeChatText('   ')).toBeNull();
    expect(sanitizeChatText('a'.repeat(2001))).toBeNull();
    expect(sanitizeChatText('x'.repeat(2000))).not.toBeNull();
  });

  it('范围校验在越界时回退默认值', () => {
    expect(sanitizeRange(NaN, 10, 100, 42)).toBe(42);
    expect(sanitizeRange(5, 10, 100, 42)).toBe(42);
    expect(sanitizeRange(500, 10, 100, 42)).toBe(42);
    expect(sanitizeRange(50, 10, 100, 42)).toBe(50);
  });
});

describe('二沉池非法几何不得挂死', () => {
  it('depth=0 立即返回而不是无限循环', () => {
    const cfg = { ...BSM1_SETTLER, area: 1500, depth: 0 };
    const t0 = Date.now();
    const r = stepSettler(
      createSettler({ ...cfg, depth: 0.001 }),
      cfg,
      { flow: 1000, concentration: 3000 },
      { flow: 800 },
      1 / 1440,
    );
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(Number.isFinite(r.xEffluent)).toBe(true);
  });

  it('area=0 立即返回', () => {
    const cfg = { ...BSM1_SETTLER, area: 0, depth: 4 };
    const t0 = Date.now();
    const r = stepSettler(createSettler(cfg, 3000), cfg, { flow: 1000, concentration: 3000 }, { flow: 800 }, 1 / 1440);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(Number.isFinite(r.xEffluent)).toBe(true);
  });

  it('NaN 几何不产生 NaN 输出', () => {
    const cfg = { ...BSM1_SETTLER, area: NaN, depth: 4 };
    const r = stepSettler(createSettler(cfg, 3000), cfg, { flow: 1000, concentration: 3000 }, { flow: 800 }, 1 / 1440);
    expect(Number.isFinite(r.xEffluent)).toBe(true);
  });
});
