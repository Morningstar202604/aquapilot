import { CONTROL_BOUNDS, labelOf, precisionOf } from './labels';
import type { ControlSettings } from '../../sim/config';
import type { PlantSnapshot } from '../../shared/protocol';
import type { ProcessTopology, UnitSpec } from '../../model/topology';
import { UNIT_KIND_ICON } from './unitIcons';

interface Props {
  snap: PlantSnapshot;
  topo: ProcessTopology;
  unit: UnitSpec;
  onClose: () => void;
  onSelect: (id: string | null) => void;
  onChangeControls: (patch: Partial<ControlSettings>) => void;
  onEditTopology: () => void;
}

const KIND_LABEL: Record<string, string> = {
  inlet: '进水',
  screening: '格栅',
  grit: '沉砂',
  primary: '初沉',
  anaerobic: '厌氧',
  anoxic: '缺氧',
  aerobic: '好氧',
  clarifier: '二沉',
  disinfection: '消毒',
  outlet: '排放',
  storage: '调蓄',
  thickener: '浓缩',
  dewatering: '脱水',
  blower: '鼓风',
  chemical: '加药',
  pump: '泵',
  splitter: '分流',
};

/**
 * 单元检视器。
 *
 * 点画布上的任何一个池子，就在这里看到它的实时数值、几何参数，
 * 以及**真的能改**的控制量（只列该单元自己支持的那几个，例如好氧池
 * 只有溶解氧，二沉池才有回流比）——这就是流程模拟器里「双击设备弹属性」
 * 的等价物。几何参数不在监视页直接改：改几何要重建并预热整个厂，
 * 走「在工艺编排中编辑」这条有校验与撤销的路径。
 */
