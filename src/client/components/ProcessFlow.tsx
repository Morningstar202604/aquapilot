import { useEffect, useMemo, useRef, useState } from 'react';
import type { PlantSnapshot } from '../../shared/protocol';
import { PLANT } from '../../sim/config';

interface Props {
  snap: PlantSnapshot;
  onSelectTank: (id: string) => void;
  selected: string | null;
}

const W = 1180;
const H = 600;

function waterColor(ratio: number, alpha = 1): string {
  const r = Math.round(62 + Math.min(1.2, ratio) * 193);
  const g = Math.round(224 - Math.min(1.2, ratio) * 128);
  const b = Math.round(181 - Math.min(1.2, ratio) * 101);
  return `rgba(${r},${g},${b},${alpha})`;
}

const ratioOf = (value: number, limit: number) => Math.max(0, Math.min(1.3, value / limit));

export function ProcessFlow({ snap, onSelectTank, selected }: Props) {
  const [hover, setHover] = useState<string | null>(null);
  const [phase, setPhase] = useState(0);
  const raf = useRef(0);

  useEffect(() => {
    let last = 0;
    const tick = (t: number) => {
      if (t - last > 55) {
        last = t;
        setPhase((p) => (p + 1) % 2000);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, []);

  const tankById = useMemo(() => Object.fromEntries(snap.tanks.map((t) => [t.id, t])), [snap.tanks]);

  const flowW = Math.max(2.4, Math.min(7, snap.influent.flow / 380));
  const irW = Math.max(1.6, Math.min(5, snap.controls.internalRecirc * 1.8));
  const rasW = Math.max(1.6, Math.min(6, snap.controls.rasRatio * 3.6));
  const effRatio = ratioOf(snap.effluent.cod, 50);
  const inRatio = ratioOf(snap.influent.cod, 600);

  const tankBoxes = [
    { id: 'anaerobic', x: 110, y: 130, w: 118, h: 120 },
    { id: 'anoxic', x: 254, y: 130, w: 118, h: 120 },
    { id: 'aerobic1', x: 398, y: 130, w: 104, h: 120 },
    { id: 'aerobic2', x: 518, y: 130, w: 104, h: 120 },
    { id: 'aerobic3', x: 638, y: 130, w: 104, h: 120 },
  ];

  const pipe = (fromX: number, toX: number, y: number, width: number, color: string, key: string) => {
    const len = Math.max(1, Math.abs(toX - fromX));
    const offset = (phase * 2.6) % (len + 42);
    return (
      <g key={key}>
        <line x1={fromX} y1={y} x2={toX} y2={y} stroke={color} strokeWidth={width} strokeLinecap="butt" opacity={0.92} />
        <line
          x1={fromX}
          y1={y}
          x2={toX}
          y2={y}
          stroke="rgba(255,255,255,0.55)"
          strokeWidth={Math.max(1, width * 0.34)}
          strokeDasharray="6 46"
          strokeDashoffset={fromX < toX ? -offset : offset}
        />
      </g>
    );
  };

  const clarifierFlow = snap.clarifier.underflowM3h;
  const wastedKgPerDay = snap.controls.wasRatio * snap.influent.flow * 24 * (snap.clarifier.xRas / 1000);

  return (
    <div className="process-panel">
      <div className="process-head">
        <div className="process-title">A²/O 生物处理 · 深度保障 · 污泥处理 · 实时物料流向</div>
        <div className="process-legend">
          <div className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--water)' }} />
            水线
          </div>
          <div className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--cyan)' }} />
            内回流
          </div>
          <div className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--amber)' }} />
            污泥线
          </div>
          <div className="legend-item">
            <span className="legend-swatch" style={{ background: 'var(--alarm)' }} />
            越限
          </div>
        </div>
      </div>

      <svg
        className="flow-svg"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="污水处理工艺流程实时图，包含厌氧池、缺氧池、三段好氧池、二沉池、消毒接触池、鼓风机房、加药间与污泥处理线"
      >
        <defs>
          <linearGradient id="clarGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="rgba(62,224,181,0.18)" />
            <stop offset="62%" stopColor="rgba(62,224,181,0.10)" />
            <stop offset="100%" stopColor="rgba(150,110,70,0.24)" />
          </linearGradient>
        </defs>

        {/* 进水 */}
        <g>
          <rect x={18} y={176} width={70} height={26} fill="none" stroke="var(--line)" />
          <text x={20} y={170} className="annotation">
            进水
          </text>
          {pipe(88, 110, 189, flowW, waterColor(inRatio, 0.85), 'in')}
          <text x={18} y={222} className="node-value">
            {snap.influent.flow.toFixed(0)} m³/h
          </text>
          <text x={18} y={236} className="node-sub">
            COD {snap.influent.cod.toFixed(0)} · NH₄ {snap.influent.nh.toFixed(1)}
          </text>
          <text x={18} y={249} className="node-sub">
            TP {snap.influent.tp.toFixed(1)} · {snap.influent.temperature.toFixed(1)}℃
          </text>
        </g>

        {/* 池体 */}
        {tankBoxes.map((box, i) => {
          const tank = tankById[box.id];
          if (!tank) return null;
          const isSel = selected === box.id;
          const isHover = hover === box.id;
          const bad = tank.kind === 'aerobic' && tank.do < 1.2;
          const next = tankBoxes[i + 1];
          return (
            <g key={box.id}>
              {next &&
                pipe(
                  box.x + box.w,
                  next.x,
                  190,
                  flowW * 0.85,
                  waterColor(ratioOf(tank.cod, 400)),
                  `lk-${box.id}`,
                )}
              <g
                className="ai-badge"
                onClick={() => onSelectTank(box.id)}
                onMouseEnter={() => setHover(box.id)}
                onMouseLeave={() => setHover(null)}
                role="button"
                tabIndex={0}
                aria-label={`${tank.name}，溶解氧 ${tank.do.toFixed(2)} 毫克每升，污泥浓度 ${tank.mlss} 毫克每升`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelectTank(box.id);
                }}
              >
                <rect
                  x={box.x}
                  y={box.y}
                  width={box.w}
                  height={box.h}
                  fill={tank.kind === 'aerobic' ? `rgba(79,214,232,${0.07 + Math.min(0.2, tank.do * 0.06)})` : 'rgba(62,224,181,0.06)'}
                  stroke={isSel ? 'var(--water)' : isHover ? 'var(--water-dim)' : bad ? 'var(--alarm-dim)' : 'var(--line)'}
                  strokeWidth={isSel ? 1.8 : 1}
                />
                <rect x={box.x} y={box.y} width={box.w} height={19} fill="rgba(6,16,15,0.62)" />
                <text x={box.x + 8} y={box.y + 14} className="node-label">
                  {tank.name}
                </text>
                <text x={box.x + 8} y={box.y + 38} className="node-sub">
                  {tank.kind === 'anaerobic' ? '释磷 · 水解酸化' : tank.kind === 'anoxic' ? '反硝化 · 脱氮' : '硝化 · 有机物氧化'}
                </text>
                <text x={box.x + 8} y={box.y + 60} className="node-value">
                  DO {tank.do.toFixed(2)}
                </text>
                <text x={box.x + 8} y={box.y + 76} className="node-sub">
                  MLSS {tank.mlss}
                </text>
                <text x={box.x + 8} y={box.y + 91} className="node-sub">
                  NH₄ {tank.nh.toFixed(1)} · NO₃ {tank.no3.toFixed(1)}
                </text>
                <text x={box.x + 8} y={box.y + 106} className="node-sub">
                  TP {tank.tp.toFixed(2)} · 碱度 {tank.alkalinity.toFixed(0)}
                </text>
                {tank.kind === 'aerobic' &&
                  [0, 1, 2, 3].map((k) => (
                    <circle
                      key={k}
                      cx={box.x + 14 + k * 24}
                      cy={box.y + box.h - 8 - ((phase * 0.5 + k * 17) % 30)}
                      r={1.3 + (k % 2) * 0.7}
                      fill="var(--cyan)"
                      opacity={0.55}
                    />
                  ))}
              </g>
            </g>
          );
        })}

        {/* 二沉池 → 消毒 */}
        {pipe(746, 768, 190, flowW * 0.85, waterColor(ratioOf(tankById.aerobic3?.cod ?? 20, 400)), 'toClar')}

        <g
          className="ai-badge"
          onClick={() => onSelectTank('clarifier')}
          onMouseEnter={() => setHover('clarifier')}
          onMouseLeave={() => setHover(null)}
          role="button"
          tabIndex={0}
          aria-label={`二沉池，污泥界面 ${snap.clarifier.blanketM.toFixed(2)} 米`}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onSelectTank('clarifier');
          }}
        >
          <rect
            x={768}
            y={100}
            width={140}
            height={180}
            fill="url(#clarGrad)"
            stroke={selected === 'clarifier' ? 'var(--water)' : hover === 'clarifier' ? 'var(--water-dim)' : 'var(--line)'}
          />
          <rect x={768} y={100} width={140} height={19} fill="rgba(6,16,15,0.62)" />
          <text x={776} y={114} className="node-label">
            二沉池
          </text>
          {(() => {
            const depth = PLANT.clarifier.depth;
            const fx = 772;
            const fw = 132;
            const fy = 126;
            const fh = 148;
            const bh = Math.min(fh, (snap.clarifier.blanketM / depth) * fh);
            const over = snap.clarifier.blanketM > depth - 0.4;
            return (
              <>
                <rect x={fx} y={fy + fh - bh} width={fw} height={bh} fill={over ? 'rgba(190,80,60,0.34)' : 'rgba(150,110,70,0.3)'} />
                <line
                  x1={fx}
                  y1={fy + fh - bh}
                  x2={fx + fw}
                  y2={fy + fh - bh}
                  stroke={over ? 'var(--alarm)' : 'var(--amber)'}
                  strokeWidth="1.3"
                  strokeDasharray="4 3"
                />
                <text x={fx + 4} y={fy + fh - bh - 4} className="annotation">
                  泥位 {snap.clarifier.blanketM.toFixed(2)} m
                </text>
                <text x={fx + 4} y={fy + 14} className="node-sub">
                  出水 SS {snap.effluent.ss.toFixed(1)}
                </text>
                <text x={fx + 4} y={fy + 30} className="node-sub">
                  SLR {snap.clarifier.slr.toFixed(1)} kg/m²·h
                </text>
                <text x={fx + 4} y={fy + 46} className="node-sub">
                  回流污泥 {snap.clarifier.xRas.toFixed(0)} mg/L
                </text>
              </>
            );
          })()}
        </g>

        {/* 消毒接触池 */}
        <g>
          {pipe(908, 934, 158, flowW * 0.7, waterColor(effRatio, 0.8), 'toDis')}
          <rect x={934} y={128} width={96} height={60} fill="rgba(79,214,232,0.07)" stroke="var(--line)" />
          <text x={942} y={145} className="node-label">
            消毒接触池
          </text>
          <text x={942} y={162} className="node-sub">
            紫外 40 mJ/cm²
          </text>
          <text x={942} y={176} className="node-sub">
            接触 30 min
          </text>
        </g>

        {/* 出水 */}
        <g>
          {pipe(1030, 1056, 158, flowW * 0.7, waterColor(effRatio, 0.85), 'toOut')}
          <rect x={1056} y={128} width={98} height={60} fill="none" stroke="var(--water-dim)" />
          <text x={1064} y={145} className="node-label">
            达标排放
          </text>
          <text x={1064} y={162} className="node-value">
            {snap.effluent.flow.toFixed(0)} m³/h
          </text>
          <text x={1064} y={178} className="node-sub">
            COD {snap.effluent.cod.toFixed(1)} · NH₄ {snap.effluent.nh.toFixed(2)}
          </text>
          <text x={1064} y={210} className="node-sub">
            TN {snap.effluent.tn.toFixed(1)} · TP {snap.effluent.tp.toFixed(2)}
          </text>
        </g>

        {/* 内回流 */}
        <g>
          <path
            d={`M 690 250 L 690 306 L 313 306 L 313 250`}
            fill="none"
            stroke="var(--cyan)"
            strokeWidth={irW}
            opacity={0.62}
            strokeLinejoin="round"
            strokeDasharray="3 9"
            strokeDashoffset={-(phase * 0.8)}
          />
          <text x={330} y={300} className="annotation">
            内回流 {snap.controls.internalRecirc.toFixed(1)}×Q → 缺氧区
          </text>
        </g>

        {/* 污泥回流 */}
        <g>
          <path
            d={`M 794 280 L 794 344 L 169 344 L 169 250`}
            fill="none"
            stroke="var(--amber)"
            strokeWidth={rasW}
            opacity={0.6}
            strokeLinejoin="round"
            strokeDasharray="3 8"
            strokeDashoffset={-(phase * 0.62)}
          />
          <text x={200} y={338} className="annotation">
            污泥回流 {snap.controls.rasRatio.toFixed(2)}×Q · 混合液 SRT {snap.srtDays.toFixed(1)} d · F/M{' '}
            {snap.fmRatio.toFixed(3)}
          </text>
        </g>

        {/* 剩余污泥 → 浓缩 → 脱水 */}
        <g>
          <path d={`M 890 280 L 890 372 L 898 372`} fill="none" stroke="var(--amber-dim)" strokeWidth="2" strokeDasharray="4 3" />
          <text x={800} y={300} className="annotation" textAnchor="end">
            排泥 {(wastedKgPerDay / 1000).toFixed(1)} t/d
          </text>
          <rect x={830} y={372} width={112} height={72} fill="rgba(150,110,70,0.09)" stroke="var(--line)" />
          <text x={838} y={390} className="node-label">
            污泥浓缩池
          </text>
          <text x={838} y={406} className="node-sub">
            进泥 {(clarifierFlow * 24 / 1000).toFixed(1)}k m³/d
          </text>
          <text x={838} y={421} className="node-sub">
            含水率 97%
          </text>
          <path d="M 942 408 L 966 408" stroke="var(--amber-dim)" strokeWidth="2" />
          <rect x={966} y={372} width={112} height={72} fill="rgba(150,110,70,0.07)" stroke="var(--line)" />
          <text x={974} y={390} className="node-label">
            脱水机房
          </text>
          <text x={974} y={406} className="node-sub">
            干泥 {wastedKgPerDay.toFixed(0)} kg/d
          </text>
          <text x={974} y={421} className="node-sub">
            含水率 60%
          </text>
          <path d="M 1078 408 L 1100 408" stroke="var(--amber-dim)" strokeWidth="2" />
          <rect x={1100} y={380} width={62} height={56} fill="none" stroke="var(--line)" strokeDasharray="3 3" />
          <text x={1106} y={400} className="node-sub">
            泥饼
          </text>
          <text x={1106} y={416} className="node-sub">
            外运
          </text>
        </g>

        {/* 鼓风机房 + 加药间 */}
        <g>
          <path d="M 450 372 L 450 250" stroke="var(--cyan)" strokeWidth="1.2" strokeDasharray="3 6" opacity={0.45} />
          <rect x={386} y={372} width={128} height={72} fill="var(--panel)" stroke="var(--line)" />
          <text x={394} y={390} className="node-label">
            鼓风机房
          </text>
          <text x={394} y={407} className="node-value">
            {snap.energy.blowerKw.toFixed(0)} kW
          </text>
          <text x={394} y={422} className="node-sub">
            供气 {snap.controls.doSetpoint.toFixed(1)} mg/L 目标
          </text>
          <text x={394} y={436} className="node-sub">
            全厂 {snap.energy.totalKw.toFixed(0)} kW
          </text>

          <path d="M 594 372 L 594 250" stroke="var(--amber)" strokeWidth="1.2" strokeDasharray="3 6" opacity={0.35} />
          <rect x={530} y={372} width={128} height={72} fill="var(--panel)" stroke="var(--line)" />
          <text x={538} y={390} className="node-label">
            加药间
          </text>
          <text x={538} y={407} className="node-sub">
            PAC {snap.controls.pacDose.toFixed(0)} mg/L
          </text>
          <text x={538} y={422} className="node-sub">
            碳源 {snap.controls.carbonDose.toFixed(0)} · 碱度 {snap.controls.alkDose.toFixed(0)}
          </text>
          <text x={538} y={436} className="node-sub">
            今日药耗 ¥{snap.cost.chemicalToday.toFixed(0)}
          </text>
        </g>

        {/* 调蓄池 */}
        <g>
          <rect x={110} y={372} width={116} height={72} fill="rgba(79,214,232,0.06)" stroke="var(--line)" />
          <text x={118} y={390} className="node-label">
            雨水调蓄池
          </text>
          <text x={118} y={407} className="node-value">
            {(snap.stormStorageM3 / 1000).toFixed(1)}k m³
          </text>
          <text x={118} y={422} className="node-sub">
            容量 16 000 m³
          </text>
          <text x={118} y={436} className="node-sub">
            分流后进水 {snap.influent.flow.toFixed(0)}
          </text>
        </g>

        {/* 底部：达标裕度 */}
        <g>
          <rect x={18} y={474} width={1136} height={62} fill="rgba(6,16,15,0.5)" stroke="var(--line-soft)" />
          <text x={30} y={492} className="annotation">
            达标裕度（越靠右越危险，虚线为限值）
          </text>
          {snap.margins.map((m, i) => {
            const x = 250 + i * 148;
            const r = Math.min(1.3, m.ratio);
            const col = r > 1 ? 'var(--alarm)' : r > 0.85 ? 'var(--amber)' : 'var(--water)';
            return (
              <g key={m.metric}>
                <text x={x} y={490} className="node-sub">
                  {m.metric} {m.value.toFixed(m.value < 1 ? 3 : 1)} / {m.limit}
                </text>
                <rect x={x} y={500} width={132} height={4} fill="var(--line-soft)" />
                <rect x={x} y={500} width={Math.min(132, (r / 1.3) * 132)} height={4} fill={col} opacity={0.85} />
                <line x1={x + 132 / 1.3} y1={496} x2={x + 132 / 1.3} y2={508} stroke="var(--text-3)" strokeWidth="1" strokeDasharray="2 2" />
              </g>
            );
          })}
          <text x={30} y={516} className="node-sub">
            日处理 {((snap.totals.inflowM3 / Math.max(1, snap.timeMin / 1440)) / 1000).toFixed(1)} 千 m³ · 累计电耗{' '}
            {(snap.totals.energyKwh / 1000).toFixed(1)} MWh · 累计成本 ¥{(snap.totals.cost / 1000).toFixed(1)}k
          </text>
        </g>
      </svg>
    </div>
  );
}

