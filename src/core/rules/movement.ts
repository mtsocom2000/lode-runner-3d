import type { Cell } from '../types';
import { faceOf, halfExtent } from '../world/fold';
import { isSolid, supportOf, type Support } from '../world/graph';
import type { Level } from '../world/tiles';

/**
 * 原版移动规则的直接移植：走 / 爬梯 / 松手 / 坠落（架构文档 §1.3-3"规则零翻译"）。
 *
 * ## Dir 是**摊平网格**方向，不是屏幕方向
 *
 * `left` = col−1，`right` = col+1，`up` = row+1，`down` = row−1。
 * 折痕那一跳（网格 col `fold-1` ↔ col `fold`）在这里就是一次普通的 left/right 平移 ——
 * 玩家过折角后**朝向**该转 90°，那是 input 层（T7）拿本地方向系做的事，core 不掺和。
 * 一旦让 core 去管"屏幕上哪边是左"，本文件就不再是原版规则的移植，而会变成一份
 * 只在这个视角下成立的近似 —— 那正是要避免的。
 *
 * ## 两种停驻模式（见 graph.ts 的 Support）
 *
 * - `stand` —— 站在砖面顶上，或攀在梯上。
 * - `hang`  —— **吊在横杆下面**（原版 rope 语义）。杆格可停驻，但停的方式是吊：
 *              能沿杆横移、能松手落下，**不能向上**。
 *              这也是 validator 规则⑦"连杆正下方不得为实心砖"的由来 —— 下方没空就吊不住。
 *
 * ## 坠落
 *
 * 走出边缘（目标格可通行但停不住）→ 沿该列下坠到第一个可停驻格；一路无支撑
 * → 掉出墙体底部 → `water`（架构文档 §1.5-3 途径①）。
 *
 * **坠落是移动的结果，不是图的边**：`world/graph.ts` 只管静态邻接，两者分工在那边有说明。
 * 落水扣命是 T9 的事，这里只负责报出"掉出去了、从哪一列掉的"这个事实。
 */

export type Dir = 'left' | 'right' | 'up' | 'down';

export const DIRS = ['left', 'right', 'up', 'down'] as const satisfies readonly Dir[];

/** `hang` 只可能出现在杆格上；`stand` 覆盖砖面与梯。 */
export type MoveMode = 'stand' | 'hang';

export interface MoveState {
  readonly cell: Cell;
  readonly mode: MoveMode;
}

/**
 * 方向非法时的**具体**原因。分开列而不是一个笼统的 false：
 * T7 要拿它给"为什么动不了"的反馈，测试也要能断言到底是撞墙了还是没梯。
 */
export type BlockReason =
  | 'out' // 走出网格边界
  | 'solid' // 撞上砖
  | 'not-ladder' // 不在梯上，或目标不是梯 —— 原版没有跳跃
  | 'not-hangable' // 吊着却想向上；或杆下方是实心砖，根本吊不住
  | 'nothing-there'; // 吊着横移，但杆的尽头之外是空中：得先松手

export type FallEnd =
  | { readonly kind: 'landed'; readonly cell: Cell }
  | { readonly kind: 'water'; readonly from: Cell; readonly row: number };

export type StepResult =
  | { readonly kind: 'move'; readonly state: MoveState }
  | { readonly kind: 'fall'; readonly end: FallEnd }
  | { readonly kind: 'blocked'; readonly reason: BlockReason };

function blocked(reason: BlockReason): StepResult {
  return { kind: 'blocked', reason };
}

/** 按全局列建格。列越界返回 null（行越界交给 level.at 的 undefined 处理）。 */
function cellAt(level: Level, col: number, row: number): Cell | null {
  if (col < 0 || col >= level.cols) return null;
  return { face: faceOf(col, level.fold), col, row };
}

/**
 * 这一格能不能停驻；能的话以什么模式停。
 * 出生点/重生点用它把坐标变成合法 state（不合法返回 null，而不是硬造一个会立刻坠落的 state）。
 */
export function stateAt(level: Level, cell: Cell): MoveState | null {
  const support: Support | null = supportOf(level, cell);
  if (support === null) return null;
  return { cell, mode: support === 'bar' ? 'hang' : 'stand' };
}

/**
 * 从 `from`（一个**刚离开支撑**的格：走空的落点、或杆下方那一格）沿本列下坠。
 *
 * 每往下一格都先问"这一格能不能停" —— 梯和杆不实心，但**能接住人**，
 * 所以判定必须用 supportOf 而不是 isSolid。只盯"下方是不是实心"会让坠落穿杆而过。
 * 一路掉到 row 0 还停不住 → 掉出墙体 → 水。
 */
export function fallTo(level: Level, from: Cell): FallEnd {
  let row = from.row;
  for (;;) {
    const cell: Cell = { face: faceOf(from.col, level.fold), col: from.col, row };
    const support: Support | null = supportOf(level, cell);
    if (support !== null) return { kind: 'landed', cell };
    if (row - 1 < 0) return { kind: 'water', from, row };
    row -= 1;
  }
}

