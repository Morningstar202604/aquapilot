import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as echarts from 'echarts/core';
import { LineChart } from 'echarts/charts';
import { GridComponent, TooltipComponent, MarkLineComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { SnapshotRow } from '../../shared/protocol';
import { formatClock } from '../../shared/time';

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, CanvasRenderer]);

/**
 * 历史回放。
 *
 * 数据来自服务端持久化（SQLite）的快照表，每约 20 仿真分钟一个点。
 * 用途：事后追查"当时到底发生了什么"——这是仿真平台区别于实时监视屏的核心能力。
 */

interface DecisionRow {
  atMin: number;
  action: string;
  severity: string;
  summary: string;
  tweaks: string;
  predictedScore: number;
  separation: number;
}

export function ReplayPanel() {
  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [decisions, setDecisions] = useState<DecisionRow[]>([]);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [cursor, setCursor] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const el = useRef<HTMLDivElement | null>(null);
  const chart = useRef<echarts.ECharts | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // 启用访问控制时，所有 API 需带令牌
      const token = (() => {
        try {
          return window.sessionStorage.getItem('aquapilot_token');
        } catch {
          return null;
        }
      })();
      const headers: HeadersInit = token ? { Authorization: `Bearer ${token}` } : {};
      const [sRes, dRes] = await Promise.all([
        fetch('/api/history/snapshots', { headers }),
        fetch('/api/history/decisions', { headers }),
      ]);
      /**
       * 必须检查 HTTP 状态。
       *
       * 401/500 时 body 是 `{error:...}`，直接当数据解析会让 enabled 变
       * undefined、列表为空，界面显示「还没有历史数据」——把鉴权失败
       * 误报成「没有数据」，用户完全不知道要重新登录。
       */
      if (sRes.status === 401 || dRes.status === 401) {
        setError('令牌无效或已过期，请重新输入访问令牌');
        return;
      }
      if (!sRes.ok || !dRes.ok) {
        setError(`读取历史失败（HTTP ${sRes.ok ? dRes.status : sRes.status}）`);
        return;
      }
      const sJson = (await sRes.json()) as { enabled: boolean; snapshots: SnapshotRow[] };
      const dJson = (await dRes.json()) as { enabled: boolean; decisions: DecisionRow[] };
      setEnabled(sJson.enabled);
      setSnapshots(sJson.snapshots ?? []);
      setDecisions((dJson.decisions ?? []).slice().reverse());
      setCursor(Math.max(0, (sJson.snapshots?.length ?? 1) - 1));
    } catch (err) {
      // fetch 抛错是网络/代理层故障，不是「未启用持久化」——
      // 把两者混为一谈会把运维引向完全错误的排查方向
      console.error('[aqua] 读取回放历史失败', err);
      setError(`无法连接仿真服务读取历史（${String(err instanceof Error ? err.message : err)}）`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 图表容器只在有数据时才渲染，因此初始化必须依赖 snapshots
  useEffect(() => {
    const node = el.current;
    if (!node || snapshots.length === 0) return;
    if (chart.current) return; // 已初始化
    const inst = echarts.init(node, undefined, { renderer: 'canvas' });
    chart.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(node);
    return () => {
      ro.disconnect();
      inst.dispose();
      chart.current = null;
    };
  }, [snapshots]);

  useEffect(() => {
    const inst = chart.current;
    if (!inst || snapshots.length === 0) return;
    const pts = snapshots;
    inst.setOption(
      {
        animation: false,
        grid: { left: 44, right: 14, top: 24, bottom: 24 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: 'rgba(255,255,255,0.97)',
          borderColor: '#d7e2de',
          textStyle: { color: '#182b26', fontSize: 11, fontFamily: 'JetBrains Mono, monospace' },
        },
        xAxis: {
          type: 'category',
          // 采样点可能落在同一小时内：写成 H:MM，否则轴上会连出「0h 0h 0h」
          data: pts.map((p) => formatClock(p.atMin)),
          axisLine: { lineStyle: { color: '#d7e2de' } },
          axisTick: { show: false },
          axisLabel: { color: '#5d7871', fontSize: 9, interval: Math.max(0, Math.floor(pts.length / 6)) },
          splitLine: { show: false },
        },
        yAxis: {
          type: 'value',
          axisLine: { show: false },
          axisTick: { show: false },
          axisLabel: { color: '#5d7871', fontSize: 9 },
          splitLine: { lineStyle: { color: 'rgba(16,49,43,0.12)' } },
        },
        series: [
          {
            name: '出水 COD',
            type: 'line',
            showSymbol: false,
            smooth: 0.2,
            lineStyle: { width: 1.4, color: '#0c9d7e' },
            data: pts.map((p) => Number(p.effluentCod.toFixed(1))),
            markLine: {
              silent: true,
              symbol: 'none',
              label: { show: false },
              lineStyle: { color: 'rgba(210,71,47,0.55)', type: 'dashed' },
              data: [{ yAxis: 50 }],
            },
          },
          {
            name: '出水 NH₄-N',
            type: 'line',
            showSymbol: false,
            smooth: 0.2,
            lineStyle: { width: 1.4, color: '#0d7f96' },
            data: pts.map((p) => Number(p.effluentNh.toFixed(2))),
          },
          {
            name: '出水 TP',
            type: 'line',
            showSymbol: false,
            smooth: 0.2,
            lineStyle: { width: 1.2, color: '#b0770e' },
            data: pts.map((p) => Number(p.effluentTp.toFixed(3))),
          },
        ],
      },
      { notMerge: true },
    );
  }, [snapshots]);

  const current = snapshots[Math.min(cursor, Math.max(0, snapshots.length - 1))];

  /**
   * 与时间轴联动的决策。
   *
   * 取「不晚于当前时刻的最近一条决策」——这才是操作员在那一刻看到的建议。
   * 单纯按列表位置高亮会误导：决策是稀疏的，采样点是连续的。
   */
  const decisionAtCursor = useMemo(() => {
    if (!current) return null;
    let best: DecisionRow | null = null;
    for (const d of decisions) {
      if (d.atMin <= current.atMin) {
        if (!best || d.atMin > best.atMin) best = d;
      }
    }
    return best;
  }, [current, decisions]);

  if (loading)
    return (
      <div className="scroll-panel">
        <div className="empty-note">加载历史…</div>
      </div>
    );

  if (error) {
    return (
      <div className="scroll-panel">
        <div className="panel-empty" role="alert">
          {error}
        </div>
        <button className="btn" onClick={() => void load()}>
          重试
        </button>
      </div>
    );
  }

  if (enabled === false) {
    return (
      <div className="scroll-panel">
        <div className="empty-note">
          持久化未启用，无法回放历史。
          <br />
          {`需要 Node 22+ 的 node:sqlite；若显式设了 AQUAPILOT_PERSIST=0，去掉后重启即可。`}
        </div>
        <button className="chip" onClick={() => void load()} style={{ alignSelf: 'flex-start' }}>
          重新检测
        </button>
      </div>
    );
  }

  if (snapshots.length === 0) {
    return (
      <div className="scroll-panel">
        <div className="empty-note">还没有历史数据，运行一段时间后再看。</div>
        <button className="chip" onClick={() => void load()} style={{ alignSelf: 'flex-start' }}>
          刷新
        </button>
      </div>
    );
  }

  return (
    <div className="scroll-panel">
      <div>
        <div className="section-label">
          历史回放 · {snapshots.length} 个采样点
          <button className="chip" onClick={() => void load()} style={{ marginLeft: 'auto' }}>
            刷新
          </button>
        </div>
        <div ref={el} style={{ height: 190 }} />
      </div>

      <div>
        <div className="section-label">时间轴</div>
        <input
          className="range"
          type="range"
          min={0}
          max={Math.max(0, snapshots.length - 1)}
          value={cursor}
          onChange={(e) => setCursor(Number(e.target.value))}
          aria-label="历史时间轴"
        />
        <div className="control-hint">
          第 {Math.floor((current?.atMin ?? 0) / 60)} 小时 · 评分 {current?.score ?? '—'} · MLSS{' '}
          {current ? Math.round(current.mlss) : '—'} · SRT {current ? current.srtDays.toFixed(1) : '—'} d
        </div>
      </div>

      {decisionAtCursor && (
        <div>
          <div className="section-label">该时刻的 AI 决策</div>
          <div className="decision-card" data-sev={decisionAtCursor.severity}>
            <div className="decision-summary">{decisionAtCursor.summary}</div>
            <div className="control-hint" style={{ marginTop: 6 }}>
              发生于第 {Math.floor(decisionAtCursor.atMin / 60)} 小时 · 预测评分 {decisionAtCursor.predictedScore}/100
            </div>
          </div>
        </div>
      )}

      {current && (
        <div>
          <div className="section-label">该时刻出水</div>
          <div className="alt-row">
            <span className="alt-name">COD</span>
            <span className="alt-score">{current.effluentCod.toFixed(1)} mg/L</span>
            <span className="alt-score">/ 50</span>
          </div>
          <div className="alt-row">
            <span className="alt-name">NH₃-N</span>
            <span className="alt-score">{current.effluentNh.toFixed(2)} mg/L</span>
            <span className="alt-score">/ 5</span>
          </div>
          <div className="alt-row">
            <span className="alt-name">TN</span>
            <span className="alt-score">{current.effluentTn.toFixed(2)} mg/L</span>
            <span className="alt-score">/ 15</span>
          </div>
          <div className="alt-row">
            <span className="alt-name">TP</span>
            <span className="alt-score">{current.effluentTp.toFixed(3)} mg/L</span>
            <span className="alt-score">/ 0.5</span>
          </div>
          <div className="alt-row">
            <span className="alt-name">能耗</span>
            <span className="alt-score">{current.energyKw.toFixed(0)} kW</span>
            <span className="alt-score">—</span>
          </div>
        </div>
      )}

      <div>
        <div className="section-label">决策记录（{decisions.length}）</div>
        {decisions.length === 0 && <div className="empty-note">暂无决策记录</div>}
        {decisions
          .slice(-12)
          .reverse()
          .map((d) => {
            const isCurrent =
              decisionAtCursor && d.atMin === decisionAtCursor.atMin && d.summary === decisionAtCursor.summary;
            return (
              <div
                className="alarm-row"
                key={`${d.atMin}-${d.summary.slice(0, 8)}`}
                data-sev={d.severity === 'critical' ? 'critical' : 'warning'}
                style={isCurrent ? { borderLeftWidth: 3, background: 'rgba(12,157,126,0.08)' } : undefined}
              >
                <div className="alarm-meta">
                  <span>第 {Math.floor(d.atMin / 60)}h</span>
                  <span style={{ color: d.severity === 'critical' ? 'var(--alarm)' : 'var(--amber)' }}>
                    {d.severity}
                  </span>
                  {isCurrent && <span style={{ color: 'var(--water)' }}>· 当前时刻</span>}
                </div>
                <div className="alarm-text">{d.summary}</div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
