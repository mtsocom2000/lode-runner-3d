import { describe, expect, it } from 'vitest';
import { BLANK } from '../src/core/level/levels/blank';
import { L3 } from '../src/core/level/levels/l3';
import {
  blockedDirs,
  foldTwin,
  paint,
  placeJoint,
  paintTerrain,
  removeDeck,
  setDeck,
  setWallGlyph,
  tileOfGlyph,
  toggleTreasure,
  type Brush,
} from '../src/core/level/paint';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';
import { cellKey, type Cell } from '../src/core/types';
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

describe('T21·3 落笔：出口**自带闸门**（用户 2026-09-22）', () => {
  /**
   * 用户的原话："出口设计的时候没有给它设计阻拦的地块，这样使得出口随时可以经过……摆放出口
   * 应该自动在两侧设置障碍物，在宝物取得之后障碍物自动消除。" —— 这就是原版出口的凹槽：
   * 左右各一块**假砖**，集齐金子后消失。
   *
   * 本作里那两块假砖 = 闸门（`=E=`，与 L3 手工排的 `r11` 一模一样）。
   */
  const exitBrush: Brush = { kind: 'tile', glyph: 'E' };

  it('放出口 = 两侧各一块硬砖，两块都登记进 `gates`', () => {
    const def = paint(BLANK, exitBrush, A(5, 1));
    expect(def.tiles[1]?.slice(4, 7)).toBe('=E=');
    expect(def.gates).toEqual([A(4, 1), A(6, 1)]);
  });

  it('重复画同一个出口**不会把闸门登记成两份**（幂等）', () => {
    const once = paint(BLANK, exitBrush, A(5, 1));
    expect(paint(once, exitBrush, A(5, 1)).gates).toEqual([A(4, 1), A(6, 1)]);
  });

  it('贴边时只画得到的那一侧有闸门（另一侧越界，跳过而不是报错）', () => {
    const def = paint(BLANK, exitBrush, A(0, 1));
    expect(def.tiles[1]?.slice(0, 2)).toBe('E=');
    expect(def.gates).toEqual([A(1, 1)]);
  });

  it('两侧原本是**可挖**的砖也一律换成硬砖：闸门要挡得住，也得能消失', () => {
    let def = setWallGlyph(BLANK, A(4, 1), 'X');
    def = setWallGlyph(def, A(6, 1), 'X');
    expect(paint(def, exitBrush, A(5, 1)).tiles[1]?.slice(4, 7)).toBe('=E=');
  });

it('把出口抹掉 → 它两侧那对闸门不再登记（砖留着，叫"闸门"这件事撤了）', () => {
    // 为什么**不**连砖一起抹：橡皮的规矩是"只擦你点的那一格"（用户为这条规则专门报过 bug）。
    // 留下的两块 `=` 现在是普通硬砖 —— 作者想抹随他，但它们不该再"集齐宝物后自己消失"，
    // 因为那个出口已经不在了。会自己消失的砖叫**幽灵闸门**，比多两块砖难查得多。
    const def = paint(BLANK, exitBrush, A(5, 1));
    const erased = paint(def, { kind: 'erase' }, A(5, 1));
    expect(erased.gates).toEqual([]);
    expect(erased.tiles[1]?.slice(4, 7)).toBe('=.=');
  });

  it('出口画在"别人的闸门格"上 → 那一格的闸门登记被撤掉（否则开闸会把出口抹掉）', () => {
    // 用户报的"集齐宝物后出口变成了梯子"就是这条路径：两个出口挨着画、
    // 名单里留着**出口自己那一格**，开闸那一下清掉的是出口本身。
    const one = paint(BLANK, exitBrush, A(5, 3));
    expect(one.gates).toEqual([A(4, 3), A(6, 3)]);
    const two = paint(one, exitBrush, A(6, 3));
    // 关键的一条：**新的出口那一格**不能还留在名单里（开闸会把它抹掉）。
    expect(two.gates?.some((g) => g.col === 6 && g.row === 3)).toBe(false);
    // 新出口自带的两个闸门在名单里。
    expect(two.gates?.some((g) => g.col === 5 && g.row === 3)).toBe(true);
    expect(two.gates?.some((g) => g.col === 7 && g.row === 3)).toBe(true);
    // 旧的 (4,3) 会作为一条**无害的**遗留留下（它现在是一块普通硬砖，开闸时多清一格而已）——
    // 不去猜"哪些旧声明属于哪个已消失的出口"，那种推断一旦猜错就是把别人的砖清掉。
  });

  it('失效的旧声明：那一格**不再是硬砖**时，重画出口会把它清掉（用户报的 `A:13,11`）', () => {
    // 用户那一关的残留正是这个形状：出口曾在 col 12（它登记 11 与 13），后来挪到 11；
    // `A:11,11` 死在**出口本身**上（被"剔掉自己"那条清掉），`A:13,11` 死在**空格**上。
    const at12 = paint(BLANK, exitBrush, A(12, 3));
    expect(at12.gates?.map((g) => g.col).sort()).toEqual([11, 13]);

    // 13 那格的砖后来被抹掉（用户那一关就是空的）—— 登记还在，但已经不成立。
    // 注：`fold = 14` 时 col 13 是折痕列，擦它会**两面一起擦**（见上一条 describe）。
    let def = paint(at12, { kind: 'erase' }, A(13, 3));
    expect(def.tiles[3]?.[13]).toBe('.');
    expect(def.gates?.map((g) => g.col).sort()).toEqual([11, 13]); // 擦除不清名单

    // 把出口挪到 11：11 变成出口（剔掉自己），13 已经不是硬砖（失效）→ 两条都清掉。
    def = paint(def, exitBrush, A(11, 3));
    expect((def.gates ?? []).map((g) => g.col).sort()).toEqual([10, 12]);
    // 留下的每一条都真的指向硬砖 —— 这就是"成立"的判据本身。
    for (const g of def.gates ?? []) {
      expect(def.tiles[g.row]?.[g.col]).toBe('=');
    }
  });

  it('L3 手工排的四个闸门**正好**是两对出口的两侧 —— 房规在真数据里也成立', () => {
    const flanks = new Set<string>();
    L3.tiles.forEach((line, row) => {
      for (let col = 0; col < line.length; col++) {
        if (line[col] !== 'E') continue;
        for (const c of [col - 1, col + 1]) {
          if (c >= 0 && c < line.length) flanks.add(cellKey({ face: col < L3.fold ? 'A' : 'B', col: c, row }));
        }
      }
    });
    expect(new Set((L3.gates ?? []).map(cellKey))).toEqual(flanks);
  });
});

