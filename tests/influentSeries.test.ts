import { describe, expect, it } from 'vitest';
import {
  bsm2ConstantSeries,
  parseInfluentCsv,
  sampleAt,
  seriesStats,
  type InfluentSeries,
} from '../src/sim/influentSeries';
import { createNetworkState, spinUpNetwork, stepNetwork } from '../src/sim/networkEngine';
import { PLANT_TOPOLOGY } from '../src/model/topology';

/**
 * 真实进水序列。
 *
 * 竞品对标得出的能力缺口：bsm2-python 有 `dyninfluent_bsm2.csv`（609 天
 * 逐 15 分钟的真实历史），QSDsan 有 DynamicInfluent 单元。我们此前只有
 * 「正弦昼夜节律 + 白噪声」——同一天永远一样，生成不出暴雨延迟稀释、
 * 工业排口周期冲击这些真实结构。
 */

describe('CSV 解析', () => {
  it('解析带表头的标准格式', () => {
    const csv = [
      'minute,flow,cod,nh,tp,ss,temperature',
      '0,2000,350,34,4.8,180,20',
      '60,2100,360,35,5,185,20.1',
      '120,2200,370,36,5.2,190,20.2',
    ].join('\n');
    const s = parseInfluentCsv(csv);
    expect(s.samples).toHaveLength(3);
    expect(s.samples[1].flow).toBe(2100);
    expect(s.durationMin).toBe(120);
    expect(s.warnings).toEqual([]);
  });

  it('无表头也能解析', () => {
    const s = parseInfluentCsv('0,2000,350,34,4.8,180,20\n60,2100,360,35,5,185,21');
    expect(s.samples).toHaveLength(2);
  });

  it('跳过坏行并报告行号，不整份拒绝', () => {
    const csv = ['0,2000,350,34,4.8,180,20', 'bad,row', '60,2100,360,35,5,185,21'].join('\n');
    const s = parseInfluentCsv(csv);
    expect(s.samples).toHaveLength(2);
    expect(s.warnings.some((w) => /无法解析/.test(w))).toBe(true);
  });

  it('解析保留原始越界值（供质量校验发现），取样时才夹紧', () => {
    const s = parseInfluentCsv('0,99999,999999,999,999,99999,99');
    // 解析层不吞掉问题：质量校验必须能看到 99999
    expect(s.samples[0].flow).toBe(99999);
    // 取样进引擎前夹紧，保证物理安全
    const sample = sampleAt(s, 0);
    expect(sample.flow).toBeLessThanOrEqual(5200);
    expect(sample.cod).toBeLessThanOrEqual(1400);
    expect(sample.nh).toBeLessThanOrEqual(120);
    expect(sample.temperature).toBeLessThanOrEqual(31);
  });

  it('重复时刻保留最后一条（修订语义）', () => {
    const s = parseInfluentCsv('0,2000,350,34,4.8,180,20\n0,2500,400,40,5,200,21');
    expect(s.samples).toHaveLength(1);
    expect(s.samples[0].flow).toBe(2500);
    expect(s.warnings.some((w) => /重复/.test(w))).toBe(true);
  });

  it('乱序时间被排序', () => {
    const s = parseInfluentCsv('120,2200,370,36,5.2,190,20\n0,2000,350,34,4.8,180,20\n60,2100,360,35,5,185,20');
    expect(s.samples.map((x) => x.minute)).toEqual([0, 60, 120]);
  });

  it('空文件与全坏行给出明确原因', () => {
    expect(parseInfluentCsv('').warnings).toContain('文件为空');
    expect(parseInfluentCsv('bad\nworse').warnings.some((w) => /没有任何可用/.test(w))).toBe(true);
  });

  it('忽略注释行', () => {
    const s = parseInfluentCsv('# 这是注释\n0,2000,350,34,4.8,180,20');
    expect(s.samples).toHaveLength(1);
  });
});