export function UnitInspector({ snap, topo, unit, onClose, onSelect, onChangeControls, onEditTopology }: Props) {
  const tank = snap.tanks.find((t) => t.id === unit.id);
  const tickets = (unit.interventions ?? []).filter(
    (k): k is keyof Omit<ControlSettings, 'aiEnabled'> =>
      k in CONTROL_BOUNDS && k !== 'aerationOn' && k !== 'pumpSpeed',
  );
  const incoming = topo.connections.filter((c) => c.to.unit === unit.id);
  const outgoing = topo.connections.filter((c) => c.from.unit === unit.id);

  return (
    <div className="unit-inspector" role="dialog" aria-label={`${unit.name} 属性`}>
      <div className="unit-inspector-head">
        <span className="unit-kind-badge" aria-hidden="true">
          {UNIT_KIND_ICON[unit.kind] ?? '▢'}
        </span>
        <span className="unit-kind-label">{KIND_LABEL[unit.kind] ?? unit.kind}</span>
        <span className="unit-inspector-title">{unit.name}</span>
        <button className="model-close" onClick={onClose} aria-label="关闭单元属性">
          ×
        </button>
      </div>

      <div className="unit-inspector-body">
        <div className="unit-inspector-row">
          <span>工艺角色</span>
          <b>{unit.role}</b>
        </div>
        {typeof unit.volume === 'number' && (
          <div className="unit-inspector-row">
            <span>容积</span>
            <b>{unit.volume.toLocaleString()} m³</b>
          </div>
        )}
        {typeof unit.area === 'number' && (
          <div className="unit-inspector-row">
            <span>面积</span>
            <b>{unit.area.toLocaleString()} m²</b>
          </div>
        )}
        {typeof unit.depth === 'number' && (
          <div className="unit-inspector-row">
            <span>池深</span>
            <b>{unit.depth} m</b>
          </div>
        )}
        {tank && (
          <>
            <div className="unit-inspector-row">
              <span>溶解氧</span>
              <b>{tank.do.toFixed(2)} mg/L</b>
            </div>
            <div className="unit-inspector-row">
              <span>MLSS</span>
              <b>{Math.round(tank.mlss)} mg/L</b>
            </div>
            <div className="unit-inspector-row">
              <span>NH₄ / NO₃</span>
              <b>
                {tank.nh.toFixed(1)} / {tank.no3.toFixed(1)} mg/L
              </b>
            </div>
          </>
        )}
        {unit.kind === 'clarifier' && (
          <>
            <div className="unit-inspector-row">
              <span>泥位</span>
              <b>{snap.clarifier.blanketM.toFixed(2)} m</b>
            </div>
            {snap.clarifier.profile && snap.clarifier.profile.length > 0 && (
              <>
                <div className="section-label" style={{ marginTop: 8 }}>
                  十层污泥浓度剖面（g SS/m³）
                </div>
                <div className="settler-profile" role="img" aria-label="二沉池十层浓度剖面">
                  {snap.clarifier.profile.map((x, i) => {
                    const max = Math.max(...snap.clarifier.profile!, 1);
                    const feed = snap.clarifier.feedLayer ?? 0;
                    return (
                      <div
                        className="settler-layer"
                        key={i}
                        data-feed={i + 1 === feed}
                        title={`第 ${i + 1} 层${i + 1 === feed ? '（进料）' : ''}：${x.toFixed(0)} g SS/m³`}
                      >
                        <span className="settler-layer-index">{i + 1}</span>
                        <span className="settler-layer-bar">
                          <span style={{ width: `${Math.min(100, (x / max) * 100)}%` }} />
                        </span>
                        <span className="settler-layer-value">{x.toFixed(0)}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="control-hint">
                  第 {snap.clarifier.feedLayer ?? '—'} 层为进料层；底层浓度决定回流污泥浓度 xRas{' '}
                  {snap.clarifier.xRas.toFixed(0)} mg/L
                </div>
              </>
            )}
          </>
        )}

        <div className="unit-inspector-row">
          <span>物流</span>
          <b>
            进 {incoming.length} · 出 {outgoing.length}
          </b>
        </div>
        {unit.meta && Object.keys(unit.meta).length > 0 && (
          <details className="unit-meta">
            <summary>设备参数（{Object.keys(unit.meta).length}）</summary>
            {Object.entries(unit.meta).map(([k, v]) => (
              <div className="unit-inspector-row" key={k}>
                <span>{k}</span>
                <b>{String(v)}</b>
              </div>
            ))}
          </details>
        )}
        {incoming.length > 0 && (
          <details className="unit-meta">
            <summary>连接的物流（{incoming.length + outgoing.length}）</summary>
            {incoming.map((c) => (
              <div className="unit-link-row" key={c.id}>
                <span className="unit-link-dot" data-stream={c.stream} />进 · {c.from.unit}.{c.from.port}
              </div>
            ))}
            {outgoing.map((c) => (
              <div className="unit-link-row" key={c.id}>
                <span className="unit-link-dot" data-stream={c.stream} />出 · {c.to.unit}.{c.to.port}
              </div>
            ))}
          </details>
        )}

        {tickets.length > 0 && (
          <>
            <div className="section-label" style={{ marginTop: 10 }}>
              可调参数
            </div>
            {tickets.map((key) => {
              const meta = CONTROL_BOUNDS[key];
              const value = snap.controls[key] as number;
              return (
                <div className="control-row" key={key}>
                  <div className="control-top">
                    <label className="control-name" htmlFor={`insp-${key}`}>
                      {labelOf(key)}
                    </label>
                    <span className="control-val">
                      {value.toFixed(precisionOf(key))}
                      <span>{meta.unit}</span>
                    </span>
                  </div>
                  <div className="range-wrap">
                    <div
                      className="range-fill"
                      style={{ width: `${((value - meta.min) / (meta.max - meta.min)) * 100}%` }}
                    />
                    <input
                      id={`insp-${key}`}
                      className="range"
                      type="range"
                      min={meta.min}
                      max={meta.max}
                      step={meta.step}
                      value={value}
                      onChange={(e) => onChangeControls({ [key]: Number(e.target.value) } as Partial<ControlSettings>)}
                      aria-label={`${labelOf(key)}，当前 ${value.toFixed(precisionOf(key))} ${meta.unit}`}
                    />
                  </div>
                  <div className="control-hint">
                    范围 {meta.min}–{meta.max} {meta.unit}
                  </div>
                </div>
              );
            })}
          </>
        )}
        {tickets.length === 0 && <div className="control-hint">该单元没有可直接调节的运行参数。</div>}

        <div className="decision-actions" style={{ marginTop: 10 }}>
          <button className="btn" onClick={onEditTopology}>
            在工艺编排中编辑
          </button>
          <button className="btn" onClick={() => onSelect(null)}>
            取消选中
          </button>
        </div>
      </div>
    </div>
  );
}
