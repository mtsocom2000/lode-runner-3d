import { describe, expect, it } from 'vitest';
import { tick, createSim } from '../src/core/sim';
import { validateLevel } from '../src/core/level/validate';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';
import { cellA, cellB } from './fixtures';
import type { ObjectParent } from '../src/render/meshSync';
import { createSyncer } from '../src/render/meshSync';

/**
 * T12-a：**实体化管道**（关卡数据 → 实体 → 渲染）。
 *
 * 这一片刻意**不含 AI** —— 无人机的巡逻段/追击段是 T12-b。先把它建出来、摆上线、能被探针认出来，
 * 是因为后面三片（入坑固定 / 踩头顶 / 溺水延时重生）全都挂在"它是个实体"这件事上。
 *
 * 与 `sim.test.ts` 的分工：那边测玩家与戳记，这里测**实体的公共契约**（id / home / facing）。
 */
const DEF: LevelDef = {
  id: 'ENEMY',
  name: '敌人夹具',
  fold: 2,
  // 4 行（偶数，满足 rowsEven）：r1 与 r3 是行走行，敌人摆在 r1。
  tiles: ['XXXX', '....', 'XXXX', '....'],
  enemies: [
    { kind: 'drone', cell: cellB(3, 1) }, // 缺省朝向 → right
    { kind: 'drone', cell: cellB(2, 1), facing: 'left' },
  ],
};
const SPAWN = cellA(0, 1);

describe('T12-a：敌人在初态里就是实体', () => {
  it('id 从 1 起（玩家固定 0）、kind 正确、`home` 就是声明的那一格', () => {
    const state = createSim(DEF, SPAWN);
    expect(state.entities.map((e) => e.id)).toEqual([0, 1, 2]);
    expect(state.entities.map((e) => e.kind)).toEqual(['player', 'drone', 'drone']);
    expect(state.entities[1]?.cell).toEqual(cellB(3, 1));
    expect(state.entities[2]?.cell).toEqual(cellB(2, 1));
    // 重生点：玩家的是出生点，敌人的是各自的出生格（§八-2 延时重生要用它）
    expect(state.entities[0]?.home).toEqual(SPAWN);
    expect(state.entities[1]?.home).toEqual(cellB(3, 1));
    expect(state.entities[2]?.home).toEqual(cellB(2, 1));
  });

  it('朝向：声明里有就按声明，没有就 `right`', () => {
    const state = createSim(DEF, SPAWN);
    expect(state.entities.map((e) => e.facing)).toEqual(['right', 'right', 'left']);
  });

  it('出生格停不住（墙里 / 越界）→ 建初态就报错，不静默造一个会立刻坠落的实体', () => {
    const bad: LevelDef = { ...DEF, enemies: [{ kind: 'drone', cell: cellA(0, 0) }] }; // 砖块内部
    expect(() => createSim(bad, SPAWN)).toThrow(/敌人/);
    const outside: LevelDef = { ...DEF, enemies: [{ kind: 'drone', cell: cellA(99, 99) }] };
    expect(() => createSim(outside, SPAWN)).toThrow(/敌人/);
  });

  it('没有 `enemies` 的关卡照旧：玩家一个实体，行为一字不变', () => {
    const plain: LevelDef = { ...DEF, enemies: undefined };
    expect(createSim(plain, SPAWN).entities).toHaveLength(1);
  });

  it('朝向只在**移动成立**时更新：撞墙（出界 / 砖）不改朝向', () => {
    const start = createSim(DEF, SPAWN);
    // 出生点在 col 0：往左是网格外 → blocked，朝向必须还是 right
    const blocked = tick(start, { move: 'left', dig: null }).state;
    expect(blocked.entities[0]?.facing).toBe('right');
    // 往右走得成 → 朝向更新
    const moved = tick(start, { move: 'right', dig: null }).state;
    expect(moved.entities[0]?.cell).toEqual(cellA(1, 1));
    expect(moved.entities[0]?.facing).toBe('right');
  });

  it('地形不因敌人而变（敌人不是地形）：关卡解析结果与不带敌人时逐字相同', () => {
    const withEnemies = parseLevel(DEF);
    const without = parseLevel({ ...DEF, enemies: undefined });
    if (!withEnemies.ok || !without.ok) throw new Error('夹具必须合法');
    expect(withEnemies.level.grid).toEqual(without.level.grid);
    expect(withEnemies.level.deck).toEqual(without.level.deck);
  });
});

describe('T12-a：关卡校验把"敌人摆错"列出来（不是等运行时抛）', () => {
  it('敌人出生格站不住 → 报 enemyStandable，并**指名**是哪一个', () => {
    const bad: LevelDef = { ...DEF, enemies: [{ kind: 'drone', cell: cellA(0, 0) }] };
    const hits = validateLevel(bad, SPAWN).filter((i) => i.rule === 'enemyStandable');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.detail).toContain('#0');
    expect(hits[0]?.detail).toContain('drone');
  });

  it('摆得对就不报 —— 否则这条规则会退化成噪声', () => {
    expect(validateLevel(DEF, SPAWN).some((i) => i.rule === 'enemyStandable')).toBe(false);
  });
});

describe('T12-a：渲染层按 kind 画，并如实报数（探针据此核对）', () => {
  const parent: ObjectParent = { add: (): void => {}, remove: (): void => {} };
  const parsed = parseLevel(DEF);
  if (!parsed.ok) throw new Error('夹具必须合法');

  it('`counts()` 报出每个种类真正画了几个 —— 含无人机', () => {
    const syncer = createSyncer(parent, parsed.level);
    syncer.update(createSim(DEF, SPAWN), 0.016);
    expect(syncer.counts()).toEqual({ player: 1, drone: 2 });
    syncer.dispose();
  });
});
