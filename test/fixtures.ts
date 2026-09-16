import type { Cell } from '../src/core/types';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';

/**
 * 共享关卡夹具。`graph.test.ts`（T2）与 `movement.test.ts`（T3）断言的是**同一批关卡**的
 * 两个面 —— 图上的邻接、和走上去会怎样。夹具只留一份，否则改了关卡两边期望会悄悄漂。
 *
 * 都是**手工可验的小图**，不是那份 v10 mock 关卡：
 * mock 是外观数据（它连 validator 规则⑦都不满足），拿它当断言依据等于把错的期望
 * 写进回归 —— 那不是测试，那是把 bug 固化成契约。每个夹具只测一件事，形状一眼能看出对错。
 */

export const cellA = (col: number, row: number): Cell => ({ face: 'A', col, row });
export const cellB = (col: number, row: number): Cell => ({ face: 'B', col, row });

export function load(def: LevelDef): Level {
  const result = parseLevel(def);
  if (!result.ok) throw new Error(`夹具应当是合法关卡，实际报错：${JSON.stringify(result.errors)}`);
  return result.level;
}

/**
 * UPPER：一关里同时出现 断路 / 绕行 / 跨折痕 / 爬梯 / 走空坠落。
 *
 * ```
 *   col:  0 1 2 3        A 面 = col 0,1   B 面 = col 2,3
 *   r3:   H . . H        ← 顶层平台的地板面。col0/col3 是梯口
 *   r2:   H X X H        ← 顶层平台（col1,col2 实心）；col0/col3 是梯
 *   r1:   H . X H        ← 底层走廊；**col2 是墙**，把两面在底层隔开
 *   r0:   X X X X        ← 地板
 * ```
 *
 * - 底层 `r1` 被 col2 的墙劈成 {A:0,A:1} 与 {B:3} 两坨 —— 这就是 **断路**。
 * - 从 A 底层到 B 底层，唯一的路是：爬 col0 的梯上 `r3` → 横穿顶层 →
 *   经 `r3` 的**折痕边**（A col1 ↔ B col2）→ 下 col3 的梯 —— 这就是 **绕行**。
 * - `r3` 的折痕边就是全场唯一的 A↔B 通道 —— 删掉 seam 边两种边集就各自封闭。
 * - 梯只接梯（col0 三段、col3 两段），且没有跳跃：站在砖面上按"上"动不了。
 */
export const UPPER: LevelDef = {
  id: 'UPPER',
  name: '断路-绕行-跨折痕',
  fold: 2,
  tiles: ['XXXX', 'H.XH', 'HXXH', 'H..H'],
};

/**
 * JETTY：横杆跨过缺口接上两块平台，且横杆本身**穿过折痕**。
 *
 * ```
 *   col:  0 1 2 3
 *   r2:   . - - .        ← col1(A) 与 col2(B) 都是横杆 → 折痕两侧在此相接
 *   r1:   X . . X        ← 两块平台的砖；col1/col2 下方悬空
 *   r0:   . . . .        ← 没有地板
 * ```
 *
 * 玩家在 `r2`：col0 / col3 站在砖面顶上，col1 / col2 是**吊在杆下**。
 * col1→col2 那一跳在摊平图里看着是"相邻列"，折起来之后其实是**跨过折痕**。
 * 杆下方悬空 → 能吊（规则⑦），所以"按↓松手"会一路掉出墙体（→ 水）。
 */
export const JETTY: LevelDef = {
  id: 'JETTY',
  name: '杆接续-跨折痕杆',
  fold: 2,
  tiles: ['....', 'X..X', '.--.'],
};

/**
 * DROP：平台比地板高两格、中间是空的 —— "坠落**不在**静态图里"这条边界的夹具。
 *
 * ```
 *   col:  0 1 2 3
 *   r3:   . . . .        ← B 面平台面（col2,col3 可站）
 *   r2:   . . X X        ← B 面平台
 *   r1:   . . . .        ← 地板面（四面都可站）
 *   r0:   X X X X        ← 地板
 * ```
 *
 * 从 `B:2,3` 直落两格就能到 `B:2,1` —— 但那是**坠落**，不是静态邻接。T2 的图不含坠落边，
 * 所以这里高台与地板是两个连通块；而 T3 的 `step` 走出边缘时会真的掉下去落到 `A:1,1`
 * （向左那一跳同时跨了折痕）。两张断言合起来正好把"图"与"运动"的分工钉死。
 */
