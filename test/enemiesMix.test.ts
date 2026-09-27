import { describe, expect, it } from 'vitest';
import { createSim, replay, wait, type SimState } from '../src/core/sim';
import { validateLevel } from '../src/core/level/validate';
import { isConsistentCell } from '../src/core/world/fold';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';
import { cellKey, type Cell } from '../src/core/types';
import { cellA, cellB } from './fixtures';
import { L1 } from '../src/core/level/levels/l1';
import { L2 } from '../src/core/level/levels/l2';
import { L3 } from '../src/core/level/levels/l3';

/**
 * **T19：AI 混编回归** —— 无人机与攀爬者**同关**。
 *
 * 之前每个敌人各有一片回归（`drone.test.ts` / `stalker.test.ts` / `enemies.test.ts`），
 * 但**没有一条测试让两种同时在场上跑** —— 而"只在混在一起时才错"正是 AI 最典型的坏法：
 * 共用一份实体循环、共享"谁占了哪一格"、共享追捕与回家的时间表，任何一处按 `kind` 分叉写错，
 * 单兵测试都看得见、混编看不见。
 *
 * 这一片只钉**不变量**，不钉具体走位（那属于各自的专项测试）：跑几百 tick，逐帧断言
 *
 * 1. **确定性**：同一份输入序列跑两遍，结果**逐字节相同**（架构红线：sim 不许有隐藏状态）；
 * 2. **位置始终合法**：每一格都能被 `parseLevel` 的世界解释（墙面格在界内且面与列一致、
 *    甲板格在甲板上）；
 * 3. **无人机不上甲板**（它的设计就是"只在墙面内活动"，用户点名过）；
 * 4. **两种都在动**：各自都到过足够多的格子 —— 防止"混编时某一类悄悄定住"。
 */
const DEF: LevelDef = {
  id: 'MIX',
  name: '混编夹具',
  fold: 3,
  // 6 列 4 行、上下两条行走行，用左端一条**连续梯子**连通（否则下面那行到不了）。
  // 一墙宝物 + 一个出口：这张夹具**自己就是一张合法关卡**（AI 再坏也不该靠一张坏地图兜）。
  tiles: ['XXXXXX', 'H...GE', 'HXXXXX', 'H.....'],
  enemies: [
    { kind: 'drone', cell: cellB(4, 1) },
    { kind: 'stalker', cell: cellA(1, 1) },
  ],
};

const SPAWN = cellA(0, 1);

/** 一路往右走、偶尔挖 —— 让两个敌人都动起来，也让玩家自己走动（追捕才有意义）。 */
function script(ticks: number): readonly { move: 'left' | 'right' | null; dig: null }[] {
  return Array.from({ length: ticks }, (_, i) => ({
    move: i % 7 < 5 ? 'right' : 'left',
    dig: null,
  }));
}

/** 逐帧检查所有实体：位置能被世界解释；无人机不上甲板。 */
function checkInvariants(def: LevelDef, state: SimState, at: string): void {
  const parsed = parseLevel(def);
  if (!parsed.ok) throw new Error('夹具必须合法');
  const level = parsed.level;

  for (const entity of state.entities) {
    const c: Cell = entity.cell;
    if (c.face === 'I') {
      // 甲板格：`col/row` 是 (x, z)，不适用墙面那一套判据 —— 但要**真的是甲板**。
      const onDeck = level.deck.some((d) => d.x === c.col && d.z === c.row);
      expect(onDeck, `${at}：${entity.kind} 站在不存在的甲板格 ${cellKey(c)}`).toBe(true);
      expect(entity.kind, `${at}：${entity.kind} 上了甲板（无人机只在墙面活动）`).not.toBe('drone');
      continue;
    }
    expect(
      isConsistentCell(c, level.fold),
      `${at}：${entity.kind} 的面与列对不上（${cellKey(c)}）`,
    ).toBe(true);
    expect(c.row, `${at}：${entity.kind} 越界（${cellKey(c)}）`).toBeGreaterThanOrEqual(0);
    expect(c.row, `${at}：${entity.kind} 越界（${cellKey(c)}）`).toBeLessThan(level.rows);
  }
}

describe('T19：无人机 + 攀爬者同关（混编回归）', () => {
  it('夹具本身合法（混编不该靠一张坏关卡撑起来）', () => {
    expect(validateLevel(DEF, SPAWN)).toEqual([]);
    expect(DEF.enemies?.map((e) => e.kind)).toEqual(['drone', 'stalker']);
  });

  it('**确定性**：同一份输入跑两遍，逐帧状态完全相同', () => {
    const seq = script(240);
    const a = replay(createSim(DEF, SPAWN), seq).map((f) => f.state);
    const b = replay(createSim(DEF, SPAWN), seq).map((f) => f.state);
    expect(a).toEqual(b);
  });

  it('几百 tick 里每一帧都合法：位置可解释、无人机不上甲板', () => {
    const frames = replay(createSim(DEF, SPAWN), script(240));
    frames.forEach((frame, i) => checkInvariants(DEF, frame.state, `t${i}`));
    expect(frames).toHaveLength(240);
  });

  it('**两种都在动**：各自都到过足够多的格子（防"混编时某一类定住"）', () => {
    const frames = replay(createSim(DEF, SPAWN), script(300));
    const visited = new Map<string, Set<string>>();
    for (const frame of frames) {
      for (const e of frame.state.entities) {
        if (e.kind === 'player') continue;
        const set = visited.get(e.kind) ?? new Set<string>();
        set.add(cellKey(e.cell));
        visited.set(e.kind, set);
      }
    }
    // 只断言"**动过**"（到过 ≥ 2 格）：具体到过几格取决于巡逻/冷却的**手感参数**，
    // 钉死它等于把手感参数也钉死 —— 那属于各自的专项测试，不是这一片要管的。
    expect(visited.get('drone')?.size ?? 0).toBeGreaterThanOrEqual(2);
    expect(visited.get('stalker')?.size ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('静止输入（全程不动）下也不会崩、不会卡死：跑满 600 tick 且每一帧合法', () => {
    // 玩家不动时敌人照样巡逻/追捕 —— 这一条把"没有输入"这条路径也过一遍（与上面那条
    // 互补：那条是玩家在整个地图上跑）。
    const frames = replay(createSim(DEF, SPAWN), wait(600));
    frames.forEach((frame, i) => checkInvariants(DEF, frame.state, `still t${i}`));
    expect(frames[599]?.state.tick).toBe(600);
  });
});

describe('T19：**内置三关**也过同一套不变量（真内容、真甲板、真接头）', () => {
  /**
   * 混编夹具是**最小的**那张；内置关卡才是真东西：L1 有无人机 + 甲板 + 接头（所以
   * "无人机不上甲板"这条在 L1 上**真的有牙齿** —— 夹具里没有甲板，那条是空转的），
   * L2 / L3 各有一个攀爬者要在塔与长杆之间活动。
   *
   * 玩家全程不动（`wait`）：AI 照样巡逻/追捕/回家，而这条路径与"玩家满地图跑"是两条。
   */
  for (const [name, def] of [
    ['L1', L1],
    ['L2', L2],
    ['L3', L3],
  ] as const) {
    it(`${name}：300 tick 每一帧合法（无人机不上甲板、甲板格必须真的存在）`, () => {
      const spawn = def.spawn ?? cellA(0, 1);
      const frames = replay(createSim(def, spawn), wait(300));
      frames.forEach((frame, i) => checkInvariants(def, frame.state, `${name} t${i}`));
      expect(frames).toHaveLength(300);
    });
  }
});