/**
 * 甲板的四向步。`(dx, dz)` 是甲板**晶格**的两个轴 —— 与墙的 `(col, row)` 不是一个坐标系。
 *
 * 若手感相反（按"左"却往另一边走），**只翻这里的符号**即可：选择集中在这一处，
 * 就是为了让那种调整只动一行，而不是散进下面的逻辑里。
 */
const DECK_DIR: Readonly<Record<Dir, { readonly dx: number; readonly dz: number }>> = {
  right: { dx: 1, dz: 0 },
  left: { dx: -1, dz: 0 },
  up: { dx: 0, dz: 1 },
  down: { dx: 0, dz: -1 },
};

/**
 * 在甲板上走一步。
 *
 * 为什么不能复用下面那套算术：`cellAt` 用 `faceOf(col, fold)` 造格、`level.at` 读摊平网格 ——
 * 两者都建立在 `(col, row)` 上，而甲板格的两个下标是 `(x, z)`、属于面 `'I'`。
 * 拿 `(col ± 1, row ± 1)` 去推甲板，得到的只会是墙上的格，且 `level.at` 在甲板的坐标上是越界。
 *
 * 三条去向：①甲板内部的四邻；②接头跨到墙面；③都没有 → **阻止**。
 *
 * ③ 是阻止而不是坠落，这是用户定的规则：**玩家不能主动走入水里**。
 * 落水只保留两条途径（见 `core/rules/drown.ts`）：墙上的地板缺口、吊杆松手。
 * 甲板没有"天然断裂处"这种东西，它的边缘就是边界。
 */
function stepOnDeck(level: Level, state: MoveState, dir: Dir): StepResult {
  const x = state.cell.col;
  const z = state.cell.row;
  const step = DECK_DIR[dir];

  // ① 甲板内部的四邻：目标必须在 `level.deck` 里。
  if (level.deck.some((d) => d.x === x + step.dx && d.z === z + step.dz)) {
    return {
      kind: 'move',
      state: { cell: { face: 'I', col: x + step.dx, row: z + step.dz }, mode: 'stand' },
    };
  }

  // ② 接头：甲板端 → 墙面端。
  //    方向按**世界坐标差的主导轴**判定，不能按晶格相等比 ——
  //    墙面格落在半整数世界坐标上（`-half + u`）、甲板砖心在整数上，两者天然差 0.5。
  const h = halfExtent(level.fold);
  for (const joint of level.joints) {
    if (joint.deck.x !== x || joint.deck.z !== z) continue;

    const w = joint.wall;
    const u = w.face === 'A' ? level.fold - 1 - w.col : w.col - level.fold;
    const dx = (w.face === 'A' ? -h : -h + u) - x;
    const dz = (w.face === 'A' ? -h + u : -h) - z;
    const toward: Dir = Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'right' : 'left') : dz > 0 ? 'up' : 'down';
    if (toward !== dir) continue;

    const support: Support | null = supportOf(level, w);
    if (support === null) return blocked('out');
    return { kind: 'move', state: { cell: w, mode: support === 'bar' ? 'hang' : 'stand' } };
  }

  // ③ 甲板边缘 —— 阻止（理由见上面那段"为什么是阻止"）。
  return blocked('out');
}

/**
 * 走一步。纯函数：不改任何东西，只回答"这一步会怎样"。
 *
 * 前置条件：`state` 只能由本函数的 `move` 结果、`stateAt`、或 `trail` 产生。
 * 万一传进来一个停不住的格子，按物理处理 —— 直接开始坠落（而不是抛异常）。
 */
