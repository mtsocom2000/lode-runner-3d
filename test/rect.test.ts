import { describe, expect, it } from 'vitest';
import { rectCells } from '../src/core/level/rect';
import { cellKey, type Cell } from '../src/core/types';

/**
 * Shift+拖 的矩形铺。与 `lineCells` 是两条语义不同的路（见 `rect.ts` 的文件头）：
 * 直线是"一路刷过去"，矩形是"这两格圈起来的整片"。
 */
const A = (col: number, row: number): Cell => ({ face: 'A', col, row });

describe('rectCells —— 矩形铺', () => {
  it('同一格：就一格', () => {
    expect(rectCells(A(3, 2), A(3, 2), 14)).toEqual([A(3, 2)]);
  });

  it('3×2 的一片：每行每列都在，且顺序固定（**行慢、列快**，同 `cellsOf`）', () => {
    const cells = rectCells(A(1, 1), A(3, 2), 14);
    expect(cells).toHaveLength(6); // (3-1+1) × (2-1+1) = 3 列 × 2 行
    expect(cells.map((c) => cellKey(c))).toEqual(['A:1,1', 'A:2,1', 'A:3,1', 'A:1,2', 'A:2,2', 'A:3,2']);
  });

  it('两个端点的**方向反着拖也成立**（从右下拖到左上）', () => {
    expect(rectCells(A(3, 3), A(1, 1), 14)).toEqual(rectCells(A(1, 1), A(3, 3), 14));
  });

  it('**跨折痕**：每一格的面由列号算出来（col 13 是 A、col 14 是 B）', () => {
    const cells = rectCells(A(13, 0), A(14, 0), 14);
    expect(cells.map((c) => `${c.face}:${c.col}`)).toEqual(['A:13', 'B:14']);
  });

  it('甲板：两个端点都在甲板上时按 (x, z) 铺一片', () => {
    const deck = (x: number, z: number): Cell => ({ face: 'I', col: x, row: z });
    expect(rectCells(deck(-7, -7), deck(-6, -6), 14).map((c) => cellKey(c))).toEqual([
      'I:-7,-7', 'I:-6,-7', 'I:-7,-6', 'I:-6,-6',
    ]);
  });

  it('甲板**跨层** / **跨坐标系**：只给终点（硬插值只会画出一堆不相干的格子）', () => {
    const deck: Cell = { face: 'I', col: -7, row: -7, level: 1 };
    expect(rectCells({ face: 'I', col: -7, row: -7 }, deck, 14)).toEqual([deck]);
    expect(rectCells(A(1, 1), { face: 'I', col: -7, row: -7 }, 14)).toEqual([
      { face: 'I', col: -7, row: -7 },
    ]);
  });
});
