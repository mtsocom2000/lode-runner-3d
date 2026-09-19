import {
  faceOf,
  fromFold,
  halfExtent,
  isConsistentCell,
  seamNeighbour,
  seamPairs,
  toFold,
  toWorld,
  type Folded,
} from '../src/core/world/fold';
import type { Cell } from '../src/core/types';

const FOLD = 7; // 每面 7 列 → 总列数 14，折痕在 col 6 | col 7 之间
const ROWS = 10;

describe('fold：摊平坐标 ↔ 折后坐标', () => {
  it('往返无损：14 × 10 全部 140 格', () => {
    let n = 0;
    for (let col = 0; col < FOLD * 2; col++) {
      for (let row = 0; row < ROWS; row++) {
        const cell: Cell = { face: faceOf(col, FOLD), col, row };
        expect(fromFold(toFold(cell, FOLD), FOLD)).toEqual(cell);
        n++;
      }
    }
    expect(n).toBe(140);
  });

  it('u = 0 紧贴折痕，u 越大离折痕越远', () => {
    expect(toFold({ face: 'A', col: 6, row: 0 }, FOLD).u).toBe(0);
    expect(toFold({ face: 'B', col: 7, row: 0 }, FOLD).u).toBe(0);
    expect(toFold({ face: 'A', col: 0, row: 0 }, FOLD).u).toBe(FOLD - 1);
    expect(toFold({ face: 'B', col: 13, row: 0 }, FOLD).u).toBe(FOLD - 1);
  });

  it('两面共用同一个 u 轴 —— 这是"折叠"能成立的前提', () => {
    // 折痕两侧同 u 的两格，折起来之后离折痕一样远；否则折起来就对不齐。
    expect(toFold({ face: 'A', col: 6, row: 3 }, FOLD).u).toBe(toFold({ face: 'B', col: 7, row: 3 }, FOLD).u);
    expect(toFold({ face: 'A', col: 5, row: 3 }, FOLD).u).toBe(toFold({ face: 'B', col: 8, row: 3 }, FOLD).u);
    expect(toFold({ face: 'A', col: 0, row: 3 }, FOLD).u).toBe(
      toFold({ face: 'B', col: 13, row: 3 }, FOLD).u,
    );
  });

  it('face 必须与 col 一致，不一致就是脏数据', () => {
    expect(isConsistentCell({ face: 'A', col: 6, row: 0 }, FOLD)).toBe(true);
    expect(isConsistentCell({ face: 'B', col: 7, row: 0 }, FOLD)).toBe(true);
    expect(isConsistentCell({ face: 'A', col: 0, row: 9 }, FOLD)).toBe(true);
    expect(isConsistentCell({ face: 'B', col: 13, row: 9 }, FOLD)).toBe(true);
    expect(isConsistentCell({ face: 'A', col: 7, row: 0 }, FOLD)).toBe(false);
    expect(isConsistentCell({ face: 'B', col: 6, row: 0 }, FOLD)).toBe(false);
    expect(isConsistentCell({ face: 'A', col: -1, row: 0 }, FOLD)).toBe(false);
    expect(isConsistentCell({ face: 'B', col: 14, row: 0 }, FOLD)).toBe(false);
  });

  it('halfExtent：7 列的一面墙 → 折痕线在 6', () => {
    // `fold - 1`（不是 `fold - 0.5`）：折痕线必须落在**整数**格上，最内列才贴得住它。
    // 见 `halfExtent` 的说明 —— 差这半格，最内列就会有一半伸到对面那面墙的背板后面
    // （用户报的"走到两个侧面交界处就进墙里了"）。
    expect(halfExtent(7)).toBeCloseTo(6, 10);
    expect(halfExtent(10)).toBeCloseTo(9, 10);
  });
});

