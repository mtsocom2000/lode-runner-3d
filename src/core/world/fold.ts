import type { Cell, Face } from '../types';

/**
 * 折叠映射：把**一张 2D 关卡**折 90° 贴到墙角的两面竖直墙上。
 *
 * 三套坐标，别混：
 *   摊平坐标 `col/row`  —— 原版 2D 关卡那一张。col ∈ [0, 2×fold)，row 从 0（最底）起。
 *   折后坐标 `face/u/y` —— 折起来之后的坐标。u = **离折痕的距离**，u = 0 是紧贴折痕的那一列。
 *   世界坐标 `x/y/z`    —— 折后坐标落到 three 场景里的位置。
 *
 * 折痕在 col = fold-1 | fold 之间；折完是 x = z = -halfExtent(fold) 那条棱线。
 *
 * 为什么 u 是"离折痕的距离"而不是"面内的列号"：折痕两侧必须是同一条轴，
 * 两面才共用同一个 u，折叠才成立（架构文档 §1.3-1）。用面内列号的话，
 * A 的 6 和 B 的 0 是同一列，得额外记方向，很快会写错。
 *
 * 本文件**不碰渲染**：toWorld 只给到"格子所在的平面 + 格心"，
 * 砖块自身的厚度偏移由 render 层加（见 render/scene.ts）。
 */

/** 折后坐标。（和 Cell 形状相似但语义不同：这里的 u 是离折痕的距离，不是全局列。） */
export interface Folded {
  readonly face: Face;
  /** 离折痕的距离，0 = 紧贴折痕。 */
  readonly u: number;
  readonly y: number;
}

export interface WorldPos {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SeamPair {
  readonly a: Cell;
  readonly b: Cell;
}

/**
 * 折痕平面到各面外缘的水平距离：`fold` 列的一面墙 → **`fold - 1`**。fold=7 时是 6.0。
 *
 * ## 为什么不是 `fold - 0.5`（用户报的"走到两个侧面交界处就进墙里了"）
 *
 * 这个数就是**折痕线自己的位置**：两面墙的背板在 `x = z = -halfExtent` 这条棱线上会合。
 * 而一列格子宽 1，所以**格子不能骑在折痕线上** —— 折痕两侧最内列的那两格必须各自贴在
 * 折痕线**之外**。
 *
 * 以前取 `fold - 0.5`，等于把最内列的**格心**摆在折痕线上，于是那两格各有一半伸到对面去：
 * A 面最内列的格子整个落在 B 面背板**后面**（被够不着它的那面墙挡住），对称的另一格也一样。
 * 表现就是玩家/无人机一走进那两格就"进了墙"（`A: fold-1 → B: fold` 的折痕一步看起来成了
 * "走进墙里、再从相邻的墙里出来"）。
 *
 * 现在取 `fold - 1`：折痕线离原点正好整数格，格子从折痕线**往外**排（见 `toWorld` 里的 `+0.5`），
 * 最内列于是贴在墙角上、两面的背板之前 —— 可见、可走；`A: fold-1` 与 `B: fold` 落在
 * **世界同一个位置**（折痕一步 = 原地转 90°，正是"折"该有的样子）。
 *
 * 顺带保住了"墙砖落在整数晶格上"（甲板/小道靠它与墙贴合）：格心 = 折痕线 + 半格 + 整数格
 * → 半整数，砖面落在整数上 —— 与 `fold - 0.5` 时代一字不差。所以 `metrics.ts` 的 `INK`
 * 不再需要参与这件事（见那边的说明）。
 */
export function halfExtent(fold: number): number {
  return fold - 1;
}

/** 摊平后的全局列属于哪一面。 */
export function faceOf(col: number, fold: number): Face {
  return col < fold ? 'A' : 'B';
}

/** Cell 的 face 必须与 col 一致 —— 不一致就是脏数据，早点抓比晚点查便宜。 */
export function isConsistentCell(cell: Cell, fold: number): boolean {
  return cell.col >= 0 && cell.col < fold * 2 && cell.row >= 0 && faceOf(cell.col, fold) === cell.face;
}

/** 摊平坐标 → 折后坐标。 */
export function toFold(cell: Cell, fold: number): Folded {
  const u = cell.face === 'A' ? fold - 1 - cell.col : cell.col - fold;
  return { face: cell.face, u, y: cell.row };
}

/** 折后坐标 → 摊平坐标。与 toFold 互为逆运算。 */
export function fromFold(f: Folded, fold: number): Cell {
  const col = f.face === 'A' ? fold - 1 - f.u : fold + f.u;
  return { face: f.face, col, row: f.y };
}

/**
 * 格心的世界坐标（不含砖块厚度偏移）。y 取行的中心。
 *
 * **那个 `+0.5` 就是"格子贴在折痕线外侧"的全部算术**：折痕线在 `-h`，最内列（`u = 0`）
 * 的格心因此在 `-h + 0.5` —— 离折痕线半格，整格都在折痕线之外（见 `halfExtent` 的说明）。
 */
export function toWorld(f: Folded, fold: number): WorldPos {
  const h = halfExtent(fold);
  const y = f.y + 0.5;
  const along = -h + 0.5 + f.u;
  return f.face === 'A' ? { x: -h, y, z: along } : { x: along, y, z: -h };
}

/**
 * 折痕边（架构文档 §1.5-1）：墙 A 的最内列 ↔ 墙 B 的最内列、**同一行** → 视为相邻。
 * 只有 u = 0 的格子才有对面的对手；其余格子返回 null。
 */
export function seamNeighbour(f: Folded): Folded | null {
  if (f.u !== 0) return null;
  return { face: f.face === 'A' ? 'B' : 'A', u: 0, y: f.y };
}

/**
 * 折痕邻接表：逐行把两面的折痕列配成对。
 * 这张表也是"折叠真的被用到了"的凭据 —— 一关里到底有几处能跨折痕走，看它。
 */
export function seamPairs(rows: number, fold: number): readonly SeamPair[] {
  const out: SeamPair[] = [];
  for (let y = 0; y < rows; y++) {
    out.push({
      a: { face: 'A', col: fold - 1, row: y },
      b: { face: 'B', col: fold, row: y },
    });
  }
  return out;
}

/**
 * 这一步是不是**跨折痕**的那一步（`A: fold-1` ↔ `B: fold`，同一行）。
 *
 * 用途只有一个：**它不该占用一格的移动冷却**。折痕两侧最内列落在**世界同一个位置**
 * （见 `metrics.BRICK_N` 的说明），所以跨折痕 = 原地转 90°、一格都没走 ——
 * 照常扣一格的冷却，角色就会在墙角停一整个移动间隔
 * （用户 2026-09-19："机器人经过转角的时候明显会停顿一下"）。
 *
 * 不扣冷却**不等于加速**：那一步位移是 0，所以"绕拐角"与"直走同样格数"所花的时间一致。
 */
export function isSeamStep(from: Cell, to: Cell, fold: number): boolean {
  if (from.face === 'I' || to.face === 'I') return false; // 甲板不是折痕
  if (from.face === to.face || from.row !== to.row) return false;
  const inner = (c: Cell): boolean => c.col === (c.face === 'A' ? fold - 1 : fold);
  return inner(from) && inner(to);
}
