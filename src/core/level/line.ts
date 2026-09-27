import { faceOf } from '../world/fold';
import type { Cell } from '../types';

/**
 * 两个格子之间的**直线经过的格子**（Bresenham）—— 拖笔补格用。
 *
 * ## 为什么需要它（用户 2026-09-23 报的实锤）
 *
 * 拖笔原来是"每个 `mousemove` 落一格"。鼠标快划一下，两次事件之间会**跳过好几格**，
 * 于是拖出来的线是虚线 —— 用户的原话："确实有快拖会跳格的问题。" 他那一整行 `====`
 * 因此一直是手敲进 JSON 的，而不是拖出来的：工具不好用，人就绕开工具。
 *
 * 补格只能按**直线**补（Bresenham），不能按"矩形范围"补：用户拖的是一条线，
 * 中间那些格子就是他要的；把包围盒整片刷满会毁掉旁边的东西。
 *
 * ## 面由列号推出来，不由参数给
 *
 * 拖过折痕时两端可能在**不同面**上（col 13 是 A、col 20 是 B）。所以每一格的 `face` 都用
 * `faceOf(col, fold)` 现算 —— 与 `world/fold.ts` 同一个判据，不让调用方再传一次"这段是哪个面"。
 *
 * 甲板（面 `'I'`）**不插值**：它的两个下标是 `(x, z)`，与墙的 `(col, row)` 不是一套坐标，
 * 按数值插值只会画出一串毫不相干的甲板格。只返回终点。
 */
export function lineCells(from: Cell, to: Cell, fold: number): readonly Cell[] {
  if (from.face === 'I' || to.face === 'I') return [to];

  const cells: Cell[] = [];
  let x = from.col;
  let y = from.row;
  const dx = Math.abs(to.col - x);
  const dy = -Math.abs(to.row - y);
  const sx = x < to.col ? 1 : -1;
  const sy = y < to.row ? 1 : -1;
  let err = dx + dy;

  for (;;) {
    cells.push({ face: faceOf(x, fold), col: x, row: y });
    if (x === to.col && y === to.row) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return cells;
}
