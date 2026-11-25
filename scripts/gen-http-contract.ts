/**
 * M2-1 HTTP/WS 契约冻结器。
 *
 * 这个脚本不生成“替代服务”，只做一件事：把 TypeScript 生产服务当前对外
 * 暴露的路由、方法策略、公开端点、WS 消息标签与源文件哈希冻结成 JSON。
 * Rust 服务端实现必须逐条通过这份 golden；源文件改动而 golden 未重生成时，
 * `npm run gen:http-contract -- --check` 会直接失败。
 *
 * 为什么用源码扫描而不是启动服务枚举：
 * - 生产服务的路由是 `pathname === ...` / `startsWith` 的一串分支，没有可反射的路由表；
 * - 版本化 API 的真实路径在 OpenAPI 与路由模块里，启动服务还需要鉴权/仿真状态；
 * - M2-1 要的是契约文本，不是一次运行时快照。扫描失败会直接报错，避免静默漏路由。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = 'rust/golden/http-contract.json';

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    fail(`无法读取 ${path}`);
  }
}

function uniqueSorted(values: string[], label: string): string[] {
  const unique = [...new Set(values)].sort();
  if (unique.length === 0) fail(`${label} 为空`);
  return unique;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function stringsIn(text: string, pattern: RegExp, label: string): string[] {
  const matches = [...text.matchAll(pattern)].map((match) => match[1]);
  if (matches.length === 0) fail(`${label} 未匹配到任何路径`);
  return uniqueSorted(matches, label);
}

const apiRoutes = read('src/server/apiRoutes.ts');
const httpRoutes = read('src/server/httpRoutes.ts');
const openapi = read('src/server/openapi.ts');
const serverIndex = read('src/server/index.ts');
const protocol = read('src/shared/protocol.ts');
const assetsRoute = read('src/server/routes/assets.ts');
const protocolsRoute = read('src/server/routes/protocols.ts');
const calibrationRoute = read('src/server/routes/calibration.ts');

const legacy = stringsIn(apiRoutes, /pathname === '(\/api\/[^']+)'/g, 'legacy routes');
const legacyPrefixes = uniqueSorted(
  [...apiRoutes.matchAll(/pathname\.startsWith\('(\/api\/[^']+\/)'\)/g)].map((match) => match[1].replace(/\/$/, '')),
  'legacy prefixes',
);
const modulePaths = stringsIn(
  [protocolsRoute, calibrationRoute].join('\n'),
  /'(\/api\/[^']+)'/g,
  'legacy module routes',
);
const assetDetail = assetsRoute.includes('segments.length === 1') ? ['/api/assets/{id}'] : [];
const legacyRoutes = uniqueSorted([...legacy, ...modulePaths, ...assetDetail], 'legacy route set');

const publicPaths = stringsIn(
  httpRoutes.match(/const PUBLIC_API_PATHS[\s\S]*?= new Set\(\[([\s\S]*?)\]\);/)?.[1] ?? '',
  /'(\/api\/[^']+)'/g,
  'public routes',
);
if (publicPaths.length !== 3) fail(`公开端点应为 3 条，实际 ${publicPaths.length}`);

const versionedRoutes = stringsIn(openapi, /'(\/api\/v1\/[^']+)':/g, 'versioned routes');

const clientTypes = uniqueSorted(
  [
    ...protocol
      .slice(protocol.indexOf('export type ClientMessage ='), protocol.indexOf('export type ServerMessage ='))
      .matchAll(/type: '([^']+)'/g),
  ].map((match) => match[1]),
  'client message types',
);
const serverStart = protocol.indexOf('export type ServerMessage =');
const serverTail = protocol.slice(serverStart + 1);
const serverEnd = serverTail.search(/\nexport /);
const serverBlock = serverEnd >= 0 ? serverTail.slice(0, serverEnd) : serverTail;
const serverTypes = uniqueSorted(
  [...serverBlock.matchAll(/type: '([^']+)'/g)].map((match) => match[1]),
  'server message types',
);

const maxPayload = /maxPayload:\s*(\d+)\s*\*\s*(\d+)/.exec(serverIndex)?.slice(1).map(Number) ?? [];
if (maxPayload.length !== 2) fail('server/index.ts 缺少 maxPayload 常量');
const maxPayloadBytes = maxPayload[0] * maxPayload[1];

// 这些数字是 M2-1 的最小覆盖面；路由增减必须显式更新契约，而不是让 golden 悄悄漂移。
if (legacyRoutes.length !== 32) fail(`legacy 路由应为 32 条，实际 ${legacyRoutes.length}`);
if (legacyPrefixes.length !== 3) fail(`legacy 前缀应为 3 条，实际 ${legacyPrefixes.length}`);
if (versionedRoutes.length !== 9) fail(`版本化路由应为 9 条，实际 ${versionedRoutes.length}`);
if (clientTypes.length !== 19) fail(`WS 客户端消息应为 19 类，实际 ${clientTypes.length}`);
if (serverTypes.length !== 14) fail(`WS 服务端消息应为 14 类，实际 ${serverTypes.length}`);
if (maxPayloadBytes !== 1024 * 512) fail(`WS maxPayload 应为 524288，实际 ${maxPayloadBytes}`);

const metaRoutes = ['/api/openapi.json'];
for (const route of publicPaths) {
  if (!legacyRoutes.includes(route) && !metaRoutes.includes(route)) {
    fail(`公开端点 ${route} 不在路由表里`);
  }
}
for (const route of legacyRoutes) {
  if (!route.startsWith('/api/')) fail(`legacy 路由 ${route} 不以 /api/ 开头`);
}
for (const route of legacyRoutes) {
  if (route === '/api/health' && !publicPaths.includes(route)) fail('health 必须公开');
}
for (const prefix of legacyPrefixes) {
  if (!legacyRoutes.some((route) => route === prefix || route.startsWith(`${prefix}/`))) {
    fail(`前缀 ${prefix} 没有对应路由`);
  }
}

const contract = {
  schemaVersion: 1,
  generatedBy: 'scripts/gen-http-contract.ts',
  oracle: 'src/server（TypeScript 生产服务）',
  note: 'M2-1 的接口契约快照；Rust 服务端逐条实现前不得把本文件当成已完成迁移。',
  sources: Object.fromEntries(
    [
      'src/server/apiRoutes.ts',
      'src/server/httpRoutes.ts',
      'src/server/openapi.ts',
      'src/server/index.ts',
      'src/shared/protocol.ts',
      'src/server/routes/assets.ts',
      'src/server/routes/protocols.ts',
      'src/server/routes/calibration.ts',
    ].map((path) => [path, sha256(read(path))]),
  ),
  http: {
    methods: ['GET', 'HEAD'],
    public: publicPaths,
    legacy: legacyRoutes,
    legacyPrefixes,
    meta: metaRoutes,
    versioned: versionedRoutes,
    mcp: ['/mcp'],
    unauthorizedStatus: 401,
    methodNotAllowedStatus: 405,
    unknownApiStatus: 404,
  },
  ws: {
    path: '/ws',
    maxPayloadBytes,
    clientTypes,
    serverTypes,
  },
} as const;

const text = `${JSON.stringify(contract, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const current = read(OUT);
  if (current !== text) {
    fail(`${OUT} 与当前源码不一致；运行 npm run gen:http-contract 更新并审阅 diff`);
  }
  console.log(
    `HTTP/WS 契约未漂移：${legacyRoutes.length} legacy / ${versionedRoutes.length} versioned / ${clientTypes.length}→${serverTypes.length} WS`,
  );
} else {
  writeFileSync(OUT, text);
  console.log(`已写入 ${OUT}`);
  console.log(
    `legacy=${legacyRoutes.length} versioned=${versionedRoutes.length} public=${publicPaths.length} client=${clientTypes.length} server=${serverTypes.length}`,
  );
}
