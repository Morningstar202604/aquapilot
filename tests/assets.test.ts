import { describe, expect, it } from 'vitest';
import { PLANT_TOPOLOGY } from '../src/model/topology';
import {
  capacityFactorFor,
  createAssetStateFromTopology,
  injectFault,
  resetAssetFault,
  resetEsd,
  tickAssets,
  triggerEsd,
  type AssetPlantState,
} from '../src/sim/assets';
import { completeWorkOrder, createWorkOrder, startWorkOrder } from '../src/sim/maintenance';
import { assetsRoute } from '../src/server/routes/assets';

function makeState(seed = 7): AssetPlantState {
  const state = createAssetStateFromTopology(PLANT_TOPOLOGY, { seed });
  // 概率性故障由概率表驱动；本套用例走显式注入，关闭随机滚动以保证确定性
  state.defaults.enableProbabilisticFaults = false;
  return state;
}

function byId(state: AssetPlantState, id: string) {
  const asset = state.assets.find((a) => a.id === id);
  if (!asset) throw new Error(`测试引用了不存在的设备 ${id}`);
  return asset;
}

function urlOf(path: string): URL {
  return new URL(`http://localhost${path}`);
}

describe('WP7 资产注册表与拓扑一致性', () => {
  it('默认拓扑派生 12 台以上设备，字段齐全且归属拓扑单元', () => {
    const state = makeState();
    expect(state.assets.length).toBeGreaterThanOrEqual(12);

    const unitIds = new Set(PLANT_TOPOLOGY.units.map((u) => u.id));
    for (const asset of state.assets) {
      expect(unitIds.has(asset.unitId)).toBe(true);
      expect(asset.groupId).toBe(`${asset.unitId}:${asset.category}`);
      expect(asset.name.length).toBeGreaterThan(0);
      expect(asset.ratedPowerKw).toBeGreaterThan(0);
      expect(['pump', 'blower', 'mixer', 'scraper', 'thickener', 'dewatering', 'dosing_pump']).toContain(
        asset.category,
      );
    }
  });

  it('初始主机 running、备机 standby，健康度满格且无锁存', () => {
    const state = makeState();
    for (const asset of state.assets) {
      expect(asset.health).toBe(100);
      expect(asset.faultLatched).toBe(false);
      expect(asset.esdLatched).toBe(false);
      expect(['running', 'standby']).toContain(asset.status);
      if (asset.isStandby) expect(asset.status).toBe('standby');
    }
    // 提升泵 3 用 1 备、风机 2 用 1 备
    const pumps = state.assets.filter((a) => a.category === 'pump');
    const blowers = state.assets.filter((a) => a.category === 'blower');
    expect(pumps.filter((a) => a.isStandby)).toHaveLength(1);
    expect(blowers.filter((a) => a.isStandby)).toHaveLength(1);
  });

  it('状态可纯 JSON 序列化往返（进快照与审计）', () => {
    const state = makeState();
    tickAssets(state, 10, [{ type: 'injectFault', assetId: 'blower-blower-1', code: 'MOTOR_OVERLOAD' }]);
    const restored = JSON.parse(JSON.stringify(state)) as AssetPlantState;
    expect(restored.assets).toHaveLength(state.assets.length);
    expect(restored.assets[0].events).toEqual(state.assets[0].events);
    expect(restored.workOrders).toEqual(state.workOrders);
  });
});

