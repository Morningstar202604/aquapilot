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
       * 阈值取当前实测值略下方，防止回退；目标红线（85% 分支）尚未达到，
       * 差额来自几处防御性错误路径（SQLite rollback、磁盘故障），
       * 这些需要注入 I/O 故障才能覆盖，已在 docs/AUDIT-REPORT.md 记录。
       */
      thresholds: {
        lines: 93,
        branches: 83,
        functions: 90,
      },
    },
  },
});