export function step(level: Level, state: MoveState, dir: Dir): StepResult {
  const cell = state.cell;

  // 甲板格单独走一条路。**必须放在 `fallTo` 之前**：那个函数内部会 `faceOf` 重造格，
  // 对甲板格会造出错误的 A/B 面（甲板边缘该阻止、不该坠落，本来也不进 `fallTo`）。
  if (cell.face === 'I') return stepOnDeck(level, state, dir);

  if (supportOf(level, cell) === null) {
    return { kind: 'fall', end: fallTo(level, cell) };
  }

  // 甲板接头**优先于**网格邻居，也**优先于下面的上下梯门**（B-1 修）。
  //
  // 为什么必须在梯门之前：接头的墙面端可能要用 `up` / `down` 才能拐上小道（B 面接点就是
  // `enterDir: 'up'`，因为小道朝 +z）。而下面那个门在 stand 态"脚下不是梯就立刻
  // `return blocked('not-ladder')`" —— 接点端恰好不是梯，于是**永远到不了这段循环**。
  // 实测量到的就是 `blocked:not-ladder`（见 test/movement.test.ts 的接点两条）。
  //
  // 提前是**安全**的：循环首句只为**声明过的接点墙面端**匹配，其余格子一律 `continue`，
  // 所以对"不是接点端"的格子行为一字不变。
  //
  // 另外它也必须**优先于**网格邻居：不加这段的话，接头的墙面端是**单向门** ——
  // `stepOnDeck` 能把你从小道送回墙上，但你再也上不去（从墙这边按过去只会走到隔壁墙格，
  // 接头的墙面端两侧通常都有网格邻居）。图里 `buildGraph` 是从接头两端各连一条边的，
  // 移动层必须同样双向。
  for (const joint of level.joints) {
    const w = joint.wall;
    if (w.face !== cell.face || w.col !== cell.col || w.row !== cell.row) continue;
    if (joint.enterDir !== dir) continue;
    return {
      kind: 'move',
      state: { cell: { face: 'I', col: joint.deck.x, row: joint.deck.z }, mode: 'stand' },
    };
  }

  if (dir === 'up' || dir === 'down') {
    if (state.mode === 'hang') return stepOnBar(level, state, dir);
    // stand：只有梯能上下。
    if (supportOf(level, cell) !== 'ladder') return blocked('not-ladder');

    const target = cellAt(level, cell.col, dir === 'up' ? cell.row + 1 : cell.row - 1);
    if (target === null) return blocked('not-ladder');
    if (supportOf(level, target) !== 'ladder') return blocked('not-ladder');
    return { kind: 'move', state: { cell: target, mode: 'stand' } };
  }

  const target = cellAt(level, dir === 'left' ? cell.col - 1 : cell.col + 1, cell.row);
  if (target === null) return blocked('out');
  if (isSolid(level.at(target.col, target.row))) return blocked('solid');

  const support: Support | null = supportOf(level, target);
  if (state.mode === 'hang') {
    if (support === 'bar') return { kind: 'move', state: { cell: target, mode: 'hang' } };
    if (support === 'brick' || support === 'ladder') {
      return { kind: 'move', state: { cell: target, mode: 'stand' } };
    }
    // 杆的尽头之外是空中：吊着不能凭空横移出去，得先松手（松手 = 按"下"）。
    return blocked('nothing-there');
  }

  if (support === null) return { kind: 'fall', end: fallTo(level, target) };
  return { kind: 'move', state: { cell: target, mode: support === 'bar' ? 'hang' : 'stand' } };
}

/**
 * 吊在杆上：只能沿杆横移（在上面的横向分支里），或按"下"**松手**。
 *
 * 松手不是"从杆上走下去"，是离开支撑开始坠 —— 所以从杆的**下一格**起算（§1.5-3 途径②）。
 * 杆下方若是实心砖，连吊都吊不住（validator 规则⑦要抓的就是这种关卡），直接判非法。
 */
function stepOnBar(level: Level, state: MoveState, dir: Dir): StepResult {
  if (dir === 'up') return blocked('not-hangable');

  const cell = state.cell;
  if (isSolid(level.at(cell.col, cell.row - 1))) return blocked('not-hangable');

  const below: Cell = { face: cell.face, col: cell.col, row: cell.row - 1 };
  return { kind: 'fall', end: fallTo(level, below) };
}

export type TrailOutcome = 'move' | 'fall-landed' | 'fall-water' | 'blocked';

export interface TrailStep {
  readonly dir: Dir;
  readonly result: StepResult;
}

export interface Trail {
  readonly start: MoveState;
  /** 结束时的状态。落水时是**落水前最后那个状态**（水里的位置由那一步的 `result` 给出）。 */
  readonly end: MoveState;
  readonly steps: readonly TrailStep[];
  readonly outcome: TrailOutcome;
}

/**
 * 按方向串跑一遍，用于轨迹断言（T3 验收）与 T13 的无头通关脚本。
 *
 * 中止条件：撞上非法方向（`blocked`）或落水（`fall-water`）。
 * 坠落但落住了（`fall-landed`）会**接着走** —— 掉下去还能继续走，这是原版的常态。
 */
export function trail(level: Level, start: MoveState, dirs: readonly Dir[]): Trail {
  let current = start;
  const steps: TrailStep[] = [];
  let outcome: TrailOutcome = 'move';

  for (const dir of dirs) {
    const result = step(level, current, dir);
    steps.push({ dir, result });

    if (result.kind === 'move') {
      outcome = 'move';
      current = result.state;
      continue;
    }
    if (result.kind === 'fall') {
      if (result.end.kind === 'landed') {
        // 落点一定是可停驻格（fallTo 只这么返回），复用 stateAt 定模式：
        // 掉在杆上就是 hang，掉在砖面/梯上就是 stand —— 不在两处各写一遍。
        const landed = stateAt(level, result.end.cell);
        if (landed !== null) current = landed;
        outcome = 'fall-landed';
        continue;
      }
      outcome = 'fall-water';
      break;
    }
    outcome = 'blocked';
    break;
  }

  return { start, end: current, steps, outcome };
}