describe('T21·3 落笔：折痕那一列**成对**落笔（用户连着三轮的真因）', () => {
  /**
   * `BLANK` 的 `fold = 14` → 折痕两侧最内列是 **col 13 | col 14**，两格在世界上同一个点。
   *
   * 用户三次报的"我连续画了一条硬砖，中间却断了一格"（`==============.=============`）
   * 病灶都在这里：拾取只能给出 A 面（`pick.test.ts` 钉着这条前提），所以 `B:fold` 根本
   * 落不了笔；而两格重合 ⇒ 画面上看不出区别。修法是在落笔这一层**同时写两面**。
   */
  const FOLD_L = BLANK.fold - 1;
  const FOLD_R = BLANK.fold;
  /** 折痕左（A 面最内列）与右（B 面最内列）—— 两格是同一个点。 */
  const L = (row: number): Cell => ({ face: 'A', col: FOLD_L, row });
  const R = (row: number): Cell => ({ face: 'B', col: FOLD_R, row });

  it('在 A:13 画砖 → B:14 同时有砖；反过来也一样', () => {
    const fromA = paintTerrain(BLANK, L(3), 'X');
    expect(fromA.tiles[3]?.[FOLD_L]).toBe('X');
    expect(fromA.tiles[3]?.[FOLD_R]).toBe('X');

    const fromB = paintTerrain(BLANK, R(3), 'X');
    expect(fromB.tiles[3]?.[FOLD_L]).toBe('X');
    expect(fromB.tiles[3]?.[FOLD_R]).toBe('X');
  });

  it('橡皮在折痕那一列也成对：擦一格 → 两面一起空', () => {
    // 不然会留下一面"隐形"的砖（画面上看着没了、支撑还在）。
    let def = paintTerrain(BLANK, L(3), '=');
    def = paint(def, { kind: 'erase' }, R(3));
    expect(def.tiles[3]?.[FOLD_L]).toBe('.');
    expect(def.tiles[3]?.[FOLD_R]).toBe('.');
  });

  it('梯 / 杆也成对（折痕处爬不上去就白搭）', () => {
    expect(paintTerrain(BLANK, L(3), 'H').tiles[3]?.[FOLD_R]).toBe('H');
    expect(paintTerrain(BLANK, R(3), '-').tiles[3]?.[FOLD_L]).toBe('-');
  });

  it('**物件不成对**：宝物 `G` 只落在拾取选中的那一面', () => {
    // 两颗同一位置的宝物会让 HUD 的"还剩 N 块"和"集齐才开闸门"都变成废话。
    const def = paint(BLANK, { kind: 'tile', glyph: 'G' }, L(3));
    expect(def.tiles[3]?.[FOLD_L]).toBe('G');
    expect(def.tiles[3]?.[FOLD_R]).toBe('.');
  });

  it('折痕**之外**的格子照旧只动一格（成对不是"顺手多画"）', () => {
    const def = paintTerrain(BLANK, { face: 'A', col: FOLD_L - 1, row: 3 }, 'X');
    expect(def.tiles[3]?.[FOLD_L - 1]).toBe('X');
    expect(def.tiles[3]?.[FOLD_L]).toBe('.');
    expect(def.tiles[3]?.[FOLD_R]).toBe('.');
  });

  it('`foldTwin` **按列判**（面写错了也照样认得这一对），别的列一律 `null`', () => {
    expect(foldTwin(L(2), BLANK.fold)).toEqual(R(2));
    expect(foldTwin(R(2), BLANK.fold)).toEqual(L(2));
    // 面写反了（`col 14` 却写 `face:'A'`）也认 —— 按列判的意义就在这里。
    expect(foldTwin({ face: 'A', col: FOLD_R, row: 2 }, BLANK.fold)).toEqual(L(2));
    expect(foldTwin({ face: 'A', col: 5, row: 2 }, BLANK.fold)).toBeNull();
    expect(foldTwin(D(-7, -7), BLANK.fold)).toBeNull();
  });
});

