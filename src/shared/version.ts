/**
 * 应用版本的唯一源码。
 *
 * 为什么不是每次读 package.json：
 * - 服务端与 CLI 都走 esbuild 打包，读文件在 SEA 单文件 exe 里没有可靠的
 *   工作目录（exe 从任意路径启动），`process.env.npm_package_version`
 *   只有 `npm run` 才有值。
 * - 直接 `import pkg from '../../package.json'` 会把整份清单（含 devDependencies）
 *   打进客户端产物。
 *
 * 所以保留一个字面量常量，并由 `scripts/check-version.mjs` 在 CI 里断言它与
 * package.json 一致——单一事实源靠门禁保证，而不是靠运行时读文件。
 */
export const APP_VERSION = '0.9.0';
