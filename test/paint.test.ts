import { describe, expect, it } from 'vitest';
import { BLANK } from '../src/core/level/levels/blank';
import { L3 } from '../src/core/level/levels/l3';
import {
  paint,
  removeDeck,
  setDeck,
  setWallGlyph,
  tileOfGlyph,
  toggleTreasure,
  type Brush,
} from '../src/core/level/paint';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';
import { validateLevel } from '../src/core/level/validate';

/**
 * T21 阶段 3 · **编辑器的落笔**。
 *
 * 这一层是编辑器的**判据层**：鼠标点在哪一格由渲染层回答，而"往那一格画了什么之后关卡数据
 * 长什么样"由这里回答。所以测试全打在这上面 —— UI 不必（也没法）单测。
 *
 * 三件最要紧的性质：
 *
 * 1. **不改原对象**（纯函数）：返回新对象，旧的照旧 —— 这是阶段 4 撤销的全部地基；
 * 2. **越界 / 认不出的笔原样返回**：编辑器里关卡长期是半成品，"画不上"不该是异常；
 * 3. **画完仍然是一个能被 `parseLevel` 吃下去的 `LevelDef`**：字形行长不能破。
 */
const A = (col: number, row: number): { face: 'A'; col: number; row: number } => ({ face: 'A', col, row });
const D = (x: number, z: number, level?: number): { face: 'I'; col: number; row: number; level?: number } =>
  level === undefined ? { face: 'I', col: x, row: z } : { face: 'I', col: x, row: z, level };

describe('T21·3 落笔：墙上的字形', () => {
  it('改一格，**只**改那一格；其余字符与行长一字不动', () => {
    const next = setWallGlyph(BLANK, A(3, 1), 'X');
    expect(next.tiles[1]).toBe(`${'.'.repeat(3)}X${'.'.repeat(24)}`);
    // 别的行必须**引用相等**吗？不必 —— 但内容要一样。
    expect(next.tiles[0]).toBe(BLANK.tiles[0]);
    expect(next.tiles.length).toBe(BLANK.tiles.length);
    expect(next.tiles.every((r) => r.length === 28)).toBe(true);
  });

  it('**不改原对象**（撤销的地基）', () => {
    const before = BLANK.tiles[1];
    setWallGlyph(BLANK, A(3, 1), 'X');
    expect(BLANK.tiles[1]).toBe(before);
  });

  it('画完仍然能被 parseLevel 吃下去（行长没破）', () => {
    const next = setWallGlyph(BLANK, A(3, 1), 'X');
    expect(parseLevel(next).ok).toBe(true);
  });

  it('越界 / 认不出的字形 / 画到甲板格上 → 原样返回（同一个对象）', () => {
    expect(setWallGlyph(BLANK, A(-1, 1), 'X')).toBe(BLANK);
    expect(setWallGlyph(BLANK, A(28, 1), 'X')).toBe(BLANK);
    expect(setWallGlyph(BLANK, A(3, 99), 'X')).toBe(BLANK);
    expect(setWallGlyph(BLANK, A(3, 1), '?')).toBe(BLANK);
    expect(setWallGlyph(BLANK, D(0, 0), 'X')).toBe(BLANK);
  });

  it('`tileOfGlyph` 认得全部字形，其余给 null', () => {
    for (const g of ['X', '=', '.', 'H', '-', 'G', 'E']) expect(tileOfGlyph(g)).not.toBeNull();
    expect(tileOfGlyph('?')).toBeNull();
  });
});