describe('T21·3 落笔：甲板接头（两格一个手势）', () => {
  const W = (col: number, row: number): Cell => ({ face: 'A', col, row });

  it('**L3 手写的两处接头**：方向推得出来，且 `down` 一定在候选里（默认取它的理由）', () => {
    // 这一条是这套推断的全部依据：作者手写的那两处，方向都落在 `blockedDirs` 里；
    // 而且两处都是 `down` —— 与"`down` = 离开当前支撑"这条房规一致。
    for (const j of L3.joints ?? []) {
      const dirs = blockedDirs(L3, j.wall) ?? [];
      expect(dirs).toContain(j.enterDir); // 规则⑧：作者写的必须是那一格"本来就堵住"的方向
      expect(dirs).toContain('down');
    }
  });

  it('放一个：默认 `down`，并说清"在哪一格按哪个键去哪块甲板"；不改入参', () => {
    // 地板砖放在 (5,1) → (5,2) 站得住，而它的 `down`（下面那格是砖）走不通。
    const def = setWallGlyph(BLANK, W(5, 1), 'X');
    const placed = placeJoint(def, { x: -7, z: -7 }, W(5, 2));
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.dir).toBe('down');
    expect(placed.def.joints).toEqual([{ deck: { x: -7, z: -7 }, wall: W(5, 2), enterDir: 'down' }]);
    expect(placed.why).toContain('down');
    expect(def.joints).toBeUndefined(); // 纯函数：原对象一个字没动
  });

  it('梯子井里那一格：四向**都不会被挡住** → 拒绝（那样的接头永远不会被触发）', () => {
    // col 2 是一条四格高的连续梯子（梯子格站得住、上下都通），左右是空的。
    // 这种格子上放接头，四个键里没有一个"本来走不通" —— 按下只会正常走位/坠落。
    const shaft: LevelDef = {
      id: 'SHAFT',
      name: '梯子井',
      fold: 3,
      tiles: ['..H...', '..H...', '..H...', '..H...'],
    };
    expect(blockedDirs(shaft, W(2, 1))).toEqual([]);
    const placed = placeJoint(shaft, { x: -7, z: -7 }, W(2, 1));
    expect(placed.ok).toBe(false);
    if (placed.ok) return;
    expect(placed.why).toContain('都走得通');
  });

  it('第一端点到墙面（不是甲板）→ 拒绝并说清手势顺序', () => {
    const placed = placeJoint(BLANK, { x: -7, z: -7 }, { face: 'I', col: -7, row: -7 });
    expect(placed.ok).toBe(false);
    if (placed.ok) return;
    expect(placed.why).toContain('墙面');
  });

  it('同一格墙 / 同一块甲板只留一个接头：再放一次是**替换**', () => {
    const def = setWallGlyph(BLANK, W(5, 1), 'X');
    const once = placeJoint(def, { x: -7, z: -7 }, W(5, 2));
    if (!once.ok) throw new Error('夹具应当能放');
    const twice = placeJoint(once.def, { x: -7, z: -7 }, W(5, 2));
    if (!twice.ok) throw new Error('替换也应当能放');
    expect(twice.def.joints).toHaveLength(1);
    const moved = placeJoint(once.def, { x: -5, z: -5 }, W(5, 2));
    if (!moved.ok) throw new Error('挪甲板也应当能放');
    expect(moved.def.joints).toEqual([{ deck: { x: -5, z: -5 }, wall: W(5, 2), enterDir: 'down' }]);
  });
});

