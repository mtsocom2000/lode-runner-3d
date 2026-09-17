import { DIRS, step, type Dir, type MoveState } from '../rules/movement';
import type { Cell } from '../types';
import { buildGraph, findPath } from '../world/graph';
import type { Level } from '../world/tiles';

/**
 * 巡逻无人机（T12-b）。**两段式** —— 用户裁定的原话是"巡逻段 + 追击段（= 原版守卫）"。
 *
 * | 段 | 条件 | 行为 |
 * |---|---|---|
 * | **追击段** | 玩家在**墙面内**可达（同一连通块） | 沿图上的**最短路径**走一步 |
 * | **巡逻段** | 其余一切（不可达 / 玩家在岛台上 / 没有玩家） | 沿 `facing` 直走，**撞墙才转向** |
 *
 * ## 为什么巡逻是"直走 + 撞墙转向"，而不是每 tick 重新选一个方向
 *
 * 后者（随机游走）看着更"活"，但每 tick 重选会让它在原地来回抖 —— 因为它没有记忆，
 * 而"往哪走"这件事每一格都在变。让它**先沿当前朝向把这一格走完**、只在走不通时才转向，
 * 是唯一既简单又不像 bug 的确定性做法。转向时**尽量不掉头**（先把反向排掉），
 * 于是它在死胡同里会转 90° 而不是原地弹回。
 *
 * ## 为什么"只在墙面内"要写成图的开关
 *
 * 用户裁定无人机只在墙面活动。这件事的正确表达是 `buildGraph(level, { decks: false })` ——
 * 让**图**里根本没有甲板节点，于是"追不追得到"这个问题由可达性本身回答：玩家跳上岛台，
 * 无人机就走不过去（自动回到巡逻段）。在 AI 里手写"这一步不许上甲板"是错的 ——
 * 那会在 AI 里重新定义一次"什么算合法移动"，而那份定义已经有主（`world/graph.ts`
 * 与 `rules/movement.ts`）。**判据只能有一个出处。**
 *
 * ## 这个模块是纯函数
 *
 * 不吃 `SimState`、不改任何东西、不碰 `Entity` 的形状 —— 只回答"朝哪走"。
 * 于是它可以被穷举式地单测（`test/drone.test.ts`），而 `sim.decide()` 只负责把
 * "玩家在哪"这件事喂进来。
 */

/** 反向。转向时"尽量不掉头"要用它。 */
const REVERSE: Readonly<Record<Dir, Dir>> = { left: 'right', right: 'left', up: 'down', down: 'up' };

/** 这一格朝这个方向走，**真能走一格**吗（坠落与撞墙都不算）。 */
function canWalk(level: Level, at: MoveState, dir: Dir): boolean {
  return step(level, at, dir).kind === 'move';
}

/**
 * 从 `from` 走到图上相邻的 `to`，第一步该按哪个键。
 *
 * 只认四种相邻：同行列 ±1（`left`/`right`）、同列行 ±1（`up`/`down`）。
 * 折痕那一跳（`col fold-1 ↔ fold`）在摊平网格里就是一次 `right`/`left` —— 与 `movement.ts`
 * 的口径一致，所以这里不需要为折痕单开一条。
 */
function firstDir(from: Cell, to: Cell): Dir | null {
  if (from.row === to.row) return to.col > from.col ? 'right' : to.col < from.col ? 'left' : null;
  if (from.col === to.col) return to.row > from.row ? 'up' : 'down';
  return null;
}

export interface DroneInput {
  readonly level: Level;
  /** 无人机此刻站在哪、怎么停的（梯上/砖面上）。 */
  readonly at: MoveState;
  /** 当前朝向（巡逻段的"直走"就是它）。 */
  readonly facing: Dir;
  /** 玩家本 tick 开始时在哪；没有玩家（终局）是 `null`。 */
  readonly playerCell: Cell | null;
}

/** 本 tick 该朝哪走；`null` = 不动（到不了玩家，而且四个方向都走不通）。 */
export function decideDrone(input: DroneInput): Dir | null {
  return chaseDir(input) ?? patrolDir(input.level, input.at, input.facing);
}

/** 追击段：玩家在墙面内可达 → 最短路径的第一步。 */
function chaseDir(input: DroneInput): Dir | null {
  const { level, at, playerCell } = input;
  if (playerCell === null) return null;

  // `decks: false` —— 见文件头"为什么只在墙面内要写成图的开关"。
  const graph = buildGraph(level, { decks: false });
  if (!graph.has(at.cell) || !graph.has(playerCell)) return null;

  const path = findPath(graph, at.cell, playerCell);
  // `length < 2`：到不了（null），或者已经站在玩家那一格上（只剩起点）。
  if (path === null || path.length < 2) return null;
  const next = path[1];
  return next === undefined ? null : firstDir(at.cell, next);
}

/** 巡逻段：沿 `facing` 直走；走不通就转向，且**尽量不掉头**。 */
function patrolDir(level: Level, at: MoveState, facing: Dir): Dir | null {
  if (canWalk(level, at, facing)) return facing;

  const open = DIRS.filter((dir) => canWalk(level, at, dir));
  // 排除反向之后按 `DIRS` 的固定顺序取第一个 —— 完全确定，回放可逐字节比对。
  const notReverse = open.filter((dir) => dir !== REVERSE[facing]);
  return notReverse[0] ?? open[0] ?? null;
}
