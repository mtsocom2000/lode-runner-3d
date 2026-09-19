import { describe, expect, it } from 'vitest';
import { L2, L2_SPAWN } from '../src/core/level/levels/l2';
import { validateLevel } from '../src/core/level/validate';
import { walkReachable } from '../src/core/rules/reach';
import { stateAt, step, trail } from '../src/core/rules/movement';
import { cellKey, type Cell } from '../src/core/types';
import { buildGraph } from '../src/core/world/graph';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';
import { cellA, cellB } from './fixtures';

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

const island = (x: number, z: number): Cell => ({ face: 'I', col: x, row: z });
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
  it('两张岛 + 岛间小道都在可达集里，甲板共 39 格', () => {
    expect(L2.deck).toHaveLength(39);
    for (const cell of L2.deck ?? []) {
      expect(reach.cells.has(KEY(island(cell.x, cell.z)))).toBe(true);
    }
  });

  it('两颗宝物在两张岛的正中，且都走得到（逼玩家把那张网走一遍）', () => {
    expect(L2.treasures).toEqual([
      { x: -8, z: -7 },
      { x: -4, z: -7 },
    ]);
    for (const t of L2.treasures ?? []) expect(reach.cells.has(KEY(island(t.x, t.z)))).toBe(true);
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

describe('T16 · L2 织网：跨折痕横杆', () => {
  it('r3 的 col 13/14 是杆，且它下面（r2）是空的 —— 规则⑦"吊得住"', () => {
    expect([level.at(13, 3), level.at(14, 3)]).toEqual(['bar', 'bar']);
    expect([level.at(13, 2), level.at(14, 2)]).toEqual(['empty', 'empty']);
  });

  it('吊着跨过折痕：A:12,3 一路往右 → 中途两格都是杆、最后落回砖面 B:15,3', () => {
    const t = trail(
      level,
      stateAt(level, cellA(12, 3)) ?? { cell: cellA(12, 3), mode: 'stand' },
      ['right', 'right', 'right'],
    );
    expect(t.steps.map((s) => (s.result.kind === 'move' ? s.result.state.mode : s.result.kind))).toEqual([
      'hang', // A:13,3（杆）
      'hang', // B:14,3（杆；这一步还是跨折痕 = 原地转 90°）
      'stand', // B:15,3（砖面）
    ]);
    expect(t.end.cell).toEqual(cellB(15, 3));
  });

  it('杆上不能向上 —— 吊着不是攀着（原版语义）', () => {
    expect(step(level, { cell: cellA(13, 3), mode: 'hang' }, 'up')).toEqual({
      kind: 'blocked',
      reason: 'not-hangable',
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