describe('T21·3 落笔：看守（敌人）', () => {
  it('点一次放一个；同一格再点一次撤掉（与宝物同一套手势）', () => {
    const b: Brush = { kind: 'enemy', enemyKind: 'stalker' };
    const one = paint(BLANK, b, A(5, 1));
    expect(one.enemies).toEqual([{ kind: 'stalker', cell: A(5, 1) }]);
    expect(paint(one, b, A(5, 1)).enemies).toEqual([]);
  });

  it('`kind` 由**笔**决定：同一格用另一支笔点会换成那种', () => {
    const one = paint(BLANK, { kind: 'enemy', enemyKind: 'drone' }, A(5, 1));
    const two = paint(one, { kind: 'enemy', enemyKind: 'stalker' }, A(5, 1));
    expect(two.enemies).toEqual([{ kind: 'stalker', cell: A(5, 1) }]);
  });

  it('多个看守各自独立，不互相顶掉', () => {
    let def = paint(BLANK, { kind: 'enemy', enemyKind: 'drone' }, A(5, 1));
    def = paint(def, { kind: 'enemy', enemyKind: 'stalker' }, A(9, 3));
    expect(def.enemies).toHaveLength(2);
  });

  it('甲板塔上也能放（攀爬者会上岛）', () => {
    const def = paint(BLANK, { kind: 'enemy', enemyKind: 'stalker' }, D(-7, -7, 1));
    expect(def.enemies?.[0]?.cell).toEqual({ face: 'I', col: -7, row: -7, level: 1 });
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