describe('WP7 故障注入、锁存与复位', () => {
  it('注入停机故障后设备 fault 锁存，故障码与严重度落账', () => {
    const state = makeState();
    const ok = injectFault(state, 'blower-blower-1', 'MOTOR_OVERLOAD');
    expect(ok).toBe(true);
    const asset = byId(state, 'blower-blower-1');
    expect(asset.status).toBe('fault');
    expect(asset.faultLatched).toBe(true);
    expect(asset.faultCode).toBe('MOTOR_OVERLOAD');
    expect(asset.faultSeverity).toBe('stop');
    expect(asset.derateFactor).toBe(0);
    expect(asset.events.some((e) => e.code === 'MOTOR_OVERLOAD')).toBe(true);
  });

  it('降容故障不跳闸，按降容系数折算能力', () => {
    const state = makeState();
    injectFault(state, 'mixer-anoxic-1', 'BEARING_OVERHEAT');
    const asset = byId(state, 'mixer-anoxic-1');
    expect(asset.status).toBe('running');
    expect(asset.faultLatched).toBe(true);
    expect(asset.derateFactor).toBeCloseTo(0.6, 2);
  });

  it('故障后可用性下降；复位显式动作后恢复角色位', () => {
    const state = makeState();
    const group = 'anoxic:mixer';
    expect(capacityFactorFor(state, group)).toBeCloseTo(1, 3);

    injectFault(state, 'mixer-anoxic-1', 'SEAL_LEAK');
    // 无备机组：一台停机，可用能力 1/2
    expect(capacityFactorFor(state, group)).toBeCloseTo(0.5, 3);

    const restored = resetAssetFault(state, 'mixer-anoxic-1');
    expect(restored).toBe(true);
    const asset = byId(state, 'mixer-anoxic-1');
    expect(asset.status).toBe('running');
    expect(asset.faultCode).toBeNull();
    expect(asset.faultLatched).toBe(false);
    // 复位只清故障锁存；健康度惩罚保留，需检修工单才能恢复满格
    expect(asset.health).toBeLessThan(100);
    expect(capacityFactorFor(state, group)).toBeGreaterThan(0.85);
    expect(capacityFactorFor(state, group)).toBeLessThan(1);
  });

  it('无备机组主机全停后可用性为 0', () => {
    const state = makeState();
    const group = 'anoxic:mixer';
    injectFault(state, 'mixer-anoxic-1', 'VIBRATION_HIGH');
    injectFault(state, 'mixer-anoxic-2', 'CONTROL_FAULT');
    expect(capacityFactorFor(state, group)).toBeCloseTo(0, 3);
  });

  it('未知设备 / 未知故障码的错误路径返回 false', () => {
    const state = makeState();
    expect(injectFault(state, 'pump-does-not-exist', 'SEAL_LEAK')).toBe(false);
    expect(injectFault(state, 'blower-blower-1', 'NO_SUCH_CODE')).toBe(false);
    expect(resetAssetFault(state, 'pump-does-not-exist')).toBe(false);
    expect(resetAssetFault(state, 'blower-blower-1')).toBe(false); // 未故障，无需复位
  });
});

describe('WP7 N+1 备机延时自启', () => {
  it('主机停机后备机在延时到期前待命，到期后自启并按额定能力恢复', () => {
    const state = makeState();
    const group = 'blower:blower';
    injectFault(state, 'blower-blower-1', 'MOTOR_OVERLOAD');

    // 延时 5 min：2 min 后备机仍待命，组可用率 1/2
    tickAssets(state, 2, []);
    const standby = byId(state, 'blower-blower-3');
    expect(standby.status).toBe('standby');
    expect(standby.standbyAvailableAtMin).toBe(5);
    expect(capacityFactorFor(state, group)).toBeCloseTo(0.5, 3);

    // 推进到第 6 min：备机自启，两台运行，能力恢复到额定
    tickAssets(state, 4, []);
    expect(standby.status).toBe('running');
    expect(standby.startCount).toBe(1);
    expect(standby.events.some((e) => e.code === 'BACKUP_AUTOSTART')).toBe(true);
    expect(capacityFactorFor(state, group)).toBeCloseTo(1, 3);

    // 恢复比例：备机额定风量与主机相同，顶替损失的一台
    expect(standby.ratedFlowM3h).toBe(byId(state, 'blower-blower-1').ratedFlowM3h);
  });

  it('备机不可用时不顶替，整组按剩余主机折算；主机全停则为 0', () => {
    const state = makeState();
    const group = 'screening:pump';
    // 先把备机送检修，使其不可用
    const standby = byId(state, 'pump-screening-4');
    const wo = createWorkOrder(state, standby.id, 'corrective', '备机定期检查', 0);
    expect(wo).not.toBeNull();
    startWorkOrder(state, wo!.id, 0);
    expect(standby.status).toBe('maintenance');

    injectFault(state, 'pump-screening-1', 'SEAL_LEAK');
    injectFault(state, 'pump-screening-2', 'SEAL_LEAK');
    injectFault(state, 'pump-screening-3', 'SEAL_LEAK');
    // 三台主机全停、备机检修：整组降容为 0
    expect(capacityFactorFor(state, group)).toBeCloseTo(0, 3);
  });
});

