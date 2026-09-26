import { describe, expect, it } from 'vitest';
import { L3 } from '../src/core/level/levels/l3';
import { cellFromPoint, deckCellAtPoint, wallPlaneOffset } from '../src/render/pick';
import { CUBE, DECK_SHIFT, DECK_TOP_Y, cellAnchor } from '../src/render/metrics';
import { cellKey, type Cell } from '../src/core/types';
import { parseLevel } from '../src/core/world/tiles';
import { halfExtent } from '../src/core/world/fold';

/**
 * T21 阶段 3 · **拾取**：射线命中点 → 关卡里的那一格。
 *
 * 这一层是"点格子落笔"的另一半（另一半是 `paint.ts` 的落笔）。它**纯函数**，所以能这么测：
 *
 * - **往返**：对每一格算出它的摆放锚点（`cellAnchor`，渲染层摆位用的**同一函数**），
 *   再拿那个点反推格子 —— 必须回到原格。改摆位常量时这里会跟着红，那正是我们要的；
 * - **顶面 = 上一层**：点方块顶面要得到上面那一层（编辑器里"往上叠一块"的手势）；
 * - **越界返回 null**：点到关卡外面不该编出一个格子来。
 */
const parsed = parseLevel(L3);
if (!parsed.ok) throw new Error('L3 必须合法');
const level = parsed.level;

/** 墙格怎么摆：`scene.ts` 的 `place()` 就是 `cellAnchor`（唯一出处）。 */
const wallPoint = (c: Cell): readonly [number, number, number] => cellAnchor(level, c).p;
/** 甲板砖怎么摆：砖心在 `layerY + level*CUBE`（与 `scene.ts` 的 `islandAndJetties` 同一式子）。 */
const deckPoint = (x: number, z: number, lv: number): readonly [number, number, number] => [
  x + DECK_SHIFT,
  DECK_TOP_Y - CUBE / 2 + lv * CUBE,
  z + DECK_SHIFT,
];

describe('T21·3 拾取：墙上', () => {
  it('**逐格往返**：锚点 → 反推，回到原格（覆盖两面墙、每一行、折痕两侧）', () => {
    // 隔几格取一次足够证明判据（`rows × cols` 有 336 格，全跑也行但没必要）。
    let checked = 0;
    for (let row = 0; row < level.rows; row++) {
      for (let col = 0; col < level.cols; col += 3) {
        const cell: Cell = { face: col < level.fold ? 'A' : 'B', col, row };
        const back = cellFromPoint(level, wallPoint(cell));
        expect(back === null ? null : cellKey(back)).toBe(cellKey(cell));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('折痕最内那一对**在世界里是同一个点** —— 拾取只能固定给 A，编辑器要显示当前格身份', () => {
    // 这不是 bug，是模型的性质（`halfExtent` 的注释）：那一对格子空间上重合。
    // 所以判据只能是"确定性地给一个" + "把它是哪一格显示出来"，而不是假装分得开。
    const a: Cell = { face: 'A', col: level.fold - 1, row: 1 };
    const b: Cell = { face: 'B', col: level.fold, row: 1 };
    expect(wallPoint(a)).toEqual(wallPoint(b)); // 同一个点 —— 这就是全部理由
    expect(cellKey(cellFromPoint(level, wallPoint(a)) ?? a)).toBe(cellKey(a));
    expect(cellKey(cellFromPoint(level, wallPoint(b)) ?? b)).toBe(cellKey(a)); // 给的是 A
  });

  it('背板（空格）也能点中 —— 空格的深度与砖不同，但落在同一格', () => {
    // 背板在 `-half + INK - CUBE/2`，比砖心更远离房间；沿墙坐标不变 → 应回到同一格。
    const h = halfExtent(level.fold);
    const point: readonly [number, number, number] = [-h - 0.5, 1.5, -h + 3.5];
    const cell = cellFromPoint(level, point);
    expect(cell?.face).toBe('A');
    expect(cell?.row).toBe(1);
  });

  it('**砖的正面**（最常点到的那一面）也要认成墙格 —— 橡皮擦不掉的根因', () => {
    // 砖的正面正好落在 `-h + CUBE` 上。第一版判据是严格小于，于是打在正面上会被判成**甲板**，
    // 擦除于是扑空（用户："橡皮对大多数物品擦除都不成功"）。
    const h = halfExtent(level.fold);
    for (const row of [0, 1, 5, 11]) {
      const point: readonly [number, number, number] = [-h + CUBE, row + 0.5, -h + 3.5];
      const cell = cellFromPoint(level, point);
      expect(cell?.face).toBe('A');
      expect(cell?.col).toBe(level.fold - 1 - 3);
      expect(cell?.row).toBe(row);
    }
  });

  it('墙外 / 关卡外 → null（不编格子）', () => {
    const h = halfExtent(level.fold);
    expect(cellFromPoint(level, [-h + 0.5, -3, -h + 3.5])).toBeNull(); // 地面以下
    expect(cellFromPoint(level, [-h + 0.5, 99, -h + 3.5])).toBeNull(); // 天花板以上
    expect(cellFromPoint(level, [-h + 0.5, 1.5, -h + 999])).toBeNull(); // 沿墙之外
  });
});

describe('T21·3 拾取：甲板', () => {
  it('板 / 杆 / 梯子（L3 里都有）逐格往返', () => {
    for (const c of L3.deck ?? []) {
      const lv = c.level ?? 0;
      const back = cellFromPoint(level, deckPoint(c.x, c.z, lv));
      expect(cellKey(back ?? { face: 'A', col: 0, row: 0 })).toBe(
        cellKey(lv === 0 ? { face: 'I', col: c.x, row: c.z } : { face: 'I', col: c.x, row: c.z, level: lv }),
      );
    }
  });

  it('**点方块的顶面 → 上面那一层**（"往上叠一块"的手势）', () => {
    // 第 0 层方块的顶面 y = 1.0（砖心 0.5 ± 0.5）→ 应当得到第 1 层。
    const onTop = deckCellAtPoint(level, -7 + DECK_SHIFT, DECK_TOP_Y, -7 + DECK_SHIFT);
    expect(onTop).toEqual({ face: 'I', col: -7, row: -7, level: 1 });
    // 而**侧面**（砖心中间）得到的是它自己那一层。
    const onSide = deckCellAtPoint(level, -7 + DECK_SHIFT, DECK_TOP_Y - CUBE / 2, -7 + DECK_SHIFT);
    expect(onSide).toEqual({ face: 'I', col: -7, row: -7 });
  });

  it('水面（比第一层砖心更低）→ 第 0 层，层号不写出来', () => {
    const water = deckCellAtPoint(level, -6 + DECK_SHIFT, 0.35, -6 + DECK_SHIFT);
    expect(water).toEqual({ face: 'I', col: -6, row: -6 });
    expect(water.level).toBeUndefined();
  });

  it('`(x, z)` 取整是"往哪一格"：砖心两侧各取一半', () => {
    // 砖心在 `x + 0.5`，所以 `x+0.5±0.4` 都该落在同一格。
    for (const dx of [-0.4, 0, 0.4]) {
      const c = deckCellAtPoint(level, -7 + 0.5 + dx, 0.35, -7 + 0.5);
      expect([c.col, c.row]).toEqual([-7, -7]);
    }
  });

  it('`wallPlaneOffset` 就是砖心那一层（给"贴合面"用）', () => {
    expect(wallPlaneOffset(level.fold)).toBeCloseTo(-halfExtent(level.fold) + 0.5, 10);
  });
});
