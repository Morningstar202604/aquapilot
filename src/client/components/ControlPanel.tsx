import { SCENARIO_LABELS } from './labels';
import { CONTROL_KEYS } from '../../sim/config';
import { useThrottledControl } from '../hooks/useThrottledControl';
import { Collapsible } from './Collapsible';
import { ControlSlider } from './ControlSlider';
import { SCENARIO_ORDER, SCENARIOS } from '../../sim/scenarios';
import { PRESETS } from '../../model/presets';
import type { ControlSettings } from '../../sim/config';
import type { PlantSnapshot } from '../../shared/protocol';
import type { ScenarioType } from '../../sim/scenarios';

interface Props {
  snap: PlantSnapshot;
  onChange: (patch: Partial<ControlSettings>) => void;
  onStartScenario: (type: ScenarioType) => void;
  onClearScenario: () => void;
  onApplyPreset: (id: string) => void;
  onSetModel: (model: 'simple' | 'asm1') => void;
  aiEnabled: boolean;
}

/** 可选求解模型：一个是快，一个是准。 */
const MODELS = [
  { id: 'simple' as const, name: '简化模型', desc: '活性污泥经验式，单步快，适合日常值守' },
  { id: 'asm1' as const, name: 'ASM1', desc: '13 组分活性污泥模型，更准，单步更慢' },
];

/**
 * 连续控制滑块的顺序从 CONTROL_KEYS 派生，新增控制量会自动出现。
 * stormStore 由暴雨工况驱动，不在这里给手动滑块。
 */
const ORDER = CONTROL_KEYS.filter((key) => key !== 'stormStore');

export function ControlPanel({
  snap,
  onChange,
  onStartScenario,
  onClearScenario,
  onApplyPreset,
  onSetModel,
  aiEnabled,
}: Props) {
  /**
   * 滑块节流：拖动期间的 60 Hz 事件不能逐条变成 WS 消息。
   * 服务端限流 500 ms/次，逐条发会让绝大多数请求被拒并弹出提示。
   */
  const commitControls = useThrottledControl(onChange);
  const activeType = snap.scenario?.type ?? null;
  const activeRemaining = snap.scenario
    ? Math.max(0, snap.scenario.startedAt + snap.scenario.durationMin - snap.timeMin)
    : 0;
  const showStorm = snap.scenario?.type === 'storm' || snap.stormStorageM3 > 0.5;

  return (
    <div className="scroll-panel">
      {/**
       * 侧栏按「环节」折叠：首屏只露出每组的当前状态，要改哪一项再展开。
       * 8 个滑块 + 8 个工况卡片全展开时一屏放不下，操作员要滚三屏才能找
       * 到 PAC 投加——这是实测反馈里最直接的可用性问题。
       */}

      <Collapsible
        title="求解模型"
        summary={snap.modelMode === 'asm1' ? 'ASM1 · 13 组分' : '简化模型 · 快速'}
        defaultOpen={false}
      >
        <div className="model-switch" role="group" aria-label="求解模型切换">
          {MODELS.map((m) => (
            <button
              key={m.id}
              className="model-choice"
              data-active={snap.modelMode === m.id}
              onClick={() => {
                if (snap.modelMode === m.id) return;
                const ok = window.confirm('切换求解模型会按当前拓扑重建并预热 30 天，仿真时间归零。继续？');
                if (ok) onSetModel(m.id);
              }}
            >
              <span className="model-name">{m.name}</span>
              <span className="model-desc">{m.desc}</span>
            </button>
          ))}
        </div>
      </Collapsible>

      <Collapsible title="工艺模板" summary={`${PRESETS.length} 套 · 切换会重建并预热`} defaultOpen={false}>
        <div className="preset-list">
          {PRESETS.map((p) => (
            <button key={p.id} className="preset-item" onClick={() => onApplyPreset(p.id)}>
              <span className="preset-name">{p.name}</span>
              <span className="preset-desc">{p.description}</span>
            </button>
          ))}
        </div>
      </Collapsible>

      <Collapsible
        title="工艺控制变量"
        summary={
          <>
            DO {snap.controls.doSetpoint.toFixed(1)} · 内回流 {snap.controls.internalRecirc.toFixed(1)} · PAC{' '}
            {snap.controls.pacDose.toFixed(0)}
          </>
        }
        defaultOpen
      >
        {ORDER.map((key) => (
          <ControlSlider
            key={key}
            idPrefix="ctl"
            controlKey={key}
            value={snap.controls[key] as number}
            onChange={commitControls}
            hintSuffix={aiEnabled ? ' · AI 持权，手动调整会触发重新推演' : ''}
          />
        ))}
        {showStorm && (
          <div className="control-row">
            <div className="control-top">
              <span className="control-name">雨水调蓄池</span>
              <span className="control-val">
                {(snap.stormStorageM3 / 1000).toFixed(1)}
                <span>千 m³</span>
              </span>
            </div>
            <div className="storm-meter">
              <span style={{ width: `${Math.min(100, (snap.stormStorageM3 / 16000) * 100)}%` }} />
            </div>
            <div className="control-hint">容量 16 000 m³ · 场景结束后按 320 m³/h 缓慢回流处理</div>
          </div>
        )}
      </Collapsible>

      <Collapsible
        title="工况注入"
        summary={
          activeType
            ? `进行中：${SCENARIO_LABELS[activeType]} · 剩 ${Math.round(activeRemaining)} 分钟`
            : `${SCENARIO_ORDER.length} 种事故/工况`
        }
        defaultOpen={Boolean(activeType)}
      >
        <div className="scenario-drawer">
          {SCENARIO_ORDER.map((type) => {
            const meta = SCENARIOS[type];
            return (
              <button
                key={type}
                className="scenario-btn"
                data-active={activeType === type}
                onClick={() => onStartScenario(type)}
                aria-pressed={activeType === type}
              >
                <div className="scenario-name">{meta.label}</div>
                <div className="scenario-desc">{meta.description.split('，')[0]}</div>
              </button>
            );
          })}
        </div>
        {activeType && (
          <div className="decision-actions">
            <button className="btn" onClick={onClearScenario}>
              清除场景（{SCENARIO_LABELS[activeType]}，剩 {Math.round(activeRemaining)} 分钟）
            </button>
          </div>
        )}
      </Collapsible>
    </div>
  );
}
