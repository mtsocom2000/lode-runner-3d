import type { Cell } from '../types';
import { deckKey, type DeckCell } from '../world/deck';
import { TILE_CHARS, type LevelDef, type TileKind } from '../world/tiles';

/**
 * **编辑器的"落笔"**（T21 阶段 3）—— 全部是**纯函数**：`(关卡, 笔, 格子) → 新关卡`。
 *
 * ## 为什么落笔必须在 core 里、而且必须是纯的
 *
 * 编辑器的 UI 只该做两件事：把鼠标位置换成**格子**、把结果画出来。至于"往这一格画一块砖
 * 之后关卡数据长什么样"—— 那是**关卡数据的规则**，与"按钮长什么样"无关。
 *
 * 放进纯函数有三个直接好处：
 *
 * 1. **可单测**：`(关卡, 笔, 格) → 新关卡` 不需要 DOM、不需要 three，边界情形（越界、
 *    改到折痕那一对、甲板换层、清掉最后一个宝物……）全都能钉住；
 * 2. **撤销/重做免费**：纯函数天然给出一串不可变快照 —— 阶段 4 的 undo 只要把旧 def 压栈；
 * 3. **与热重建对得上**：`buildWorld(def)` 吃的就是 `LevelDef`，落笔给的就是 `LevelDef`，
 *    中间不需要"再拼一次数据"这种第二次转换。
 *
 * ## 一条贯穿的纪律：**不合法也要能画**
 *
 * 所有函数对越界 / 形状不对的输入**原样返回**（而不是抛）—— 编辑器里关卡长期处于半成品，
 * "画不上"绝不该变成一个异常。真正的把关在 `validate.ts`（它是给人看的清单）。
 */

/** 甲板格的三种形态（`hang` / `ladder` 都省略在 `DeckCell` 里，这里只是给 UI 一个名字）。 */
export type DeckMode = 'board' | 'hang' | 'ladder';

/**
 * 一支"笔"。它表达的是**要往这一格放什么**，不表达"哪个按钮被选中"——
 * 于是 UI 换皮、加快捷键、加撤销都不用碰这一段。
 */
export type Brush =
  /** 往墙上写一个字形（`X` / `=` / `.` / `H` / `-` / `G` / `E`）。 */
  | { readonly kind: 'tile'; readonly glyph: string }
  /** 甲板：板 / 杆 / 梯子（画在**这一格自己的层**上）。 */
  | { readonly kind: 'deck'; readonly mode: DeckMode }
  /** 橡皮：墙上抹成空、甲板上删掉。 */
  | { readonly kind: 'erase' }
  /** 玩家出生点。 */
  | { readonly kind: 'spawn' }
  /** 宝物：有就收走、没有就放一颗（这样一键既是"放"也是"撤"）。 */
  | { readonly kind: 'treasure' };

/** 字形 → 瓦片种类，认不出来就 `null`（UI 拿它给按钮标"这支笔能不能用"）。 */
export function tileOfGlyph(glyph: string): TileKind | null {
  return TILE_CHARS[glyph] ?? null;
}

/** 落笔。认不出来的笔 / 画不到的位置 → **原样返回同一个对象**（引用相等让调用方省一次重画）。 */
export function paint(def: LevelDef, brush: Brush, at: Cell): LevelDef {
  switch (brush.kind) {
    case 'tile':
      return setWallGlyph(def, at, brush.glyph);
    case 'erase':
      return at.face === 'I' ? removeDeck(def, at) : setWallGlyph(def, at, '.');
    case 'deck':
      return setDeck(def, at, brush.mode);
    case 'spawn':
      return { ...def, spawn: { face: at.face, col: at.col, row: at.row } };
    case 'treasure':
      return toggleTreasure(def, at);
  }
}

/**
 * 墙上某一格改成某个字形。**越界 / 不是墙格 / 字形不认识 → 原样返回。**
 *
 * 逐字符替换而不是重排整行：行长必须保持不变（`parseLevel` 会查行长齐不齐），
 * 替换一个字符天然满足这一条 —— 重排就得自己保证不弄丢一位。
 */
export function setWallGlyph(def: LevelDef, at: Cell, glyph: string): LevelDef {
  if (at.face === 'I') return def;
  if (TILE_CHARS[glyph] === undefined) return def;
  const cols = def.fold * 2;
  if (at.col < 0 || at.col >= cols || at.row < 0 || at.row >= def.tiles.length) return def;

  const tiles = def.tiles.map((line, row) =>
    row === at.row ? `${line.slice(0, at.col)}${glyph}${line.slice(at.col + 1)}` : line,
  );
  return { ...def, tiles };
}

/**
 * 甲板某一格设成板 / 杆 / 梯子 —— **原来是什么都覆盖**（这就是"替换"）。
 *
 * **层 0 省略不写**（与 `cellKey` / `parseCell` 同一条约定）：手画的关卡不该因为编辑器
 * 多写一个 `level: 0` 而与手写的关卡看起来不一样。
 */
export function setDeck(def: LevelDef, at: Cell, mode: DeckMode): LevelDef {
  if (at.face !== 'I') return def;
  const level = at.level ?? 0;
  const rest = (def.deck ?? []).filter(
    (c) => !(c.x === at.col && c.z === at.row && (c.level ?? 0) === level),
  );
  const cell: DeckCell = {
    x: at.col,
    z: at.row,
    ...(level === 0 ? {} : { level }),
    ...(mode === 'hang' ? { hang: true } : {}),
    ...(mode === 'ladder' ? { ladder: true } : {}),
  };
  return { ...def, deck: [...rest, cell] };
}

/** 删掉甲板某一格（只删**那一层**）。不在那儿就原样返回。 */
export function removeDeck(def: LevelDef, at: Cell): LevelDef {
  if (at.face !== 'I') return def;
  const level = at.level ?? 0;
  const before = def.deck ?? [];
  const rest = before.filter((c) => !(c.x === at.col && c.z === at.row && (c.level ?? 0) === level));
  if (rest.length === before.length) return def;
  return { ...def, deck: rest };
}

/** 宝物：这一格有就收走、没有就放一颗。 */
export function toggleTreasure(def: LevelDef, at: Cell): LevelDef {
  if (at.face !== 'I') return def;
  const level = at.level ?? 0;
  const key = deckKey({ x: at.col, z: at.row, level });
  const before = def.treasures ?? [];
  const rest = before.filter((t) => deckKey(t) !== key);
  if (rest.length !== before.length) return { ...def, treasures: rest };
  return { ...def, treasures: [...before, { x: at.col, z: at.row, ...(level === 0 ? {} : { level }) }] };
}
