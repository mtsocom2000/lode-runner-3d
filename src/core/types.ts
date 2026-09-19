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
 * - `'I'`：**水平甲板**（岛台 / 小道 / 塔）。它不来自摊平网格 —— 网格只贴在那两片墙上。
 *
 * ## `'I'` 的坐标语义与 A/B **不同**（这是整个文件最该被记住的一条）
 *
 * 对 A/B：`col` = 面内列（贴折痕为 0，由 `fold.ts` 的 `toFold` 换算），`row` = **高度**。
 * 对 `'I'`：`col` = **世界 x**，`row` = **世界 z**，`level` = **层**（见下）。
 *
 * 也就是说 `col/row` 对面 `'I'` 是"两个水平轴"，不是"沿墙 + 高度"。
 * 这么复用是为了**不动 `cellKey` / `parseCell` 的形状**（`${face}:${col},${row}`）。
 *
 * **代价与纪律**：每个碰到 `face` 的函数都要先问一句"这个判断对面 `'I'` 成立吗"。
 * `fold.ts` 开头正是在警告"三套坐标，别混" —— 这里是**第四套**，别让它扩散。
 * 好在 `isConsistentCell` 会对面 `'I'` 返回 false（`faceOf` 只产出 A/B），
 * 所以折面相关逻辑不会把甲板格误当成墙面格。
 *
 * ## `level`（2026-09-19 加）：甲板的**层**
 *
 * 甲板原先是一张**没有厚度**的平板（高度是常数 `DECK_TOP_Y`），于是"塔"这种东西表达不出来。
 * `level` 给它一维：同一 `(x, z)` 上可以叠很多层，`0` = 原来的那一层（水面上的岛台/小道）。
 *
 * - **只有面 `'I'` 用得到它**；A/B 的高度就是 `row`，`level` 恒为 `undefined`。
 * - `cellKey` 会把它编进去（`I:5,3@1`），所以"同一格的上下两层"是**两个不同的节点** ——
 *   图、可达性、`SimState` 都不用为"塔"写特例。
 * - 上下层之间怎么走：**`Z`/`X` 两个键**（世界上下，唯一含义），见 `rules/movement.ts`。
 */
export type Face = 'A' | 'B' | 'I';

export const FACES = ['A', 'B', 'I'] as const satisfies readonly Face[];

/**
 * 折面坐标：面 + 列 + 行（面 `'I'` 时 col/row 是 x/z、另有 `level`，见 `Face` 的注释）。
 * `level` 省略 = `0`（水面上的那一层）—— 于是所有既有关卡数据一字不改。
 */
export interface Cell {
  readonly face: Face;
  readonly col: number;
  readonly row: number;
  /** 甲板的层（只有面 `'I'` 有意义）。省略 = 0。 */
  readonly level?: number;
}

export function isFace(v: string | undefined): v is Face {
  return v === 'A' || v === 'B' || v === 'I';
}

/** `Cell.level` 的读取口：省略即 0，免得每个调用点都写 `?? 0`。 */
export function levelOf(c: Cell): number {
  return c.level ?? 0;
}

/**
 * 站立面的**类型**：墙（竖直）还是甲板（水平）。
 *
 * 存在的理由只有一个：**键位含义按它分**。墙面是竖直的，屏幕上只有 ←→↑↓ 四个方向（没有斜向）；
 * 甲板是水平的，四个方向在屏幕上正好是四个斜向。于是"键该做什么"必须问一句"我在哪种面上"。
 *
 * 用户 2026-09-19 的裁定：`w`/`s` **在墙面上不做任何事** —— 墙上的上下是**爬梯**，
 * 而爬梯归 `Z`/`X`（世界上下）。所以墙体上 `WASD` 只剩 `a`/`d` 沿墙左右。
 *
 * 这是"我在哪种面上"的**唯一出处**：输入层（`app/input.ts`）与方向提示（`render/hints.ts`）
 * 都从这里取，别各自写一遍 `face === 'I'`。
 */
export type Surface = 'wall' | 'deck';

export function surfaceOf(c: Cell): Surface {
  return c.face === 'I' ? 'deck' : 'wall';
}

/**
 * Cell → 字符串键。用于 Map / Set（`Cell` 是对象，不能直接当键用）。
 * 往返必须无损 —— 这是 T1「折叠映射」的地基。
 *
 * 面 `'I'` 会把层编进去（`I:5,3@1`）；A/B 不加后缀（它们没有层，且旧键必须原样有效）。
 */
export function cellKey(c: Cell): string {
  const base = `${c.face}:${c.col},${c.row}`;
  if (c.face !== 'I') return base;
  // 层 0 省略不写 —— 与 `parseCell` 同一条约定（旧键逐字节不变）。
  const level = c.level ?? 0;
  return level === 0 ? base : `${base}@${level}`;
}

/** 非法键一律返回 null，不抛异常（调用方自己决定怎么处理脏数据）。 */
export function parseCell(key: string): Cell | null {
  const m = /^([A-Z]):(-?\d+),(-?\d+)(?:@(-?\d+))?$/.exec(key);
  if (!m) return null;
  const face = m[1];
  const col = m[2];
  const row = m[3];
  const level = m[4];
  if (!isFace(face) || col === undefined || row === undefined) return null;
  // `@` 后缀只对面 `'I'` 有意义 —— A/B 带层是脏数据，宁可返回 null。
  if (level !== undefined && face !== 'I') return null;
  // `level = 0` **省略不写**：于是 `cellKey → parseCell` 对旧键（A/B、以及层 0 的 I）往返后
  // 与加层之前**逐字节相同** —— `Cell.level` 的默认值语义靠这条保持一致。
  return level === undefined || Number(level) === 0
    ? { face, col: Number(col), row: Number(row) }
    : { face, col: Number(col), row: Number(row), level: Number(level) };
}