export function TankDetail({ snap, tankId, onClose }: { snap: PlantSnapshot; tankId: string; onClose: () => void }) {
  if (tankId === 'clarifier') {
    return (
      <div className="section-label">
        二沉池 · 界面 {snap.clarifier.blanketM.toFixed(2)} m
        <button className="chip" onClick={onClose} style={{ marginLeft: 'auto' }}>
          收起
        </button>
      </div>
    );
  }
  const tank = snap.tanks.find((t) => t.id === tankId);
  if (!tank) return null;
  return (
    <>
      <div className="section-label">
        {tank.name}
        <button className="chip" onClick={onClose} style={{ marginLeft: 'auto' }}>
          收起
        </button>
      </div>
      <div className="alt-row">
        <span className="alt-name">溶解氧</span>
        <span className="alt-score">{tank.do.toFixed(2)} mg/L</span>
      </div>
      <div className="alt-row">
        <span className="alt-name">污泥浓度</span>
        <span className="alt-score">{tank.mlss} mg/L</span>
      </div>
      <div className="alt-row">
        <span className="alt-name">氨氮 / 硝酸盐</span>
        <span className="alt-score">
          {tank.nh.toFixed(2)} / {tank.no3.toFixed(2)}
        </span>
      </div>
      <div className="alt-row">
        <span className="alt-name">总磷 / 碱度</span>
        <span className="alt-score">
          {tank.tp.toFixed(2)} / {tank.alkalinity.toFixed(0)}
        </span>
      </div>
    </>
  );
}
