import type { Dir, MoveMode } from './movement';

/**
 * 落水途径（T9）。
 *
 * ## 机制在 `movement.ts` 里，这里只做**命名**
 *
 * 两条途径在 `step` 里早就是自然的产物了，不需要新代码：
 *
 * - **途径① 坠落至水面** —— 横向走向一个站不住的格（地板天然断裂处），
 *   `step` 返回 `fall`，`fallTo` 沿该列下坠，一路没有支撑 → 掉出墙体 → `water`。
 * - **途径② 杆上"下"跳** —— 吊在横杆上按 `down` 不是走路，是**松手**。
 *   `stepOnBar` 从杆的**下一格**起算坠落（因为杆本身不是落脚点），同样可能落到水。
 *
 * 所以本文件不重算任何东西，只回答"这次动作算哪条途径"。
 * 这么分的理由很实际：**两条途径在玩法上是不同的事件** ——
 * 途径①是"没看清地形"，途径②是"自己松的手"（T20 的落水涟漪与死亡反馈要分开做，
 * T13 的通关脚本也要能断言"我是从哪条路死的"）。混成一个布尔值，那种区分就再也拿不回来了。
 *
 * ## 为什么没有 `drownCheck(state, dir, result)` 这种组合入口
 *
 * 一开始写的就是那个形状，然后 `tsc` 报了 3 处错、全指向同一件事：**普通函数无法参与收窄**。
 * 调用方（`sim.advance` 的坠落分支）需要把 `result.end` 收窄成落水那一支才敢读 `from`、
 * 才敢断定另一支有 `cell`；而一个返回 `{ kind: 'drowned' | 'none' }` 的函数做不到这点，
 * 于是那里只能写 `(result.end as WaterFall).from` —— 而 `as` 在本仓库是禁的。
 *
 * 所以正确的形状是**两个能各自收窄、各自单测的原语**：
 *
 * - `world/water.ts` 的 `isWater(end): end is WaterFall` —— 回答"是不是水"，且**收窄类型**
 * - 本文件的 `drownPath(mode, dir)` —— 回答"算哪条途径"
 *
 * `sim` 里两行拼起来，全程无断言。**能让编译器算出来的事，不要用断言糊过去。**
 */

/** 两条落水途径。顺序与架构文档 §1.5-3 一致。 */
export type DrownPath =
  /** ① 横向走向站不住的格 → 沿列坠到墙体底边以下。 */
  | 'fall'
  /** ② 吊在横杆上按"下"松手 → 从杆下一格起坠，落点不是支撑 → 水。 */
  | 'bar-release';

export const DROWN_PATHS = ['fall', 'bar-release'] as const satisfies readonly DrownPath[];

/**
 * 这次动作算哪条途径。
 *
 * 只需要 `mode` 与 `dir`，因为"走空了"与"自己松的手"的区别**只在动作发生前的状态里**：
 * 同一份 `fall` + `water` 的结果，吊着按"下"是松手，站着横移是走空 ——
 * 光看 `StepResult` 永远分不出来。这就是它必须吃这两个参数、而不是只吃结果的原因。
 *
 * 调用前应当已经确认过"确实落水了"（`isWater(result.end)`）；本函数不重复判那件事，
 * 因为"判是不是水"归 `world/water.ts`，两处各判一遍就会漂。
 */
export function drownPath(mode: MoveMode, dir: Dir): DrownPath {
  return mode === 'hang' && dir === 'down' ? 'bar-release' : 'fall';
}
