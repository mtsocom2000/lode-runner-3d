import { describe, expect, it } from 'vitest';
import {
  asCell,
  buildDeck,
  deckKey,
  fromCell,
  rectCells,
  type DeckCell,
  type DeckJoint,
} from '../src/core/world/deck';
import { cellKey, parseCell, type Cell } from '../src/core/types';
import { validateLevel } from '../src/core/level/validate';
import { stateAt, step } from '../src/core/rules/movement';
import { buildGraph, isStandable, reachableFrom } from '../src/core/world/graph';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';

describe('deck：甲板是"不在摊平网格上"的水平面', () => {
  it('rectCells 含首含尾，且行列都升序', () => {
    const cells = rectCells(-1, -1, 1, 1);
    expect(cells).toHaveLength(9); // 3×3
    expect(cells[0]).toEqual({ x: -1, z: -1 });
    expect(cells[8]).toEqual({ x: 1, z: 1 });
  });

  it('rectCells 参数颠倒也给同一批格子（矩形的两个角是等价的）', () => {
    expect(rectCells(1, 1, -1, -1)).toEqual(rectCells(-1, -1, 1, 1));
  });

  it('rectCells 能表达退化矩形 —— 小道就是 1×N', () => {
    const jetty = rectCells(0, 0, 0, 3);
    expect(jetty).toHaveLength(4);
    expect(jetty.every((c) => c.x === 0)).toBe(true);
  });

  it('buildDeck 去重：同一格传两次只留一次', () => {
    const deck = buildDeck([
      { x: 0, z: 0 },
      { x: 0, z: 0 },
      { x: 1, z: 0 },
    ]);
    expect(deck.cells).toHaveLength(2);
  });

  it('Deck.has 认甲板格、不认别的格，且不抛异常', () => {
    const deck = buildDeck(rectCells(0, 0, 1, 1));
    expect(deck.has(0, 0)).toBe(true);
    expect(deck.has(1, 1)).toBe(true);
    expect(deck.has(2, 0)).toBe(false);
    // 负坐标是常态（岛心在 -3.5），别写成只认正数的实现。
    expect(deck.has(-1, -1)).toBe(false);
  });

  it('deckKey 区分不同的 (x,z) —— 别让 (1,-2) 和 (12,-) 之类撞键', () => {
    expect(deckKey({ x: 1, z: -2 })).not.toBe(deckKey({ x: 12, z: 0 }));
  });
});

describe('deck：M2 编码（面 I + col=x, row=z）必须与现有工具往返无损', () => {
  it('asCell 用的就是面 I，col=x、row=z', () => {
    expect(asCell({ x: -4, z: -3 })).toEqual({ face: 'I', col: -4, row: -3 });
  });

  it('asCell → fromCell 往返回原样', () => {
    const cell = { x: -3, z: -5 };
    expect(fromCell(asCell(cell))).toEqual(cell);
  });

  // 这一条是 M2 的**前提本身**：如果 cellKey/parseCell 装不下甲板格，
  // 那么"复用 Cell、不动这两个函数"这条省事的路线就不成立。它必须真的能往返。
  it('cellKey → parseCell 对甲板格往返无损（这是 M2 能省下改动的原因）', () => {
    const cell = asCell({ x: -4, z: -3 });
    const round = parseCell(cellKey(cell));
    expect(round).toEqual(cell);
  });

  it('甲板格的键不会和墙面格撞（面不同）', () => {
    const deckCell = asCell({ x: 0, z: 0 });
    const wallCell = { face: 'A', col: 0, row: 0 } as const;
    expect(cellKey(deckCell)).not.toBe(cellKey(wallCell));
  });
});

describe('parseLevel 把甲板透传进 Level（T10 步骤③）', () => {
  /** fold=1 + 两列宽的网格 = 最小合法 LevelDef（cols 必须 = fold×2）。 */
  const bare = { id: 't', name: 't', fold: 1, tiles: ['..'] } as const;

  function load(def: Parameters<typeof parseLevel>[0]) {
    const parsed = parseLevel(def);
    if (!parsed.ok) throw new Error(`parseLevel 失败：${JSON.stringify(parsed.errors)}`);
    return parsed.level;
  }

  it('没写 deck/joints 时给**空数组**，不是 undefined', () => {
    const level = load(bare);
    expect(level.deck).toEqual([]);
    expect(level.joints).toEqual([]);
  });

  it('deck 会去重（同一格写两次不该变成两个节点）', () => {
    const level = load({
      ...bare,
      deck: [
        { x: 1, z: 2 },
        { x: 1, z: 2 },
        { x: 1, z: 3 },
      ],
    });
    expect(level.deck).toHaveLength(2);
    expect(level.deck).toEqual([
      { x: 1, z: 2 },
      { x: 1, z: 3 },
    ]);
  });

  it('joints 原样透传，且甲板格能还原成 Cell 再还原回来', () => {
    const joints = [
      { deck: { x: -1, z: 0 }, wall: { face: 'A', col: 4, row: 1 }, enterDir: 'right' },
    ] as const;
    const level = load({ ...bare, deck: [{ x: -1, z: 0 }], joints });

    expect(level.joints).toEqual(joints);
    const cell = asCell(level.deck[0]!);
    expect(cell).toEqual({ face: 'I', col: -1, row: 0 });
    expect(fromCell(cell)).toEqual({ x: -1, z: 0 });
  });
});