describe('WP7 ESD 锁存与复位', () => {
  it('全厂 ESD 后所有设备进入安全位并锁存，可用率为 0；显式复位后恢复', () => {
    const state = makeState();
    triggerEsd(state);
    expect(state.esd.active).toBe(true);
    expect(state.esd.scope).toBe('plant');
    for (const asset of state.assets) {
      expect(asset.status).toBe('esd_tripped');
      expect(asset.esdLatched).toBe(true);
    }
    expect(capacityFactorFor(state, 'blower:blower')).toBeCloseTo(0, 3);
    expect(capacityFactorFor(state, 'screening:pump')).toBeCloseTo(0, 3);

    resetEsd(state);
    expect(state.esd.active).toBe(false);
    for (const asset of state.assets) {
      expect(asset.esdLatched).toBe(false);
      expect(asset.status).toBe(asset.isStandby ? 'standby' : 'running');
    }
  });

  it('单元级 ESD 只锁存该单元设备，其余单元不受影响', () => {
    const state = makeState();
    triggerEsd(state, { unitId: 'blower' });
    const blowers = state.assets.filter((a) => a.unitId === 'blower');
    const others = state.assets.filter((a) => a.unitId !== 'blower');
    expect(blowers.every((a) => a.status === 'esd_tripped')).toBe(true);
    expect(others.every((a) => a.status === 'running' || a.status === 'standby')).toBe(true);

    resetEsd(state);
    expect(blowers.every((a) => a.status !== 'esd_tripped')).toBe(true);
  });

  it('ESD 位上拒绝故障注入，且不能靠故障复位退出', () => {
    const state = makeState();
    triggerEsd(state);
    expect(injectFault(state, 'blower-blower-1', 'MOTOR_OVERLOAD')).toBe(false);
    expect(resetAssetFault(state, 'blower-blower-1')).toBe(false);
    expect(byId(state, 'blower-blower-1').status).toBe('esd_tripped');
  });
});

describe('WP7 预防性维护与工单', () => {
  it('运行时数达到周期自动生成预防性工单；开工后不可用，完工后健康度恢复', () => {
    const state = makeState();
    const asset = byId(state, 'dosing_pump-chemical-1');
    // 距上次保养累计 1999.8 h（阈值 2000 h），再跑 10 min 应到期
    asset.runtimeMin = 2000 * 60 - 10;
    asset.lastMaintenanceMin = 0;

    tickAssets(state, 10, []);
    const order = state.workOrders.find((w) => w.assetId === asset.id);
    expect(order).not.toBeUndefined();
    expect(order!.kind).toBe('preventive');
    expect(order!.status).toBe('open');
    expect(asset.activeWorkOrderId).toBe(order!.id);

    tickAssets(state, 1, [{ type: 'workOrderStart', workOrderId: order!.id }]);
    expect(asset.status).toBe('maintenance');
    expect(asset.activeWorkOrderId).toBe(order!.id);

    tickAssets(state, 60, [{ type: 'workOrderComplete', workOrderId: order!.id }]);
    expect(asset.status).toBe('running');
    expect(asset.health).toBe(100);
    expect(asset.activeWorkOrderId).toBeNull();
    expect(order!.downtimeMin).toBeGreaterThan(0);
  });

  it('日历天数达到周期也触发工单（双触发，先到为准）', () => {
    const state = makeState();
    const asset = byId(state, 'dosing_pump-chemical-2');
    state.timeMin = 200 * 1440; // 已投运 200 天
    asset.lastMaintenanceMin = 0;
    asset.runtimeMin = 0; // 运行时数未到 2000 h，只由日历触发
    tickAssets(state, 1, []);
    const order = state.workOrders.find((w) => w.assetId === asset.id);
    expect(order).not.toBeUndefined();
    expect(order!.reason).toContain('日历');
  });

  it('健康度随运行时数下降，完工后回升到满格', () => {
    const state = makeState();
    const asset = byId(state, 'pump-screening-1');
    const before = asset.health;
    tickAssets(state, 600, []); // 运行 10 h
    expect(asset.health).toBeLessThan(before);
    expect(asset.health).toBeGreaterThan(99);

    const wo = createWorkOrder(state, asset.id, 'corrective', '检修恢复', state.timeMin);
    startWorkOrder(state, wo!.id, state.timeMin);
    completeWorkOrder(state, wo!.id, state.timeMin + 30);
    expect(asset.health).toBe(100);
  });

  it('检修逾期标记：开工后超过计划时长未完工记 overdue', () => {
    const state = makeState();
    const asset = byId(state, 'mixer-anaerobic-1');
    const wo = createWorkOrder(state, asset.id, 'corrective', '故障检修', 0);
    startWorkOrder(state, wo!.id, 0);
    tickAssets(state, 300, []); // 计划 180 min
    expect(wo!.overdue).toBe(true);
    expect(wo!.status).toBe('in_progress');
  });
});

