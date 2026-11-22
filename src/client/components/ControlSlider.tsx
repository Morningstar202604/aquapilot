import { CONTROL_BOUNDS } from '../../sim/config';
import type { ControlKey, ControlSettings } from '../../sim/config';
import { labelOf, precisionOf } from './labels';

interface Props {
  /** DOM id 前缀：控制面板用 ctl，单元属性面板用 insp */
  idPrefix: string;
  controlKey: ControlKey;
  value: number;
  onChange: (patch: Partial<ControlSettings>) => void;
  /** 范围提示后追加的说明（例如 AI 持权提示） */
  hintSuffix?: string;
}

/**
 * 单个控制量滑块。
 *
 * 控制面板与单元属性面板此前各写了一份相同的 range / 填充条 / aria，
 * 改一处文案另一处就漏；这里把标签、精度、单位、范围合并为一个组件。
 */
export function ControlSlider({ idPrefix, controlKey, value, onChange, hintSuffix = '' }: Props) {
  const meta = CONTROL_BOUNDS[controlKey];
  const pct = ((value - meta.min) / (meta.max - meta.min)) * 100;
  const id = `${idPrefix}-${controlKey}`;
  return (
    <div className="control-row">
      <div className="control-top">
        <label className="control-name" htmlFor={id}>
          {labelOf(controlKey)}
        </label>
        <span className="control-val">
          {value.toFixed(precisionOf(controlKey))}
          <span>{meta.unit}</span>
        </span>
      </div>
      <div className="range-wrap">
        <div className="range-fill" style={{ width: `${pct}%` }} />
        <input
          id={id}
          className="range"
          type="range"
          min={meta.min}
          max={meta.max}
          step={meta.step}
          value={value}
          onChange={(e) => onChange({ [controlKey]: Number(e.target.value) } as Partial<ControlSettings>)}
          aria-label={`${labelOf(controlKey)}，当前 ${value.toFixed(precisionOf(controlKey))} ${meta.unit}`}
        />
      </div>
      <div className="control-hint">
        范围 {meta.min}–{meta.max} {meta.unit}
        {hintSuffix}
      </div>
    </div>
  );
}
