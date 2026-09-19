import type { Cell } from '../types';
import { faceOf } from '../world/fold';
import type { Level, TileKind } from '../world/tiles';
import type { Dir } from './movement';

/**
 * 挖与回填（原版 Lode Runner 的核心动作之一）。
 *
 * 这个模块只有**纯函数**：给定关卡、当前格、方向，回答"能不能挖 / 挖完网格变成什么样"。
 * 把"什么时候扣掉、什么时候长回来"留给 `sim.ts` 的 tick —— 那样这里可以单独测，
 * 而 `SimState` 也只需要多一个"待回填"的纯数据列表（见下）。
 */

/**
 * 挖开后多久自己长回来 —— **原版基准 4 秒**。
 *
 * 4 s × `TICK_HZ`(60) = 240。这里写 240 而不是"≈3.3 秒的 200"：
 * 手感参数必须能从它的来源推出来，否则下一个人调 `TICK_HZ` 时会得到一个跟着变的秒数而不知道。
 *
 * 调参只有这一行一个入口 —— 原版的手感很大程度由这个数决定：
 * 太短则挖了等于没挖，太长则玩家可以把自己关在洞里（原版是会长回来的）。
 */
export const DIG_BACKFILL_TICKS = 240;

/**
 * 坑**被占住**（有人站在坑里）时，回填倒数按几倍速走。
 *
 * 手册把这叫"走顶加速"，但**归档原型 `legacy/canyon.html:123-131` 的实际实现是"人在坑里"**：
 * ```js
 * o.t += dt;
 * if (player.x===o.x && player.y===o.y) o.t += dt*3;   // 身在坑中 → 总共 4×
 * for (const e of enemies) if (e.x===o.x && e.y===o.y) e.t += dt*3;
 * ```
 * 手册说"**规则零翻译**：按原版语义直接生效，不自创规则"，所以这里对齐**代码**而不是措辞 ——
 * 代码更具体，而且它正好解释了文档里那句"**以身填坑**"：掉进自己挖的坑的人会加速把自己埋掉。
 *
 * 倍率沿用原型的 `1 + 3 = 4` → 240/4 = 60 tick ≈ 1 秒。这也让坑真正成为陷阱：
 * 掉进去只剩约 1 秒脱身（和原版一致 —— 自己挖的坑会埋自己）。
 *
 * > 手册措辞（"走顶"）与原型行为（"身在坑中"）不一致，已记进 T-SP1 的确认清单。
 */
export const DIG_OCCUPIED_ACCEL = 4;

/** 唯一一种可挖的砖。`'hard'` 挡路但挖不动 —— 这两者必须分开。 */
const DIGGABLE: TileKind = 'dig';

/**
 * 挖出来那一格是什么：**坑**（`'pit'`），不是空。
 *
 * 这一格是"一格深、有底的口袋"这个**地形事实**的载体 —— 掉进去的人停在坑里（`supportOf`
 * 对 `'pit'` 返回 `'brick'`），而不是穿到下面那层去。理由与依据见 `world/tiles.ts` 的
 * `TileKind` 注释（原型的 `hAt` 是 `Math.max(1, h-1)`：坑永远不会挖穿世界）。
 */
export const PIT: TileKind = 'pit';

/**
 * 「护绳」：这些瓦片**正上方**的那一格不可挖。
 *
 * 手册原文是"杆下/梯井不可挖（护绳）"。这两半的出处不同，所以各自按依据处理：
 *
 * - **杆下**：原型 v0.5 的回归里就是"杆正下方的砖不可挖"—— `legacy/test.js:101` 检查
 *   `isBar(x, y-1)`，`README-v0.5-prototype.md:75` 也把它写成原版护绳规则。
 *   所以判据 = 目标格**正上方**是横杆。
 * - **梯井**：原型里是 `ladTop(x,y)`（`legacy/canyon.html:121`）—— **梯子顶端那一格**受保护。
 *   而梯子格在本模型里**根本不是可挖砖**（`TILE_CHARS['H'] = 'ladder'`），
 *   `canDig` 的 `DIGGABLE` 判据已经把它挡掉了。**再补一条"上方是梯子"就是自创规则**
 *   （手册明令避免），而且会误伤"紧贴着梯子的那块正常地板"。
 */
const PROTECTS_BELOW: readonly TileKind[] = ['bar'];

/**
 * 挖的目标格：**斜下方**那一格。
 *
 * 原版挖的就是脚边斜下方那块砖，不是脚下 —— 挖脚下等于给自己挖坟。
 * 所以只有左右两个方向能挖；上下返回 `null`（"挖"没有向上的版本）。
 *
 * 面的归属用 `faceOf(col)` 重算，不沿用 `cell.face`：折痕那一列
 * （`col fold-1 ↔ fold`）跨过去正好换面，沿用旧面会造出一个不存在的格。
 */
