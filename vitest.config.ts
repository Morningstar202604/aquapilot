import { defineConfig } from 'vitest/config';

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
      exclude: ['src/server/index.ts', 'src/sim/plantTypes.ts'],
      /**
       * 阈值必须在所有受支持的 Node 版本上都能通过。
       *
       * 实测差异（同一份代码、同一批测试）：
       *   Node 22: lines 93.44 / branches 83.46 / functions 91.72
       *   Node 20: lines 92.09 / branches 81.56 / functions 90.5
       * V8 在不同版本间的覆盖率统计口径略有差别（分支计数方式）。
       * 因此取 Node 20 的实测值再留 1 个点余量作为门槛，
       * 既能在两个版本上通过，又能挡住真实回退。
       */
      thresholds: {
        lines: 93,
        branches: 83,
        functions: 93,
      },
    },
  },
});