describe('WP7 路由契约', () => {
  it('/api/assets 返回注册表、状态、组可用率与工单', () => {
    const state = makeState();
    injectFault(state, 'blower-blower-1', 'MOTOR_OVERLOAD');
    const reply = assetsRoute('/api/assets', urlOf('/api/assets'), { state });
    expect(reply).not.toBeNull();
    expect(reply!.status).toBe(200);
    const body = reply!.body as {
      summary: { total: number; fault: number; plantAvailability: number };
      groups: unknown[];
      assets: { id: string; availability: number }[];
      workOrders: unknown[];
    };
    expect(body.summary.total).toBe(state.assets.length);
    expect(body.summary.fault).toBe(1);
    expect(body.groups.length).toBeGreaterThan(0);
    expect(body.assets.length).toBe(state.assets.length);
  });

  it('/api/assets/:id 返回单体详情；未知 id 404 ASSET_NOT_FOUND', () => {
    const state = makeState();
    const ok = assetsRoute('/api/assets/blower-blower-1', urlOf('/api/assets/blower-blower-1'), { state });
    expect(ok!.status).toBe(200);
    expect((ok!.body as { asset: { id: string } }).asset.id).toBe('blower-blower-1');

    const missing = assetsRoute('/api/assets/nope-999', urlOf('/api/assets/nope-999'), { state });
    expect(missing!.status).toBe(404);
    expect(missing!.body).toEqual({ error: '未找到设备 nope-999', code: 'ASSET_NOT_FOUND' });
  });

  it('不匹配的路径返回 null，交回调用方 404', () => {
    const state = makeState();
    expect(assetsRoute('/api/other', urlOf('/api/other'), { state })).toBeNull();
  });

  it('子系统未启用（state null）返回空视图，可用率不拖累引擎', () => {
    const reply = assetsRoute('/api/assets', urlOf('/api/assets'), { state: null });
    expect(reply!.status).toBe(200);
    expect((reply!.body as { summary: { total: number; plantAvailability: number } }).summary.total).toBe(0);
    expect(capacityFactorFor(null, 'blower:blower')).toBe(1);
  });
});

describe('WP7 时间推进集成（24 h）', () => {
  it('连续推进 24 h：主机运行时数累计、备机待命不计时数、工单状态一致', () => {
    const state = makeState();
    for (let i = 0; i < 24; i += 1) tickAssets(state, 60, []);

    expect(state.timeMin).toBe(1440);
    const duty = state.assets.filter((a) => !a.isStandby && a.status === 'running');
    const standby = state.assets.filter((a) => a.isStandby);
    expect(duty.every((a) => a.runtimeMin === 1440)).toBe(true);
    expect(standby.every((a) => a.runtimeMin === 0)).toBe(true);

    // 24 h 内未到保养周期，不应产生预防性工单
    expect(state.workOrders.filter((w) => w.kind === 'preventive')).toHaveLength(0);

    // 再把一台加药泵（保养阈值 2000 h）推到临界，下一补应自动出工单
    const asset = state.assets.find((a) => a.category === 'dosing_pump' && !a.isStandby)!;
    asset.runtimeMin = asset.lastMaintenanceMin + 2000 * 60 - 5;
    tickAssets(state, 10, []);
    expect(state.workOrders.some((w) => w.assetId === asset.id && w.kind === 'preventive')).toBe(true);
  });
});
