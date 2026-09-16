import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'dist-single/**', 'node_modules/**', 'legacy/**', 'mocks/**', 'tools/out/**'] },
  ...tseslint.configs.recommended,
  {
    // 架构红线（架构文档 §三）：core 层零 three、零 DOM。
    // 用 lint 强制而不是靠自觉——这条线一破，无头回归测试就没了。
    rules: {
      'no-restricted-imports': ['error', { patterns: ['three', 'three/*'] }],
      // TS 的 noUnusedParameters 尊重 `_` 前缀，eslint 默认不认 —— 对齐两者的口径，
      // 这样"有意不用的参数"可以显式表达，而不是被迫删参数或加 eslint-disable。
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/render/**/*.ts', 'src/app/**/*.ts', 'src/input/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
