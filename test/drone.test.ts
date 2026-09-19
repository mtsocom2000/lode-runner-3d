import { describe, expect, it } from 'vitest';
import { decideDrone } from '../src/core/ai/drone';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { stateAt, type MoveState } from '../src/core/rules/movement';
import { buildGraph } from '../src/core/world/graph';
import { parseLevel, withGrid, type Level, type LevelDef } from '../src/core/world/tiles';
import { cellA, cellB } from './fixtures';
import type { Cell } from '../src/core/types';

/**
 * T12-b：巡逻无人机 = **巡逻段 + 追击段**（用户裁定的"两段式"，= 原版守卫）。
 *
 * 决策模块是纯函数（吃 level + 它在哪 + 朝哪 + 玩家在哪），所以这里可以逐条摆出来测，
 * 不用起 sim —— `sim.decide` 那边只负责把"玩家在哪"喂进来。
 */

/** 走廊夹具：一条通行走廊，`r1`/`r3` 都能走。 */
const CORRIDOR: LevelDef = {
  id: 'CORRIDOR',
  name: '走廊（巡逻夹具）',
  fold: 2,
  tiles: ['XXXX', '....', 'XXXX', '....'],
};

/** 死胡同 + 梯：走廊尽头立一把梯 —— 用来测"转向时优先 90° 而不是掉头"。 */
const DEADEND_LADDER: LevelDef = {
  id: 'DEADEND',
  name: '死胡同带梯',
  fold: 2,
  tiles: ['XXXH', '...H', 'XXXH', '...H'],
};

/** 孤立格：左右是空（会坠落，不算"走得成"）、上下无梯 → 四个方向都不成立。 */
const LONELY: LevelDef = {
  id: 'LONELY',
  name: '孤立可站立格',
  fold: 2,
  tiles: ['X..X', '....', '....', '....'],
};

