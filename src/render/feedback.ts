import type { SimEvent } from '../core/sim';

/**
 * 一条 sim 事件该在 HUD 上亮什么字 —— **纯函数**，`main.ts` 只负责把它贴到屏幕上。
 *
 * ## 为什么单独一个模块
 *
 * 这段映射原先写在 `main.ts` 的帧循环里，于是**没法测**（那里要起 WebGL）。
 * 它随即长出了本仓库最典型的一个 bug（用户 2026-09-19 报的）：
 * *"机器人被活埋，结果提示玩家命 −1"* —— 原因是它**只看事件种类，不看是谁**，
 * 而 `buried` / `drowned` 敌人也会发（T12-d 的"延时重生"）。把映射搬成纯函数之后，
 * 那条 bug 就变成了一行断言（见 `test/feedback.test.ts`）。
 *
 * ## 判据与谁同源
 *
 * "该不该扣命"的唯一出处是 `sim.ts` 的 ⑤ 结算（"victim 是玩家才扣命"）。
 * 这里问的是**同一个问题**（`event.entity` 是不是玩家），所以两边不可能漂。
 */
export interface Feedback {
  readonly text: string;
  /** 常驻（终局 / 过关）还是闪一下就收（死亡提示）。 */
  readonly sticky: boolean;
}

/**
 * 这条事件要不要亮字。`playerId` 是玩家实体的 id（`main.ts` 从 `state.entities` 里查）。
 *
 * 敌人那两条文案（`被 埋` / `落 水`）是有用的正反馈：玩家挖坑埋掉追兵时，屏幕上得说一声
 * "成了" —— 但**绝不能**说成自己掉命。
 */
export function feedbackFor(event: SimEvent, playerId: number | undefined): Feedback | null {
  // `entity` 的读取放在各自的分支里：不是每种事件都带它（`won` / `gameover` 就没有）。
  switch (event.kind) {
    case 'drowned':
      return event.entity === playerId
        ? { text: '落 水 ｜ 命数 −1', sticky: false }
        : { text: '追 兵 落 水 ｜ 它得回家重来', sticky: false };
    case 'buried':
      return event.entity === playerId
        ? { text: '被 活 埋 ｜ 命数 −1', sticky: false }
        : { text: '追 兵 被 埋 ｜ 困 住 它 了', sticky: false };
    case 'caught':
      // `caught` 的 `entity` 结构上就是玩家（`sim.ts` 里那条事件是从玩家身上发的）。
      return { text: '被 抓 住 ｜ 命数 −1', sticky: false };
    case 'gameover':
      return { text: 'GAME OVER —— 按 R 重开', sticky: true };
    case 'won':
      return { text: '★ 过 关 ！', sticky: true };
    default:
      return null;
  }
}
