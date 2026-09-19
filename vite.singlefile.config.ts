import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run pack` → dist-single/index.html
// JS/CSS 全部内联成**单个 HTML**：双击即玩，也能直接发给别人（不需要"部署"）。
// 这是"打包 ≠ 必须部署"的落地方式，见架构文档 §5.2。
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  /**
   * 编译期常量：**构建时间**。
   *
   * 为什么需要它：`dist-single/index.html` 是**产物** —— 改了源码不 `npm run pack` 就不会生效，
   * 而这一点已经白绕过两次（一次输入手感、一次敌人速度）：用户在浏览器里看的其实是旧版，
   * 却以为"改动没生效"。把它印在 HUD 上，一眼就能回答"我现在跑的是哪个构建"。
   *
   * 只放时间、不放 git 哈希：让打包**不依赖 git**（导出目录、CI 里也能构建）。
   * 类型声明见 `src/build-stamp.d.ts`。
   */
  define: {
    __BUILD_STAMP__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  build: {
    outDir: 'dist-single',
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
  },
});
