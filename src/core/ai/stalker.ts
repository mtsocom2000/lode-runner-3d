import type { Dir, StepOptions } from '../rules/movement';
import { decideDrone, type DroneInput } from './drone';

/**
 * **潜伏攀爬者 The Stalker**（T15）。
 *
 * ## 它与巡逻无人机的差别只有一条：**能力**（`STALKER_STEP`）
 *
 * 两段式（巡逻 + 追击）、寻路、落坑受困、落水/被埋延时重生 —— 这些**全是同一套**，
 * 所以决策直接复用 `ai/drone.ts` 的引擎，这里只声明"它能去哪儿"。
 *
 * 「可爬崖」在本作里就是这句话：**它能上岛台**（`decks: true`）。无人机被用户裁定
 * "只在墙面内"，于是岛台/小道是玩家的安全区；攀爬者把这个安全区取消掉 —— 这正是
 * 设计文档 A.4 给它的定位（"可跨折痕追击 = 高威胁度来源"，L2 引入）。
 *
 * ## 速度
 *
 * `STALKER_MOVE_TICKS = 20`（玩家的 40%）—— 比无人机（24）快一点，但**一样追不上你**
 * （用户试玩："貌似你速度又改快了，我记得原本的机器人速度也是慢于玩家的"）。
 * 它真正的威胁不在速度，而在**能力**：下面那条 `STALKER_STEP`（能上岛台）。
 */
export const STALKER_STEP: StepOptions = { decks: true };

/**
 * 攀爬者本 tick 朝哪走。与无人机**同一个引擎**（`decideDrone`），只是换一份能力 ——
 * 于是"图能到的地方，脚也能走到"这条不变量对两种敌人同时成立（那份能力只写一次）。
 */
export function decideStalker(input: Omit<DroneInput, 'step'>): Dir | null {
  return decideDrone({ ...input, step: STALKER_STEP });
}
