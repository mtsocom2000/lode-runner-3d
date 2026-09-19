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
 * `STALKER_MOVE_TICKS = 9`（玩家的 88.9%，计划里的验收是"≤90%"）。
 * 无人机是 24 —— 两者的分工是：无人机"一直在来"，攀爬者"真追得上"。
 */
export const STALKER_STEP: StepOptions = { decks: true };

/**
 * 攀爬者本 tick 朝哪走。与无人机**同一个引擎**（`decideDrone`），只是换一份能力 ——
 * 于是"图能到的地方，脚也能走到"这条不变量对两种敌人同时成立（那份能力只写一次）。
 */
export function decideStalker(input: Omit<DroneInput, 'step'>): Dir | null {
  return decideDrone({ ...input, step: STALKER_STEP });
}
