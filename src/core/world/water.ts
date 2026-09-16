import type { FallEnd } from '../rules/movement';

/**
 * 水面（T9）。
 *
 * ## 水为什么不是一种瓦片
 *
 * 原版 Lode Runner 没有水。这一版的水是**折面带来的新东西**：两片墙围起来的中间那块空地。
 * 关键在于它**不在关卡网格里** —— 网格只有那两片墙，而墙是竖起来的。
 *
 * 所以"某一格是不是水"这个问题，在本模型里只有一个诚实的答案：
 * **不是网格里的任何一格。** 水是"坠落掉出了墙体"这件事的**结果**（见 `FallEnd`）。
 *
 * 硬把它塞成一排瓦片（比如在 row −1 加一行水）会立刻引出三个假问题：
 * 那一行算不算可站立格？能不能被挖（T11）？玩家站在最底行时脚下是什么（`supportOf` 要不要认它）？
 * —— 这些都不需要回答，因为水本来就不该是"可以站的地方"。
 *
 * ## 这条定义有三处消费者
 *
 * - `rules/drown.ts` —— 判定一次坠落是不是落水，那是扣命的入口
 * - `ai.drone`（T12）—— 被打掉的无人机往哪掉，它也得知道"下面是不是水"
 * - `render/scene.ts` —— 水面那一片平面画在什么高度
 *
 * ## 唯一的"高度"约束
 *
 * 网格是抽象的（`row` 只是行号），而水得画在某个 y 上。那个 y 属于**渲染**，
 * 但它必须落在"掉出墙体"的那一段里 —— 否则会出现"规则说淹死了、画面上人还在水面上飞"。
 *
 * 所以这里给的是**规则侧的约束，不是那个值**：
 *
 * - 墙体底边 = 网格 y `0`（`row 0` 那块砖的下表面）
 * - `row 0` 的砖占网格 y `[0, 1]`，所以 `row 1` 的行走面（玩家的脚）在网格 y `1`
 * - 于是水面必须在 **`(0, 1)`** 这个开区间里：高于墙体底边（不然水还在墙里），
 *   低于行 1 的行走面（不然人站在最底行走行就泡在水里了）
 *
 * `WATER_LEVEL_RANGE` 把这条写成可断言的东西 —— `test/water.test.ts` 拿它去卡
 * `render/metrics.ts` 的 `WATER_Y`。**两个数字各写一遍必然会漂，这是本仓库历次 bug 的形状**：
 * 与其写一句"记得对齐"的注释，不如让错的那天有个测试红。
 */

/**
 * 水面允许落在的网格高度区间（开区间，单位 = 一格）。
 * 由砖块几何推出，不是拍的 —— 推导见上面。
 */
export const WATER_LEVEL_RANGE = { min: 0, max: 1 } as const;

/** 这个网格高度能不能放水面。渲染侧的水面 y 必须让它为 true。 */
export function isWaterLevel(y: number): boolean {
  return y > WATER_LEVEL_RANGE.min && y < WATER_LEVEL_RANGE.max;
}

/** 落水那一支的 `FallEnd`。给 `isWater` 当类型谓词用。 */
export type WaterFall = Extract<FallEnd, { readonly kind: 'water' }>;

/**
 * 一次坠落的终点是不是水。
 *
 * `FallEnd` 本来就只有 `landed` / `water` 两支，所以这个函数看着像废话 —— 它存在的理由是
 * **给"水"一个名字**：`end.kind === 'water'` 这句话将来会分散在 sim（扣命）、drone（T12）、
 * 特效（T20）里，散着写的代价是"改了水面的定义却漏掉一处"。收敛成一个函数，改的时候
 * 编译器和测试会替你找齐。
 *
 * 返回**类型谓词**而不是 `boolean`，这一点是必需的而不是修饰：调用方（`sim.advance` 的坠落分支）
 * 要靠它把 `result.end` 收窄成落水那一支，才敢读 `from` / 才敢断定另一支有 `cell`。
 * 返回 `boolean` 的话，那里就只能写 `(result.end as WaterFall).from` —— 而 `as` 在本仓库是禁的
 * （见架构红线）。**能让编译器算出来的事，不要用断言糊过去。**
 */
export function isWater(end: FallEnd): end is WaterFall {
  return end.kind === 'water';
}

/**
 * 这条列上、这个行号以下有没有水 —— 也就是"从这一格继续往下掉会不会淹死"。
 *
 * 现在只有一种可能：`row < 0`，即掉到墙体底边以下。
 * T10 加岛台之后这里会长出第二种（岛台之外的空隙），那时改这一处。
 *
 * 之所以现在就写成函数而不是内联 `row < 0`：T12 的无人机、
 * T20 的落水特效都要问同一个问题，而这个问题将来会变复杂。
 */
export function waterBelow(row: number): boolean {
  return row < 0;
}