describe('T21·3 落笔：甲板三态', () => {
  it('放一块板：层 0 **省略不写**（手画的关卡不该多一个 `level: 0`）', () => {
    const next = setDeck(BLANK, D(-7, -7), 'board');
    expect(next.deck).toEqual([{ x: -7, z: -7 }]);
  });

  it('放一根杆 / 一格梯子：带上对应的旗标', () => {
    const rod = setDeck(BLANK, D(-6, -7), 'hang');
    expect(rod.deck).toEqual([{ x: -6, z: -7, hang: true }]);
    const lad = setDeck(BLANK, D(-8, -8, 1), 'ladder');
    expect(lad.deck).toEqual([{ x: -8, z: -8, level: 1, ladder: true }]);
  });

  it('**同一格再画一次 = 替换**（不是叠两块）', () => {
    const a = setDeck(BLANK, D(-7, -7), 'board');
    const b = setDeck(a, D(-7, -7), 'hang');
    expect(b.deck).toEqual([{ x: -7, z: -7, hang: true }]);
  });

  it('**层不同就是不同的格**：第 1 层与第 0 层并存', () => {
    const a = setDeck(BLANK, D(-7, -7), 'board');
    const b = setDeck(a, D(-7, -7, 1), 'board');
    expect(b.deck).toEqual([{ x: -7, z: -7 }, { x: -7, z: -7, level: 1 }]);
  });

  it('删除只删那一层；不在那儿就原样返回', () => {
    const a = setDeck(setDeck(BLANK, D(-7, -7), 'board'), D(-7, -7, 1), 'board');
    const b = removeDeck(a, D(-7, -7, 1));
    expect(b.deck).toEqual([{ x: -7, z: -7 }]);
    expect(removeDeck(b, D(5, 5))).toBe(b);
  });

  it('**擦除会回退一层**：点方块顶面（拾取给的是上一层）也能抹掉方块本身', () => {
    // 用户报的"橡皮似乎不怎么工作"就是这个：拾取把"点顶面"翻成上面那一层，
    // 而顶层是空的 → 擦除扑空 → 什么都不发生。擦除因此多一步回退。
    const stack = setDeck(setDeck(BLANK, D(-7, -7), 'board'), D(-7, -7, 1), 'board');
    // 点第 1 层的顶面 → 拾取给第 2 层（空的）→ 回退到第 1 层，把它抹掉。
    expect(removeDeck(stack, D(-7, -7, 2)).deck).toEqual([{ x: -7, z: -7 }]);
    // 一层足够：隔着两层不动（那多半是点歪了）。
    expect(removeDeck(stack, D(-7, -7, 3))).toBe(stack);
  });
});

describe('T21·3 落笔：出生点与宝物', () => {
  it('出生点画在哪一格就是哪一格（层也带上）', () => {
    const next = paint(BLANK, { kind: 'spawn' }, A(7, 1));
    expect(next.spawn).toEqual({ face: 'A', col: 7, row: 1 });
  });

  it('宝物：一键两用 —— 没有就放、有了就收', () => {
    const b: Brush = { kind: 'treasure' };
    const one = paint(BLANK, b, D(-7, -7));
    expect(one.treasures).toEqual([{ x: -7, z: -7 }]);
    const two = paint(one, b, D(-7, -7));
    expect(two.treasures).toEqual([]);
  });

  it('宝物按**层**区分：同一 (x, z) 的两层各有一颗', () => {
    const one = toggleTreasure(BLANK, D(-7, -7));
    const two = toggleTreasure(one, D(-7, -7, 1));
    expect(two.treasures).toEqual([{ x: -7, z: -7 }, { x: -7, z: -7, level: 1 }]);
  });
});

describe('T21·3 落笔：橡皮与整体', () => {
  it('橡皮：墙上抹成空、甲板上删格', () => {
    const wall = setWallGlyph(BLANK, A(3, 1), 'X');
    const erased = paint(wall, { kind: 'erase' }, A(3, 1));
    expect(erased.tiles[1]).toBe(BLANK.tiles[1]);

    const deck = setDeck(BLANK, D(-7, -7), 'board');
    expect(paint(deck, { kind: 'erase' }, D(-7, -7)).deck).toEqual([]);
  });

  it('**从空白关卡画出一张能玩的关卡**：铺地板 + 放出生点 + 放出口 → 校验不再报 spawn/noExit', () => {
    // 这一条就是编辑器的"最小可用闭环"：用户能亲手把一张空白关卡改到"能玩"。
    let def: LevelDef = BLANK;
    for (let col = 0; col < 28; col++) def = setWallGlyph(def, A(col, 0), 'X');
    def = paint(def, { kind: 'spawn' }, A(0, 1));
    def = setWallGlyph(def, A(1, 11), 'E');
    def = toggleTreasure(def, D(-7, -7));

    const issues = validateLevel(def, def.spawn);
    const rules = issues.map((i) => i.rule);
    expect(rules).not.toContain('spawnStandable');
    expect(rules).not.toContain('noExit');
    // 地铺好了、出生点站得住 → 能起一局（这才是"能玩"的判据本身）。
    expect(parseLevel(def).ok).toBe(true);
  });

  it('对现成关卡落笔同样成立（拿 L3 当底板，改一格）', () => {
    const next = setWallGlyph(L3, A(0, 0), 'H');
    expect(next.tiles[0]?.startsWith('H')).toBe(true);
    expect(L3.tiles[0]?.startsWith('X')).toBe(true); // 原对象没动
  });
});
