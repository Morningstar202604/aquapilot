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
      ...reactHooks.configs.recommended.rules,
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
    files: ['src/server/index.ts', 'src/server/observability.ts'],
    rules: { 'no-console': ['warn', { allow: ['warn', 'error', 'log'] }] },
  },
);
