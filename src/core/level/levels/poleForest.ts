import type { Cell } from '../../types';
import type { LevelDef } from '../../world/tiles';

/**
 * **L6「杆林」**（T22 名册）—— 每面 14 列 × 12 行，**没有甲板**。
 *
 * ## 性格：走道被**杆**切成一段一段，横杆成了主路
 *
 * 「横杆」（L2）只有两根杆，而且是在**落水缺口**上方；这一关把杆做成**常态地形**：
 * 偶数砖行被掏出好几个洞，洞正上方挂着（一比宽的）**杆桥** —— 走进去就吊上，横移过去再落回砖面。
 * 一片一片地挂在同一层不同高度上，像"杆的森林"。
 *
 * ## 图纸
 *
 * ```
 *   col:  0         1         2
 *         0123456789012345678901234567
 *   r11:  =E=H.......H....H.......H=E=   顶行：两个出口 + 四块闸门
 *   r10:  XXXHXXXXXXXHXXXXHXXXXXXXHXXX
 *   r9:   ...H.......H....H....--.HG..   走道 + 两格杆桥（col 21/22）
 *   r8:   XXXHXXXXXXXHXXXXHXXXX..XHXXX   砖，但 col 21/22 掏空（给上面的杆桥让位）
 *   r7:   ...H..--G..H....H.......H...   走道 + 两格杆桥（col 6/7）
 *   r6:   XXXHXX..XXXHXXXXHXXXXXXXHXXX   砖，col 6/7 掏空
 *   r5:   ...H.......H....H..---..H.G.   走道 + 三格杆桥（col 19/20/21）
 *   r4:   XXXHXXXXXXXHXXXXHXX...XXHXXX   砖，col 19/20/21 掏空
 *   r3:   ...H.G---..H....H.G.....H...   走道 + 三格杆桥（col 6/7/8）
 *   r2:   XXXHXX...XXHXXXXHXXXXXXXHXXX   砖，col 6/7/8 掏空
 *   r1:   .G.H.......H....H.......H...   底层走道（全铺，出生点在这一行）
 *   r0:   XXXXXXXXXXXXXXXXXXXXXXXXXXXX   实心地板（这一关不设落水）
 * ```
 *
 * ## 杆为什么"吊得住"（规则⑦）
 *
 * 每座杆桥**正下方那一格**（偶数行）是掏空的 —— 吊着的人占的是杆下面那一格，下方是砖就卡住了。
 * 校验的 `barHangable` 会盯着这条，改关卡的人填回砖就会当场报出来。
 *
 * ## 折痕
 *
 * 四处杆桥都在 `col 6..8 / 19..21 / 6..7 / 21..22`，**都避开了折痕那两列**
 * （`col 13 | 14` 是同一个点，杆在那里会变成两根穿过同一点的交叉 —— L2 第一版栽过）。
 * 折痕逐行核过：两侧一致。
 *
 * ## 宝物 6 颗
 *
 * 底层两颗（`r1` 两端）、`r3/r5/r7/r9` 各一颗，左右交错。四座杆桥把走道切开，
 * 于是有些宝物得**吊着杆**才拿得到。
 *
 * ## 看守 2 个（用户定的分配：第 4 关起 2 个）
 *
 * 一个**无人机**守底层、一个**攀爬者**在中层 —— 攀爬者**也会吊杆**，别在杆桥上磨蹭。
 */
export const POLE_FOREST: LevelDef = {
  id: 'POLE_FOREST',
  name: '杆林',
  fold: 14,
  tiles: [
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXX', // r0 实心地板
    '.G.H.......H....H.......H...', // r1 底层走道 + 一颗宝物（四部梯子）
    'XXXHXX...XXHXXXXHXXXXXXXHXXX', // r2 砖（col 6/7/8 掏空）
    '...H.G---..H....H.G.....H...', // r3 走道 + 三格杆桥 + 两颗宝物
    'XXXHXXXXXXXHXXXXHXX...XXHXXX', // r4 砖（col 19/20/21 掏空）
    '...H.......H....H..---..H.G.', // r5 走道 + 三格杆桥 + 一颗宝物
    'XXXHXX..XXXHXXXXHXXXXXXXHXXX', // r6 砖（col 6/7 掏空）
    '...H..--G..H....H.......H...', // r7 走道 + 两格杆桥 + 一颗宝物
    'XXXHXXXXXXXHXXXXHXXXX..XHXXX', // r8 砖（col 21/22 掏空）
    '...H.......H....H....--.HG..', // r9 走道 + 两格杆桥 + 一颗宝物
    'XXXHXXXXXXXHXXXXHXXXXXXXHXXX', // r10 顶层平台（出口脚下）
    '=E=H.......H....H.......H=E=', // r11 顶行：两个出口 + 四块闸门
  ],
  /** 出口两侧的硬砖 = 闸门（集齐 6 颗宝物后消失）。与前面几关同一份房规：`=E=`。 */
  gates: [
    { face: 'A', col: 0, row: 11 },
    { face: 'A', col: 2, row: 11 },
    { face: 'B', col: 25, row: 11 },
    { face: 'B', col: 27, row: 11 },
  ],
  /** 出生点：底层走道最西端（A 面 col 0，脚下 r0 是砖）。 */
  spawn: { face: 'A', col: 0, row: 1 },
  /** 第 6 关起 2 个看守：无人机守底层、攀爬者在中层（杆桥是它也会用的路）。 */
  enemies: [
    { kind: 'drone', cell: { face: 'A', col: 12, row: 1 } },
    { kind: 'stalker', cell: { face: 'B', col: 22, row: 5 } },
  ],
  hints: [
    '目标：取走 6 颗宝物 → 出口两侧的硬砖消失 → 走进出口过关。',
    '**杆**（`-`）：走进去会自动**吊住**，`A`/`D` 沿杆横移，按 `S` 松手掉下去。这一关的走道被**四座杆桥**切开，杆下面都是空的 —— 吊过去是这里的常规走法。',
    '四条竖梯（`col 3 / 11 / 16 / 24`）贯通上下，两面之间靠它们来回。',
    '追兵是无人机 + 攀爬者：**攀爬者也会吊杆**，杆桥上别停太久。',
  ],
};

/** 出生点（`LevelDef.spawn` 才是唯一出处；这个导出留给旧调用方）。 */
export const POLE_FOREST_SPAWN: Cell = { face: 'A', col: 0, row: 1 };
