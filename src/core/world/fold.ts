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

/** 折痕平面到各面外缘的水平距离：fold 列的一面墙 → fold - 0.5。fold=7 时是 6.5。 */
export function halfExtent(fold: number): number {
  return fold - 0.5;
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

/** 格心的世界坐标（不含砖块厚度偏移）。y 取行的中心。 */
export function toWorld(f: Folded, fold: number): WorldPos {
  const h = halfExtent(fold);
  const y = f.y + 0.5;
  return f.face === 'A' ? { x: -h, y, z: -h + f.u } : { x: -h + f.u, y, z: -h };
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
