/**
 * AquaPilot 版本化 API 契约（OpenAPI 3.1 / JSON Schema 2020-12）。
 *
 * 这份文档是“新控制面”的公开契约：实验创建、查询、取消、结果导出。
 * 旧 GET 端点保持原样，避免破坏现有前端；新端点从 `/api/v1` 开始，
 * 享受 RFC 9457 错误、幂等键与 OpenAPI 校验。
 */

import { EXPERIMENT_LIMITS } from '../sim/experiment';
import { SCENARIO_ORDER } from '../sim/scenarios';
import { DISCHARGE_STANDARDS } from '../sim/standards';
import { CONTROL_BOUNDS, CONTROL_KEYS } from '../sim/config';

const standardIds = DISCHARGE_STANDARDS.map((s) => s.id);
const controlProperties = Object.fromEntries(
  CONTROL_KEYS.map((key) => [
    key,
    {
      type: 'number',
      minimum: CONTROL_BOUNDS[key].min,
      maximum: CONTROL_BOUNDS[key].max,
      description: `${CONTROL_BOUNDS[key].label}（${CONTROL_BOUNDS[key].unit || '无量纲'}）`,
    },
  ]),
);

const ExperimentSpec = {
  type: 'object',
  additionalProperties: false,
  required: ['durationMin'],
  properties: {
    name: { type: 'string', maxLength: 80 },
    model: { type: 'string', enum: ['simple', 'asm1', 'asm2d'], default: 'asm1' },
    seed: { type: 'integer', minimum: 0, maximum: 2_147_483_647, default: 20_261_019 },
    warmupDays: { type: 'integer', minimum: 0, maximum: EXPERIMENT_LIMITS.maxWarmupDays, default: 5 },
    durationMin: {
      type: 'integer',
      minimum: 60,
      maximum: EXPERIMENT_LIMITS.maxDurationMin,
      description: '仿真时长（分钟）；30 天 = 43200',
    },
    sampleEveryMin: {
      type: 'integer',
      minimum: EXPERIMENT_LIMITS.minSampleEveryMin,
      maximum: EXPERIMENT_LIMITS.maxSampleEveryMin,
      default: 30,
    },
    scenario: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: {
            type: { type: 'string', enum: SCENARIO_ORDER },
            durationMin: { type: 'integer', minimum: 5, maximum: 4_320 },
            magnitude: { type: 'number', minimum: 0, maximum: 3 },
          },
        },
      ],
    },
    controls: {
      type: 'object',
      additionalProperties: false,
      properties: controlProperties,
    },
    plantEnabled: { type: 'boolean', default: false },
    bioPRemoval: { type: 'boolean', default: true },
    standardId: { type: 'string', enum: standardIds, default: 'gb18918-1a' },
    policy: { type: 'string', enum: ['fixed', 'ai'], default: 'fixed' },
    decisionIntervalMin: { type: 'integer', minimum: 15, maximum: 1_440, default: 240 },
    validation: { type: 'string', enum: ['basic', 'full'], default: 'basic' },
  },
} as const;

const MetricStats = {
  type: 'object',
  required: ['min', 'mean', 'p50', 'p95', 'max'],
  properties: {
    min: { type: 'number' },
    mean: { type: 'number' },
    p50: { type: 'number' },
    p95: { type: 'number' },
    max: { type: 'number' },
  },
} as const;

const ComplianceRow = {
  type: 'object',
  required: ['key', 'label', 'limit', 'max', 'p95', 'exceedSamples', 'compliant'],
  properties: {
    key: { type: 'string' },
    label: { type: 'string' },
    limit: { type: 'number' },
    max: { type: 'number' },
    p95: { type: 'number' },
    exceedSamples: { type: 'integer' },
    compliant: { type: 'boolean' },
  },
} as const;

const ExperimentSummary = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    model: { type: 'string' },
    seed: { type: 'integer' },
    durationMin: { type: 'integer' },
    sampleCount: { type: 'integer' },
    policy: { type: 'string' },
    decisions: { type: 'integer' },
    standardId: { type: 'string' },
    standardLabel: { type: 'string' },
    compliant: { type: 'boolean' },
    effluent: {
      type: 'object',
      additionalProperties: MetricStats,
    },
    compliance: { type: 'array', items: { $ref: '#/components/schemas/ComplianceRow' } },
    energyKwh: { type: 'number' },
    chemicalCost: { type: 'number' },
    totalCost: { type: 'number' },
    inflowM3: { type: 'number' },
    specificEnergyKwhM3: { type: 'number' },
    meanMlss: { type: 'number' },
    finalSrtDays: { type: 'number' },
    finalDo: { type: 'number' },
    alarms: { type: 'object' },
  },
} as const;

