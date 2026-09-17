import { DIRS, stateAt, step, type Dir, type MoveState } from './movement';
import { cellKey, type Cell } from '../types';
import type { Level } from '../world/tiles';

/**
 * **按移动规则**的可达性 —— 与 `world/graph.ts` 的静态图**刻意分开**，两者回答的是不同的问题：
 *
 * | 问题 | 用谁 |
 * |---|---|
 * | "玩家真的走得到吗？"（走 / 爬 / 掉下去都算） | **本文件** |
 * | "只靠地面能不能到？""去掉杆还剩什么？"（可配置边集的路径规划） | `graph.ts` |
 *
 * ## 为什么必须分开（这是踩过的坑，不是洁癖）
 *
 * 曾经 `validate` 的 `unreachable` 规则用的是**静态图**，于是漏掉了一整类关卡事故：
 * 甲板接头的**墙面端**，`step` 会让"按 enterDir 那个方向"优先上小道 —— 也就是说那一格
 * **横向移动被接头吃掉了**。但 `buildGraph` 照旧连了一条 walk 边（它不知道接头会覆盖横移），
 * 于是出现 **"校验说可达、玩家走不到"**：L1 的底层走廊就被这么切断成 `{0,1}` 与 `{2,3}` 两段，
 * 而 validate 判"全过"。
 *
 * 判据只能有一个出处：**问"走不走得到"就必须问 `step`**。静态图服务于另一类问题
 * （AI 的受限边集、连通性分析），它不该被拿来回答这个。
 */
export interface WalkReach {
  /** 走得到的**格**（`cellKey`）。同一格的两种停驻方式（站 / 吊）算同一格。 */
  readonly cells: ReadonlySet<string>;
  /** "一踏进去就落水"的走法（出发点 + 方向）。地形危险度的清单。 */
  readonly drownings: readonly WalkStep[];
}

export interface WalkStep {
  readonly cell: Cell;
  readonly dir: Dir;
}

/**
 * 从某一格**走一步**能到达的格。含"走空坠落但落住了"的落点；**落水不算到达**。
 *
 * 这是"移动规则下的相邻"这个关系本身 —— `walkReachable` 与"孤岛碎成几块"的分块都用它，
 * 所以它只能有一份实现：两处各写一遍，"可达"与"分块"就会漂成两套事实。
 */
export function walkNeighbours(level: Level, cell: Cell): readonly Cell[] {
  const from = stateAt(level, cell);
  if (from === null) return [];
  const out: Cell[] = [];
  for (const dir of DIRS) {
    const reached = tryStep(level, from, dir);
    if (reached !== null) out.push(reached);
  }
  return out;
}

/** 内部：一步的结果归一成"到了哪一格"；落水 / 撞墙 / 落点站不住都返回 null。 */
function tryStep(level: Level, from: MoveState, dir: Dir): Cell | null {
  const result = step(level, from, dir);
  if (result.kind === 'blocked') return null;
  if (result.kind === 'move') return result.state.cell;
  // 坠落：落住了才算到达（`fallTo` 只对 landed 给落点；水的那一支没有落点）。
  if (result.end.kind === 'water') return null;
  return result.end.cell;
}

/** 累积 + 去重 + 记录落水口的那点机内状态。抽出来是因为两个入口都要用同一套判据。 */
function walkFrom(level: Level, start: MoveState): WalkReach {
  const cells = new Set<string>();
  const seen = new Set<string>();
  const drownings: WalkStep[] = [];
  const queue: MoveState[] = [];

  const push = (state: MoveState): void => {
    const key = `${cellKey(state.cell)}|${state.mode}`;
    if (seen.has(key)) return;
    seen.add(key);
    cells.add(cellKey(state.cell));
    queue.push(state);
  };

  push(start);
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    if (cur === undefined) continue;
    for (const dir of DIRS) {
      const result = step(level, cur, dir);
      if (result.kind === 'blocked') continue;
      if (result.kind === 'move') {
        push(result.state);
        continue;
      }
      if (result.end.kind === 'water') {
        drownings.push({ cell: cur.cell, dir });
        continue;
      }
      const landed = stateAt(level, result.end.cell);
      if (landed !== null) push(landed);
    }
  }

  return { cells, drownings };
}

/** 按移动规则从 `start` 出发能走到的所有格（含 `start` 自己；起点站不住就是空集）。 */
export function walkReachable(level: Level, start: Cell): WalkReach {
  const from = stateAt(level, start);
  if (from === null) return { cells: new Set<string>(), drownings: [] };
  return walkFrom(level, from);
}
