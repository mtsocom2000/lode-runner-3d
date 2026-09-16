import { defineConfig } from 'vite';

// 开发服务器 / 常规构建。
// base:'./' → 产物用相对路径，可以直接丢进任意静态目录托管（见架构文档 §5.2）。
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: true,
  },
});
