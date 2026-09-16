import type { Cell } from '../../types';
import type { LevelDef } from '../../world/tiles';

/**
 * **开发用关卡**：就是 `mocks/cube-fold-mock-v10.html` 里那张 14×10 关卡。
 *
 * 为什么它单独一个文件、而不是叫 L1：
 * - 它是**构图基准**（T5 的验收是"截图与 v10 mock 构图一致"），需要一份与 mock 逐字相同的数据。
 * - 它**不是**一个合格的关卡：`r7` 的横杆正下方 `r6 col7` 是实心砖 —— validator 规则⑦
 *   明令禁止（下方没空就吊不住人）。这正是 T8 该抓的东西，所以它天然不可能是最终 L1。
 * - 真正的 `L1 折角`（教学流向：跨折痕 → 挖坑困敌 → 出口）由 T14 设计。
 *
 * 数据字形：`X` 可挖砖 `=` 硬砖 `.` 空 `H` 梯 `-` 横杆 `G` 宝物 `E` 出口，
 * 行索引 0 = **最底行**。cols 0..6 = 墙 A，cols 7..13 = 墙 B，折痕在 6|7 之间。
 */
export const DEV_FOLD: LevelDef = {
  id: 'DEV_FOLD',
  name: '构图基准（v10 mock）',
  fold: 7,
  tiles: [
    'XX.X.XX.XXX.XX', // r0 地板：col4 是竖井口，直通水面
    '..............', // r1 走廊
    'XXXX.XX..XX.XX', // r2 主平台
    '.....H....XX..', // r3 梯 col5
    'XX.XX..XX.XX.X', // r4
    '.XX.HXXX..H.XX', // r5 梯 col4 / col10；col6-col7 在折痕处相接
    'XXX....XX..X.X', // r6
    '..XX.X--X.XX..', // r7 横杆 col6 / col7 穿过折痕 ← 规则⑦反例（见文件头）
    'XX.XX.X.XX.XX.', // r8
    '..X.G.X.EE.X.G', // r9 宝物 G / 出口 E
  ],
};

/**
 * 出生点：`r1` 西端走廊。选它的理由：正下方 `r0 col0` 是砖 → 站得住；
 * 且落在画面左下角，开局就能看清"人站在墙面上"这件事（T6 验收要看的正是这个）。
 */
export const PLAYER_SPAWN: Cell = { face: 'A', col: 0, row: 1 };
