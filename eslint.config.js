import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['dist/**', 'out/**', 'coverage/**', 'node_modules/**', 'scripts/**', '.tmpcheck/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      /**
       * 只启用经典的两条 hooks 规则。
       *
       * eslint-plugin-react-hooks 7.x 的 recommended 还包含 React Compiler
       * 诊断（set-state-in-effect、memoization、render 后赋值）。本项目没有
       * 启用 React Compiler，这些规则会把合法的异步取数/局部渲染写法判成
       * 错误，迫使代码为编译器改写而不是为运行时改写——噪音大于收益。
       */
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['tests/**/*.ts', 'src/client/**/*.tsx'],
    rules: { 'no-console': 'off' },
  },
  {
    // 日志实现本身就是 console 的唯一出口；启动横幅也要写 stdout
    files: ['src/server/index.ts', 'src/server/observability.ts', 'src/cli.ts'],
    rules: { 'no-console': ['warn', { allow: ['warn', 'error', 'log'] }] },
  },
);