function load(def: LevelDef): Level {
  const parsed = parseLevel(def);
  if (!parsed.ok) throw new Error(`夹具必须合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

function standOn(level: Level, cell: Cell): MoveState {
  const at = stateAt(level, cell);
  if (at === null) throw new Error('夹具格必须站得住');
  return at;
}

describe('T12-b 巡逻段：沿 facing 直走，撞墙才转向', () => {
  const level = load(CORRIDOR);

  it('前面走得通 → 直走（不每 tick 重选，所以不会原地抖）', () => {
    const at = standOn(level, cellB(2, 1));
    expect(decideDrone({ level, at, facing: 'right', playerCell: null })).toBe('right');
  });

  it('走到尽头 → 转向（没有别的路时只能掉头）', () => {
    const at = standOn(level, cellB(3, 1));
    expect(decideDrone({ level, at, facing: 'right', playerCell: null })).toBe('left');
  });

  it('转向**尽量不掉头**：尽头旁边有梯就拐 90° 上去', () => {
    const dead = load(DEADEND_LADDER);
    const at = standOn(dead, cellB(3, 1));
    // 可选 up/down/left，先排掉反向 left → 剩下 up/down → 按 DIRS 固定顺序取 up
    expect(decideDrone({ level: dead, at, facing: 'right', playerCell: null })).toBe('up');
  });

  it('只剩一个方向时就走它（角落）', () => {
    const at = standOn(level, cellA(0, 1));
    expect(decideDrone({ level, at, facing: 'right', playerCell: null })).toBe('right');
  });

  it('四个方向都不成立 → **不动**，而不是硬挤一格', () => {
    const lonely = load(LONELY);
    const at = standOn(lonely, cellA(0, 1));
    expect(decideDrone({ level: lonely, at, facing: 'right', playerCell: null })).toBeNull();
  });
});

describe('T12-b 追击段：玩家在墙面内可达 → 走最短路径', () => {
  const level = load(CORRIDOR);

  it('玩家在左边 → 追（哪怕巡逻朝向是右）', () => {
    const at = standOn(level, cellB(2, 1));
    // 对照：同样的朝向、没有玩家 → 巡逻是 right
    expect(decideDrone({ level, at, facing: 'right', playerCell: null })).toBe('right');
    // 追击：玩家在 A:0,1（同一连通块）→ 第一步 left
    expect(decideDrone({ level, at, facing: 'right', playerCell: cellA(0, 1) })).toBe('left');
  });

  it('已经站在玩家那一格上 → 没有"第一步"可走，于是落回巡逻', () => {
    const cell = cellB(2, 1);
    const at = standOn(level, cell);
    // `findPath` 对"起点 = 终点"返回只含起点的一条路（长度 1）→ 没有第一步
    expect(decideDrone({ level, at, facing: 'right', playerCell: cell })).toBe('right');
  });
});

describe('T12-b 只在墙面内（用户裁定）：玩家上岛台就追不到', () => {
  const level = load(CONCEPT_MINIMAL);
  const at = standOn(level, cellA(4, 1));

  it('对照：玩家在墙面上同一连通块里 → 会追（第一步 left）', () => {
    expect(decideDrone({ level, at, facing: 'right', playerCell: cellA(3, 1) })).toBe('left');
  });

  it('玩家站在岛台上 → 追不到，回到巡逻（第一步 right）', () => {
    // 岛台格不在"墙面内"的图里（`decks: false` 连节点都没有），于是可达性自己给出了答案 ——
    // 不需要在 AI 里写一条"不许上甲板"的特例。
    const deckPlayer: Cell = { face: 'I', col: -3, row: -3 };
    expect(decideDrone({ level, at, facing: 'right', playerCell: deckPlayer })).toBe('right');
  });

  it('图的开关本身：`decks: false` 时甲板格根本不是节点（默认照旧是）', () => {
    const deckCell: Cell = { face: 'I', col: -3, row: -3 };
    expect(buildGraph(level, { decks: false }).has(deckCell)).toBe(false);
    expect(buildGraph(level).has(deckCell)).toBe(true);
  });
});

/**
 * T12-e：**挖坑反制**。用户试玩原话：
 *
 * > 机器人会像玩家角色移动，但是如果玩家角色在面前挖了一个坑之后，机器人似乎检测到了这个坑，
 * > 就不会沿着会掉进坑里的路线移动了，这样的话挖坑就失去了意义
 *
 * 这是一个真 bug，而且是"判据用错了地方"：追击拿**当前地形**建图，坑那一格不是节点，
 * 于是 `findPath` 精确地绕开它。原版守卫是照着**记忆里的地形**走的 —— 它不会躲洞，它会掉进去
 * （归档原型的注释：`AI is "blind" to pits; classic dumb guards`）。
 * 修法就是 `plannedGrid`：规划时把坑（`'pit'`）当成还是砖。
 */
describe('T12-e：追击按"地形还完整"规划 → 守卫会走进玩家挖的坑', () => {
  /**
   * `r0` 硬底 / `r1` 空 / `r2` 可挖砖（col 1 稍后会变成坑）/ `r3` 行走行。
   *
   * **`r1` 为什么必须是空的**：那正是这个夹具能分辨对错的地方。坑在 `r2`，若下面是实心，
   * "穿到下层"和"停在坑里"算出来是同一格（都落在 `r1`），测不出区别 —— 就像 `PIT` 夹具那样。
   * 多层楼（`r1` 是走廊）才逼出用户报的那个 bug：坑在 `r2`，穿下去会落到 `r1`。
   */
  const TIERED: LevelDef = {
    id: 'TIERED',
    name: '多层楼里的坑夹具',
    fold: 3,
    tiles: ['======', '......', 'XXXXXX', '......'],
  };
  const level = load(TIERED);
  /** 把 `A:1,2` 变成**坑**（`'pit'`）= "玩家刚把它挖开"。下标 = row*cols + col = 2*6+1。 */
  const withPit = withGrid(
    level,
    level.grid.map((kind, i) => (i === 2 * (TIERED.fold * 2) + 1 ? ('pit' as const) : kind)),
  );

  it('没有坑时：正常追击（第一步 left）—— 对照组，免得这条修法顺手改了别的东西', () => {
    const at = standOn(level, cellA(2, 3));
    expect(decideDrone({ level, at, facing: 'right', playerCell: cellA(0, 3) })).toBe('left');
  });

  it('有坑时**照样**朝坑走（守卫对坑是瞎的）—— 玩家挖的坑这才成为陷阱', () => {
    const at = standOn(withPit, cellA(2, 3));
    // 拿当前地形规划的话，`A:1,3`（坑口那格）不是节点 → 只能绕/放弃 → 那是修之前的 bug。
    expect(decideDrone({ level: withPit, at, facing: 'right', playerCell: cellA(0, 3) })).toBe('left');
  });
});
