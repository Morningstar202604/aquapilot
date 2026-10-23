import { defineConfig } from 'vitest/config';

/**
 * Stryker 专用测试配置：排除整厂稳态基准（30–60 s/次）。
 * 变异评估只跑快速单测；基准对照本身有自己的 ±10% 红线锁。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/bsm1-benchmark.test.ts', 'node_modules/**'],
    environment: 'node',
    testTimeout: 20000,
  },
});
