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
import { PLANT_TOPOLOGY, ProcessTopology, findUnit } from '../model/topology';
import { deleteUnits, nudgeUnit } from '../model/topologyEdit';
import { Trends } from './components/Trends';
import { ChatPanel } from './components/ChatPanel';
import { DecisionPanel } from './components/DecisionPanel';
import { ControlPanel } from './components/ControlPanel';
import { AlarmsPanel } from './components/AlarmsPanel';
import { InsightsPanel } from './components/InsightsPanel';
import { ReplayPanel } from './components/ReplayPanel';
import { ModelSettingsPanel } from './components/ModelSettingsPanel';
import { AgentSettingsPanel } from './components/AgentSettingsPanel';
import { WatchdogPanel } from './components/WatchdogPanel';
import { UnitInspector } from './components/UnitInspector';
import { TopbarMenu } from './components/TopbarMenu';
import { Collapsible } from './components/Collapsible';
import { PLANT } from '../sim/config';

type Tab = 'chat' | 'decision' | 'control' | 'alarms' | 'insights' | 'replay' | 'health';
type View = 'plant' | 'editor';

export default function App() {
  const sim = useSimulation();
  const [tab, setTab] = useState<Tab>('chat');
  const [view, setView] = useState<View>('plant');
  const [selectedTank, setSelectedTank] = useState<string | null>(null);
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  /** 编辑器内当前选中的单元（用于 Delete 快捷键） */
  const [editorSelected, setEditorSelected] = useState<string | null>(null);
  /** 编辑器内的多选集合：批量删除要对全部选中项生效 */
  const [editorSelection, setEditorSelection] = useState<string[]>([]);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);

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

  /**
   * 编辑器快捷键。
   *
   * Ctrl/Cmd+Z 撤销、Ctrl/Cmd+Shift+Z 或 Ctrl+Y 重做；
   * Delete/Backspace 删除选中的全部单元（整步可撤销，是否把厂拆散交给校验判断）。
   * 输入框里按键不拦截。
   */
  useEffect(() => {
    if (view !== 'editor') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (typing) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      // 方向键微调选中单元：一次一格（14px），Shift 加速到 5 格
      const nudgeTargets = editorSelection.length > 1 ? editorSelection : editorSelected ? [editorSelected] : [];
      if (nudgeTargets.length > 0 && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = (e.shiftKey ? 5 : 1) * 14;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        setHist((h) => {
          const cur = h.idx >= 0 ? h.stack[h.idx] : null;
          if (!cur) return h;
          let next = cur;
          for (const id of nudgeTargets) next = nudgeUnit(next, id, dx, dy);
          return commitHistory(h, next);
        });
        return;
      }
      if (e.key === 'Escape') {
        setEditorSelected(null);
        setEditorSelection([]);
        return;
      }
      const deleteIds = editorSelection.length > 0 ? editorSelection : editorSelected ? [editorSelected] : [];
      if ((e.key === 'Delete' || e.key === 'Backspace') && deleteIds.length > 0) {
        e.preventDefault();
        const ids = deleteIds;
        setHist((h) => {
          const cur = h.idx >= 0 ? h.stack[h.idx] : null;
          if (!cur) return h;
          return commitHistory(h, deleteUnits(cur, ids));
        });
        setEditorSelected(null);
        setEditorSelection([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, canUndo, canRedo, editorSelected, editorSelection]);

  /**
   * 全局 Esc：按「最上层」逐级关闭。
   *
   * 顺序与视觉层级一致——配置弹窗 → 单元检视器 → 关闭后焦点回到页面。
   * 之前只有编辑器内响应 Esc，导致监视页打开检视器后按 Esc 没反应。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (modelPanelOpen) {
        setModelPanelOpen(false);
        return;
      }
      if (agentPanelOpen) {
        setAgentPanelOpen(false);
        return;
      }
      if (selectedTank) setSelectedTank(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modelPanelOpen, agentPanelOpen, selectedTank]);

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
          {/**
           * 两个配置入口收进一个「设置」菜单。
           *
           * 顶栏在 1280 宽下已经排满，配置属于低频操作；菜单项里直接显示当前
           * 生效值（模型名 / 角色名 / 权限），不点开也知道现在是什么。
           */}
          <TopbarMenu
            label="设置"
            live={Boolean(sim.llm.config || sim.agent.config)}
            items={[
              {
                key: 'model',
                label: '模型设置',
                hint: sim.llm.config ? `${sim.llm.config.model} · ${sim.llm.config.protocol}` : '未配置',
                onSelect: () => setModelPanelOpen(true),
              },
              {
                key: 'agent',
                label: 'Agent 设置',
                hint: sim.agent.config ? `${sim.agent.config.persona.name} · ${sim.agent.config.permission}` : '未配置',
                onSelect: () => setAgentPanelOpen(true),
              },
            ]}
          />
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
              <div className="stage-canvas-wrap">
                <PlantCanvas
                  snap={snap}
                  topo={sim.topology ?? PLANT_TOPOLOGY}
                  selected={selectedTank}
                  onSelect={setSelectedTank}
                />
                {/**
                 * 单元检视器浮在画布上而不是塞进侧栏：
                 * 点哪个池子就在池子旁边看数据、改参数，视线不用离开工艺图。
                 */}
                {selectedTank &&
                  (() => {
                    const unit = findUnit(sim.topology ?? PLANT_TOPOLOGY, selectedTank);
                    if (!unit) return null;
                    return (
                      <UnitInspector
                        snap={snap}
                        topo={sim.topology ?? PLANT_TOPOLOGY}
                        unit={unit}
                        onClose={() => setSelectedTank(null)}
                        onSelect={setSelectedTank}
                        onChangeControls={sim.setControls}
                        onEditTopology={() => {
                          seedDraft(sim.topology ?? PLANT_TOPOLOGY);
                          setView('editor');
                        }}
                      />
                    );
                  })()}
              </div>
              <Collapsible
                title="趋势"
                summary="COD / 营养盐 / 能耗 · 最近 24 小时"
                defaultOpen
                keepMounted
                className="trend-section"
              >
                <Trends snap={snap} />
              </Collapsible>
            </>
          ) : (
            <ProcessEditor
              snap={snap}
              topology={draft ?? sim.topology ?? PLANT_TOPOLOGY}
              selectedId={editorSelected}
              onSelectedChange={setEditorSelected}
              selectionIds={editorSelection}
              onSelectionChange={setEditorSelection}
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
              <button
                className="side-tab"
                role="tab"
                aria-selected={tab === 'health'}
                data-active={tab === 'health'}
                onClick={() => {
                  setTab('health');
                  sim.watchdogReload();
                }}
              >
                自检
                {sim.watchdog && sim.watchdog.severity !== 'ok' && (
                  <span className="side-tab-count">
                    {sim.watchdog.checks.filter((c) => c.severity !== 'ok').length}
                  </span>
                )}
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
            {tab === 'health' && <WatchdogPanel report={sim.watchdog} />}
          </aside>
        )}
      </div>

      <ModelSettingsPanel llm={sim.llm} open={modelPanelOpen} onClose={() => setModelPanelOpen(false)} />
      <AgentSettingsPanel agent={sim.agent} open={agentPanelOpen} onClose={() => setAgentPanelOpen(false)} />

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
