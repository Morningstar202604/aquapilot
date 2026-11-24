import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PlantSnapshot } from '../shared/protocol';
import { validateTopology, type ProcessTopology } from '../model/topology';
import type { NetworkSimState } from '../sim/networkEngine';
import { CONTROL_BOUNDS, LIMITS, PLANT } from '../sim/config';
import { DEFAULT_STANDARD, DISCHARGE_STANDARDS } from '../sim/standards';
import { PRESETS } from '../model/presets';
import { checkRunReadiness } from './topologyRuntime';
import { listModelDescriptors } from '../sim/modelRegistry';
import { ADAPTER_CAPABILITIES } from '../sim/dataSources';
import type { Store } from './store';
import type { TopologyStore } from './topologyStore';
import { authRequired, authorize } from './auth';
import { isPublicApiPath, isReadMethod } from './httpRoutes';
import { sendDownload, sendJson, sendText } from './httpJson';
import { boundedWindow, MAX_SNAPSHOT_POINTS } from './queryBounds';
import { buildOperationsReport, decisionsCsv, reviewsCsv, snapshotsCsv } from './export';
import { logger, metrics, metricsJson, renderPrometheus } from './observability';
import { queryOf } from './staticFiles';
import { hydraulicsRoute } from './routes/hydraulics';
import { complianceRoute } from './routes/compliance';
import { assetsRoute } from './routes/assets';
import { protocolsRoute } from './routes/protocols';
import { plantBoundaryRoute } from './routes/plantBoundary';
import { instrumentsRoute } from './routes/instruments';
import { calibrationRoute } from './routes/calibration';
import type { MinuteReading } from '../sim/sampling';
import type { AssetPlantState } from '../sim/assets';
import type { ProtocolAdapter } from './protocols/adapter';
import type { ProtocolAuditLog } from './protocols/audit';
import { createProtocolAudit } from './protocols/audit';
import type { ExperimentApi } from './routes/experiments';
import type { StudyApi } from './routes/studies';
import type { ProtocolKind } from './protocols/tags';

/**
 * 只读 HTTP API 的单一入口。
 *
 * `server/index.ts` 此前把这十几条路由、鉴权默认拒绝、405 语义、导出头
 * 全部塞在 `main()` 的闭包里，单文件超过 2000 行。抽出来后：
 * - 路由顺序与状态码可在一个文件里逐条读完；
 * - 入口只负责安全响应头、MCP 分派与静态文件回落；
 * - 每条路由都能用假的 req/res 做契约测试，不必启动完整仿真。
 *
 * 写操作仍只走 WebSocket：HTTP 这边全部是 GET/HEAD。
 */

export interface ApiRuntimeView {
  topology: ProcessTopology;
  topologyRevision: number;
  net: NetworkSimState;
  activePresetId: string | null;
  paused: boolean;
}

export interface ApiHandlerDeps {
  runtime: () => ApiRuntimeView;
  snapshot: () => PlantSnapshot;
  store: Store;
  topologyStore: TopologyStore;
  /**
   * 工业级扩展的可选接线点。
   *
   * 三个域（合规 / 资产 / 协议）各自是可独立启停的子系统：
   * 未接线时不报错、返回空表，而不是让整个 API 因为一个未装配的子系统 500。
   * 这样单测可以只注入需要的域，生产入口按实际配置逐条接。
   */
  /** WP6：合规采样账本读数（40 天窗口）；缺省视为没有样品 */
  complianceReadings?: () => MinuteReading[];
  /** WP7：资产状态；未接线时 /api/assets 返回空表 */
  assetState?: () => AssetPlantState | null;
  /** WP8：协议通道；未配置时 /api/protocols/status 返回空通道表 */
  protocolAdapters?: () => Partial<Record<ProtocolKind, ProtocolAdapter>>;
  /** WP8：写审计；未配置时 /api/protocols/audit 返回空列表 */
  protocolAudit?: () => ProtocolAuditLog | null;
  /** 版本化实验 API；未接线时该前缀仍会落到 404，不会误入静态资源 */
  experimentApi?: ExperimentApi;
  /** 版本化研究 API（批量变体/Pareto）；同样先于旧只读门分派 */
  studyApi?: StudyApi;
}

