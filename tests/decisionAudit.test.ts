import { describe, expect, it } from 'vitest';
import { decisionFingerprint, shouldRecordDecision } from '../src/server/decisionAudit';

const rec = (summary: string, action: 'hold' | 'adjust' = 'hold', severity: 'normal' | 'critical' = 'critical') => ({
  action,
  severity,
  summary,
});

describe('决策审计去重', () => {
  it('第一条决策总是落库', () => {
    expect(shouldRecordDecision(null, rec('结构性 SS 风险'), 100)).toBe(true);
  });

  it('同指纹在一小时内只落一次', () => {
    const r = rec('结构性 SS 风险');
    const last = { key: decisionFingerprint(r), atMin: 100 };
    expect(shouldRecordDecision(last, r, 130)).toBe(false);
    expect(shouldRecordDecision(last, r, 159)).toBe(false);
  });

  it('满一小时后允许再次落库', () => {
    const r = rec('结构性 SS 风险');
    const last = { key: decisionFingerprint(r), atMin: 100 };
    expect(shouldRecordDecision(last, r, 160)).toBe(true);
  });

  it('摘要变化立即落库', () => {
    const last = { key: decisionFingerprint(rec('结构性 SS 风险')), atMin: 100 };
    expect(shouldRecordDecision(last, rec('预测出现新的 NH 风险'), 101)).toBe(true);
  });

  it('人工强制刷新不受窗口限制', () => {
    const r = rec('结构性 SS 风险');
    const last = { key: decisionFingerprint(r), atMin: 100 };
    expect(shouldRecordDecision(last, r, 101, { force: true })).toBe(true);
  });
});
