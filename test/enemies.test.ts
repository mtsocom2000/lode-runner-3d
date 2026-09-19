import { describe, expect, it } from 'vitest';
import {
  tick,
  createSim,
  replay,
  wait,
  ENEMY_DOWN_TICKS,
  DRONE_MOVE_TICKS,
  MOVE_TICKS,
  RESPAWN_TICKS,
  type SimState,
} from '../src/core/sim';
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
    // 用**没有敌人**的夹具：朝向是玩家的属性，而夹具里的无人机会在同一个 tick 追过来
    // （接触即死把玩家送回出生点）—— 那会让这条断言变成在测别的东西。
    const plain: LevelDef = { ...DEF, enemies: undefined };
    const start = createSim(plain, SPAWN);
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

describe('T12-c：接触即死（原版守卫，用户裁定）', () => {
  /** 无人机就摆在玩家旁边一格 —— 一个 tick 内必撞上。 */
  const CONTACT: LevelDef = {
    id: 'CONTACT',
    name: '接触夹具',
    fold: 2,
    tiles: ['XXXX', '....', 'XXXX', '....'],
    enemies: [{ kind: 'drone', cell: cellA(1, 1) }],
  };

  it('无人机走到玩家那一格 → `caught` + 扣命 + 重生回出生点', () => {
    const frame = tick(createSim(CONTACT, cellA(0, 1)), { move: null, dig: null });
    // `returned` = 敌人被重置回家（同一条规则的另一半），见下一个用例
    expect(frame.events.map((e) => e.kind)).toEqual(['entered', 'caught', 'respawned', 'returned']);
    const caught = frame.events[1];
    expect(caught?.kind === 'caught' && caught.by).toBe(1); // 谁抓的
    expect(frame.state.lives).toBe(2);
    // 重生回**自己的** home（玩家就是出生点）
    expect(frame.state.entities[0]?.cell).toEqual(cellA(0, 1));
    expect(frame.state.entities[0]?.cooldown).toBe(RESPAWN_TICKS);
  });

  it('死亡时**追捕重置**：敌人回自己的家并冻结 —— 否则守在出生点就能连锁带走三条命', () => {
    let state = createSim(CONTACT, cellA(0, 1));
    state = tick(state, { move: null, dig: null }).state; // 第一次被抓
    expect(state.lives).toBe(2);

    // 关键：它**不再赖在玩家那一格上**，而是回了家（A:1,1）且带冻结。
    // （第一版想用"重生期间不判接触"挡住连锁，但那个窗口只覆盖重生那一 tick，实测无效。）
    expect(state.entities[1]?.cell).toEqual(cellA(1, 1));
    expect(state.entities[1]?.cooldown).toBe(RESPAWN_TICKS);

    // 冻结期内它走不动 → 不可能再撞上，命数不动
    for (let i = 0; i < RESPAWN_TICKS - 1; i++) {
      state = tick(state, { move: null, dig: null }).state;
    }
    expect(state.lives).toBe(2);
  });
});

