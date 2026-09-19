/**
 * `vite.singlefile.config.ts` 里 `define` 注入的**构建时间戳**（形如 `2026-09-19 03:41`）。
 *
 * `define` 是**文本替换**：打包时 `__BUILD_STAMP__` 这个标识符会被换成一个字符串字面量。
 * 这里只给 TypeScript 一个声明，好让 `main.ts` 能直接引用它。
 *
 * 用途见 `main.ts` 的 HUD 那一行：**一眼看出浏览器里跑的是哪个构建** ——
 * 产物不会自己跟着源码变，忘了 `npm run pack` 时，靠它当场发现。
 */
declare const __BUILD_STAMP__: string;
