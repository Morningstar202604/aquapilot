import { useEffect, useMemo, useState } from 'react';
import { useSimulation } from './hooks/useSimulation';
import {
  canRedoHistory,
  canUndoHistory,
  commitHistory,
  emptyHistory,
  redoHistory,
  seedHistory,
  undoHistory,
} from './hooks/topoHistory';
import { PlantCanvas } from './components/PlantCanvas';
import { ProcessEditor } from './components/ProcessEditor';
import { PLANT_TOPOLOGY, ProcessTopology } from '../model/topology';
import { Trends } from './components/Trends';
import { ChatPanel } from './components/ChatPanel';
import { DecisionPanel } from './components/DecisionPanel';
import { ControlPanel } from './components/ControlPanel';
import { AlarmsPanel } from './components/AlarmsPanel';
import { InsightsPanel } from './components/InsightsPanel';
import { ReplayPanel } from './components/ReplayPanel';
import { PLANT } from '../sim/config';

type Tab = 'chat' | 'decision' | 'control' | 'alarms' | 'insights' | 'replay';
type View = 'plant' | 'editor';

export default function App() {
  const sim = useSimulation();
  const [tab, setTab] = useState<Tab>('chat');
  const [view, setView] = useState<View>('plant');
  const [selectedTank, setSelectedTank] = useState<string | null>(null);

  /**
   * 拓扑编辑历史（撤销/重做）。
   *
   * draft 直接由历史栈推导，避免「历史状态」与「当前草稿」两套真相漂移。
   * 具体合并/裁剪逻辑在 hooks/topoHistory（纯函数，有单测）。
   */
  const [hist, setHist] = useState(emptyHistory);
  const draft: ProcessTopology | null = hist.idx >= 0 ? hist.stack[hist.idx] : null;
  const canUndo = canUndoHistory(hist);
  const canRedo = canRedoHistory(hist);

  const seedDraft = (base: ProcessTopology) => setHist((h) => seedHistory(h, base));
  const commitDraft = (next: ProcessTopology) => setHist((h) => commitHistory(h, next));
  const undo = () => setHist(undoHistory);
  const redo = () => setHist(redoHistory);

  // 编辑器内 Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做
  useEffect(() => {
    if (view !== 'editor') return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, canUndo, canRedo]);

  const snap = sim.snapshot;

  const aiEnabled = snap?.controls.aiEnabled ?? true;
  const alarmCount = snap?.activeAlarms.length ?? 0;

  // 每秒跳一次，让「数据最后更新时间」在暂停/断流时也能真实刷新
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const staleSeconds =
    sim.link.connected && sim.link.lastUpdateAt ? Math.max(0, Math.round((now - sim.link.lastUpdateAt) / 1000)) : null;
  const linkLabel = !sim.link.connected
    ? '断线重连'
    : staleSeconds !== null && staleSeconds > 5
      ? `数据 ${staleSeconds}s 前更新`
      : '链路正常';

  const dateLabel = useMemo(() => {
    if (!snap) return '';
    const day = Math.floor(snap.timeMin / 1440) + 1;
    const h = Math.floor((snap.timeMin % 1440) / 60);
    const m = Math.floor(snap.timeMin % 60);
    return `第 ${day} 天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }, [snap]);

  if (!snap) {
    return (
      <div className="loading">
        {sim.link.connected ? '正在接收仿真数据…' : (sim.link.error ?? '正在连接仿真服务…')}
      </div>
    );
  }

  const kpis = buildKpis(snap);
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">AQUAPILOT</span>
          <span className="brand-sub">AI 值守仿真台</span>
        </div>
        <div className="topbar-meta">
          <div className="meta-item">
            <span className="meta-label">厂站</span>
            <span className="meta-value">
              {PLANT.name} · {PLANT.code}
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">仿真时钟</span>
            <span className="meta-value">{dateLabel}</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">处理规模</span>
            <span className="meta-value">{(PLANT.capacityM3d / 1000).toFixed(0)} 千 m³/d</span>
          </div>
          <div className="meta-item">
            <span className="meta-label">求解结构</span>
            <span className="meta-value">
              {snap.modelMode === 'asm1' ? 'ASM1 13 组分' : '经验动力学'} · {snap.reactorCount} 反应器 ·{' '}
              {snap.tanks.reduce((a, t) => a + t.volume, 0).toLocaleString()} m³
            </span>
          </div>
          <div className="meta-item">
            <span className="meta-label">执行标准</span>
            <span className="meta-value">{PLANT.dischargeStandard}</span>
          </div>
        </div>
        <div className="topbar-right">
          <div className="pill" role="group" aria-label="视图">
            <button
              onClick={() => setView('plant')}
              data-active={view === 'plant'}
              aria-pressed={view === 'plant'}
              style={{ padding: '0 6px', color: 'inherit' }}
            >
              运行监视
            </button>
            <button
              onClick={() => {
                seedDraft(sim.topology ?? PLANT_TOPOLOGY);
                setView('editor');
              }}
              data-active={view === 'editor'}
              aria-pressed={view === 'editor'}
              style={{ padding: '0 6px', color: 'inherit' }}
            >
              工艺编排
            </button>
          </div>
          <button className="pill" onClick={sim.pause} data-active={sim.paused} aria-pressed={sim.paused}>
            <span className="dot" data-tone={sim.paused ? 'amber' : undefined} data-live={!sim.paused} />
            {sim.paused ? '已暂停' : '运行中'}
          </button>
          <div className="pill" role="group" aria-label="仿真速度">
            {[1, 2, 4].map((s) => (
              <button
                key={s}
                onClick={() => sim.changeSpeed(s)}
                data-active={sim.speed === s}
                style={{ padding: '0 4px', color: 'inherit' }}
                aria-pressed={sim.speed === s}
              >
                {s}×
              </button>
            ))}
          </div>
          <button className="pill" onClick={sim.reset}>
            重置
          </button>
          <span
            className="health-pill"
            data-grade={snap.health.grade}
            title={
              `全厂健康度 ${snap.health.score}/100：` +
              snap.health.parts.map((p) => `${p.label} ${p.detail}`).join('；')
            }
            aria-label={`全厂健康度 ${snap.health.score} 分`}
          >
            健康度 {snap.health.score}
          </span>
          <span className="pill" data-tone={aiEnabled ? undefined : 'amber'} data-active={aiEnabled}>
            <span className="dot" data-live={aiEnabled} data-tone={aiEnabled ? undefined : 'amber'} />
            {aiEnabled ? 'AI 自动值守' : 'AI 仅建议'}
          </span>
          <span
            className="pill"
            style={{ borderColor: sim.link.connected ? 'var(--water-dim)' : 'var(--alarm-dim)' }}
            title={
              sim.link.lastUpdateAt
                ? `最近一次收到服务端数据：${new Date(sim.link.lastUpdateAt).toLocaleTimeString()}`
                : undefined
            }
          >
            <span className="dot" data-live={sim.link.connected} data-tone={sim.link.connected ? undefined : 'alarm'} />
            {linkLabel}
          </span>
        </div>
      </header>

      <div className={view === 'editor' ? 'layout layout-editor' : 'layout'}>
        <section className={view === 'editor' ? 'stage stage-editor' : 'stage'}>
          {view === 'plant' && (
            <div className="kpi-strip">
              {kpis.map((k) => (
                <div className="kpi" key={k.label} data-state={k.state} title={k.hint}>
                  <div className="kpi-label">
                    <span>{k.label}</span>
                    <span className="kpi-limit">{k.limit}</span>
                  </div>
                  <div className="kpi-value">
                    <span className="kpi-num tabular">{k.value}</span>
                    <span className="kpi-unit">{k.unit}</span>
                  </div>
                  <div className="kpi-bar">
                    <span
                      style={{
                        width: `${Math.min(100, k.ratio * 100)}%`,
                        background:
                          k.state === 'bad' ? 'var(--alarm)' : k.state === 'warn' ? 'var(--amber)' : 'var(--water-dim)',
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {view === 'plant' ? (
            <>
              <PlantCanvas
                snap={snap}
                topo={sim.topology ?? PLANT_TOPOLOGY}
                selected={selectedTank}
                onSelect={setSelectedTank}
              />
              <Trends snap={snap} />
            </>
          ) : (
            <ProcessEditor
              snap={snap}
              topology={draft ?? sim.topology ?? PLANT_TOPOLOGY}
              onChange={commitDraft}
              onApply={() => {
                if (draft) {
                  sim.applyTopology(draft);
                  setView('plant');
                }
              }}
              dirty={Boolean(draft) && JSON.stringify(draft) !== JSON.stringify(sim.topology ?? PLANT_TOPOLOGY)}
              canUndo={canUndo}
              canRedo={canRedo}
              onUndo={undo}
              onRedo={redo}
            />
          )}
        </section>

        {view === 'plant' && (
          <aside className="side">
            <nav className="side-tabs" role="tablist" aria-label="操作面板">
              <button
                className="side-tab"
                role="tab"
                aria-selected={tab === 'chat'}
                data-active={tab === 'chat'}
                onClick={() => setTab('chat')}
              >
                AI 对话
              </button>
              <button
                className="side-tab"
                role="tab"
                aria-selected={tab === 'decision'}
                data-active={tab === 'decision'}
                onClick={() => setTab('decision')}
              >
                决策解释
              </button>
              <button
                className="side-tab"
                role="tab"
                aria-selected={tab === 'control'}
                data-active={tab === 'control'}
                onClick={() => setTab('control')}
              >
                控制与工况
              </button>
              <button
                className="side-tab"
                role="tab"
                aria-selected={tab === 'alarms'}
                data-active={tab === 'alarms'}
                onClick={() => setTab('alarms')}
              >
                告警
                {alarmCount > 0 && <span className="side-tab-count">{alarmCount}</span>}
              </button>
              <button
                className="side-tab"
                role="tab"
                aria-selected={tab === 'insights'}
                data-active={tab === 'insights'}
                onClick={() => setTab('insights')}
              >
                效益
              </button>
              <button
                className="side-tab"
                role="tab"
                aria-selected={tab === 'replay'}
                data-active={tab === 'replay'}
                onClick={() => setTab('replay')}
              >
                回放
              </button>
            </nav>

            {tab === 'chat' && <ChatPanel chat={sim.chat} onAsk={sim.ask} connected={sim.link.connected} snap={snap} />}
            {tab === 'decision' && (
              <DecisionPanel
                snap={snap}
                rec={sim.recommendation}
                onApply={sim.applyRecommendation}
                onRefresh={sim.refreshDecision}
                aiEnabled={aiEnabled}
                onToggleAi={sim.setAiEnabled}
              />
            )}
            {tab === 'control' && (
              <ControlPanel
                snap={snap}
                onChange={sim.setControls}
                onStartScenario={sim.startScenario}
                onClearScenario={sim.clearScenario}
                onApplyPreset={sim.applyPreset}
                aiEnabled={aiEnabled}
              />
            )}
            {tab === 'alarms' && <AlarmsPanel snap={snap} />}
            {tab === 'insights' && <InsightsPanel snap={snap} aiEnabled={aiEnabled} />}
            {tab === 'replay' && <ReplayPanel />}
          </aside>
        )}
      </div>

      <div className="notice-stack" aria-live="polite">
        {sim.notices.slice(0, 3).map((n) => (
          <div className="notice" data-level={n.level} key={n.id}>
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 日运行成本基准：按设计流量 48 000 m³/d、吨水电耗 0.28 kWh、电价 0.68 元估算 */
const DAY_COST_BASELINE = 48000 * 0.28 * 0.68 + 48000 * 0.038 * 2.2;

function buildKpis(snap: NonNullable<ReturnType<typeof useSimulation>['snapshot']>) {
  const L = snap.limits;
  const e = snap.effluent;
  // ASM1 不含生物除磷：TP 为惰性示踪 + 化学除磷（PAC）口径，如实标注避免误解
  const tpHint =
    snap.modelMode === 'asm1'
      ? 'ASM1 模型不含生物除磷：出水总磷 = 惰性示踪输运 − PAC 化学去除，稳态值会高于含生物除磷的经验模型'
      : '总磷 = 生物除磷（厌氧释磷/好氧吸磷）+ PAC 化学除磷';
  const items = [
    {
      label: '出水 COD',
      value: e.cod.toFixed(1),
      unit: 'mg/L',
      limit: `≤ ${L.cod}`,
      ratio: e.cod / L.cod,
      hint: '化学需氧量，溶解性组分 + 出水悬浮物折算',
    },
    {
      label: '出水 NH₃-N',
      value: e.nh.toFixed(2),
      unit: 'mg/L',
      limit: `≤ ${L.nh}`,
      ratio: e.nh / L.nh,
      hint: '氨氮，硝化效果的直接指标',
    },
    {
      label: '出水 总磷',
      value: e.tp.toFixed(3),
      unit: 'mg/L',
      limit: `≤ ${L.tp}`,
      ratio: e.tp / L.tp,
      hint: tpHint,
    },
    {
      label: '出水 SS',
      value: e.ss.toFixed(1),
      unit: 'mg/L',
      limit: `≤ ${L.ss}`,
      ratio: e.ss / L.ss,
      hint: '悬浮物，由二沉池出水层给出',
    },
    {
      label: '出水 总氮',
      value: e.tn.toFixed(1),
      unit: 'mg/L',
      limit: `≤ ${L.tn}`,
      ratio: e.tn / L.tn,
      hint: '总氮 = 氨氮 + 硝态氮 + 悬浮物折算；依赖内回流与碳源',
    },
    {
      label: '吨水电耗',
      value: snap.energy.specificKwhM3.toFixed(3),
      unit: 'kWh/m³',
      limit: '设计 0.28',
      ratio: snap.energy.specificKwhM3 / 0.28,
      hint: '吨水电耗 = 鼓风 + 搅拌 + 泵送总功率 ÷ 进水量',
    },
    {
      label: '今日运行成本',
      value: snap.cost.totalToday.toFixed(0),
      unit: '元',
      limit: `基准 ¥${(DAY_COST_BASELINE / 1000).toFixed(0)}k`,
      ratio: snap.cost.totalToday / DAY_COST_BASELINE,
      hint: '当日电耗 + 药耗 + 污泥处置成本（跨日清零）',
    },
  ];
  return items.map((i) => {
    const ratio = Math.max(0, i.ratio);
    const state: 'ok' | 'warn' | 'bad' = ratio > 1 ? 'bad' : ratio > 0.85 ? 'warn' : 'ok';
    return { ...i, ratio, state };
  });
}
