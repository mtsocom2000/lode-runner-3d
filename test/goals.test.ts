import type { Cell } from '../src/core/types';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { createSim, NO_INTENTS, tick, viewOf, type SimState } from '../src/core/sim';
import { takeWallTreasure, wallTreasureAt } from '../src/core/rules/goals';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';

/**
 * T13 的**通关链**：采宝 → 开闸 → 触达出口过关。
 *
 * ## 为什么用 `createSim` 指定出生点，而不是手写一条走位脚本
 *
 * "从出生点走到岛台再走到出口"那条路是**关卡内容**（走小道、跨甲板接头），
 * 它的可达性已经由 `validateLevel` 的 `exitGated` 与 `conceptMinimal.test` 钉住了 ——
 * 在这里再手画一遍路线，测的是"我这次算的步数对不对"，而不是规则。
 *
 * 所以这三条分别把规则的三段钉死：站上出口**不**过关（未集齐）、踩到宝**开闸**、
 * 开闸后站上出口**过关**。`createSim` 只要求出生点站得住，而"出口站得住但**走不到**"
 * 正是 T13 物理门的设计 —— 它恰好让我们能直接构造出"未集齐就站在出口上"这个边界。
 */
const EXIT: Cell = { face: 'A', col: 4, row: 5 };
const TREASURE: Cell = { face: 'I', col: -3, row: -3 };

/** 把关卡里的两个闸门格换掉没有。闸门是 `hard`，开闸后应当是 `ladder`。 */
function gateKinds(state: SimState): readonly (string | undefined)[] {
  const level = viewOf(state);
  return [level.at(3, 5), level.at(5, 5)];
}

/** 把玩家挪到另一格（只用于构造边界状态；规则本身不管传送）。 */
function withPlayerAt(state: SimState, cell: Cell): SimState {
  return {
    ...state,
    entities: state.entities.map((e) => (e.kind === 'player' ? { ...e, cell } : e)),
  };
}

describe('T13：通关链（采宝 → 开闸 → 出口）', () => {
  it('没集齐宝物时，站在出口上**不算过关**（物理门的 sim 侧断言）', () => {
    const start = createSim(CONCEPT_MINIMAL, EXIT);
    expect(start.treasures.length).toBe(1);
    expect(start.gatesOpen).toBe(false);

    const frame = tick(start, NO_INTENTS);
    expect(frame.events.some((e) => e.kind === 'won')).toBe(false);
    expect(frame.state.status).toBe('playing');
  });

  it('踩到宝物那一个 tick：collected + opened，闸门格从硬砖变梯子', () => {
    const start = createSim(CONCEPT_MINIMAL, TREASURE);
    expect(gateKinds(start)).toEqual(['hard', 'hard']);

    const frame = tick(start, NO_INTENTS);
    const kinds = frame.events.map((e) => e.kind);
    expect(kinds).toContain('collected');
    expect(kinds).toContain('opened');

    // 宝物从 state 里消失，闸门开了，而且**开了之后不再重复报 opened**。
    expect(frame.state.treasures).toEqual([]);
    expect(frame.state.gatesOpen).toBe(true);
    expect(gateKinds(frame.state)).toEqual(['ladder', 'ladder']);

    const again = tick(frame.state, NO_INTENTS);
    expect(again.events.map((e) => e.kind)).not.toContain('opened');
  });

  it('开闸后站上出口：won，且 status 变 won 之后实体冻住、时钟继续走', () => {
    const opened = tick(createSim(CONCEPT_MINIMAL, TREASURE), NO_INTENTS).state;
    expect(opened.gatesOpen).toBe(true);

    const onExit = withPlayerAt(opened, EXIT);
    const frame = tick(onExit, NO_INTENTS);
    expect(frame.events.map((e) => e.kind)).toContain('won');
    expect(frame.state.status).toBe('won');

    // 终局之后：事件为空、实体不动，但 tick 照走（时钟是回放与限时判定的基准）。
    const after = tick(frame.state, NO_INTENTS);
    expect(after.events).toEqual([]);
    expect(after.state.tick).toBe(frame.state.tick + 1);
    expect(after.state.entities).toEqual(frame.state.entities);
  });

  it('没有宝物的关卡：出口**一开始就是开的**，而且不报 `opened`（T21 修的模型矛盾）', () => {
    // 这条原来断言的是"空集不该被当成集齐 → 不开闸"。方向对了一半：空集确实不该被当成
    // "刚刚集齐"（所以**没有 `opened` 事件**），但**门该是开的** —— 没有可集的宝物，就没有
    // "集齐"这回事。原来的写法让"没有宝物的关卡"永远开不了闸门 → 走到出口也不过关，
    // 而校验（`exitGated`）却早把这类关卡当成"不设门"跳过了。两边不一致，错的是 sim 这边。
    const noTreasure = { ...CONCEPT_MINIMAL, treasures: [] };
    const start = createSim(noTreasure, EXIT);
    expect(start.gatesOpen).toBe(true);
    const frame = tick(start, NO_INTENTS);
    expect(frame.events.map((e) => e.kind)).not.toContain('opened');
    expect(viewOf(frame.state).at(EXIT.col, EXIT.row)).toBe('exit');
  });
});

