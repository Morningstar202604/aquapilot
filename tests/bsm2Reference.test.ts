import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BSM2_CONST_INFLUENT_CSV } from '../src/sim/data/bsm2ConstInfluent';
import {
  BSM2_INFLUENT_COLUMNS,
  parseBsm2InfluentCsv,
  parseBsm2InfluentRow,
  toConventional,
} from '../src/sim/data/bsm2Reference';
import { bsm2ConstantSeries } from '../src/sim/influentSeries';

/**
 * IWA BSM2 官方进水基准的真实性测试。
 *
 * 这组测试守的是一条容易被悄悄破坏的性质：**内联常量必须和磁盘上的
 * 官方文件逐字节一致**。任何人「顺手调一下数字让结果好看」都会在这里失败，
 * 从而保证 README/BENCHMARKS 里那句「取自官方数据」始终成立。
 */

const OFFICIAL_CSV = join(import.meta.dirname, '..', 'src', 'sim', 'data', 'constinfluent_bsm2.csv');

describe('BSM2 官方进水向量', () => {
  it('内联常量与磁盘上的上游原文件逐字节一致', () => {
    const onDisk = readFileSync(OFFICIAL_CSV, 'utf8').replace(/\r\n/g, '\n').trim();
    const inline = BSM2_CONST_INFLUENT_CSV.replace(/\r\n/g, '\n').trim();
    expect(inline).toBe(onDisk);
  });

  it('文件是两行、每行 22 列', () => {
    const rows = parseBsm2InfluentCsv(BSM2_CONST_INFLUENT_CSV);
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0])).toHaveLength(BSM2_INFLUENT_COLUMNS.length);
    expect(BSM2_INFLUENT_COLUMNS).toHaveLength(22);
  });

  it('列数与预期不符时抛错，而不是静默截断', () => {
    expect(() => parseBsm2InfluentRow('1,2,3')).toThrow(/22 列/);
  });

  it('非数值单元格抛错', () => {
    const cells = new Array(22).fill('1');
    cells[5] = 'n/a';
    expect(() => parseBsm2InfluentRow(cells.join(','))).toThrow(/不是有限数值/);
  });

  it('两行时间点与上游一致（0 d 与 1000 d）', () => {
    const rows = parseBsm2InfluentCsv(BSM2_CONST_INFLUENT_CSV);
    expect(rows[0].time).toBe(0);
    expect(rows[1].time).toBe(1000);
  });
});

describe('ASM1 组分 → 常规指标换算', () => {
  const [row] = parseBsm2InfluentCsv(BSM2_CONST_INFLUENT_CSV);

  it('总 COD 是七个含碳组分的加和', () => {
    const expected = row.SI + row.SS + row.XI + row.XS + row.XBH + row.XBA + row.XP;
    expect(toConventional(row, 1).cod).toBeCloseTo(expected, 6);
    // 与官方向量手算值对齐，防止组分顺序被改动
    expect(expected).toBeCloseTo(592.53, 1);
  });

  it('流量按 m³/d → m³/h 换算（20648/24 = 860.35）', () => {
    expect(toConventional(row, 1).flow).toBeCloseTo(860.35, 2);
  });

  it('氨氮与 TSS 直接取官方值', () => {
    const c = toConventional(row, 1);
    expect(c.nh).toBeCloseTo(23.86, 2);
    expect(c.ss).toBeCloseTo(380.34, 1);
  });

  it('碱度按 CaCO₃ 当量换算（7 mol/m³ × 50 = 350 g/m³）', () => {
    expect(toConventional(row, 1).alkalinity).toBeCloseTo(350, 6);
  });

  it('总磷由调用方显式给出，并标记为 substituted', () => {
    const c = toConventional(row, 4.2);
    expect(c.tp).toBe(4.2);
    expect(c.provenance.substituted).toContain('tp');
    expect(c.provenance.official).not.toContain('tp');
  });
});

describe('内置序列与官方数据一致', () => {
  it('不再出现手写近似值（COD 300 / NH 31.6 / SS 171）', () => {
    const sample = bsm2ConstantSeries().samples[0];
    expect(sample.cod).toBeCloseTo(592.53, 1);
    expect(sample.nh).toBeCloseTo(23.86, 2);
    expect(sample.ss).toBeCloseTo(380.34, 1);
    expect(sample.flow).toBeCloseTo(860.35, 2);
  });

  it('温度不再是凑整的 15 ℃', () => {
    expect(bsm2ConstantSeries().samples[0].temperature).toBeCloseTo(14.858, 3);
  });

  it('序列自带「总磷为替代值」的告警，界面能如实展示', () => {
    const warnings = bsm2ConstantSeries().warnings.join(' ');
    expect(warnings).toMatch(/总磷/);
  });
});
