import { describe, expect, it } from 'vitest';
import { decideDrone, DRONE_STEP } from '../src/core/ai/drone';
import { decideStalker, STALKER_STEP } from '../src/core/ai/stalker';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { stateAt } from '../src/core/rules/movement';
import {
  DRONE_MOVE_TICKS,
  MOVE_TICKS,
  STALKER_MOVE_TICKS,
  createSim,
  replay,
  tick,
  wait,
  type SimState,
} from '../src/core/sim';
import type { Cell } from '../src/core/types';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';
import { cellA } from './fixtures';

/**
 * **T15：潜伏攀爬者**。
 *
 * 与巡逻无人机共用同一套两段式引擎（`ai/drone.ts`），**唯一的差别是能力**：
 * `STALKER_STEP = { decks: true }` —— 也就是"**可爬崖**"在本作里的意思：**它能上岛台**。
 *
 * 这条差别不是装饰：无人机被用户裁定"只在墙面内"，于是岛台/小道是玩家的**安全区**；
 * 攀爬者把这个安全区取消掉，L2 引入它就是为了这个（设计文档 A.4："高威胁度来源"）。
 */
const parsed = parseLevel(CONCEPT_MINIMAL);
if (!parsed.ok) throw new Error('概念关卡必须合法');
const level = parsed.level;

function stand(cell: Cell) {
  const at = stateAt(level, cell);
  if (at === null) throw new Error(`夹具格 ${JSON.stringify(cell)} 停不住`);
  return at;
}

describe('T15：速度 —— 快过无人机，但仍然**明显慢于玩家**', () => {
  it('常量关系：比无人机快，比玩家慢得多（用户："原本的机器人速度也是慢于玩家的"）', () => {
    expect(STALKER_MOVE_TICKS).toBeLessThan(DRONE_MOVE_TICKS);
    expect(STALKER_MOVE_TICKS).toBeGreaterThanOrEqual(MOVE_TICKS);
    // 它的威胁在**能力**（能上岛台），不在速度 —— 所以这里钉"慢得下来"：
    // 一格至少花玩家两倍的时间。
    expect(STALKER_MOVE_TICKS).toBeGreaterThanOrEqual(MOVE_TICKS * 2);
  });

  it('跑起来也一样：同一次移动之后攀爬者的冷却 = STALKER_MOVE_TICKS-1', () => {
    const def: LevelDef = { ...CONCEPT_MINIMAL, enemies: [{ kind: 'stalker', cell: cellA(0, 1) }] };
    const state = createSim(def, { face: 'I', col: -3, row: -3 }); // 玩家放岛上（离得远，先看它自己走）
    const after = tick(state, { move: null, dig: null }).state;
    expect(after.entities[1]?.cooldown).toBe(STALKER_MOVE_TICKS - 1);
  });
});

describe('T15：可爬崖 —— 玩家躲到岛台上也追得上', () => {
  /** 攀爬者站在 A 面接头那一格，玩家在岛台正中。 */
  const onWallNearJoint: Cell = cellA(4, 1);
  const onIsland: Cell = { face: 'I', col: -3, row: -3 };

  it('无人机的对照：玩家在岛台上 → 它到不了 → 落回巡逻', () => {
    const input = { level, at: stand(onWallNearJoint), facing: 'left' as const, playerCell: onIsland };
    expect(decideDrone(input)).toBe('left'); // 巡逻：沿 facing 直走（左边是可走的墙格）
  });

  it('攀爬者：同一条输入 → 朝接头走（`down`），因为它的**图里有甲板节点**', () => {
    const input = { level, at: stand(onWallNearJoint), facing: 'left' as const, playerCell: onIsland };
    // 接头的方向 2026-09-19 从 `right` 改成 `down`：`right` 在那格是**走得通**的走廊走法，
    // 接头占着它就等于把走廊切断（用户实测到的那一步）。`down` 在那一格堵死（脚下是砖不是梯），
    // 所以它是"没别的路可走"时的那一步 —— 追击路径的第一步因此变成 `down`。
    expect(decideStalker(input)).toBe('down'); // 追击：第一步就上小道
  });

  it('两个方向确实不同（否则上面两条只是在测同一件事）', () => {
    const input = { level, at: stand(onWallNearJoint), facing: 'left' as const, playerCell: onIsland };
    expect(decideStalker(input)).not.toBe(decideDrone(input));
  });

  it('能力只写一份：`DRONE_STEP` / `STALKER_STEP` 就是那个差别本身', () => {
    expect(DRONE_STEP.decks).toBe(false);
    expect(STALKER_STEP.decks).toBe(true);
  });
});

describe('T15：剧本 —— 一路追到岛台（含跨折痕那一段）', () => {
  it('从 B 面远端出发，它会过折痕、上小道、最后站到玩家所在的岛台格上', () => {
    // 起手把攀爬者放在 B 面（与玩家不同面）→ 它必须**跨折痕**再走小道。
    const def: LevelDef = {
      ...CONCEPT_MINIMAL,
      enemies: [{ kind: 'stalker', cell: { face: 'B', col: 15, row: 5 } }],
    };
    let state: SimState = createSim(def, { face: 'I', col: -3, row: -3 });

    const seen = new Set<string>();
    for (let i = 0; i < 1200; i++) {
      state = tick(state, { move: null, dig: null }).state;
      const e = state.entities[1];
      if (e === undefined) break;
      if (e.cell.face === 'I') seen.add('deck'); // 上过甲板
      if (e.cell.face !== 'B') seen.add('left-B'); // 离开过 B 面（跨折痕）
      if (e.cell.face === 'I' && e.cell.col === -3 && e.cell.row === -3) {
        seen.add('island');
        break;
      }
    }
    expect(seen.has('left-B')).toBe(true); // 跨折痕
    expect(seen.has('deck')).toBe(true); // 上小道 / 岛台
    expect(state.entities[0]?.kind).toBe('player');
  });
});

describe('T15：坑反制对它同样有效（挖坑 → 受困 → 活埋）', () => {
  it('掉进坑里就动不了，土长回来时它还在里面 → 被埋 + 倒地', () => {
    // 与 T12-d 同一个夹具：走廊 + 可挖地板 + 硬底。
    const def: LevelDef = {
      id: 'STALK_PIT',
      name: '攀爬者落坑夹具',
      fold: 3,
      tiles: ['======', '......', 'XXXXXX', '......'],
      enemies: [{ kind: 'stalker', cell: cellA(2, 3) }],
    };
    const index = 2 * 6 + 1; // (row 2, col 1)
    const start = createSim(def, cellA(0, 3));
    // 直接把 `A:1,2` 挖成坑，并把攀爬者放进去（等价于玩家挖完、它掉进去了）。
    const trapped: SimState = {
      ...start,
      grid: start.grid.map((kind, i) => (i === index ? ('pit' as const) : kind)),
      fills: [{ index, remaining: 2 }],
      entities: start.entities.map((e) => (e.id === 1 ? { ...e, cell: cellA(1, 2) } : e)),
    };

    const frames = replay(trapped, wait(4));
    const events = frames.flatMap((f) => f.events).map((e) => e.kind);
    expect(events).toContain('buried');
    expect(events).toContain('downed');
    // 它不会自己走掉：全程停在那一格。
    for (const f of frames) expect(f.state.entities[1]?.cell).toEqual(cellA(1, 2));
  });
});