describe('validate 抓得出指空的甲板接头（T10 步骤⑤）', () => {
  const wall = { id: 't', name: 't', fold: 1, tiles: ['XX', '..'] } as const;

  /** 只要规则 id 列表，不关心这张最小关卡还触发了别的规则（比如 noExit）。 */
  function rules(def: Parameters<typeof validateLevel>[0]): readonly string[] {
    return validateLevel(def).map((i) => i.rule);
  }

  it('接头的甲板端不在 level.deck 里 → deckJointDangling', () => {
    const def: LevelDef = {
      ...wall,
      deck: [{ x: 0, z: 0 }],
      joints: [{ deck: { x: 9, z: 9 }, wall: { face: 'A', col: 0, row: 1 }, enterDir: 'right' }],
    };
    expect(rules(def)).toContain('deckJointDangling');
  });

  it('接头的墙面端站不住（r0 下方没有地板）→ deckJointDangling', () => {
    const def: LevelDef = {
      ...wall,
      deck: [{ x: 0, z: 0 }],
      joints: [{ deck: { x: 0, z: 0 }, wall: { face: 'A', col: 0, row: 0 }, enterDir: 'right' }],
    };
    expect(rules(def)).toContain('deckJointDangling');
  });

  it('两端都落到实处的健康接头不报这条', () => {
    const def: LevelDef = {
      ...wall,
      deck: [{ x: 0, z: 0 }],
      joints: [{ deck: { x: 0, z: 0 }, wall: { face: 'A', col: 0, row: 1 }, enterDir: 'right' }],
    };
    expect(rules(def)).not.toContain('deckJointDangling');
  });
});

describe('甲板行走（movement.ts）', () => {
  // `fold = 2`（4 列）：**不能取 1** —— 那时折痕线就在原点，接头两端（墙面格与甲板格）
  // 会落在**世界同一个点**上，"往哪边走"根本没有意义（`stepOnDeck` 的方向判据是主导轴之差）。
  // 真实关卡里接头两端差一格，这里也照那个来。
  const wall = { id: 't', name: 't', fold: 2, tiles: ['XXXX', '....'] } as const;
  // 一条 3 格甲板 + 一处接头。甲板格是 (x, z)，`right → +x`。
  const deckCells: readonly DeckCell[] = [
    { x: 0, z: 0 },
    { x: 1, z: 0 },
    { x: 2, z: 0 },
  ];
  const joints: readonly DeckJoint[] = [{ deck: { x: 0, z: 0 }, wall: { face: 'A', col: 0, row: 1 }, enterDir: 'right' }];

  const parsed = parseLevel({ ...wall, deck: deckCells, joints });
  if (!parsed.ok) throw new Error(`夹具 parseLevel 失败：${JSON.stringify(parsed.errors)}`);
  const lv = parsed.level;

  /** 站在某格；停不住就炸，别静默。 */
  function at(cell: Cell) {
    const s = stateAt(lv, cell);
    if (s === null) throw new Error(`夹具里 ${cellKey(cell)} 停不住`);
    return s;
  }

  const deck0: Cell = { face: 'I', col: 0, row: 0 };
  const deck2: Cell = { face: 'I', col: 2, row: 0 };
  const wallEnd: Cell = { face: 'A', col: 0, row: 1 };

  it('甲板格是可停驻的（支撑 = 砖面）', () => {
    expect(stateAt(lv, deck0)).toEqual({ cell: deck0, mode: 'stand' });
  });

  it('甲板内部：right → +x', () => {
    expect(step(lv, at(deck0), 'right')).toEqual({
      kind: 'move',
      state: { cell: { face: 'I', col: 1, row: 0 }, mode: 'stand' },
    });
  });

  it('走到甲板边缘 → blocked("out")，**不是** fall（主动入水要阻止）', () => {
    const r = step(lv, at(deck2), 'right');
    expect(r).toEqual({ kind: 'blocked', reason: 'out' });
    expect(r.kind).not.toBe('fall');
  });

  it('接头是**双向**的：甲板 → 墙、墙 → 甲板都能走', () => {
    // 甲板 → 墙（stepOnDeck 的 ②）
    expect(step(lv, at(deck0), 'left')).toEqual({ kind: 'move', state: { cell: wallEnd, mode: 'stand' } });
    // 墙 → 甲板：这条曾经缺失，接头在移动层是单向门（能下来、上不去）
    expect(step(lv, at(wallEnd), 'right')).toEqual({ kind: 'move', state: { cell: deck0, mode: 'stand' } });
  });
});