/** 路由模块需要 URL（含 searchParams），不是只有 query */
function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://localhost');
}

interface RouteReply {
  status: number;
  body: unknown;
}

/** 路由模块的统一回写：CSV 下载走附件头，其余按 JSON */
function replyTo(res: ServerResponse, reply: RouteReply): void {
  const body = reply.body as { format?: string; csv?: string; filename?: string };
  if (reply.status === 200 && body && body.format === 'csv' && typeof body.csv === 'string') {
    sendDownload(res, body.filename ?? 'report.csv', body.csv, 'text/csv; charset=utf-8');
    return;
  }
  sendJson(res, reply.status, reply.body);
}

export function createApiHandler(deps: ApiHandlerDeps) {
  return function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    /**
     * 访问控制用**默认拒绝**结构：先假设一切 /api/* 都要鉴权，只有
     * 公开白名单显式提前放行。新增端点不写代码就是受保护的。
     */
    // 版本化实验 API：自带 viewer/operator 分级、POST/cancel、幂等键与
    // RFC 9457 错误，必须先于旧只读门分派；否则 401 会以旧 `{error}`
    // 形状提前返回，破坏版本化 API 的错误契约。
    if (deps.studyApi?.matches(pathname)) {
      void deps.studyApi.handle(req, res, pathname);
      return;
    }
    if (deps.experimentApi?.matches(pathname)) {
      deps.experimentApi.handle(req, res, pathname);
      return;
    }
    if (!isPublicApiPath(pathname)) {
      const decision = authorize(req, null, 'viewer');
      if (!decision.allowed) {
        metrics.authFailures += 1;
        logger.warn('auth rejected', {
          scope: 'http',
          route: pathname,
          reason: decision.reason,
          ip: req.socket.remoteAddress,
        });
        sendJson(res, 401, { error: decision.reason, authRequired: true });
        return;
      }
    }
    // 其余 API 都是只读的（写操作走 WebSocket），非 GET/HEAD 一律 405
    if (!isReadMethod(req.method)) {
      sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET, HEAD' });
      return;
    }

    if (pathname === '/api/auth-required') {
      sendJson(res, 200, { required: authRequired() });
      return;
    }

    if (pathname === '/api/health') {
      const url = queryOf(req);
      const deep = url.get('deep') === '1';
      const body: Record<string, unknown> = {
        ok: true,
        authRequired: authRequired(),
        uptimeSeconds: Math.round(process.uptime()),
      };
      if (deep) {
        const rt = deps.runtime();
        const stalled = rt.paused && metrics.tickErrors > 0;
        sendJson(res, stalled ? 503 : 200, {
          ...body,
          ok: !stalled,
          paused: rt.paused,
          tickErrors: metrics.tickErrors,
          lastTickMs: Number(metrics.lastTickMs.toFixed(1)),
          persistence: deps.store.enabled ? 'enabled' : 'disabled',
          simulationMinutes: Math.round(rt.net.timeMin),
        });
        return;
      }
      sendJson(res, 200, body);
      return;
    }

    if (pathname === '/api/metrics') {
      const url = queryOf(req);
      if (url.get('format') === 'json') {
        sendJson(res, 200, metricsJson());
        return;
      }
      sendText(res, 200, renderPrometheus(), 'text/plain; version=0.0.4; charset=utf-8');
      return;
    }

    if (pathname === '/api/standards') {
      sendJson(res, 200, {
        standards: DISCHARGE_STANDARDS.map((s) => ({
          id: s.id,
          label: s.label,
          source: s.source,
          limits: s.limits,
          note: s.note,
        })),
        default: DEFAULT_STANDARD.id,
      });
      return;
    }

    if (pathname === '/api/models') {
      const rt = deps.runtime();
      const list = listModelDescriptors().map((d) => ({
        id: d.id,
        name: d.name,
        components: d.components.length,
        processes: d.processes.length,
        /**
         * 当前主仿真是否直接用该模型。
         *
         * 默认的 `simple` 模式是 ASM1 的简化变体（同一份守恒校验），
         * 因此也只有 asm1 会标 true；显式切换到 asm1 时同样为 true。
         */
        active: d.id === 'asm1' && (rt.net.modelMode === 'asm1' || rt.net.modelMode === 'simple'),
        /** 是否已接入主求解器；ASM2d 可驱动主界面，但网络级稳态仍是实验特性 */
        inRuntime: d.id === 'asm1' || d.id === 'asm2d',
        /** 实验特性标记：ASM2d 网络级稳态/除磷尚未达验收门（见 docs/PLANT-BOUNDARY.md） */
        experimental: d.id === 'asm2d',
      }));
      sendJson(res, 200, { models: list, influentSources: ADAPTER_CAPABILITIES });
      return;
    }

    if (pathname === '/api/limits') {
      sendJson(res, 200, { limits: LIMITS, bounds: CONTROL_BOUNDS, plant: PLANT });
      return;
    }

    if (pathname === '/api/topology/history') {
      sendJson(res, 200, { versions: deps.topologyStore.history() });
      return;
    }

    if (pathname === '/api/topology') {
      const rt = deps.runtime();
      sendJson(res, 200, {
        topology: rt.topology,
        revision: rt.topologyRevision,
        readiness: checkRunReadiness(rt.topology),
        issues: validateTopology(rt.topology),
        solved: {
          reactors: rt.net.reactors.map((r) => ({ id: r.id, name: r.name, kind: r.kind, volume: r.volume })),
          bioVolume: rt.net.volume.bio,
          aerobicVolume: rt.net.volume.aerobic,
          anoxicVolume: rt.net.volume.anoxic,
          anaerobicVolume: rt.net.volume.anaerobic,
        },
      });
      return;
    }

    if (pathname === '/api/history/decisions') {
      sendJson(res, 200, { enabled: deps.store.enabled, decisions: deps.store.recentDecisions(100) });
      return;
    }

    if (pathname === '/api/history/reviews') {
      const url = queryOf(req);
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(url.get('limit') ?? 100) || 100)));
      const runId = url.get('runId') ?? undefined;
      sendJson(res, 200, { enabled: deps.store.enabled, reviews: deps.store.recentReviews(limit, runId) });
      return;
    }

    if (pathname === '/api/history/alarms') {
      const url = queryOf(req);
      const limit = Math.min(500, Math.max(1, Math.trunc(Number(url.get('limit') ?? 100) || 100)));
      const runId = url.get('runId') ?? undefined;
      sendJson(res, 200, { enabled: deps.store.enabled, alarms: deps.store.recentAlarms(limit, runId) });
      return;
    }

    if (pathname === '/api/history/snapshots') {
      const url = queryOf(req);
      const window = boundedWindow(url);
      if (!window.ok) {
        sendJson(res, 400, { error: window.error });
        return;
      }
      sendJson(res, 200, {
        enabled: deps.store.enabled,
        runId: deps.store.latestRunId(),
        runs: deps.store.listRuns(),
        snapshots: deps.store.snapshotsBetween(window.from, window.to, undefined, MAX_SNAPSHOT_POINTS),
        limit: MAX_SNAPSHOT_POINTS,
      });
      return;
    }

    if (pathname === '/api/history/stats') {
      sendJson(res, 200, { enabled: deps.store.enabled, counts: deps.store.count() });
      return;
    }

    if (pathname === '/api/presets') {
      sendJson(res, 200, {
        presets: PRESETS.map((p) => ({ id: p.id, name: p.name, description: p.description })),
        activeId: deps.runtime().activePresetId,
      });
      return;
    }

    if (pathname === '/api/export/snapshots.csv') {
      const url = queryOf(req);
      const window = boundedWindow(url);
      if (!window.ok) {
        sendJson(res, 400, { error: window.error });
        return;
      }
      const rows = deps.store.snapshotsBetween(window.from, window.to, undefined, MAX_SNAPSHOT_POINTS);
      sendDownload(res, 'aquapilot-snapshots.csv', snapshotsCsv(rows), 'text/csv; charset=utf-8');
      return;
    }

    if (pathname === '/api/export/decisions.csv') {
      sendDownload(
        res,
        'aquapilot-decisions.csv',
        decisionsCsv(deps.store.recentDecisions(1000)),
        'text/csv; charset=utf-8',
      );
      return;
    }

    if (pathname === '/api/export/reviews.csv') {
      sendDownload(res, 'aquapilot-reviews.csv', reviewsCsv(deps.store.recentReviews(1000)), 'text/csv; charset=utf-8');
      return;
    }

    if (pathname === '/api/export/report.md') {
      sendDownload(res, 'aquapilot-report.md', buildOperationsReport(deps.snapshot()), 'text/markdown; charset=utf-8');
      return;
    }

    // —— 工业级扩展域：各自独立模块，未接线时返回空表/空通道，不阻断主 API ——
    if (pathname === '/api/hydraulics' || pathname === '/api/hydraulics/tracer') {
      const reply = hydraulicsRoute(pathname, requestUrl(req), { state: deps.runtime().net });
      if (reply) {
        replyTo(res, reply);
        return;
      }
    }

    if (pathname === '/api/compliance/report' || pathname === '/api/compliance/samples') {
      const reply = complianceRoute(pathname, requestUrl(req), {
        readings: deps.complianceReadings?.() ?? [],
        limits: DEFAULT_STANDARD.limits,
        standardId: DEFAULT_STANDARD.id,
      });
      if (reply) {
        replyTo(res, reply);
        return;
      }
    }

    if (pathname === '/api/plant/balance') {
      const reply = plantBoundaryRoute(pathname, requestUrl(req), { state: deps.runtime().net });
      if (reply) {
        replyTo(res, reply);
        return;
      }
    }

    if (pathname === '/api/instruments' || pathname === '/api/control/interlocks') {
      const reply = instrumentsRoute(pathname, requestUrl(req), { state: deps.runtime().net });
      if (reply) {
        replyTo(res, reply);
        return;
      }
    }

    if (pathname === '/api/assets' || pathname.startsWith('/api/assets/')) {
      // 资产状态现在住在引擎状态里（WP4 接线后每步 tick），可选依赖只作为单测替身
      const reply = assetsRoute(pathname, requestUrl(req), {
        state: deps.assetState?.() ?? deps.runtime().net.assets ?? null,
      });
      if (reply) {
        replyTo(res, reply);
        return;
      }
    }

    if (pathname.startsWith('/api/protocols/')) {
      const reply = protocolsRoute(pathname, requestUrl(req), {
        adapters: deps.protocolAdapters?.() ?? {},
        audit: deps.protocolAudit?.() ?? createProtocolAudit(),
      });
      if (reply) {
        replyTo(res, reply);
        return;
      }
    }

    if (pathname.startsWith('/api/calibration/')) {
      // WS 标定仍是唯一入口；HTTP 只镜像“当前是否具备区间分析条件”。
      // 合成数据只有出水、没有剖面观测，因此无可用区间时返回 409 而不是假区间。
      const reply = calibrationRoute(pathname, requestUrl(req), {
        uncertainty: null,
        predictions: null,
        dataSource: 'synthetic',
      });
      if (reply) {
        replyTo(res, reply);
        return;
      }
    }

    if (pathname === '/api/snapshot') {
      sendJson(res, 200, deps.snapshot());
      return;
    }

    // 未匹配的 /api/* 必须 404，不能掉进静态分支返回 index.html
    sendJson(res, 404, { error: 'not found' });
  };
}