describe('T12-d：敌人溺水/被埋 → **延时重生**（§八-2 裁定）', () => {
  /** 一条走廊：无人机在 `A:1,1`，它脚下 `r0` 是砖。`grid` 下标 = row*cols + col。 */
  const CORRIDOR: LevelDef = {
    id: 'DOWN',
    name: '倒地夹具',
    fold: 2,
    tiles: ['XXXX', '....', 'XXXX', '....'],
    enemies: [{ kind: 'drone', cell: cellA(1, 1) }],
  };
  const DRONE = 1;

  /** 把某一格改成空 —— 相当于**地形上本来就有个洞**（像 L1 `r0` 的落水缺口）。
   *
   * 注意它**不是**"玩家把砖挖掉"：挖掉会得到 `'pit'`（一格深的口袋），掉进去是受困而不是落水
   * （见 `world/tiles.ts`）。落水要的是**直通水面**的洞，所以这里写 `'empty'`。 */
  function hollow(base: ReturnType<typeof createSim>, index: number) {
    return { ...base, grid: base.grid.map((kind, i) => (i === index ? ('empty' as const) : kind)) };
  }

  it('溺水：脚下支撑没了 → 掉进水里 → `drowned` + `downed`，并且**留在原地**（不是立刻回家）', () => {
    const start = createSim(CORRIDOR, cellA(0, 1));
    const frame = tick(hollow(start, 0 * CORRIDOR.fold * 2 + 1), { move: null, dig: null });
    expect(frame.events.map((e) => e.kind)).toEqual(['drowned', 'downed']);
    const drone = frame.state.entities[DRONE];
    expect(drone?.down).toBe(ENEMY_DOWN_TICKS); // 原地倒下
    expect(drone?.cell).toEqual(cellA(1, 1)); // 还没回家
  });

  it('倒下满 `ENEMY_DOWN_TICKS` 之后回 `home`，事件是 `returned`（渲染层据此瞬移）', () => {
    const start = createSim(CORRIDOR, cellA(0, 1));
    const state = tick(hollow(start, 1), { move: null, dig: null }).state;
    expect(state.entities[DRONE]?.down).toBe(ENEMY_DOWN_TICKS);

    const frames = replay(state, wait(ENEMY_DOWN_TICKS));
    const home = frames[frames.length - 1]?.state.entities[DRONE];
    expect(home?.down).toBe(0);
    expect(home?.cell).toEqual(cellA(1, 1)); // 出生格 = 它的家
    expect(frames.some((f) => f.events.some((e) => e.kind === 'returned'))).toBe(true);
  });

  it('被埋：站在坑里、土落回来 → `buried` + `downed`（与溺水走同一条延时重生）', () => {
    const start = createSim(CORRIDOR, cellA(0, 1));
    // 直接造一个"马上要回填、而且无人机正站在里面"的坑 —— 挖/回填的机器另有测试。
    // 下标 = row * cols + col；无人机在 `A:1,1` → `1 * 4 + 1 = 5`。
    const withPit = { ...start, fills: [{ index: 1 * CORRIDOR.fold * 2 + 1, remaining: 1 }] };
    const frame = tick(withPit, { move: null, dig: null });
    // 顺序是回填那一步的：先报"谁被埋"，再报"这一格长回来了"；`downed` 在 ⑤ 结算里补上。
    expect(frame.events.map((e) => e.kind)).toEqual(['buried', 'filled', 'downed']);
    expect(frame.state.entities[DRONE]?.down).toBe(ENEMY_DOWN_TICKS);
  });

  it('倒下期间它不动、也不撞人（尸体是安全的）', () => {
    const start = createSim(CORRIDOR, cellA(0, 1));
    const downed = tick(hollow(start, 1), { move: null, dig: null }).state;
    // 把倒下的无人机挪到玩家那一格：仍然不该判被抓
    const stacked = {
      ...downed,
      entities: downed.entities.map((e) => (e.id === DRONE ? { ...e, cell: cellA(0, 1) } : e)),
    };
    const frame = tick(stacked, { move: null, dig: null });
    expect(frame.events.some((e) => e.kind === 'caught')).toBe(false);
    expect(frame.state.lives).toBe(3);
  });
});

describe('T12-c：落坑受困 + 踩其头顶的前提', () => {
  const PIT_DEF: LevelDef = {
    id: 'TRAP',
    name: '受困夹具',
    fold: 2,
    tiles: ['XXXX', '....', 'XXXX', '....'],
    enemies: [{ kind: 'drone', cell: cellA(1, 1) }],
  };
  const DRONE = 1;

  /**
   * 把某一格变成**坑**。两件事都要做，缺一就不是坑：
   * ① 瓦片 `'pit'`（地形：一格深的口袋，`supportOf` 靠它）；② `fills`（回填倒计时）。
   * 以前这里只写 `fills` —— 那时"是不是坑"只有一个出处（`fills`），现在地形形状归瓦片表。
   */
  function pitAt(base: ReturnType<typeof createSim>, index: number): SimState {
    return {
      ...base,
      grid: base.grid.map((kind, i) => (i === index ? ('pit' as const) : kind)),
      fills: [{ index, remaining: 120 }],
    };
  }

  it('站在坑里的无人机**动不了**（这是"落坑受困"，不是冷却）', () => {
    const start = createSim(PIT_DEF, cellA(0, 1));
    // `A:1,1` 变成坑（等着回填）：无人机就在那一格上
    const withPit = pitAt(start, PIT_DEF.fold * 2 * 1 + 1);
    const frames = replay(withPit, wait(20));
    for (const frame of frames) {
      expect(frame.state.entities[DRONE]?.cell).toEqual(cellA(1, 1));
      expect(frame.events.some((e) => e.kind === 'entered')).toBe(false);
    }
  });

  it('坑里的无人机碰到玩家**不算被抓**（"踩其头顶跨越"的前提）', () => {
    const start = createSim(PIT_DEF, cellA(0, 1));
    // 无人机与玩家同格、而且它在坑里
    const stacked = {
      ...pitAt(start, PIT_DEF.fold * 2 * 1 + 0),
      entities: start.entities.map((e) => (e.id === DRONE ? { ...e, cell: cellA(0, 1) } : e)),
    };
    const frame = tick(stacked, { move: null, dig: null });
    expect(frame.events.some((e) => e.kind === 'caught')).toBe(false);
    expect(frame.state.lives).toBe(3);
  });
});

