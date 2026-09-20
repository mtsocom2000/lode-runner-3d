import { describe, expect, it } from 'vitest';
import { L3, L3_SPAWN } from '../src/core/level/levels/l3';
import { validateLevel } from '../src/core/level/validate';
import { walkReachable } from '../src/core/rules/reach';
import { stateAt, step, stepLift } from '../src/core/rules/movement';
import { cellKey, type Cell } from '../src/core/types';
import { buildGraph, isStandable } from '../src/core/world/graph';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';
import { cellA } from './fixtures';

/**
 * T17 · **L3「立柱」** 的机器可验收部分（对照 `l1.test.ts` / `l2.test.ts`）。
 *
 * L3 的新东西有三件：**三格长的连杆**（跨三格宽的缺口）、**甲板上的连杆**（两岛之间吊着过去）、
 * **柱**（三层高、宝物在顶）。墙面骨架与 L1/L2 不同（梯子换到了 `3/11/16/24`），
 * 所以这里连"骨架仍然合法"也一并钉住 —— 那是"换一关换一副骨架"这句话的凭据。
 */
function load(def: LevelDef): Level {
  const parsed = parseLevel(def);
  if (!parsed.ok) throw new Error(`关卡必须合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

const level = load(L3);
const reach = walkReachable(level, L3_SPAWN);

const deck = (x: number, z: number, level_ = 0): Cell =>
  level_ === 0 ? { face: 'I', col: x, row: z } : { face: 'I', col: x, row: z, level: level_ };
const KEY = (c: Cell): string => cellKey(c);

describe('T17 · L3 立柱：结构校验', () => {
  it('validate 全过（含 exitGated 的双向断言与 unreachable）', () => {
    expect(validateLevel(L3, L3_SPAWN)).toEqual([]);
  });

  it('与 L1/L2 同规格：每面 14 列 × 12 行（6 层砖）', () => {
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
    expect(stranded).toEqual([]);
  });
});

describe('T17 · L3 立柱：三格长的连杆（跨三格宽的缺口）', () => {
  it('两处缺口各三格宽，正上方是三根连着的杆', () => {
    for (const [from, to] of [
      [4, 6],
      [21, 23],
    ] as const) {
      for (let col = from; col <= to; col++) {
        expect(level.at(col, 0)).toBe('empty'); // 缺口：地板断在这里
        expect(level.at(col, 1)).toBe('bar'); // 正上方是杆
      }
    }
  });

  it('吊着能一路横移跨过去，落回砖面（`A:3,1` → 三根杆 → `A:7,1`）', () => {
    const start = stateAt(level, cellA(3, 1));
    if (start === null) throw new Error('A:3,1 应当站得住（梯脚）');
    let state = start;
    const modes: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = step(level, state, 'right');
      if (r.kind !== 'move') throw new Error(`第 ${i + 1} 步应当走得通，实际 ${r.kind}`);
      state = r.state;
      modes.push(state.mode);
    }
    expect(modes).toEqual(['hang', 'hang', 'hang', 'stand']); // 三根杆上吊着，然后落回砖面
    expect(state.cell).toEqual(cellA(7, 1));
  });

  it('杆正下方**不是**实心砖（规则⑦：下方是砖就吊不住）', () => {
    for (let col = 4; col <= 6; col++) expect(level.at(col, 0)).not.toBe('dig');
  });
});

describe('T17 · L3 立柱：甲板上的连杆（两岛之间吊着过去）', () => {
  it('两岛之间的三格**不是板**，是杆（`hang: true`）', () => {
    for (const z of [-8, -7, -6]) {
      const cell = deck(-6, z);
      expect(isStandable(level, cell)).toBe(true); // 能停（吊）
      expect(stateAt(level, cell)?.mode).toBe('hang');
    }
    // 两岛本身仍然是板：站着。
    expect(stateAt(level, deck(-7, -7))?.mode).toBe('stand');
    expect(stateAt(level, deck(-5, -7))?.mode).toBe('stand');
  });

  it('A 岛 → 杆 → B 岛：一路吊过去', () => {
    const start = stateAt(level, deck(-7, -7));
    if (start === null) throw new Error('A 岛正中应当站得住');
    const first = step(level, start, 'right'); // +x：朝 B 岛
    expect(first).toEqual({ kind: 'move', state: { cell: deck(-6, -7), mode: 'hang' } });
    if (first.kind !== 'move') throw new Error('unreachable');
    const second = step(level, first.state, 'right');
    expect(second).toEqual({ kind: 'move', state: { cell: deck(-5, -7), mode: 'stand' } });
  });

  it('吊在杆上按 `X` → 松手落水（下面没有板）', () => {
    const onRod = stateAt(level, deck(-6, -7));
    if (onRod === null) throw new Error('杆上应当停得住');
    expect(stepLift(level, onRod, 'fall')).toEqual({
      kind: 'fall',
      end: { kind: 'water', from: deck(-6, -7), row: -7 },
    });
  });
});

describe('T17 · L3 立柱：柱（三层高，宝物在顶）', () => {
  it('柱顶那一格真的存在，而且只能靠 `Z` 上去', () => {
    const top = deck(-4, -8, 2);
    expect(isStandable(level, top)).toBe(true);
    expect(reach.cells.has(KEY(top))).toBe(true); // 可达性也认它
  });

  it('从柱底连按两次 `Z` 到柱顶', () => {
    const bottom = stateAt(level, deck(-5, -8));
    if (bottom === null) throw new Error('柱底应当站得住');
    const one = stepLift(level, bottom, 'rise');
    expect(one).toEqual({ kind: 'move', state: { cell: deck(-5, -8, 1), mode: 'stand' } });
    if (one.kind !== 'move') throw new Error('unreachable');
    const two = stepLift(level, one.state, 'rise');
    expect(two).toEqual({ kind: 'move', state: { cell: deck(-5, -8, 2), mode: 'stand' } });
  });

  it('柱顶那一格是宝物的落点（不是"看得见捡不到"）', () => {
    const treasure = L3.treasures?.find((t) => (t.level ?? 0) === 2);
    expect(treasure).toEqual({ x: -4, z: -8, level: 2 });
  });
});

describe('T17 · L3 立柱：两处接头仍然成立', () => {
  it('按 `s`（`down`）从走廊拐上小道，落点与小道那端一致', () => {
    for (const joint of level.joints) {
      const from = stateAt(level, joint.wall);
      if (from === null) throw new Error(`${cellKey(joint.wall)} 应当站得住`);
      const r = step(level, from, 'down');
      expect(r).toEqual({
        kind: 'move',
        state: { cell: { face: 'I', col: joint.deck.x, row: joint.deck.z }, mode: 'stand' },
      });
    }
  });
});
