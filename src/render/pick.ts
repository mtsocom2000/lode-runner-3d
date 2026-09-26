import { halfExtent } from '../core/world/fold';
import type { Level } from '../core/world/tiles';
import type { Cell } from '../core/types';
import { BRICK_N, CUBE, DECK_SHIFT, DECK_TOP_Y } from './metrics';

/**
 * **射线命中点 → 关卡里的那一格**（T21 阶段 3，编辑器的拾取）。
 *
 * ## 为什么是"点 → 格"的纯函数，而不是"哪个 mesh 被点中"
 *
 * 场景里的东西**本来就是按格子摆的** —— 砖心、甲板块心、背板，全都由 `metrics.ts` 的
 * `cellAnchor` 一族算出来。所以反过来问"这一点属于哪一格"就不需要任何 mesh 标签：
 * **几何本身就是标签**。好处是这一层完全纯函数、可单测，而且与摆位读的是**同一组常量**
 * （`BRICK_N` / `DECK_SHIFT` / `CUBE` / `halfExtent`）—— 改了摆位、这里跟着变，不会各算一套。
 *
 * （`test/pick.test.ts` 拿 `cellAnchor` 逐格往返验证：先算锚点、再反推格子，必须回到原格。）
 *
 * ## 三条判据
 *
 * 1. **先看在哪面墙上**：两面板墙的砖/背板都在 `x` 或 `z` 的 `[-h, -h+1]` 这一格里
 *    （`h = halfExtent(fold)`）。甲板从 `-h+1` 往外排 —— 两者正好不重叠。
 * 2. **墙上**：`u`（沿墙那一格）与 `row`（高度）各自取整。
 * 3. **甲板上**：`(x, z)` 取整；层取 `round(y - 砖心偏移)` —— 于是**点方块的顶面会得到上一层**，
 *    那正是编辑器里"往上叠一块"的手势（顶面在 `level + 1`，而砖心在 `level + 0.5`，
 *    `round` 把它们分到相邻两格）。
 */
export type PickPoint = readonly [number, number, number];

export function cellFromPoint(level: Level, p: PickPoint): Cell | null {
  const h = halfExtent(level.fold);
  const [x, y, z] = p;
  // 墙上：砖心在 `-h + BRICK_N`（`cellAnchor` 的偏移），背板在更里面一点。
  //
  // ⚠ **边界要向外让一点**（`+ EPS`）：砖的**正面**（朝房间那一侧）正好落在 `-h + CUBE` 上，
  // 而射线打在正面时 `point.x` 恰好等于它 —— 判据写成"严格小于"就会把那一下判成**甲板**，
  // 于是在墙上擦不掉砖（用户："橡皮对大多数物品擦除都不成功"：正面正是最常点到的那一面，
  // 顶面才偶尔点到）。这不是浮点抖动的边角情形，是**最常见的一条路径**。
  //
  // 让出去的这一丁点与"甲板最靠墙那一列"重合 —— 那一列的两面本来就在同一个平面上，
  // 几何上分不开，取墙那一侧（甲板那边还能点顶面）。
  const wallReach = -h + CUBE + 1e-3;

  if (x < wallReach) return wallCell(level, 'A', h, y, z);
  if (z < wallReach) return wallCell(level, 'B', h, y, x);
  return deckCellAtPoint(level, x, y, z);
}

/**
 * 墙 A：沿墙那一格走 `z`；墙 B：走 `x`（`toWorld` 的约定，见 `fold.ts`）。
 *
 * ## 折痕那一对是**真的重合**，这里只能二选一
 *
 * `A:(fold-1)` 与 `B:fold` 落在世界**同一个点**上（`halfExtent` 的注释里写着为什么）——
 * 所以点那个角时**几何上分不出**用户想改哪一面。这里**固定给 A**（确定性优先），
 * 而"改到另一面"交给编辑器面板显示当前格身份、由用户自己核对。
 * 这不是妥协，是模型本身的性质：那两格在空间里就是一处。
 */
function wallCell(level: Level, face: 'A' | 'B', h: number, y: number, along: number): Cell | null {
  const row = Math.floor(y);
  if (row < 0 || row >= level.rows) return null;
  const u = Math.floor(along + h);
  const col = face === 'A' ? level.fold - 1 - u : level.fold + u;
  if (col < 0 || col >= level.cols) return null;
  return { face, col, row };
}

/** 甲板：`(x, z)` 取整、层取 `round(y - 砖心)`（点顶面 = 上一层）。 */
export function deckCellAtPoint(_level: Level, x: number, y: number, z: number): Cell {
  const col = Math.round(x - DECK_SHIFT);
  const row = Math.round(z - DECK_SHIFT);
  const level = Math.round(y - (DECK_TOP_Y - CUBE / 2));
  return level <= 0 ? { face: 'I', col, row } : { face: 'I', col, row, level };
}

/** 墙 A 的深度（`-h + BRICK_N`）—— 只给测试与调用方当"贴合面"的参考。 */
export function wallPlaneOffset(fold: number): number {
  return -halfExtent(fold) + BRICK_N;
}
