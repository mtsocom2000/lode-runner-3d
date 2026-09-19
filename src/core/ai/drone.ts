import { DIRS, step, type Dir, type MoveState, type StepOptions } from '../rules/movement';
import type { Cell } from '../types';
import { buildGraph, findPath } from '../world/graph';
import { withGrid, type Level, type TileKind } from '../world/tiles';

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

/**
 * 无人机的**移动能力**：只在墙面内 —— 它的世界里没有甲板（岛台 / 小道）。
 *
 * 这是"只在墙面内"这条裁定的**唯一一份**出处：`chaseDir` 用 `buildGraph(...,{decks:false})`
 * 拿图上的那一半，`sim.advance` 拿这一份去走实际那一步。两处必须是同一个答案 ——
 * 早先只有图那一半，于是巡逻到接头那一格、朝向正好是 `enterDir` 时，它**一步就上了小道**，
 * 然后在小道上"变傻"（甲板上没有它的图节点，追不了人）。
 */
export const DRONE_STEP: StepOptions = { decks: false };

/** 这一格朝这个方向走，**真能走一格**吗（坠落与撞墙都不算）。 */
function canWalk(level: Level, at: MoveState, dir: Dir, opts: StepOptions): boolean {
  return step(level, at, dir, opts).kind === 'move';
}

/**
 * 从 `from` 走到图上的邻居 `to`，第一步按哪个键。
 *
 * 两条来源，按"两个格子在哪张网格上"分工 —— 各取自己那份**唯一出处**：
 *
 * - **两端都在墙面**：用摊平网格的坐标差（同行列 ±1）。这也覆盖折痕那一跳
 *   （`col fold-1 ↔ fold` 在摊平图里就是一次 `right`/`left`）。
 *   走坐标差而不是问 `step`，是因为**踩空也是合法的一步**：追兵的路径会穿过坑口
 *   （"守卫对坑是瞎的"，见 T12-e），而 `step` 对那一格给的是 `fall`、拿不到目标格 ——
 *   只看"能不能 move"会把这条路径整条判掉。
 * - **一端在甲板上**：那条边是**接头**声明的，问 `step`（四个方向试一遍）。甲板格的
 *   `(x, z)` 不属于墙的坐标系，坐标差在这里没有意义（T15 之前无人机图里没有甲板节点，
 *   这里一直只有第一支；攀爬者第一步就是接头 —— 一接上就现形）。
 */
function firstDir(level: Level, at: MoveState, to: Cell, opts: StepOptions): Dir | null {
  if (at.cell.face !== 'I' && to.face !== 'I') {
    if (at.cell.row === to.row) return to.col > at.cell.col ? 'right' : to.col < at.cell.col ? 'left' : null;
    if (at.cell.col === to.col) return to.row > at.cell.row ? 'up' : 'down';
    return null;
  }

  for (const dir of DIRS) {
    const r = step(level, at, dir, opts);
    if (r.kind !== 'move') continue;
    const c = r.state.cell;
    if (c.face === to.face && c.col === to.col && c.row === to.row) return dir;
  }
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
  /**
   * 这个敌人的**移动能力**（默认 = 无人机的 `DRONE_STEP`：只在墙面内）。
   *
   * 攀爬者（`ai/stalker.ts`）传它自己那一份（`decks: true`）—— 于是**图与脚用同一个答案**：
   * 图上能到岛台，它就走得上去。这条参数化是 T15 加进来时唯一需要改的地方。
   */
  readonly step?: StepOptions;
}

/** 本 tick 该朝哪走；`null` = 不动（到不了玩家，而且四个方向都走不通）。 */
export function decideDrone(input: DroneInput): Dir | null {
  const step = input.step ?? DRONE_STEP;
  return chaseDir(input, step) ?? patrolDir(input.level, input.at, input.facing, step);
}

/**
 * "**地形还完整**"的网格：把坑（瓦片 `'pit'`）当成还是可挖砖。没有坑时原样返回（不做无谓的拷贝）。
 *
 * 为什么不直接拿当前地形去规划：坑那一格在图上不是节点，`findPath` 会**精确地绕开它** ——
 * 玩家辛苦挖的坑对守卫毫无作用（用户报的原话："机器人似乎检测到了这个坑，就不会沿着会掉进
 * 坑里的路线移动了，这样的话挖坑就失去了意义"）。
 *
 * 归档原型把这条写在注释里（`legacy/canyon.html:103`）：
 * `// exits from pit treated as normal (AI is "blind" to pits; classic dumb guards)` ——
 * **守卫对坑是"瞎"的**，它照记忆里的地形走，脚下没了才掉下去。
 */
function plannedGrid(level: Level): readonly TileKind[] {
  if (!level.grid.includes('pit')) return level.grid;
  return level.grid.map((kind) => (kind === 'pit' ? 'dig' : kind));
}

/**
 * 追击段：玩家在墙面内可达 → 沿**记忆里的地形**走最短路径的第一步。
 *
 * ## 为什么守卫会（也应该）掉进坑里
 *
 * 守卫是照着"地形还完整"的图规划路线的（`plannedGrid`），但**脚下是当前地形** ——
 * 于是它一头走进玩家刚挖的缺口、掉下去，正好落进"**落坑受困 → 土回填 → 活埋**"那条链。
 * 这就是原版守卫的行为：它们不躲洞，它们掉进去；玩家挖坑反制才有意义。
 * （用当前地形规划会绕开坑，整条玩法失效。）
 *
 * 注意"计划"与"物理"的分工：这里只决定**朝哪走**；踩空会怎样由 `sim.advance` 里的 `step`
 * 判定（那才是唯一的地形真相）。
 */
function chaseDir(input: DroneInput, opts: StepOptions): Dir | null {
  const { level, at, playerCell } = input;
  if (playerCell === null) return null;

  // 图与脚用**同一个** `decks`（见文件头"为什么只在墙面内要写成图的开关"）。
  // 无人机是 `decks: false`（只在墙面内），攀爬者是 `true`（能上岛台）。
  const graph = buildGraph(withGrid(level, plannedGrid(level)), { decks: opts.decks !== false });
  if (!graph.has(at.cell) || !graph.has(playerCell)) return null;

  const path = findPath(graph, at.cell, playerCell);
  // `length < 2`：到不了（null），或者已经站在玩家那一格上（只剩起点）。
  if (path === null || path.length < 2) return null;
  const next = path[1];
  return next === undefined ? null : firstDir(level, at, next, opts);
}

/** 巡逻段：沿 `facing` 直走；走不通就转向，且**尽量不掉头**。 */
function patrolDir(level: Level, at: MoveState, facing: Dir, opts: StepOptions): Dir | null {
  if (canWalk(level, at, facing, opts)) return facing;

  const open = DIRS.filter((dir) => canWalk(level, at, dir, opts));
  // 排除反向之后按 `DIRS` 的固定顺序取第一个 —— 完全确定，回放可逐字节比对。
  const notReverse = open.filter((dir) => dir !== REVERSE[facing]);
  return notReverse[0] ?? open[0] ?? null;
}