describe('T12-e：挖坑反制（用户报的 bug）—— 守卫会**走进**玩家挖的坑，并且**停在坑里**', () => {
  /**
   * `r0` 硬底 / `r1` 空 / `r2` 可挖砖（col 1 稍后会变成坑）/ `r3` 行走行。
   *
   * `r1` 空是**关键**：用户报的 bug 正是"掉进坑里之后直接落到下层地板上"。
   * 若坑下面就是实心（像 `PIT` 夹具），两种语义算出来是同一格，这条 bug 根本测不出来。
   */
  const TIERED: LevelDef = {
    id: 'TIERED',
    name: '多层楼里的坑夹具',
    fold: 3,
    tiles: ['======', '......', 'XXXXXX', '......'],
    enemies: [{ kind: 'drone', cell: cellA(2, 3) }],
  };
  const DRONE = 1;

  /** 玩家把 `A:1,2` 挖开：**地形**多一个坑（`'pit'`）+ **回填**登记一条。两者都要，缺一就不是坑。 */
  function withPit(base: ReturnType<typeof createSim>): SimState {
    const index = 2 * (TIERED.fold * 2) + 1; // row * cols + col
    return {
      ...base,
      grid: base.grid.map((kind, i) => (i === index ? ('pit' as const) : kind)),
      fills: [{ index, remaining: 120 }],
    };
  }

  it('它**不再绕开**：下一步就走进坑', () => {
    const start = withPit(createSim(TIERED, cellA(0, 3)));
    const frame = tick(start, { move: null, dig: null });
    const drone = frame.state.entities[DRONE];
    expect(drone?.cell).toEqual(cellA(1, 2)); // 走进坑口那一格 → 开始坠落
    expect(frame.events.some((e) => e.kind === 'fell')).toBe(true);
  });

  it('落点在**坑里**（`A:1,2`），不是穿到下层地板（`A:1,1`）—— 用户报的那条', () => {
    // 同一条链再走一 tick：坠落结算完成，人停在坑里
    let state = withPit(createSim(TIERED, cellA(0, 3)));
    state = tick(state, { move: null, dig: null }).state; // 走进坑口 + 起坠
    state = tick(state, { move: null, dig: null }).state; // 落到坑里
    expect(state.entities[DRONE]?.cell).toEqual(cellA(1, 2));
  });

  it('掉进去之后就走不动了 —— 接上 T12-c 的"落坑受困"，回填会把它埋掉', () => {
    let state = withPit(createSim(TIERED, cellA(0, 3)));
    state = tick(state, { move: null, dig: null }).state;
    state = tick(state, { move: null, dig: null }).state;
    expect(state.entities[DRONE]?.cell).toEqual(cellA(1, 2));
    // 困在坑里：连走 20 tick 一步没动（不追人、也不自己爬出来）
    state = replay(state, wait(20))[19]?.state ?? state;
    expect(state.entities[DRONE]?.cell).toEqual(cellA(1, 2));
  });
});

describe('T12 手感：敌人比玩家慢（用户试玩反馈"机器人速度快了点"）', () => {
  const SPEED: LevelDef = {
    id: 'SPEED',
    name: '速度夹具',
    fold: 2,
    tiles: ['XXXX', '....', 'XXXX', '....'],
    enemies: [{ kind: 'drone', cell: cellB(3, 1) }], // 离玩家远一点，先看它自己走
  };

  it('同一次移动之后：玩家的冷却 = MOVE_TICKS-1，无人机的 = DRONE_MOVE_TICKS-1', () => {
    const start = createSim(SPEED, cellA(0, 1));
    // 玩家往右走一步
    const afterPlayer = tick(start, { move: 'right', dig: null }).state;
    expect(afterPlayer.entities[0]?.cooldown).toBe(MOVE_TICKS - 1);
    // 无人机自己走一步（追击 → 沿最短路径）
    const afterDrone = tick(start, { move: null, dig: null }).state;
    expect(afterDrone.entities[1]?.cooldown).toBe(DRONE_MOVE_TICKS - 1);
  });

  it('敌人确实更慢（否则这条手感结论只是注释）', () => {
    expect(DRONE_MOVE_TICKS).toBeGreaterThan(MOVE_TICKS);
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
