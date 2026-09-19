import { describe, expect, it } from 'vitest';
import { L2, L2_SPAWN } from '../src/core/level/levels/l2';
import { validateLevel } from '../src/core/level/validate';
import { walkReachable } from '../src/core/rules/reach';
import { stateAt, step, stepLift, trail } from '../src/core/rules/movement';
import { treasureAt } from '../src/core/rules/goals';
import { cellKey, type Cell } from '../src/core/types';
import { buildGraph } from '../src/core/world/graph';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';
import { cellA } from './fixtures';

/**
 * T16 · **L2「织网」** 的机器可验收部分（对照 `l1.test.ts`）。
 *
 * L2 的新东西只有三件：**第二座岛 + 岛间小道**、**跨折痕横杆**、**攀爬者**。
 * 墙面骨架与 L1 相同（那是刻意的 —— 见 `l2.ts` 的文件头），所以这里**不重复** L1 已经钉过的
 * 那些（梯子连续性、缺口与出生点的距离……），只钉"L2 新引入的那三件真的成立"。
 */
function load(def: LevelDef): Level {
  const parsed = parseLevel(def);
  if (!parsed.ok) throw new Error(`关卡必须合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

const level = load(L2);
const reach = walkReachable(level, L2_SPAWN);

const island = (x: number, z: number, level = 0): Cell =>
  level === 0 ? { face: 'I', col: x, row: z } : { face: 'I', col: x, row: z, level };
const KEY = (c: Cell): string => cellKey(c);

describe('T16 · L2 织网：结构校验', () => {
  it('validate 全过（含 exitGated 的双向断言与 unreachable）', () => {
    expect(validateLevel(L2, L2_SPAWN)).toEqual([]);
  });

  it('与 L1 同规格：每面 14 列 × 12 行（6 层砖）', () => {
    expect([level.cols, level.rows, level.fold]).toEqual([28, 12, 14]);
  });

  it('按移动规则全可达（出口除外 —— 闸门故意封着）', () => {
    const gated = new Set<string>();
    for (let row = 0; row < level.rows; row++) {
      for (let col = 0; col < level.cols; col++) {
        if (level.at(col, row) === 'exit') gated.add(KEY({ face: col < 14 ? 'A' : 'B', col, row }));
      }
    }
    const stranded = buildGraph(level).nodes.filter(
      (n) => !reach.cells.has(KEY(n)) && !gated.has(KEY(n)),
    );
    expect(stranded.map(KEY)).toEqual([]);
  });
});

describe('T16 · L2 织网：第二座岛只能经岛间小道过去', () => {
  it('两张岛 + 岛间小道 + 塔都在可达集里，甲板共 43 格（39 + 塔的 4 格）', () => {
    expect(L2.deck).toHaveLength(43);
    for (const cell of L2.deck ?? []) {
      expect(reach.cells.has(KEY(island(cell.x, cell.z, cell.level ?? 0)))).toBe(true);
    }
  });

  it('两颗宝物：一颗在 A 岛正中，一颗在 **B 岛塔顶**（`level = 1`），都走得到', () => {
    expect(L2.treasures).toEqual([
      { x: -8, z: -7 },
      { x: -4, z: -8, level: 1 },
    ]);
    for (const t of L2.treasures ?? []) {
      expect(reach.cells.has(KEY(island(t.x, t.z, t.level ?? 0)))).toBe(true);
    }
  });

  it('岛间小道是**咽喉**：拿掉那三格，B 岛那颗宝物就够不着了（A 岛那颗照旧）', () => {
    const cut: LevelDef = {
      ...L2,
      deck: (L2.deck ?? []).filter((c) => !(c.x === -6 && c.z >= -8 && c.z <= -6)),
    };
    const cutReach = walkReachable(load(cut), L2_SPAWN);
    expect(cutReach.cells.has(KEY(island(-8, -7)))).toBe(true); // A 岛（仍连在两条小道之间）
    expect(cutReach.cells.has(KEY(island(-4, -7)))).toBe(false); // B 岛：断了
  });

  it('从 A 岛走到 B 岛：一条 1 宽的甲板小路（`trail` 逐格走一遍）', () => {
    const t = trail(level, stateAt(level, island(-8, -7)) ?? { cell: island(-8, -7), mode: 'stand' }, [
      'right', // -7
      'right', // -6（岛间小道）
      'right', // -5（B 岛）
      'right', // -4（B 岛正中）
    ]);
    expect(t.outcome).toBe('move');
    expect(t.end.cell).toEqual(island(-4, -7));
  });
});

describe('T16 · L2 织网：落水缺口上的连杆（用户裁定的位置，见架构文档 §八-11）', () => {
  it('杆在 `r1` 的 `col 5 / col 22`，正好在落水缺口正上方；下面是空的（规则⑦"吊得住"）', () => {
    expect([level.at(5, 1), level.at(22, 1)]).toEqual(['bar', 'bar']);
    expect([level.at(5, 0), level.at(22, 0)]).toEqual(['empty', 'empty']);
    // 缺口与杆是**同一列**：这才是"吊着跨过缺口"。
    expect(level.at(5, 1)).toBe('bar');
  });

  it('对照：L2 里**没有**杆在折痕附近（第一版把它摆在交界处，是错的）', () => {
    const fold = L2.fold;
    for (let row = 0; row < level.rows; row++) {
      expect(level.at(fold - 1, row)).not.toBe('bar');
      expect(level.at(fold, row)).not.toBe('bar');
    }
  });

  it('吊着跨过缺口：A:4,1 一路往右 → 中间那格是杆、右边落回砖面', () => {
    const t = trail(
      level,
      stateAt(level, cellA(4, 1)) ?? { cell: cellA(4, 1), mode: 'stand' },
      ['right', 'right'],
    );
    expect(t.steps.map((s) => (s.result.kind === 'move' ? s.result.state.mode : s.result.kind))).toEqual([
      'hang', // A:5,1（杆）
      'stand', // A:6,1（砖面）
    ]);
    expect(t.end.cell).toEqual(cellA(6, 1));
  });

  it('吊在杆上按 `X`（世界向下）松手 → **掉进水里**（危险还在，只是不再是"必掉"）', () => {
    const released = step(level, { cell: cellA(5, 1), mode: 'hang' }, 'down');
    expect(released.kind).toBe('fall');
    if (released.kind !== 'fall') throw new Error('松手必须是坠落');
    expect(released.end.kind).toBe('water');
  });

  it('杆上不能向上 —— 吊着不是攀着（原版语义）', () => {
    expect(step(level, { cell: cellA(5, 1), mode: 'hang' }, 'up')).toEqual({
      kind: 'blocked',
      reason: 'not-hangable',
    });
  });
});

describe('T16 · L2 织网：塔（甲板加层之后的第一件东西）', () => {
  it('B 岛上叠了 2×2 的一层（`level = 1`）', () => {
    const top = (L2.deck ?? []).filter((c) => (c.level ?? 0) === 1);
    expect(top.map((c) => `${c.x},${c.z}`).sort()).toEqual(['-4,-8', '-4,-9', '-5,-8', '-5,-9']);
  });

  it('`Z`/`X`（世界上下）能从塔底上到塔顶；塔外没有那一层 → 走不动', () => {
    const base = stateAt(level, island(-4, -8)) ?? { cell: island(-4, -8), mode: 'stand' };
    expect(base.cell.level ?? 0).toBe(0);
    const up = stepLift(level, base, 'rise');
    expect(up).toEqual({ kind: 'move', state: { cell: island(-4, -8, 1), mode: 'stand' } });

    // 塔顶再往上就没有甲板了 —— `no-lift`，不是"掉下去"。
    const top = stateAt(level, island(-4, -8, 1)) ?? { cell: island(-4, -8, 1), mode: 'stand' };
    expect(stepLift(level, top, 'rise')).toEqual({ kind: 'blocked', reason: 'no-lift' });
    // 塔外那一格（B 岛上有甲板、但没有 level 1）同样上不去。
    const outside = stateAt(level, island(-3, -7)) ?? { cell: island(-3, -7), mode: 'stand' };
    expect(stepLift(level, outside, 'rise')).toEqual({ kind: 'blocked', reason: 'no-lift' });
  });

  it('塔顶站着**不会**误收塔底那颗宝物（层必须一起比）', () => {
    // 塔底 `(-4,-8)@0` 与塔顶 `(-4,-8)@1` 的 `(x, z)` 相同 —— 层不比就会误判。
    expect(treasureAt(L2.treasures ?? [], island(-4, -8))).toBeUndefined();
    expect(treasureAt(L2.treasures ?? [], island(-4, -8, 1))).toEqual({
      x: -4,
      z: -8,
      level: 1,
    });
  });
});

describe('T16 · L2 织网：攀爬者', () => {
  it('关卡声明的就是一个 stalker（T15 的敌人首次登场）', () => {
    expect(L2.enemies).toEqual([{ kind: 'stalker', cell: { face: 'B', col: 26, row: 1 } }]);
  });

  it('它站得住（否则 createSim 会当场抛）', () => {
    expect(stateAt(level, { face: 'B', col: 26, row: 1 })).not.toBeNull();
  });
});
