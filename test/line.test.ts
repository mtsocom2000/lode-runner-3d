import { describe, expect, it } from 'vitest';
import { lineCells } from '../src/core/level/line';
import { cellKey, type Cell } from '../src/core/types';

/**
 * 拖笔补格（Bresenham）。用户 2026-09-23："确实有快拖会跳格的问题。"
 *
 * 这一层是纯函数，所以把"补格"的语义钉在这里：**端点都算、中间不留洞、面按列算**。
 */
const A = (col: number, row: number): Cell => ({ face: 'A', col, row });

describe('lineCells —— 拖笔补格', () => {
  it('同一格：就一格', () => {
    expect(lineCells(A(3, 2), A(3, 2), 14)).toEqual([A(3, 2)]);
  });

  it('同一行的长条：**中间一格不漏**（这正是快拖跳格的那个洞）', () => {
    // 用户那一行 `==============.=============` 是 28 格 —— 手拖时中间断的正是这里。
    const cells = lineCells(A(0, 5), A(7, 5), 14);
    expect(cells.map((c) => c.col)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(cells.every((c) => c.row === 5)).toBe(true);
  });

  it('反向拖也成立（从右边拖回左边）', () => {
    expect(lineCells(A(7, 5), A(0, 5), 14).map((c) => c.col)).toEqual([7, 6, 5, 4, 3, 2, 1, 0]);
  });

  it('斜线：45° 走对角，一格不多一格不少', () => {
    expect(lineCells(A(0, 0), A(3, 3), 14).map((c) => cellKey(c))).toEqual([
      'A:0,0',
      'A:1,1',
      'A:2,2',
      'A:3,3',
    ]);
  });

  it('缓斜线：每列都取到，行按最接近的走', () => {
    const cells = lineCells(A(0, 0), A(4, 2), 14);
    expect(cells.map((c) => c.col)).toEqual([0, 1, 2, 3, 4]);
    expect(cells.map((c) => c.row)).toEqual([0, 1, 1, 2, 2]);
  });

  it('**跨折痕**：每一格的面由列号算出来（col 13 是 A、col 14 是 B）', () => {
    const cells = lineCells(A(12, 3), A(15, 3), 14);
    expect(cells.map((c) => `${c.face}:${c.col}`)).toEqual(['A:12', 'A:13', 'B:14', 'B:15']);
  });

  it('甲板（另一套坐标）**不插值**：只给终点，免得画出一串不相干的甲板格', () => {
    const deck: Cell = { face: 'I', col: -7, row: -7 };
    expect(lineCells(deck, { face: 'I', col: -3, row: -3 }, 14)).toEqual([{ face: 'I', col: -3, row: -3 }]);
    expect(lineCells(A(1, 1), deck, 14)).toEqual([deck]);
  });

  it('一格不漏的判据：走出的格数 = 切比雪夫距离 + 1', () => {
    // 对任意两端，Bresenham 的步数恰好是 max(|Δcol|, |Δrow|)，所以格数是它 + 1 ——
    // 这条比逐例断言更能说明"没有洞"。
    for (const [c0, r0, c1, r1] of [
      [0, 0, 9, 4],
      [3, 7, 3, 2],
      [12, 1, 20, 10],
      [20, 10, 12, 1],
    ] as const) {
      const n = lineCells(A(c0, r0), A(c1, r1), 14).length;
      expect(n).toBe(Math.max(Math.abs(c1 - c0), Math.abs(r1 - r0)) + 1);
    }
  });
});