const Validation = {
  type: 'object',
  required: ['level', 'scope', 'certified', 'operatingCompliant', 'checks'],
  properties: {
    level: { type: 'string', enum: ['basic', 'full'] },
    scope: { type: 'string', enum: ['waterline', 'plant'] },
    certified: { type: 'boolean', description: '模型/数值认证，不包含本次运行是否达标' },
    operatingCompliant: { type: 'boolean', description: '本次运行六项出水指标是否全部达标' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'label', 'status', 'detail'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          status: { type: 'string', enum: ['pass', 'warn', 'fail', 'skip'] },
          detail: { type: 'string' },
        },
      },
    },
  },
} as const;

const ExperimentDetail = {
  type: 'object',
  required: ['id', 'status', 'name', 'createdAt', 'progress', 'spec'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['queued', 'running', 'succeeded', 'failed', 'cancelled'] },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    startedAt: { oneOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
    finishedAt: { oneOf: [{ type: 'null' }, { type: 'string', format: 'date-time' }] },
    progress: { type: 'integer', minimum: 0, maximum: 100 },
    simMinute: { type: 'number' },
    queuePosition: { oneOf: [{ type: 'null' }, { type: 'integer', minimum: 0 }] },
    topologyHash: { type: 'string' },
    spec: { $ref: '#/components/schemas/ExperimentSpec' },
    summary: { oneOf: [{ type: 'null' }, { $ref: '#/components/schemas/ExperimentSummary' }] },
    validation: { oneOf: [{ type: 'null' }, { $ref: '#/components/schemas/ExperimentValidation' }] },
    provenance: { oneOf: [{ type: 'null' }, { type: 'object' }] },
    error: { oneOf: [{ type: 'null' }, { type: 'string' }] },
    links: {
      type: 'object',
      properties: {
        self: { type: 'string' },
        samples: { type: 'string' },
        report: { type: 'string' },
        cancel: { type: 'string' },
      },
    },
  },
} as const;

const StudyControls = {
  type: 'object',
  additionalProperties: false,
  properties: controlProperties,
} as const;

const StudyScenario = {
  type: 'object',
  additionalProperties: false,
  required: ['type'],
  properties: {
    type: { type: 'string', enum: SCENARIO_ORDER },
    durationMin: { type: 'integer', minimum: 5, maximum: 4_320 },
    magnitude: { type: 'number', minimum: 0, maximum: 3 },
  },
} as const;

const StudyVariant = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', maxLength: 40 },
    seedOffset: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
    controls: { $ref: '#/components/schemas/StudyControls' },
    scenario: { oneOf: [{ type: 'null' }, { $ref: '#/components/schemas/StudyScenario' }] },
    model: { type: 'string', enum: ['simple', 'asm1', 'asm2d'] },
    plantEnabled: { type: 'boolean' },
    bioPRemoval: { type: 'boolean' },
  },
} as const;

const StudyObjective = {
  type: 'object',
  additionalProperties: false,
  required: ['metric', 'direction'],
  properties: {
    metric: {
      type: 'string',
      enum: [
        'totalCost',
        'energyKwh',
        'specificEnergyKwhM3',
        'meanMlss',
        'finalSrtDays',
        'finalDo',
        'effluent.cod',
        'effluent.bod',
        'effluent.ss',
        'effluent.nh',
        'effluent.tn',
        'effluent.tp',
      ],
    },
    direction: { type: 'string', enum: ['min', 'max'] },
  },
} as const;

const StudySpec = {
  type: 'object',
  additionalProperties: false,
  required: ['base', 'variants', 'objectives'],
  properties: {
    name: { type: 'string', maxLength: 80 },
    base: { $ref: '#/components/schemas/ExperimentSpec' },
    variants: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: { $ref: '#/components/schemas/StudyVariant' },
    },
    replicates: { type: 'integer', minimum: 1, maximum: 2, default: 1 },
    objectives: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: { $ref: '#/components/schemas/StudyObjective' },
    },
  },
} as const;

const StudyVariantResult = {
  type: 'object',
  properties: {
    index: { type: 'integer' },
    name: { type: 'string' },
    experiments: { type: 'integer' },
    completed: { type: 'integer' },
    succeeded: { type: 'integer' },
    failed: { type: 'integer' },
    cancelled: { type: 'integer' },
    complianceRate: { type: 'number' },
    certifiedRate: { type: 'number' },
    operatingComplianceRate: { type: 'number' },
    metrics: { type: 'object', additionalProperties: { type: 'object' } },
    objectiveValues: { type: 'object', additionalProperties: { type: 'number' } },
    rank: { oneOf: [{ type: 'null' }, { type: 'integer' }] },
  },
} as const;

