import { describe, expect, it } from 'vitest';
import { L1, L1_SPAWN } from '../src/core/level/levels/l1';
import { CONCEPT_MINIMAL, PLAYER_SPAWN } from '../src/core/level/levels/conceptMinimal';
import { validateLevel } from '../src/core/level/validate';
import { walkReachable } from '../src/core/rules/reach';
import { cellKey, type Cell } from '../src/core/types';
import { buildGraph } from '../src/core/world/graph';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';

/**
 * T14 · **L1「折角」** 的机器可验收部分。
 *
 * 关卡数据是手写的，所以"它能玩通"必须由机器回答，而不是靠作者看一眼。
 * 这里钉四件事：① 十条校验规则全过；② **按移动规则**每一格都走得到；③ 两个接头的两端都走得到；
 * ④ 闸门真的封住了出口（取宝前不可达）。
 *
 * ## 为什么这些断言用 `walkReachable` 而不是 `buildGraph`
 *
 * 因为踩过：L1 的第一版把梯子放在接头那一列（`col 1`），于是 `A:1,1` 的**横移被接头吃掉**，
 * 底层走廊被切成两段、`A:2,1 / A:3,1` 按移动规则永远走不到 —— 而当时的 `unreachable`
 * 规则用的是静态图、判"全过"。静态图连了那条边，`step` 不走它。
 * 所以"走不走得到"这一律问 `rules/reach.ts`（见那边的文件头），静态图只用于它擅长的那些问题。
 */
function load(def: LevelDef) {
  const parsed = parseLevel(def);
  if (!parsed.ok) throw new Error(`关卡必须合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

describe('T14 · L1 折角：结构校验', () => {
  it('validate 全过（parse / rowsEven / spawnStandable / enemyStandable / exitGated / …）', () => {
    expect(validateLevel(L1, L1_SPAWN)).toEqual([]);
  });

  it('每面 10 列 × 12 行 → 6 层砖（用户要的"做宽 + 再加一层"）', () => {
    const level = load(L1);
    expect(level.cols).toBe(20);
    expect(level.rows).toBe(12);
    expect(level.fold).toBe(10);
    // 砖行是 r0/r2/r4/r6/r8/r10 —— 数一数：6 层。
    const brickRows = [...Array(level.rows).keys()].filter((row) =>
      [...Array(level.cols).keys()].some((col) => level.at(col, row) === 'dig'),
    );
    expect(brickRows).toEqual([0, 2, 4, 6, 8, 10]);
  });
});

/** 出口**故意**可以到不了（闸门封的就是它）—— 与 `validate` 的 `unreachable` 规则同一口径。 */
function exitKeys(level: Level, fold: number): ReadonlySet<string> {
  const keys = new Set<string>();
  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      if (level.at(col, row) !== 'exit') continue;
      keys.add(cellKey({ face: col < fold ? 'A' : 'B', col, row }));
    }
  }
  return keys;
}

describe('T14 · L1 折角：按移动规则走得到', () => {
  const level = load(L1);
  const reach = walkReachable(level, L1_SPAWN);

  it('所有可站立格都走得到（出口除外 —— 闸门故意封着；这条曾经用静态图判过"全过"，是错的）', () => {
    const nodes = buildGraph(level).nodes;
    const gated = exitKeys(level, L1.fold);
    const stranded = nodes.filter((n) => !reach.cells.has(cellKey(n)) && !gated.has(cellKey(n)));
    expect(stranded.map(cellKey)).toEqual([]);
  });

  it('甲板 20/20（岛台 16 + 两条小道 4）与宝物格都在可达集里', () => {
    const deck = L1.deck ?? [];
    expect(deck).toHaveLength(20);
    for (const cell of deck) {
      expect(reach.cells.has(cellKey({ face: 'I', col: cell.x, row: cell.z }))).toBe(true);
    }
    const treasure = L1.treasures?.[0];
    expect(treasure).toBeDefined();
    if (treasure === undefined) throw new Error('L1 必须有宝物');
    expect(reach.cells.has(cellKey({ face: 'I', col: treasure.x, row: treasure.z }))).toBe(true);
  });

  it('两处接头的**墙端与甲板端**都走得到（接头是唯一的上岛通道）', () => {
    for (const joint of L1.joints ?? []) {
      expect(reach.cells.has(cellKey(joint.wall))).toBe(true);
      expect(reach.cells.has(cellKey({ face: 'I', col: joint.deck.x, row: joint.deck.z }))).toBe(true);
    }
  });

  it('落水口正好 4 个，且关于折痕对称（col6 两侧 + col13 两侧）', () => {
    const holes = reach.drownings
      .map((d) => `${d.cell.face}:${d.cell.col},${d.cell.row}--${d.dir}`)
      .sort();
    expect(holes).toEqual(
      ['A:5,1--right', 'A:7,1--left', 'B:12,1--right', 'B:14,1--left'].sort(),
    );
  });

  it('出生点**不在**缺口旁边：从出生点走到最近的水要横穿好几格（概念场景吃过这个亏）', () => {
    // 出生点在 col0；两个缺口在 col6 / col13 —— 中间隔着 6 格与好几把梯子。
    const firstHole = Math.min(...reach.drownings.map((d) => d.cell.col + 1));
    expect(firstHole).toBeGreaterThanOrEqual(4);
  });
});

describe('T14 · L1 折角：闸门封住了出口', () => {
  const level = load(L1);
  const reach = walkReachable(level, L1_SPAWN);

  it('两个出口都站得住，且**取宝前都走不到**', () => {
    const exits: readonly Cell[] = [
      { face: 'A', col: 1, row: 11 },
      { face: 'B', col: 18, row: 11 },
    ];
    for (const exit of exits) {
      expect(reach.cells.has(cellKey(exit))).toBe(false);
    }
  });
});

describe('T14 · 概念关卡也按移动规则全可达（把"图可达 ≠ 走得到"钉成断言）', () => {
  it('CONCEPT_MINIMAL：所有可站立格都在 walkReachable 里（同样排除两个出口）', () => {
    const level = load(CONCEPT_MINIMAL);
    const reach = walkReachable(level, PLAYER_SPAWN);
    const nodes = buildGraph(level).nodes;
    const gated = exitKeys(level, CONCEPT_MINIMAL.fold);
    const stranded = nodes.filter((n) => !reach.cells.has(cellKey(n)) && !gated.has(cellKey(n)));
    expect(stranded.map(cellKey)).toEqual([]);
  });
});