describe('fold：折痕邻接表', () => {
  it('逐行配对，共 rows 对', () => {
    const pairs = seamPairs(ROWS, FOLD);
    expect(pairs).toHaveLength(ROWS);
    expect(pairs[0]).toEqual({
      a: { face: 'A', col: 6, row: 0 },
      b: { face: 'B', col: 7, row: 0 },
    });
  });

  it('每一对都同行、分属两面、且落在最内列上', () => {
    for (const p of seamPairs(ROWS, FOLD)) {
      expect(p.a.row).toBe(p.b.row);
      expect(p.a.face).toBe('A');
      expect(p.b.face).toBe('B');
      expect(p.a.col).toBe(FOLD - 1);
      expect(p.b.col).toBe(FOLD);
    }
  });

  it('seamNeighbour：只有 u=0 有对手，且是对面同一行', () => {
    const a = toFold({ face: 'A', col: 6, row: 4 }, FOLD);
    expect(seamNeighbour(a)).toEqual({ face: 'B', u: 0, y: 4 });
    const b = toFold({ face: 'B', col: 7, row: 9 }, FOLD);
    expect(seamNeighbour(b)).toEqual({ face: 'A', u: 0, y: 9 });
  });

  it('seamNeighbour 是对合运算：走两次回到原地', () => {
    const seamCells: readonly Cell[] = [
      { face: 'A', col: 6, row: 0 },
      { face: 'A', col: 6, row: 7 },
      { face: 'B', col: 7, row: 2 },
      { face: 'B', col: 7, row: 9 },
    ];
    for (const cell of seamCells) {
      const once: Folded | null = seamNeighbour(toFold(cell, FOLD));
      expect(once).not.toBeNull();
      if (!once) continue;
      expect(seamNeighbour(once)).toEqual(toFold(cell, FOLD));
      expect(fromFold(once, FOLD)).toEqual({
        face: cell.face === 'A' ? 'B' : 'A',
        col: cell.face === 'A' ? FOLD : FOLD - 1,
        row: cell.row,
      });
    }
  });

  it('不在折痕列上就没有对手', () => {
    expect(seamNeighbour(toFold({ face: 'A', col: 5, row: 0 }, FOLD))).toBeNull();
    expect(seamNeighbour(toFold({ face: 'B', col: 8, row: 0 }, FOLD))).toBeNull();
    expect(seamNeighbour(toFold({ face: 'A', col: 0, row: 0 }, FOLD))).toBeNull();
    expect(seamNeighbour(toFold({ face: 'B', col: 13, row: 0 }, FOLD))).toBeNull();
  });
});

describe('fold：世界坐标', () => {
  it('A 面的格子全部落在 x = -6 这个竖直面上（折痕线自己）', () => {
    for (let u = 0; u < FOLD; u++) {
      expect(toWorld({ face: 'A', u, y: 0 }, FOLD).x).toBe(-6);
    }
  });

  it('B 面的格子全部落在 z = -6 这个竖直面上（折痕线自己）', () => {
    for (let u = 0; u < FOLD; u++) {
      expect(toWorld({ face: 'B', u, y: 0 }, FOLD).z).toBe(-6);
    }
  });

  it('u 的方向就是从折痕往外：A 沿 +z，B 沿 +x；**最内列在折痕之外半格**', () => {
    // 最内列（u=0）的格心在 -half + 0.5 —— 整格都在折痕线之外，不骑在它上面。
    // 用户报的"走到两个侧面交界处就进墙里了"就是这条被破坏时的样子（见 `halfExtent`）。
    expect(toWorld({ face: 'A', u: 0, y: 0 }, FOLD).z).toBe(-5.5);
    expect(toWorld({ face: 'A', u: 6, y: 0 }, FOLD).z).toBe(0.5);
    expect(toWorld({ face: 'B', u: 0, y: 0 }, FOLD).x).toBe(-5.5);
    expect(toWorld({ face: 'B', u: 6, y: 0 }, FOLD).x).toBe(0.5);
  });

  it('格心在行的中央：y = row + 0.5', () => {
    for (let row = 0; row < ROWS; row++) {
      expect(toWorld({ face: 'A', u: 0, y: row }, FOLD).y).toBe(row + 0.5);
    }
  });

  it('折痕两侧对应的两格关于角线对称（x/z 互换、y 相同）', () => {
    for (let y = 0; y < ROWS; y++) {
      const a = toWorld({ face: 'A', u: 0, y }, FOLD);
      const b = toWorld({ face: 'B', u: 0, y }, FOLD);
      expect(a.x).toBe(b.z);
      expect(a.z).toBe(b.x);
      expect(a.y).toBe(b.y);
    }
  });
});