export function digTarget(level: Level, cell: Cell, dir: Dir): Cell | null {
  if (dir === 'up' || dir === 'down') return null;

  const col = cell.col + (dir === 'left' ? -1 : 1);
  const row = cell.row - 1;
  if (col < 0 || col >= level.cols || row < 0) return null;

  return { face: faceOf(col, level.fold), col, row };
}

/**
 * 这一下能不能挖。两条判据：目标格是**可挖砖**，且不在护绳范围内。
 *
 * **不能复用 `isSolid`**：它把 `'dig' | 'hard'` 一起判成"实心"——那是"挡路"的语义，
 * 而这里要的是"能不能挖"。硬砖挡路，但挖不动；拿 `isSolid` 会让硬砖也能挖。
 */
export function canDig(level: Level, cell: Cell, dir: Dir): boolean {
  const target = digTarget(level, cell, dir);
  if (target === null || level.at(target.col, target.row) !== DIGGABLE) return false;

  // 护绳：正上方是横杆 / 梯子就不许挖。注意 `at()` 越界返回 undefined，
  // 于是最顶行天然不被保护 —— 那里本来也没有"上方"。
  const above = level.at(target.col, target.row + 1);
  return above === undefined || !PROTECTS_BELOW.includes(above);
}

/**
 * 回填倒数：本 tick 该从 `remaining` 里扣掉多少。
 *
 * 规则是纯数据 → 这个纯函数，`sim.ts` 只负责把它算出来的数减掉。
 * 把"几倍速"关在这里，是为了让 `sim.ts` 不必知道任何回填的手感数字。
 *
 * `occupied` = **本 tick 开始时有没有人站在坑里**（不含"站在坑口上方"——
 * 那既不是原型的条件，在物理上也踩不住）。
 */
export function fillDrain(occupied: boolean): number {
  return occupied ? DIG_OCCUPIED_ACCEL : 1;
}

/** 挖开之后的结果：**新的**网格（不原地改），外加被挖那一格的身份与行主序下标。 */
export interface DigResult {
  /** 行主序，长度 `cols × rows`，与 `Level.grid` 同一约定。 */
  readonly grid: readonly TileKind[];
  /** 被挖那一格的下标。回填时用它把 `'empty'` 还原成 `'dig'`。 */
  readonly index: number;
  /** 被挖那一格（= `digTarget` 的结果）。事件与活埋判定都要用它，省得调用方重算一遍。 */
  readonly cell: Cell;
}

/**
 * 挖开一格。挖不动时返回 `null`（而不是抛异常）—— 调用方拿 `canDig` 或这个返回值
 * 判断都行，两种用法都不该让"乱按方向键"变成一个错误。
 *
 * 返回**新数组**而不是原地改：`grid` 是 `SimState` 的一部分，而 `SimState` 必须是
 * 不可变的纯数据（`replay()` 要逐字节比对历帧）。
 */
export function applyDig(level: Level, cell: Cell, dir: Dir): DigResult | null {
  if (!canDig(level, cell, dir)) return null;

  const target = digTarget(level, cell, dir);
  if (target === null) return null; // 上一层已经挡掉了，这里是给类型收窄用的

  const index = target.row * level.cols + target.col;
  const grid = level.grid.slice();
  grid[index] = PIT;
  return { grid, index, cell: target };
}

/** 回填：把某个洞还原成可挖砖。同样返回新数组。 */
export function applyBackfill(grid: readonly TileKind[], index: number): readonly TileKind[] {
  const next = grid.slice();
  next[index] = DIGGABLE;
  return next;
}

/**
 * `applyDig` 那个下标的逆运算。回填到期时要把它还原成列行，才能问"坑里有人吗"。
 *
 * 特意不做成"返回 `Cell`"：这里只需要列行来比对，而补面需要 `fold`，
 * 把 `fold` 牵扯进来只为造一个马上被丢掉的面，不值得。
 */
export function indexToColRow(index: number, cols: number): { col: number; row: number } {
  return { col: index % cols, row: Math.floor(index / cols) };
}

/**
 * 一个"已经挖开、等着长回来"的坑。**纯数据**，会被存进 `SimState` 并参与回放逐字节比对。
 *
 * 为什么记 `remaining`（还要几个 tick）而不是 `at`（到哪个 tick 回填）：
 * "走顶加速"要**每 tick**重新决定扣多少 —— 用绝对 tick 的话，加速只能在登记时算一次，
 * 而"谁踩在坑口上"是随时在变的。倒计时倒数才表达得了这条规则。
 */
export interface PendingFill {
  /** 被挖那一格的行主序下标（与 `applyDig` 返回的同一个约定）。 */
  readonly index: number;
  /** 还要几个 tick 才回填。`<= 0` 就是本 tick 到期。 */
  readonly remaining: number;
}
