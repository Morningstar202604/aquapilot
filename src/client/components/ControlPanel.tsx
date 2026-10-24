import { CONTROL_BOUNDS, SCENARIO_LABELS, labelOf, precisionOf } from './labels';
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
  aiEnabled: boolean;
}

const ORDER: (keyof Omit<ControlSettings, 'aiEnabled'>)[] = [
  'doSetpoint',
  'internalRecirc',
  'rasRatio',
  'wasRatio',
  'stepFeed',
  'pacDose',
  'carbonDose',
  'alkDose',
];

export function ControlPanel({ snap, onChange, onStartScenario, onClearScenario, onApplyPreset, aiEnabled }: Props) {
  const activeType = snap.scenario?.type ?? null;
  const activeRemaining = snap.scenario
    ? Math.max(0, snap.scenario.startedAt + snap.scenario.durationMin - snap.timeMin)
    : 0;
  const showStorm = snap.scenario?.type === 'storm' || snap.stormStorageM3 > 0.5;

  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">工艺模板（切换会重建并预热）</div>
        <div className="preset-list">
          {PRESETS.map((p) => (
            <button key={p.id} className="preset-item" onClick={() => onApplyPreset(p.id)}>
              <span className="preset-name">{p.name}</span>
              <span className="preset-desc">{p.description}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="section-label">工艺控制变量</div>
        {ORDER.map((key) => {
          const meta = CONTROL_BOUNDS[key];
          const value = snap.controls[key] as number;
          const pct = ((value - meta.min) / (meta.max - meta.min)) * 100;
          return (
            <div className="control-row" key={key}>
              <div className="control-top">
                <label className="control-name" htmlFor={`ctl-${key}`}>
                  {labelOf(key)}
                </label>
                <span className="control-val">
                  {value.toFixed(precisionOf(key))}
                  <span>{meta.unit}</span>
                </span>
              </div>
              <div className="range-wrap">
                <div className="range-fill" style={{ width: `${pct}%` }} />
                <input
                  id={`ctl-${key}`}
                  className="range"
                  type="range"
                  min={meta.min}
                  max={meta.max}
                  step={meta.step}
                  value={value}
                  onChange={(e) => onChange({ [key]: Number(e.target.value) } as Partial<ControlSettings>)}
                  aria-label={`${labelOf(key)}，当前 ${value.toFixed(precisionOf(key))} ${meta.unit}`}
                />
              </div>
              <div className="control-hint">
                范围 {meta.min}–{meta.max} {meta.unit}
                {aiEnabled ? ' · AI 持权，手动调整会触发重新推演' : ''}
              </div>
            </div>
          );
        })}
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
      </div>

      <div>
        <div className="section-label">工况注入</div>
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
      </div>
    </div>
  );
}