describe('甲板接进通行图（T10 步骤④）', () => {
  /**
   * 一块"能站人"的墙 + 可选甲板。
   * `tiles[0]` 是**最底行**，所以 ['XX','..'] = 底行两块砖、上一行两格空 → 两格都可站。
   * fold=1 → col 0 属面 A，col 1 属面 B。
   */
  const wall = { id: 't', name: 't', fold: 1, tiles: ['XX', '..'] } as const;

  function load(extra: { deck?: readonly DeckCell[]; joints?: readonly DeckJoint[] }) {
    const parsed = parseLevel({ ...wall, ...extra });
    if (!parsed.ok) throw new Error(`parseLevel 失败：${JSON.stringify(parsed.errors)}`);
    return parsed.level;
  }

  const onWall: Cell = { face: 'A', col: 0, row: 1 };

  it('声明过的甲板格算"可站"，没声明的 I 格不算', () => {
    const level = load({ deck: [{ x: 0, z: 0 }] });
    expect(isStandable(level, asCell({ x: 0, z: 0 }))).toBe(true);
    // 关键：'I' 不是"默认可站"的面 —— 必须真的在 level.deck 里。
    expect(isStandable(level, asCell({ x: 9, z: 9 }))).toBe(false);
  });

  it('甲板格进 nodes，成为图的第二个节点来源', () => {
    const bare = load({});
    const withDeck = load({ deck: [{ x: 0, z: 0 }] });
    const n0 = buildGraph(bare).nodes.length;
    const n1 = buildGraph(withDeck).nodes.length;
    expect(n1).toBe(n0 + 1);
    expect(buildGraph(withDeck).has(asCell({ x: 0, z: 0 }))).toBe(true);
    // 甲板为空时不该凭空多出节点（惰性：不声明甲板的关卡图不变）
    expect(buildGraph(bare).nodes.some((c) => c.face === 'I')).toBe(false);
  });

  it('接头是甲板与墙之间唯一的桥：没接头 → 走不到甲板', () => {
    const noJoint = buildGraph(load({ deck: [{ x: 0, z: 0 }] }));
    expect(reachableFrom(noJoint, onWall).has(cellKey(asCell({ x: 0, z: 0 })))).toBe(false);

    const jointed = buildGraph(
      load({ deck: [{ x: 0, z: 0 }], joints: [{ deck: { x: 0, z: 0 }, wall: onWall, enterDir: 'right' }] }),
    );
    expect(reachableFrom(jointed, onWall).has(cellKey(asCell({ x: 0, z: 0 })))).toBe(true);
    // 反向也通（用户已定：这是 walk 边，不是单向的）
    expect(reachableFrom(jointed, asCell({ x: 0, z: 0 })).has(cellKey(onWall))).toBe(true);
  });

  it('甲板内部能横向走（4×4 岛台不是一格孤岛）', () => {
    const graph = buildGraph(
      load({
        deck: [
          { x: 0, z: 0 },
          { x: 1, z: 0 },
        ],
      }),
    );
    const a = asCell({ x: 0, z: 0 });
    const b = asCell({ x: 1, z: 0 });
    expect(graph.neighbours(a).some((e) => e.kind === 'walk' && cellKey(e.to) === cellKey(b))).toBe(true);
    expect(reachableFrom(graph, a).has(cellKey(b))).toBe(true);
  });

  it('接头指向不存在的地面时**不连边**（关卡数据错了，不该悄悄补一条）', () => {
    const level = load({
      deck: [{ x: 0, z: 0 }],
      joints: [{ deck: { x: 7, z: 7 }, wall: onWall, enterDir: 'right' }], // 甲板侧不存在
    });
    const graph = buildGraph(level);
    expect(graph.nodes.some((c) => c.col === 7)).toBe(false);
    expect(reachableFrom(graph, onWall).size).toBeGreaterThan(0);
    expect(reachableFrom(graph, onWall).has(cellKey(asCell({ x: 7, z: 7 })))).toBe(false);
  });
});
