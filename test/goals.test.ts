import type { Cell } from '../src/core/types';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { createSim, NO_INTENTS, tick, viewOf, type SimState } from '../src/core/sim';

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

  it('没有宝物的关卡不会"开局就自己开闸"（空集不该被当成集齐）', () => {
    // 这条是一个真踩过的洞：判据若写成"宝物列表空了没"，没有宝物的关卡会在第 1 tick
    // 就把闸门打开。`createSim` 需要一个站得住的出生点，随便挑一格就行。
    const noTreasure = { ...CONCEPT_MINIMAL, treasures: [] };
    const start = createSim(noTreasure, EXIT);
    const frame = tick(start, NO_INTENTS);
    expect(frame.state.gatesOpen).toBe(false);
    expect(frame.events.map((e) => e.kind)).not.toContain('opened');
  });
});
