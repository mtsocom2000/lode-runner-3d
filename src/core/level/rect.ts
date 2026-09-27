import { faceOf } from '../world/fold';
import type { Cell } from '../types';

/**
 * **矩形**范围内的格子（Shift+拖 = 整片铺）。
 *
 * ## 为什么与 `lineCells` 分成两个函数、而不是一个"模式"参数
 *
 * 两者的**端点语义**完全不同：直线是"从甲到乙一路刷过去"，矩形是"这两格圈起来的整片"。
 * 合成一个带 `mode` 的函数，调用方每次都要读一遍文档才知道传进去的两个点会被怎么解释 ——
 * 分成两个名字，函数名就把语义说完了。
 *
 * ## 面按列算（与 `lineCells` 同一条约定）
 *
 * 矩形可以横跨折痕（左侧 12..13 是 A、14..15 是 B），所以每一格的 `face` 都用
 * `faceOf(col, fold)` 现算，不让调用方再传一次"这段属于哪个面"。
 *
 * ## 甲板（另一套坐标）
 *
 * 两个端点**都在甲板面**（`'I'`）时按 `(x, z)` 铺一片；只要有一端不在，就只返回终点 ——
 * 与 `lineCells` 一样：跨两套坐标系的"矩形"没有意义，硬插值只会画出一堆不相干的格子。
 * 甲板格还要**同层**：跨层的矩形同样没有意义。
 */
export function rectCells(a: Cell, b: Cell, fold: number): readonly Cell[] {
  if (a.face === 'I' || b.face === 'I') {
    if (a.face !== 'I' || b.face !== 'I') return [b];
    if ((a.level ?? 0) !== (b.level ?? 0)) return [b];
    const level = a.level ?? 0;
    const cells: Cell[] = [];
    // **行（z）慢、列（x）快** —— 与 `validate.ts` 的 `cellsOf` 同一个顺序约定（行 ↑、列 ↑）。
    for (let z = Math.min(a.row, b.row); z <= Math.max(a.row, b.row); z++) {
      for (let x = Math.min(a.col, b.col); x <= Math.max(a.col, b.col); x++) {
        cells.push({ face: 'I', col: x, row: z, ...(level === 0 ? {} : { level }) });
      }
    }
    return cells;
  }

  // **行慢、列快**（同上）。顺序固定之后，"从矩形里取第几个"不会因为调用方不同而两样。
  const cells: Cell[] = [];
  for (let row = Math.min(a.row, b.row); row <= Math.max(a.row, b.row); row++) {
    for (let col = Math.min(a.col, b.col); col <= Math.max(a.col, b.col); col++) {
      cells.push({ face: faceOf(col, fold), col, row });
    }
  }
  return cells;
}