const StudyAggregate = {
  type: 'object',
  required: ['status', 'progressPercent', 'total', 'variants', 'ranking', 'pareto'],
  properties: {
    status: {
      type: 'string',
      enum: ['queued', 'running', 'succeeded', 'partial', 'failed', 'cancelled'],
    },
    progressPercent: { type: 'integer' },
    total: { type: 'integer' },
    completed: { type: 'integer' },
    succeeded: { type: 'integer' },
    failed: { type: 'integer' },
    cancelled: { type: 'integer' },
    variants: { type: 'array', items: { $ref: '#/components/schemas/StudyVariantResult' } },
    ranking: { type: 'array', items: { type: 'object' } },
    pareto: { type: 'array', items: { type: 'object' } },
    best: { oneOf: [{ type: 'null' }, { type: 'object' }] },
    validation: { type: 'object' },
    objectives: { type: 'array', items: { $ref: '#/components/schemas/StudyObjective' } },
  },
} as const;

const StudyDetail = {
  type: 'object',
  required: ['id', 'name', 'createdAt', 'spec', 'aggregate', 'children'],
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    error: { oneOf: [{ type: 'null' }, { type: 'string' }] },
    spec: { $ref: '#/components/schemas/StudySpec' },
    aggregate: { $ref: '#/components/schemas/StudyAggregate' },
    children: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          experimentId: { oneOf: [{ type: 'null' }, { type: 'string' }] },
          name: { type: 'string' },
          variantIndex: { type: 'integer' },
          replicate: { type: 'integer' },
          links: { oneOf: [{ type: 'null' }, { type: 'object' }] },
        },
      },
    },
    links: { type: 'object' },
  },
} as const;

const Problem = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail'],
  properties: {
    type: { type: 'string', format: 'uri' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, message: { type: 'string' } },
      },
    },
  },
} as const;

function problem(description: string): { description: string; content: Record<string, unknown> } {
  return {
    description,
    content: {
      'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
    },
  };
}

