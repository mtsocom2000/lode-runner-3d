import { describe, expect, it } from 'vitest';
import { feedbackFor } from '../src/render/feedback';
import type { SimEvent } from '../src/core/sim';
import { cellA } from './fixtures';

/**
 * 死亡 / 终局的 HUD 文案。这一小段是被一个真 bug 逼出来的（用户 2026-09-19）：
 * *"机器人被活埋，结果提示玩家命 −1"* —— 文案以前写在 `main.ts` 的帧循环里，
 * **只看事件种类、不看是谁**，而 `buried` / `drowned` 敌人也会发（T12-d）。
 *
 * `entity` 的约定：玩家恒为 `0`，敌人从 `1` 起（见 `sim.ts` 的 `spawnEnemies`）。
 */
const PLAYER = 0;
const DRONE = 1;

describe('HUD 死亡文案：必须看是**谁**（不然追兵被埋会报成玩家掉命）', () => {
  it('玩家被活埋 → 命数 −1', () => {
    const event: SimEvent = { kind: 'buried', entity: PLAYER, cell: cellA(1, 1) };
    expect(feedbackFor(event, PLAYER)).toEqual({ text: '被 活 埋 ｜ 命数 −1', sticky: false });
  });

  it('**追兵**被活埋 → 一个"命数"都不许出现，改成"困住它了"', () => {
    const event: SimEvent = { kind: 'buried', entity: DRONE, cell: cellA(1, 1) };
    const note = feedbackFor(event, PLAYER);
    expect(note).not.toBeNull();
    expect(note?.text).not.toContain('命数');
    expect(note?.text).toContain('追 兵');
  });

  it('追兵落水同理（它只是回 `home` 重来，玩家不掉命）', () => {
    const event: SimEvent = { kind: 'drowned', entity: DRONE, cell: cellA(1, 1), path: 'fall' };
    const note = feedbackFor(event, PLAYER);
    expect(note?.text).not.toContain('命数');
  });

  it('玩家落水仍然是"命数 −1"', () => {
    const event: SimEvent = { kind: 'drowned', entity: PLAYER, cell: cellA(1, 1), path: 'fall' };
    expect(feedbackFor(event, PLAYER)?.text).toContain('命数 −1');
  });

  it('被抓 / 终局 / 过关：终局与过关是**常驻**', () => {
    expect(feedbackFor({ kind: 'caught', entity: PLAYER, by: DRONE, cell: cellA(1, 1) }, PLAYER))
      .toEqual({ text: '被 抓 住 ｜ 命数 −1', sticky: false });
    expect(feedbackFor({ kind: 'gameover' }, PLAYER)?.sticky).toBe(true);
    expect(feedbackFor({ kind: 'won' }, PLAYER)?.sticky).toBe(true);
  });

  it('其余事件一律不亮字（移动、挖、采宝……）', () => {
    const moved: SimEvent = { kind: 'entered', entity: DRONE, from: cellA(1, 1), cell: cellA(2, 1) };
    expect(feedbackFor(moved, PLAYER)).toBeNull();
    expect(feedbackFor({ kind: 'returned', entity: DRONE, cell: cellA(1, 1) }, PLAYER)).toBeNull();
  });
});
