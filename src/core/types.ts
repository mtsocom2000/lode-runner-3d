/**
 * core 层的公共类型。
 *
 * 铁律：这个目录**只允许纯 TypeScript** —— 不引 three、不碰 DOM。
 * 理由见架构文档 §三：core 必须能在纯 Node 里无头跑，否则写不了回归测试；
 * 而本项目历次真正的 bug（白块、梯面朝向、BFS 漏格）全是靠无头测试抓出来的。
 * 这条线由 eslint 的 no-restricted-imports 强制，不靠自觉。
 */

/**
 * 折面世界的面。
 *
 * - `'A'` / `'B'`：关卡沿折痕折 90° 后的两片**竖直**墙（左半在 A，右半在 B）。
 * - `'I'`：**水平甲板**（岛台）。它不来自摊平网格 —— 网格只贴在那两片墙上。
 *
 * ## `'I'` 的坐标语义与 A/B **不同**（这是整个文件最该被记住的一条）
 *
 * 对 A/B：`col` = 面内列（贴折痕为 0，由 `fold.ts` 的 `toFold` 换算），`row` = **高度**。
 * 对 `'I'`：`col` = **世界 x**，`row` = **世界 z**，两者都是水平坐标，高度固定。
 *
 * 也就是说 `col/row` 对面 `'I'` 是"两个水平轴"，不是"沿墙 + 高度"。
 * 这么复用是为了**不动 `cellKey` / `parseCell`**：它们的形状
 * （`${face}:${col},${row}`、`/^([A-Z]):(-?\d+),(-?\d+)$/`）本来就装得下 `I:5,3`。
 *
 * **代价与纪律**：每个碰到 `face` 的函数都要先问一句"这个判断对面 `'I'` 成立吗"。
 * `fold.ts` 开头正是在警告"三套坐标，别混" —— 这里是**第四套**，别让它扩散。
 * 好在 `isConsistentCell` 会对面 `'I'` 返回 false（`faceOf` 只产出 A/B），
 * 所以折面相关逻辑不会把甲板格误当成墙面格。
 */
export type Face = 'A' | 'B' | 'I';

export const FACES = ['A', 'B', 'I'] as const satisfies readonly Face[];

/** 折面坐标：面 + 列 + 行。（面 `'I'` 时 col/row 是 x/z，见 `Face` 的注释。） */
export interface Cell {
  readonly face: Face;
  readonly col: number;
  readonly row: number;
}

export function isFace(v: string | undefined): v is Face {
  return v === 'A' || v === 'B' || v === 'I';
}

/**
 * Cell → 字符串键。用于 Map / Set（`Cell` 是对象，不能直接当键用）。
 * 往返必须无损 —— 这是 T1「折叠映射」的地基。
 */
export function cellKey(c: Cell): string {
  return `${c.face}:${c.col},${c.row}`;
}

/** 非法键一律返回 null，不抛异常（调用方自己决定怎么处理脏数据）。 */
export function parseCell(key: string): Cell | null {
  const m = /^([A-Z]):(-?\d+),(-?\d+)$/.exec(key);
  if (!m) return null;
  const face = m[1];
  const col = m[2];
  const row = m[3];
  if (!isFace(face) || col === undefined || row === undefined) return null;
  return { face, col: Number(col), row: Number(row) };
}