/**
 * **墙上的宝物**（字形 `G`）—— 用户 2026-09-21 的追问："宝物无法放置在砖块上。"
 *
 * 原版 Lode Runner 的金子就撒在砖面上，所以这两类**等价**：都要取、都算进"集齐才开闸门"。
 * 第一版只把甲板那套接进通关逻辑，墙上的 `G` 只画出来、没接 —— 于是"宝物"那支笔在墙上
 * 点了毫无反应。
 */
describe('T13：墙上宝物（`G` 字形）也是宝物', () => {
  /** 4 列（`fold=2`）：`r1` 的 col 1 放一片金子，出口在 col 2，闸门在 col 3。 */
  const CHIP: LevelDef = {
    id: 'CHIP',
    name: '墙上的宝物',
    fold: 2,
    tiles: ['XXXX', '.G.E', '....'],
    spawn: { face: 'A', col: 0, row: 1 },
    // 闸门声明在 col 3（B 面）—— 只是为了有个闸门可开，几何不重要。
    gates: [{ face: 'B', col: 3, row: 1 }],
  };

  it('`wallTreasureAt` 认字形，且**守面**（甲板格一律不算）', () => {
    const parsed = parseLevel(CHIP);
    if (!parsed.ok) throw new Error('夹具必须合法');
    const level = parsed.level;
    expect(wallTreasureAt(level, { face: 'A', col: 1, row: 1 })).toEqual({ face: 'A', col: 1, row: 1 });
    expect(wallTreasureAt(level, { face: 'A', col: 0, row: 1 })).toBeNull(); // 空
    expect(wallTreasureAt(level, { face: 'I', col: 1, row: 1 })).toBeNull(); // 甲板格：两套坐标系，不许混比
  });

  it('`takeWallTreasure` 把那一格变空，且**不改原数组**', () => {
    const parsed = parseLevel(CHIP);
    if (!parsed.ok) throw new Error('夹具必须合法');
    const grid = parsed.level.grid;
    const next = takeWallTreasure(grid, { face: 'A', col: 1, row: 1 }, 4);
    expect(next[1 * 4 + 1]).toBe('empty');
    expect(grid[1 * 4 + 1]).toBe('treasure'); // 原数组一字未动
  });

  it('走过去取到它：报 `collected`、那一格变空、**闸门随即开启**（它是最后一块）', () => {
    const start = createSim(CHIP, { face: 'A', col: 0, row: 1 });
    const frame = tick(start, { move: 'right', dig: null });
    expect(frame.events.map((e) => e.kind)).toContain('collected');
    expect(viewOf(frame.state).at(1, 1)).toBe('empty');
    expect(frame.state.gatesOpen).toBe(true);
    expect(frame.events.map((e) => e.kind)).toContain('opened');
  });
});
