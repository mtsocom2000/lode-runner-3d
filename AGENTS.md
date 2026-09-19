# 本仓库的约定（给 AI 助手 / 也被 README 引用）

## 改完源码**必须**打包，否则用户看不到

`dist-single/index.html` 是 `npm run pack` 的**产物** —— 用户双击的就是它。
只跑 `typecheck` / `test` **不会**更新它。这件事已经白绕过两次（一次输入手感、一次敌人速度）：
用户在浏览器里看的是旧版，却以为"改动没生效"。

- 交付前跑 `npm run pack`；或跑 `npm run probe` / `npm run shot`（这两个**会先 pack**）。
- 想一眼确认跑的是哪个构建：HUD 最后一行有**构建时间戳**（`__BUILD_STAMP__`，见
  `vite.singlefile.config.ts` 的 `define`）。

## 门禁（五个都要绿）

```
npm run typecheck   # tsc --noEmit
npm run lint        # eslint .
npm test            # vitest run
npm run probe       # 先 pack，再用无头 Chrome 对**真实产物**做像素断言
npm run pack        # 产出 dist-single/index.html
```

`probe` 是最容易被跳过、也最值钱的一个：它验的是**产物**（不是源码），
包含"角色画出来了/画在对的位置""关卡声明的东西都画出来了""没有整片白块"这些
单测永远抓不到的回归。`npm run shot` 出图（`tools/out/page.png`）。

## 红线（继承架构文档，改代码前先读 `src/core/world/graph.ts` 的文件头）

- `core/` **零 three / 零 DOM**；渲染层**只读** state + events，不改任何东西。
- sim 是**确定性**的：同一个 `(state, intents)` 永远给同一帧，可 `replay` 逐字节比对。
- **判据只能有一个出处**：别在第二处重新推导同一件事（图 vs `step`、调色板 vs 探针规则……）。
  已经因此栽过：甲板锚点、接头方向、可达性判定各有一份"看起来对"的副本。
- 改 `movement.ts` / `graph.ts` / `sim.ts` 的移动与坠落之后，**必须**跑 `test/drone.test.ts`
  与 `test/enemies.test.ts`（AI 与坑/落水的回归都在那儿）。
