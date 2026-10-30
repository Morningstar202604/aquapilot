import { describe, expect, it } from 'vitest';
import {
  ADAPTER_CAPABILITIES,
  CsvReplayAdapter,
  DataSourceChain,
  SimulatorAdapter,
  UnavailableAdapter,
  type DataSourceAdapter,
} from '../src/sim/dataSources';
import { parseInfluentCsv } from '../src/sim/influentSeries';

const design = { flow: 2000, cod: 350, nh: 34, tp: 4.8, ss: 180, temperature: 20 };

describe('adapter capabilities', () => {
  it('marks simulator and csv as implemented, mqtt/opcua as not', () => {
    const byKind = Object.fromEntries(ADAPTER_CAPABILITIES.map((a) => [a.kind, a]));
    expect(byKind.simulator.implemented).toBe(true);
    expect(byKind.csv.implemented).toBe(true);
    expect(byKind.mqtt.implemented).toBe(false);
    expect(byKind.opcua.implemented).toBe(false);
    expect(byKind.mqtt.reason).toMatch(/协议栈/);
  });
});

describe('simulator adapter', () => {
  it('produces a finite sample with diurnal shape', () => {
    const adapter = new SimulatorAdapter(design);
    const midnight = adapter.read(0)!;
    const noon = adapter.read(12 * 60)!;
    expect(Number.isFinite(midnight.flow)).toBe(true);
    expect(noon.flow).toBeGreaterThan(midnight.flow);
    expect(adapter.status().ready).toBe(true);
  });

  it('never returns null (it is the fallback source)', () => {
    const adapter = new SimulatorAdapter(design);
    for (const minute of [0, 1, 720, 1439, 100000]) {
      expect(adapter.read(minute)).not.toBeNull();
    }
  });
});

describe('csv replay adapter', () => {
  it('replays the series and reports healthy', () => {
    const series = parseInfluentCsv('0,2000,350,34,4.8,180,20\n1440,3000,600,60,8,300,22');
    const adapter = new CsvReplayAdapter(series);
    const sample = adapter.read(720)!;
    expect(sample.flow).toBeGreaterThan(2000);
    expect(adapter.status().ready).toBe(true);
    expect(adapter.name).toBe(series.name);
  });

  it('reports an error instead of fabricating data for an empty series', () => {
    const adapter = new CsvReplayAdapter({ name: 'empty', samples: [], durationMin: 0, warnings: [] });
    expect(adapter.read(0)).toBeNull();
    expect(adapter.status().ready).toBe(false);
    expect(adapter.status().lastError).toMatch(/没有可用数据/);
  });

  it('clamps out-of-range raw values at sampling time', () => {
    const series = parseInfluentCsv('0,99999,999999,999,999,99999,99');
    const adapter = new CsvReplayAdapter(series);
    const sample = adapter.read(0)!;
    expect(sample.flow).toBeLessThanOrEqual(5200);
  });
});

describe('unavailable adapters', () => {
  it('returns null and a readable reason rather than fake data', () => {
    for (const kind of ['mqtt', 'opcua'] as const) {
      const adapter = new UnavailableAdapter(kind);
      expect(adapter.read()).toBeNull();
      const status = adapter.status();
      expect(status.ready).toBe(false);
      expect(status.lastError).toMatch(/协议栈|评估/);
      expect(status.lastSuccessAt).toBeNull();
      expect(status.stalenessMs).toBeNull();
    }
  });
});

describe('data source chain', () => {
  const csv = parseInfluentCsv('0,2500,500,50,6,250,21\n1440,2500,500,50,6,250,21');

  it('prefers the first available adapter', () => {
    const chain = new DataSourceChain([new CsvReplayAdapter(csv), new SimulatorAdapter(design)]);
    const sample = chain.read(10)!;
    expect(sample.cod).toBe(500);
    expect(chain.activeName()).toContain('自定义进水');
    expect(chain.degraded()).toBe(false);
  });

  it('falls back to the simulator when the primary yields nothing, and records degradation', () => {
    const dead: DataSourceAdapter = {
      kind: 'csv',
      name: '坏掉的 CSV 源',
      read: () => null,
      status: () => ({ kind: 'csv', ready: false, lastSuccessAt: null, lastError: 'x', stalenessMs: null }),
      close: () => {},
    };
    const chain = new DataSourceChain([dead, new SimulatorAdapter(design)]);
    const sample = chain.read(600)!;
    expect(sample).not.toBeNull();
    expect(chain.degraded()).toBe(true);
    expect(chain.activeName()).toContain('内置模拟');
  });

  it('excludes unavailable adapters from the chain entirely', () => {
    const chain = new DataSourceChain([new UnavailableAdapter('mqtt'), new SimulatorAdapter(design)]);
    expect(chain.read(0)).not.toBeNull();
    expect(chain.activeName()).toContain('内置模拟');
    expect(chain.degraded()).toBe(false);
  });

  it('reports an error when every adapter is unavailable', () => {
    const chain = new DataSourceChain([new UnavailableAdapter('mqtt'), new UnavailableAdapter('opcua')]);
    expect(chain.read(0)).toBeNull();
    expect(chain.status().ready).toBe(false);
    expect(chain.status().lastError).toMatch(/没有任何可用数据源/);
  });

  it('closes every adapter without throwing', () => {
    const chain = new DataSourceChain([new CsvReplayAdapter(csv), new SimulatorAdapter(design)]);
    expect(() => chain.close()).not.toThrow();
  });
});