export function openApiDocument(appVersion: string): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'AquaPilot Simulation Experiment API',
      version: appVersion,
      summary: '仿真建模、离线实验与多维验证的控制面 API',
      description:
        'AquaPilot 把一次仿真实验表达为可复现资源：拓扑快照、种子、边界条件与校验结果共同构成 provenance。所有长任务异步执行，客户端用 Location/轮询读取状态。',
      license: { name: 'MIT' },
    },
    servers: [{ url: '/', description: '同源部署' }],
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/v1/experiments': {
        get: {
          operationId: 'listExperiments',
          summary: '列出实验',
          parameters: [
            {
              name: 'status',
              in: 'query',
              schema: {
                type: 'string',
                enum: ['all', 'queued', 'running', 'succeeded', 'failed', 'cancelled'],
                default: 'all',
              },
            },
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            '200': {
              description: '实验列表',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      items: { type: 'array', items: { type: 'object' } },
                      nextCursor: { oneOf: [{ type: 'null' }, { type: 'string' }] },
                    },
                  },
                },
              },
            },
            '400': problem('查询参数不合法'),
            '401': problem('缺少或无效令牌'),
            '403': problem('令牌权限不足'),
          },
        },
        post: {
          operationId: 'createExperiment',
          summary: '创建离线仿真实验',
          description:
            '创建后立即返回 202 与 Location。若带 Idempotency-Key，则同一请求返回既有资源（200）而不重复执行。',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              schema: { type: 'string', maxLength: 128 },
              description: '客户端生成的唯一键；同键不同 body 返回 409。',
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ExperimentSpec' } },
            },
          },
          responses: {
            '202': {
              description: '已入队',
              headers: {
                Location: { schema: { type: 'string' }, description: '实验资源地址' },
              },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ExperimentDetail' } } },
            },
            '200': { description: '幂等重放，返回既有实验' },
            '400': problem('JSON 结构或字段类型不合法'),
            '409': problem('Idempotency-Key 已用于不同请求'),
            '413': problem('请求体超过 64 KiB'),
            '415': problem('Content-Type 不是 application/json'),
            '422': problem('业务边界校验失败（控制量/场景/采样上限）'),
            '429': {
              description: '实验队列已满',
              headers: { 'Retry-After': { schema: { type: 'integer' } } },
              content: {
                'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } },
              },
            },
          },
        },
      },
      '/api/v1/experiments/{id}': {
        get: {
          operationId: 'getExperiment',
          summary: '读取实验详情',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: '实验详情',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ExperimentDetail' } } },
            },
            '404': problem('实验不存在'),
          },
        },
      },
      '/api/v1/experiments/{id}/cancel': {
        post: {
          operationId: 'cancelExperiment',
          summary: '取消排队中或运行中的实验',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '202': {
              description: '取消请求已接受',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/ExperimentDetail' } } },
            },
            '404': problem('实验不存在'),
            '409': problem('实验已结束，不能取消'),
          },
        },
      },
      '/api/v1/experiments/{id}/samples.csv': {
        get: {
          operationId: 'downloadExperimentSamples',
          summary: '下载逐点样本 CSV',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'CSV 文件', content: { 'text/csv': { schema: { type: 'string' } } } },
            '404': problem('实验不存在'),
            '409': problem('实验尚未成功完成'),
          },
        },
      },
      '/api/v1/experiments/{id}/report.md': {
        get: {
          operationId: 'downloadExperimentReport',
          summary: '下载可复现实验报告（Markdown）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Markdown 报告', content: { 'text/markdown': { schema: { type: 'string' } } } },
            '404': problem('实验不存在'),
            '409': problem('实验尚未成功完成'),
          },
        },
      },
      '/api/v1/studies': {
        get: {
          operationId: 'listStudies',
          summary: '列出仿真研究',
          parameters: [
            { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          ],
          responses: {
            '200': {
              description: '研究列表',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { items: { type: 'array', items: { $ref: '#/components/schemas/StudyDetail' } } },
                  },
                },
              },
            },
            '401': problem('缺少或无效令牌'),
            '403': problem('令牌权限不足'),
          },
        },
        post: {
          operationId: 'createStudy',
          summary: '创建仿真研究（批量变体 + 重复 + 目标）',
          description:
            '一个 Study 会展开为 N 个可复现子实验，共享拓扑快照与边界，只改变控制/场景/模型/边界开关。子实验进入同一持久队列；若队列空闲槽位不足，整批返回 429。',
          parameters: [
            {
              name: 'Idempotency-Key',
              in: 'header',
              required: false,
              schema: { type: 'string', maxLength: 128 },
              description: '客户端生成的唯一键；同键不同 body 返回 409。',
            },
          ],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/StudySpec' } } },
          },
          responses: {
            '202': {
              description: '整批已入队',
              headers: { Location: { schema: { type: 'string' } }, 'Retry-After': { schema: { type: 'integer' } } },
              content: { 'application/json': { schema: { $ref: '#/components/schemas/StudyDetail' } } },
            },
            '200': { description: '幂等重放，返回既有研究' },
            '400': problem('JSON 结构或字段类型不合法'),
            '409': problem('Idempotency-Key 已用于不同研究'),
            '422': problem('研究参数不合法（变体/重复/目标/控制边界）'),
            '429': problem('实验队列空闲槽位不足'),
          },
        },
      },
      '/api/v1/studies/{id}': {
        get: {
          operationId: 'getStudy',
          summary: '读取研究详情与聚合结果',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: '研究详情',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/StudyDetail' } } },
            },
            '404': problem('研究不存在'),
          },
        },
      },
      '/api/v1/studies/{id}/cancel': {
        post: {
          operationId: 'cancelStudy',
          summary: '取消整批研究',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '202': {
              description: '取消请求已接受',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/StudyDetail' } } },
            },
            '404': problem('研究不存在'),
          },
        },
      },
      '/api/v1/studies/{id}/report.md': {
        get: {
          operationId: 'downloadStudyReport',
          summary: '下载研究级 Markdown 报告（含排序/Pareto/认证率/复现 ID）',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': { description: 'Markdown 报告', content: { 'text/markdown': { schema: { type: 'string' } } } },
            '404': problem('研究不存在'),
          },
        },
      },
      '/api/openapi.json': {
        get: {
          operationId: 'getOpenApi',
          summary: '读取本契约',
          security: [],
          responses: { '200': { description: 'OpenAPI 3.1 文档' } },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'AQUAPILOT_TOKEN / OPERATOR / VIEWER' },
      },
      schemas: {
        ExperimentSpec,
        ExperimentSummary,
        ComplianceRow,
        ExperimentValidation: Validation,
        ExperimentDetail,
        StudyControls,
        StudyScenario,
        StudyVariant,
        StudyObjective,
        StudySpec,
        StudyVariantResult,
        StudyAggregate,
        StudyDetail,
        Problem,
      },
    },
  };
}
