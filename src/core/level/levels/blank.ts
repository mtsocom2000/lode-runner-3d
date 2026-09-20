import type { Cell } from '../../types';
import type { LevelDef } from '../../world/tiles';

/**
 * **空白关卡**（T21 编辑器）：两面板墙 + 水面，别的什么都没有。
 *
 * 这就是用户在编辑器里看到的起点 —— "只有左右侧面墙和水面，其他都是空白，允许我自由设计"。
 *
 * 它**故意不合法**（没有出口、出生点脚下没有砖），所以：
 *
 * - **不能**直接拿它开一局（`createSim` 会因为出生点站不住而抛）；
 * - 编辑器**必须能加载不合法的草稿** —— 编辑过程中它必然一直是"还不合法"的，
 *   而 `validateLevel` 的结果是给人看的**清单**，不是拒绝加载的门槛。
 *
 * 这条区别是编辑器的第一原则：**校验是提示，不是闸门**。
 */
export const BLANK: LevelDef = {
  id: 'BLANK',
  name: '空白',
  fold: 14,
  /** 12 行 × 28 列（每面 14 列）—— 与 L1/L2/L3 同规格，全空。 */
  tiles: Array.from({ length: 12 }, () => '.'.repeat(28)),
  spawn: { face: 'A', col: 0, row: 1 },
};

/** 空白关卡的出生格（编辑器新建时的默认位置）。 */
export const BLANK_SPAWN: Cell = BLANK.spawn ?? { face: 'A', col: 0, row: 1 };
