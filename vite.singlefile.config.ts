import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run pack` → dist-single/index.html
// JS/CSS 全部内联成**单个 HTML**：双击即玩，也能直接发给别人（不需要"部署"）。
// 这是"打包 ≠ 必须部署"的落地方式，见架构文档 §5.2。
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist-single',
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false,
  },
});
