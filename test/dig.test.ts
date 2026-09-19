import { describe, expect, it } from 'vitest';
import { applyBackfill, applyDig, canDig, digTarget, PIT } from '../src/core/rules/dig';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { fallTo, step } from '../src/core/rules/movement';
import type { Cell } from '../src/core/types';
import { supportOf } from '../src/core/world/graph';
import { parseLevel, withGrid } from '../src/core/world/tiles';

/** 造一张小关卡。`tiles[0]` 是**最底行**。 */
function level(tiles: readonly string[], fold = 1) {
  const parsed = parseLevel({ id: 't', name: 't', fold, tiles });
  if (!parsed.ok) throw new Error(`夹具 parseLevel 失败：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

/** 可挖砖在下、脚在上的最小夹具：挖左右都能挖到 `X`。4 列 → fold 必须 4/2 = 2。 */
const diggable = level(['XXXX', '....'], 2);
const onTop: Cell = { face: 'A', col: 1, row: 1 };

/** 左边是硬砖 `=`、右边是可挖砖 `X`。 */
const mixed = level(['==XX', '....'], 2);
const onMixed: Cell = { face: 'A', col: 1, row: 1 };

describe('dig：挖的目标格', () => {
  it('挖的是**斜下方**那一格，不是脚下', () => {
    expect(digTarget(diggable, onTop, 'left')).toEqual({ face: 'A', col: 0, row: 0 });
    // col 2 已跨到折痕另一侧 → face 是 'B'。
    expect(digTarget(diggable, onTop, 'right')).toEqual({ face: 'B', col: 2, row: 0 });
  });

  it('上下不能挖 —— "挖"没有向上的版本', () => {
    expect(digTarget(diggable, onTop, 'up')).toBeNull();
    expect(digTarget(diggable, onTop, 'down')).toBeNull();
  });

  it('面的归属按目标列**重算**，不沿用当前格', () => {
    // fold=1 → col 0 属 A、col 1 属 B。玩家在 B 面向左挖，目标落在 A。
    const twoCol = level(['XX', '..']);
    const onB: Cell = { face: 'B', col: 1, row: 1 };
    expect(digTarget(twoCol, onB, 'left')).toEqual({ face: 'A', col: 0, row: 0 });
    // 沿用 `cell.face` 会给出 face:'B' —— 那是折痕另一侧的不存在的格。
  });

  it('越界返回 null：row 0 不能往下挖、最边列不能往外挖', () => {
    expect(digTarget(diggable, { face: 'A', col: 1, row: 0 }, 'left')).toBeNull(); // row -1
    expect(digTarget(diggable, { face: 'A', col: 0, row: 1 }, 'left')).toBeNull(); // col -1
    expect(digTarget(diggable, { face: 'B', col: 3, row: 1 }, 'right')).toBeNull(); // col 4
  });

  it('甲板（岛台 / 小道）上没有可挖的砖 —— 站上去按挖，什么都不发生', () => {
    // 甲板的 `(x, z)` 不是墙的 `(col, row)`（见 `core/world/deck.ts`）：不挡住的话，
    // 算出来的"目标格"在正坐标布局里就是墙上另一块砖 —— 挖岛台却把墙挖了个洞。
    const parsed = parseLevel(CONCEPT_MINIMAL);
    if (!parsed.ok) throw new Error('概念关卡必须合法');
    const onIsland: Cell = { face: 'I', col: -4, row: -4 };
    const onJetty: Cell = { face: 'I', col: -6, row: -4 };
    expect(digTarget(parsed.level, onIsland, 'left')).toBeNull();
    expect(digTarget(parsed.level, onIsland, 'right')).toBeNull();
    expect(canDig(parsed.level, onIsland, 'right')).toBe(false);
    expect(canDig(parsed.level, onJetty, 'left')).toBe(false);
  });

  it('**站在小道接口那一格**（那是墙面格）照常能挖 —— 挖不动的只有甲板本身', () => {
    const parsed = parseLevel(CONCEPT_MINIMAL);
    if (!parsed.ok) throw new Error('概念关卡必须合法');
    // 概念关卡的接头墙面端：`A:3,1`。它左右斜下方分别是 r0 的 col2（落水缺口，不是砖）
    // 与 col4（可挖砖）—— 正好把"能挖 / 不能挖"两条都钉住。
    const atJoint: Cell = { face: 'A', col: 3, row: 1 };
    expect(canDig(parsed.level, atJoint, 'left')).toBe(false); // 目标是落水缺口：没砖可挖
    expect(canDig(parsed.level, atJoint, 'right')).toBe(true); // 目标是可挖砖
  });
});

describe('dig：能不能挖', () => {
  it('可挖砖 → 能挖', () => {
    expect(canDig(diggable, onTop, 'left')).toBe(true);
    expect(canDig(diggable, onTop, 'right')).toBe(true);
  });

  it('**硬砖挖不动** —— 这条是"不能复用 isSolid"的钉子', () => {
    // `isSolid` 把 'dig' | 'hard' 都判成实心。若拿它当判据，硬砖会变成可挖。
    expect(canDig(mixed, onMixed, 'left')).toBe(false);
    expect(canDig(mixed, onMixed, 'right')).toBe(true); // 对照组：同一次调用里右边是可挖砖
  });

  it('空格挖不动（没有砖可挖）', () => {
    const empty = level(['..', '..']);
    expect(canDig(empty, { face: 'A', col: 1, row: 1 }, 'left')).toBe(false);
  });
});

describe('dig：挖开与回填', () => {
  it('挖开把砖变空、返回**新**网格，原网格不动', () => {
    const before = diggable.grid.slice();
    const result = applyDig(diggable, onTop, 'left');

    expect(result).not.toBeNull();
    expect(result!.index).toBe(0); // (col 0, row 0) → 0 * cols + 0
    expect(result!.grid[0]).toBe(PIT);
    expect(diggable.grid).toEqual(before); // 不可变：原数组一个字节都没改
    expect(result!.grid).not.toBe(diggable.grid);
  });

  it('挖不动时返回 null（不是抛异常）', () => {
    expect(applyDig(mixed, onMixed, 'left')).toBeNull(); // 硬砖
    expect(applyDig(diggable, onTop, 'up')).toBeNull(); // 方向不合法
  });

  it('回填把空还原成可挖砖，同样返回新数组', () => {
    const dug = applyDig(diggable, onTop, 'left');
    expect(dug).not.toBeNull();

    const filled = applyBackfill(dug!.grid, dug!.index);
    expect(filled[0]).toBe('dig');
    expect(dug!.grid[0]).toBe(PIT); // 原网格仍是挖开的状态
  });

  it('挖开 → 回填 走一圈回到最初', () => {
    const dug = applyDig(diggable, onTop, 'left')!;
    const filled = applyBackfill(dug.grid, dug.index);
    // 逐格相等即"回到最初"—— 原关卡在整段里一个字节都没被改过。
    expect(filled).toEqual(diggable.grid);
  });
});

describe('护绳：只保护「杆下」，**不**保护「梯子上方」', () => {
  // 三张图都是：r0/r1 两行砖，r2 放一个"上方物件"。玩家站 (1,2) 往左挖 (0,1)。
  const underBar = level(['XX', 'XX', '-.']);
  const underLadder = level(['XX', 'XX', 'H.']);
  const DIGGER: Cell = { face: 'A', col: 1, row: 2 };

  it('杆**正下方**挖不动（原型 v0.5 的护绳规则，`legacy/test.js:101`）', () => {
    expect(canDig(underBar, DIGGER, 'left')).toBe(false);
  });

  it('梯子正下方**可以**挖 —— "梯井不可挖"指的是梯子格本身', () => {
    // 依据原型 `legacy/canyon.html:121` 的判据是 `ladTop(x,y)`（**梯顶那一格**），
    // 而不是"上方有梯子"。梯子格本身在本模型里是 `'ladder'`，`DIGGABLE` 已经挡掉。
    // 这条同时是"别再加一条'上方是梯子'"的防回归钉子。
    expect(canDig(underLadder, DIGGER, 'left')).toBe(true);
  });

  it('梯子格本身挖不动（由 `DIGGABLE` 判据覆盖，不需要额外规则）', () => {
    const targetIsLadder = level(['XX', 'H.', '..']);
    expect(canDig(targetIsLadder, DIGGER, 'left')).toBe(false);
  });
});

/**
 * 坑是**一格深的口袋**，不是通往下一层的竖井（用户 2026-09-19 报的 bug）。
 *
 * 依据是归档原型 `legacy/canyon.html:92` 的 `hAt`：`h = Math.max(1, h-1)` —— 挖出来的坑
 * **永远不会挖穿世界**，坑底那一格留着。所以掉进去的人停在坑里、出不来，直到土长回来
 * （同文件 127-129 行的 `buriedPlayer` / `buriedEnemy`）。
 */
describe('坑是口袋：掉进去停在坑里、出不来（不穿到下一层）', () => {
  /**
   * 多层楼：`r0` 硬底 / `r1` **空的走廊** / `r2` 平台（col 1 挖成了坑）/ `r3` 行走行。
   *
   * `r1` 空是这条测试能成立的关键：若坑下面就是实心，"穿到下层"与"停在坑里"落在同一格，
   * 两种语义就分不开了。
   */
  const tiered = level(['======', '......', 'XXXXXX', '......'], 3);
  const withPit = withGrid(
    tiered,
    tiered.grid.map((kind, i) => (i === 2 * 6 + 1 ? PIT : kind)), // (row 2, col 1)
  );
  const abovePit: Cell = { face: 'A', col: 1, row: 3 };
  const inPit: Cell = { face: 'A', col: 1, row: 2 };

  it('对照组：那一格若只是**空的洞**（修之前的语义）→ 一路穿到**下一层的走廊** `A:1,1`', () => {
    // 这正是用户报的现象："机器人会从掉入坑中，然后直接掉落在下层地板上。"
    const justHole = withGrid(
      tiered,
      tiered.grid.map((kind, i) => (i === 2 * 6 + 1 ? 'empty' : kind)),
    );
    expect(fallTo(justHole, abovePit)).toEqual({
      kind: 'landed',
      cell: { face: 'A', col: 1, row: 1 },
    });
  });

  it('有坑时：同一列掉下去**停在坑里**（`A:1,2`）—— 这就是修好的那条', () => {
    expect(fallTo(withPit, abovePit)).toEqual({ kind: 'landed', cell: inPit });
  });

  it('坑口上方那一格**站不住** —— 走在上面的人会掉进去（口袋的另一半）', () => {
    expect(supportOf(withPit, abovePit)).toBeNull();
    expect(supportOf(withPit, inPit)).toBe('brick');
  });

  it('掉进坑里就出不来了：左右是砖、上下没有梯', () => {
    const at = { cell: inPit, mode: 'stand' as const };
    expect(step(withPit, at, 'left')).toEqual({ kind: 'blocked', reason: 'solid' });
    expect(step(withPit, at, 'right')).toEqual({ kind: 'blocked', reason: 'solid' });
    expect(step(withPit, at, 'up')).toEqual({ kind: 'blocked', reason: 'not-ladder' });
    expect(step(withPit, at, 'down')).toEqual({ kind: 'blocked', reason: 'not-ladder' });
  });

  it('回填之后坑就"合上"了：那一格变回砖，支撑回来了', () => {
    const filled = withGrid(withPit, applyBackfill(withPit.grid, 2 * 6 + 1));
    expect(filled.at(1, 2)).toBe('dig');
    expect(supportOf(filled, inPit)).toBeNull(); // 砖里不能站人
    expect(supportOf(filled, abovePit)).toBe('brick'); // 站在砖面上
  });
});