export const DROP: LevelDef = {
  id: 'DROP',
  name: '坠落边界',
  fold: 2,
  tiles: ['XXXX', '....', '..XX', '....'],
};

/**
 * BARSTUB：横杆尽头之外就是空中 —— "吊着不能凭空横移出去"的夹具。
 *
 * ```
 *   col:  0 1 2 3
 *   r2:   . - . .        ← col1 是横杆；col2/col3 悬空（停不住）
 *   r1:   X . . .        ← 只有 col0 有砖 → 只有 col0 顶上站得住
 *   r0:   . . . .        ← 没有地板
 * ```
 *
 * 节点只有两格：`A:0,2`（站在砖面上）与 `A:1,2`（吊在杆下）。
 * 从杆再往右是空中 —— 该按"↓"松手，而不是横着飘过去。
 */
export const BARSTUB: LevelDef = {
  id: 'BARSTUB',
  name: '杆尽头',
  fold: 2,
  tiles: ['....', 'X...', '.-..'],
};

/**
 * BAROVER：**连杆正下方是实心砖** —— validator 规则⑦明确禁止的关卡。
 *
 * ```
 *   col:  0 1 2 3
 *   r2:   . - . .        ← 横杆
 *   r1:   X X . .        ← col1 的砖正好垫在横杆底下 → 吊不住
 *   r0:   . . . .
 * ```
 *
 * 这里刻意保留它，用来钉住一条分工：**运动层只管"这一步能不能走"，不替 validator 判关卡好坏**。
 * 所以进杆（`hang`）是允许的，只有"按↓松手"被判非法（下方是砖，无处可落）。
 * 关卡本身该被 T8 的 validate 拦下 —— 不是在这里静默修掉。
 */
export const BAROVER: LevelDef = {
  id: 'BAROVER',
  name: '杆压砖（规则⑦反例）',
  fold: 2,
  tiles: ['....', 'XX..', '.-..'],
};

/**
 * CLIFF：平台边缘之外整列都是空的，一路到网格底部 —— 落水途径①（坠落）的夹具。
 *
 * ```
 *   col:  0 1 2 3
 *   r3:   . . . .        ← 站在 r2 平台顶上
 *   r2:   X X . .        ← 平台只有 col0/col1；col2/col3 往下全是空
 *   r1:   . . . .
 *   r0:   . . . .        ← 连地板都没有 → 掉出去就是水面
 * ```
 *
 * 从 `A:1,3` 往右一步：目标格停不住 → 沿 col2 下坠 → 一路无支撑 → 掉出墙体 → 水。
 */
export const CLIFF: LevelDef = {
  id: 'CLIFF',
  name: '坠落入水',
  fold: 2,
  tiles: ['....', '....', 'XX..', '....'],
};

/**
 * PIT：**挖得穿、但掉不进虚空**的地板 —— T11「挖→坠→入坑→回填」的夹具。
 *
 * ```
 *   col:  0 1 2 3
 *   r2:   . . . .        ← 玩家站在这一层
 *   r1:   X X X X        ← 可挖地板（挖的就是这一行）
 *   r0:   = = = =        ← 硬砖垫底：挖不动，但接得住人
 * ```
 *
 * 关键在于 **`r1` 是可挖砖、`r0` 是硬的**：少了 `r0` 这层，挖穿 `r1` 之后
 * 目标格下面就是墙体之外 —— 掉进去等于落水（`CLIFF` 就是那种），
 * 那就测不出"坑"这个东西，因为坑根本不存在，只有一个通向水面的洞。
 *
 * 从 `A:1,2` 往左挖 → `A:0,1` 变空；再往左一步 `A:0,2` 失去支撑 → 坠进 `A:0,1`。
 * 人于是**站在自己挖的坑里** —— 这正是"活埋"能被触发的前提。
 */
export const PIT: LevelDef = {
  id: 'PIT',
  name: '可挖地板-坑',
  fold: 2,
  tiles: ['====', 'XXXX', '....'],
};
