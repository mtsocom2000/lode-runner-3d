import type { Cell } from '../../types';
import type { LevelDef } from '../../world/tiles';

/**
 * **L5「梯城」**（T22 名册）—— 每面 14 列 × 12 行，**没有甲板**。
 *
 * ## 性格：一整座城市由**六部梯子**撑起来
 *
 * 「走廊」是四条等高的竖梯，「横杆」把两条梯子砍成一高一低，「回字」「折线」换了形状。
 * 这一关回到**竖梯**，但把它做成主角：**六部梯子，高度各不相同** —— 两翼那些较矮的
 * （`col 7 / 11 / 20 / 24`）只到半途，只有 `col 3`（A）与 `col 16`（B）两部是**通天的塔**。
 * 于是"去哪一层、坐哪部梯子"是这一关唯一要想的事。
 *
 * ## 图纸
 *
 * ```
 *   col:  0         1         2
 *         0123456789012345678901234567
 *   r11:  =E=H............H........=E=   顶行：两个出口 + 四块闸门（两部通天梯到此）
 *   r10:  XXXHXXXXXXXXXXXXHXXXXXXXXXXX   全铺砖
 *   r9:   ...H............H.....G.....   走道（两翼；中间 13..15 是空的）
 *   r8:   XXXHXXXXXXXXX...HXXXXXXXXXXX   两翼砖（13..15 掏空 → r9 中间站不住）
 *   r7:   ...H.......H....H.G.....H...   走道（全铺）
 *   r6:   XXXHXXXXXXXHXXXXHXXXXXXXHXXX
 *   r5:   ...H...H.G.H....H...H...H...   走道（两翼）
 *   r4:   XXXHXXXHXXXHX...HXXXHXXXHXXX   两翼砖（13..15 掏空）
 *   r3:   ...H.G.H...H....H..GH...H...   走道（全铺）
 *   r2:   XXXHXXXHXXXHXXXXHXXXHXXXHXXX
 *   r1:   .G.H...H...H....H...H...H...   底层走道（全铺，出生点在这一行）
 *   r0:   XXXXXXXXXXXXXXXXXXXXXXXXXXXX   实心地板（这一关不设落水）
 * ```
 *
 * ## 折痕
 *
 * `col 13 | 14` 逐行核过（那两列在世界里是同一个点）：砖行两列都砖、走道行两列都站得住
 * （或都站不住 —— `r5/r9` 中间那几格两翼都掏空）、空行两列都空 —— **两侧一致**。
 *
 * ## 宝物 6 颗，逼你把六部梯子都用一遍
 *
 * `r1` 两颗（`col 1`、底层）、`r3/r5/r7/r9` 各一颗，左右两面交错摆开。要集齐就得
 * 在两面之间来回、上下好几层 —— 两翼较矮的梯子正好够到各自那一层的宝物。
 *
 * ## 看守 2 个（用户定的分配：第 4 关起 2 个）
 *
 * 一个**无人机**守着 A 面底层走道，一个**攀爬者**在 B 面高层走道 —— 一低一高。
 */
export const LADDER_CITY: LevelDef = {
  id: 'LADDER_CITY',
  name: '梯城',
  fold: 14,
  tiles: [
    'XXXXXXXXXXXXXXXXXXXXXXXXXXXX', // r0 实心地板
    '.G.H...H...H....H...H...H...', // r1 底层走道（六部梯子的脚）+ 一颗宝物
    'XXXHXXXHXXXHXXXXHXXXHXXXHXXX', // r2 全铺砖（六部梯子都活着）
    '...H.G.H...H....H..GH...H...', // r3 走道 + 两颗宝物
    'XXXHXXXHXXXHX...HXXXHXXXHXXX', // r4 两翼砖（13..15 掏空）
    '...H...H.G.H....H...H...H...', // r5 走道（两翼）+ 一颗宝物；col 7/20 的梯子到此为止
    'XXXHXXXXXXXHXXXXHXXXXXXXHXXX', // r6 全铺砖（col 11/24 的梯子到此为止）
    '...H.......H....H.G.....H...', // r7 走道 + 一颗宝物
    'XXXHXXXXXXXXX...HXXXXXXXXXXX', // r8 两翼砖（13..15 掏空）
    '...H............H.....G.....', // r9 走道（两翼）+ 一颗宝物
    'XXXHXXXXXXXXXXXXHXXXXXXXXXXX', // r10 顶层平台（出口脚下）
    '=E=H............H........=E=', // r11 顶行：两个出口 + 四块闸门
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
  /** 第 5 关起 2 个看守：无人机守低层、攀爬者在高层。 */
  enemies: [
    { kind: 'drone', cell: { face: 'A', col: 12, row: 1 } },
    { kind: 'stalker', cell: { face: 'B', col: 23, row: 9 } },
  ],
  hints: [
    '目标：取走 6 颗宝物 → 出口两侧的硬砖消失 → 走进出口过关。',
    '这一关有**六部梯子**，但高度各不相同：只有 `col 3`（A）与 `col 16`（B）两部通到顶，其余四部只到半途。',
    '走道在**两翼**上：`r5`/`r9` 的中段（`col 13..15`）是空的 —— 想从一面换到另一面，得先上下到全铺的那几层（`r1`/`r3`/`r7`/`r11`）。',
    '追兵两个（无人机 + 攀爬者），一低一高 —— 躲不开就挖坑。',
  ],
};

/** 出生点（`LevelDef.spawn` 才是唯一出处；这个导出留给旧调用方）。 */
export const LADDER_CITY_SPAWN: Cell = { face: 'A', col: 0, row: 1 };
