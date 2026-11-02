import { defineConfig } from 'vitest/config';

/**
 * 覆盖率门禁。
 *
 * 阈值只对「受支持的 Node 版本」有意义：Vitest 5 自身要求
 * `^22.12.0 || ^24.0.0 || >=26.0.0`，所以 CI 矩阵是 22 + 24。
 * 两代 V8 的分支计数口径有细微差别（同一份代码同一批测试，
 * Node 22 的分支率通常比 Node 24 低约 1 个点），阈值按**较低的那个**
 * 定，再留 1 个点余量——这样两条流水线都过，但任何真实回退仍会红。
 *
 * 2026-11-02 实测（91 文件 / 1133 测试，Node 24.20.0）：
 *   statements 92.23 / branches 81.66 / functions 95.95 / lines 93.97
 *
 * 历史值只作参考，不要拿旧版本的数字去"调阈值"：
 * 阈值是回归报警器，不是用来追着实现跑的。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // 大多数是纯计算/服务端测试；需要 DOM 的用例用文件头 `// @vitest-environment jsdom`
    environment: 'node',
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/sim/**', 'src/ai/**', 'src/model/**', 'src/server/**', 'src/client/components/labels.ts'],
      exclude: ['src/server/index.ts', 'src/sim/plantTypes.ts', 'src/sim/data/**'],
      thresholds: {
        lines: 90,
        branches: 81,
        functions: 95,
      },
    },
  },
});