describe('插值', () => {
  const series: InfluentSeries = {
    name: 'test',
    samples: [
      { minute: 0, flow: 1000, cod: 300, nh: 30, tp: 4, ss: 170, temperature: 15 },
      { minute: 100, flow: 2000, cod: 400, nh: 40, tp: 6, ss: 270, temperature: 25 },
    ],
    durationMin: 100,
    warnings: [],
  };

  it('中点线性插值', () => {
    const s = sampleAt(series, 50);
    expect(s.flow).toBeCloseTo(1500, 6);
    expect(s.cod).toBeCloseTo(350, 6);
    expect(s.temperature).toBeCloseTo(20, 6);
  });

  it('端点精确命中', () => {
    expect(sampleAt(series, 0).flow).toBe(1000);
    expect(sampleAt(series, 100).flow).toBe(1000); // 循环回起点
  });

  it('超出末尾后循环（长仿真可复用 24h 剖面）', () => {
    const at50 = sampleAt(series, 50).flow;
    const at150 = sampleAt(series, 150).flow;
    expect(at150).toBeCloseTo(at50, 6);
  });

  it('单点序列恒定', () => {
    const one = { ...series, samples: [series.samples[0]], durationMin: 0 };
    expect(sampleAt(one, 999).flow).toBe(1000);
  });

  it('空序列回落到设计值', () => {
    const empty = { name: 'empty', samples: [], durationMin: 0, warnings: [] };
    const s = sampleAt(empty, 0);
    expect(s.flow).toBeGreaterThan(0);
    expect(Number.isFinite(s.cod)).toBe(true);
  });

  it('二分查找在大序列上正确', () => {
    const big: InfluentSeries = {
      name: 'big',
      samples: Array.from({ length: 2000 }, (_, i) => ({
        minute: i * 15,
        flow: 1000 + i,
        cod: 300,
        nh: 30,
        tp: 4,
        ss: 170,
        temperature: 15,
      })),
      durationMin: 1999 * 15,
      warnings: [],
    };
    // 第 1000 个点的正中
    const s = sampleAt(big, 999 * 15 + 7.5);
    expect(s.flow).toBeCloseTo(1999.5, 1);
  });
});

describe('统计摘要', () => {
  it('给出均值、峰值与温度范围', () => {
    const series = parseInfluentCsv('0,1000,300,30,4,170,15\n60,3000,500,50,8,300,25');
    const s = seriesStats(series)!;
    expect(s.points).toBe(2);
    expect(s.flowMean).toBe(2000);
    expect(s.flowPeak).toBe(3000);
    expect(s.codPeak).toBe(500);
    expect(s.temperatureRange).toEqual([15, 25]);
  });

  it('空序列返回 null', () => {
    expect(seriesStats({ name: 'x', samples: [], durationMin: 0, warnings: [] })).toBeNull();
  });
});

describe('内置 BSM2 恒定进水', () => {
  it('数值来自技术报告量级', () => {
    const s = bsm2ConstantSeries();
    expect(s.samples).toHaveLength(1);
    expect(s.samples[0].flow).toBeCloseTo(768.6, 1);
    expect(s.samples[0].temperature).toBe(15);
  });
});

describe('引擎接线', () => {
  it('加载序列后进水由序列驱动（不再走合成模型）', () => {
    const series = parseInfluentCsv('0,3000,800,80,12,500,25\n1440,3000,800,80,12,500,25');
    const net = createNetworkState(PLANT_TOPOLOGY, { seed: 7 });
    net.influentSeries = series;
    spinUpNetwork(net, PLANT_TOPOLOGY, 5);
    // 预热后重新挂上（spinUp 会推进时间）
    net.influentSeries = series;
    stepNetwork(net, PLANT_TOPOLOGY, 1);
    // 序列值是 3000/800/80，合成模型是 2000/350/34 —— 差异必须体现出来
    expect(net.influent.flow).toBeGreaterThan(2900);
    expect(net.influent.cod).toBeGreaterThan(780);
    expect(net.influent.nh).toBeGreaterThan(78);
  });

  it('未加载序列时行为与之前一致（合成模型）', () => {
    const net = createNetworkState(PLANT_TOPOLOGY, { seed: 7 });
    spinUpNetwork(net, PLANT_TOPOLOGY, 5);
    stepNetwork(net, PLANT_TOPOLOGY, 1);
    expect(net.influent.flow).toBeGreaterThan(1500);
    expect(net.influent.flow).toBeLessThan(2600);
  });

  it('序列模式下场景仍然生效（暴雨必须放大流量）', () => {
    const series = parseInfluentCsv('0,2000,350,34,4.8,180,20\n1440,2000,350,34,4.8,180,20');
    const net = createNetworkState(PLANT_TOPOLOGY, { seed: 7 });
    net.influentSeries = series;
    spinUpNetwork(net, PLANT_TOPOLOGY, 5);
    net.influentSeries = series;
    const baseline = (() => {
      stepNetwork(net, PLANT_TOPOLOGY, 1);
      return net.influent.flow;
    })();
    net.scenario = { type: 'storm', durationMin: 60, magnitude: 1, startedAt: net.timeMin };
    for (let i = 0; i < 30; i++) stepNetwork(net, PLANT_TOPOLOGY, 1);
    // 暴雨把流量抬高（合成模型和序列模型都必须如此）
    expect(net.influent.flow).toBeGreaterThan(baseline);
  });
});
