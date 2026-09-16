import { defineConfig } from 'vitest/config';

// core 必须能在**纯 Node** 里跑（零 DOM / 零 three）——这是回归测试成立的前提，
// 见架构文档 §三 红线。所以 environment 固定为 node，不用 jsdom。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
