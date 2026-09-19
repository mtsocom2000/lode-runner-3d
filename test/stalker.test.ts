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

describe('T15：速度 —— 计划里的验收是"≤ 90%"', () => {
  it('常量关系：攀爬者比无人机快得多，但仍慢于玩家', () => {
    expect(STALKER_MOVE_TICKS).toBeLessThan(DRONE_MOVE_TICKS);
    expect(STALKER_MOVE_TICKS).toBeGreaterThanOrEqual(MOVE_TICKS);
    // ≤90%：一格要 ≥ 8/0.9 ≈ 8.89 tick。
    expect(STALKER_MOVE_TICKS).toBeGreaterThanOrEqual(Math.ceil(MOVE_TICKS / 0.9));
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

  it('攀爬者：同一条输入 → 朝接头走（`right`），因为它的**图里有甲板节点**', () => {
    const input = { level, at: stand(onWallNearJoint), facing: 'left' as const, playerCell: onIsland };
    expect(decideStalker(input)).toBe('right'); // 追击：第一步就上小道
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
