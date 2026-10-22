import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/sim/**', 'src/ai/**', 'src/model/**', 'src/server/**'],
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
       *
       * 目标红线（分支 85%）尚未达到：缺口来自库层的防御性错误路径
       * （SQLite rollback、磁盘写入失败），需要注入 I/O 故障才能覆盖。
       * 已在 docs/AUDIT-REPORT.md 中如实记录，不通过调低标准来掩盖。
       */
      thresholds: {
        lines: 91,
        branches: 80,
        functions: 89,
      },
    },
  },
});
