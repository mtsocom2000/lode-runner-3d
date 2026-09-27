import { cellKey, type Cell } from '../types';
import { deckKey, type DeckCell } from '../world/deck';
import { faceOf } from '../world/fold';
import { TILE_CHARS, type EnemyKind, type LevelDef, type TileKind } from '../world/tiles';

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
  /** 出厂：墙上写一个字形（`X` / `=` / `.` / `H` / `-` / `G` / `E`）。 */
  | { readonly kind: 'tile'; readonly glyph: string }
  /** 甲板：板 / 杆 / 梯子（画在**这一格自己的层**上）。 */
  | { readonly kind: 'deck'; readonly mode: DeckMode }
  /**
   * **看守**（电脑控制的敌人）：这一格有就撤掉、没有就放一个（`kind` 决定放哪种）。
   *
   * 用户问："为什么不能指定电脑控制的看守位置？" —— 现在能了。一个键既是"放"也是"撤"，
   * 与宝物那支笔同一个手势。
   */
  | { readonly kind: 'enemy'; readonly enemyKind: EnemyKind }
  /** 橡皮：墙上抹成空、甲板上删掉。 */
  | { readonly kind: 'erase' }
  /** 玩家出生点。 */
  | { readonly kind: 'spawn' }
  /**
   * **宝物**：甲板上放"地台上的宝物"、墙面上放"芯片 `G`" —— **一支笔,两种落脚处**。
   *
   * 用户的原话："宝物无法放置在砖块上，似乎只能放置在场景中央的水面附近。" —— 他说得对，
   * 而且他想要的正是**原版 Lode Runner 的做法**：金子撒在砖面上，集齐才开出口。
   * 所以这一支笔按**指到哪儿**自己分派（`toggleTreasure` / 墙上的 `G` 字形），
   * 用户不必知道内部是两套数据。两支笔点一次都是"放"，再点一次都是"撤"。
   */
  | { readonly kind: 'treasure' };

/** 字形 → 瓦片种类，认不出来就 `null`（UI 拿它给按钮标"这支笔能不能用"）。 */
export function tileOfGlyph(glyph: string): TileKind | null {
  return TILE_CHARS[glyph] ?? null;
}

/**
 * **能成对落笔的地形**：砖 / 硬砖 / 空 / 梯 / 杆。
 *
 * 不含 `treasure`（`G`）与 `exit`（`E`）：那两样是**物件**而不是地形 —— 折痕那一对是同一个点，
 * 两处都放一颗宝物会让"集齐"变成两句废话，两处都放出口更是没有意义。物件就放在拾取选中的
 * 那一面（画面上是同一个点，看不出区别）。
 */
const MIRRORED: readonly TileKind[] = ['dig', 'hard', 'empty', 'ladder', 'bar'];

/**
 * **折痕那一对的另一半**：`A:fold-1` 与 `B:fold` 在世界里**是同一个点**
 * （见 `fold.ts` 的 `halfExtent`：`halfExtent(fold) = fold - 1`）。
 *
 * ## 为什么必须有这个函数（用户连着三轮报的同一个坑）
 *
 * 两格重合 ⇒ 拾取**只能**给出其中一面。`.paint` 的拾取是先判 A 面（`pick.ts` 里
 * `if (x < wallReach)` 在前），而折痕那一列的 A/B 两点满足**同一个**判据 —— 于是
 * `B:fold` 永远被判成 `A:fold-1`，**那一列根本画不上**。
 *
 * 用户的症状因此是：他连续拖着画一整条硬砖（`==============.=============`），
 * 中间那一格却始终是 `.` —— 不是他漏了，是工具不给画。而两格重合意味着**画面上看不出区别**：
 * 只有 A 侧有砖、和两侧都有砖，看起来一模一样。
 *
 * 所以落笔必须**成对**：地形（砖 / 梯 / 杆 / 空）在折痕那一列是"一个东西"，同时写两面。
 */
export function foldTwin(at: Cell, fold: number): Cell | null {
  // **按列判**，不按 `at.face`：面本来就是列的函数（`faceOf(col, fold) = col < fold ? 'A' : 'B'`），
  // 让调用方把面写对是多余的负担 —— 而且写错了会**静默不生效**（那种最坏）。
  if (at.face === 'I') return null;
  if (at.col === fold - 1) return { face: faceOf(fold, fold), col: fold, row: at.row };
  if (at.col === fold) return { face: faceOf(fold - 1, fold), col: fold - 1, row: at.row };
  return null;
}

/**
 * **地形落笔**：折痕那一列**两面一起写**（见 `foldTwin`），其余格子照旧只动一格。
 *
 * 甲板格（面 `'I'`）不走这里 —— 它属于另一套坐标系，`foldTwin` 对它返回 `null`。
 */
export function paintTerrain(def: LevelDef, at: Cell, glyph: string): LevelDef {
  const first = overwrite(def, at, glyph);
  const twin = at.face === 'I' ? null : foldTwin(at, def.fold);
  return twin === null ? first : overwrite(first, twin, glyph);
}

/** 落笔。认不出来的笔 / 画不到的位置 → **原样返回同一个对象**（引用相等让调用方省一次重画）。 */
export function paint(def: LevelDef, brush: Brush, at: Cell): LevelDef {
  switch (brush.kind) {
    case 'tile': {
      // 出口走**专线**：它自带两侧的闸门（见 `placeExit`）。
      if (brush.glyph === 'E') return placeExit(def, at);
      const kind = tileOfGlyph(brush.glyph);
      // 地形成对；物件（宝物 `G`）只落在拾取选中的那一面。
      if (kind !== null && MIRRORED.includes(kind)) return paintTerrain(def, at, brush.glyph);
      return overwrite(def, at, brush.glyph);
    }
    case 'erase':
      return at.face === 'I' ? removeDeck(def, at) : paintTerrain(def, at, '.');
    case 'deck':
      return setDeck(def, at, brush.mode);
    case 'spawn':
      return { ...def, spawn: { face: at.face, col: at.col, row: at.row } };
    case 'treasure':
      return toggleAnyTreasure(def, at);
    case 'enemy':
      return toggleEnemy(def, at, brush.enemyKind);
  }
}

/**
 * **出口**（`E`）—— 放出口时**自动在两侧设闸门**（用户 2026-09-22 的要求）。
 *
 * 用户的原话："出口设计的时候没有给它设计阻拦的地块，这样使得出口随时可以经过……摆放出口
 * 应该自动在两侧设置障碍物，在宝物取得之后障碍物自动消除。" 这正是**原版 Lode Runner 的出口**：
 * 一个凹槽，左右各一块**假砖** —— 看着是墙，集齐金子之后消失。
 *
 * 本作里那两块假砖就是**闸门**（`LevelDef.gates`）：砖是 `=`（硬砖，挖不动），集齐宝物后
 * `openGates` 把它们换成**梯子**（`goals.ts`），于是出口从两侧都进得去。手工画的 L1/L2/L3
 * 一直是这么排的（L3 的 `r11` 就是 `=E=`）—— 这个函数只是把那条房规搬进工具里，
 * 免得每个放出口的人都要自己记得摆两块砖、还要记得登记进 `gates`。
 *
 * 两侧**一律设成硬砖**（哪怕原本是可挖的 `X`）：闸门必须挡得住，而"集齐后就消失"这件事
 * 要求它是闸门 —— 可挖的砖既挡不住也消不掉。
 *
 * **幂等**：重复画同一个出口不会把闸门登记成两份（先按格子去重再追加）。
 */
export function placeExit(def: LevelDef, at: Cell): LevelDef {
  if (at.face === 'I') return def;
  const cols = def.fold * 2;
  if (at.col < 0 || at.col >= cols || at.row < 0 || at.row >= def.tiles.length) return def;

  let next = setWallGlyph(def, at, 'E');
  const twin = foldTwin(at, def.fold);
  const flank: Cell[] = [];
  for (const col of [at.col - 1, at.col + 1]) {
    if (col < 0 || col >= cols) continue; // 贴边时只有一侧有闸门
    const cell: Cell = { face: faceOf(col, def.fold), col, row: at.row };
    // 出口正好落在折痕那一列时，`at.col ± 1` 里有一个**就是它自己的另一半**（同一个点）——
    // 给那儿砌墙等于把闸门砌在出口自己身上，跳过。
    if (twin !== null && cell.col === twin.col) continue;
    next = setWallGlyph(next, cell, '=');
    flank.push(cell);
  }
  const kept = (next.gates ?? []).filter(
    (g) => !flank.some((f) => f.face === g.face && f.col === g.col && f.row === g.row),
  );
  return { ...next, gates: [...kept, ...flank] };
}

/**
 * 写一个字形；若**抹掉的正好是一个出口**，它两侧那对闸门也跟着撤。
 *
 * 不然闸门会越积越多：出口挪个地方，旧位置就留下两块"永远开不了"的硬砖（它们只属于
 * 那个已经不存在的出口）。判据是**旧字形**，不是新字形 —— `setWallGlyph` 返回同一个对象
 * 就说明这一笔哪儿也没画到，那就什么都别动。
 */
function overwrite(def: LevelDef, at: Cell, glyph: string): LevelDef {
  const next = setWallGlyph(def, at, glyph);
  if (next === def || glyph === 'E') return next;
  if (glyphTileAt(def, at) !== 'exit') return next;
  const before = next.gates ?? [];
  const kept = before.filter(
    (g) => !(g.face === at.face && g.row === at.row && (g.col === at.col - 1 || g.col === at.col + 1)),
  );
  return kept.length === before.length ? next : { ...next, gates: kept };
}

/** 墙格上此刻**是哪种瓦片**（越界 / 甲板格 → `null`）。给"宝物"那支笔判断该放还是该撤。 */
function glyphTileAt(def: LevelDef, at: Cell): TileKind | null {
  if (at.face === 'I') return null;
  const line = def.tiles[at.row];
  if (line === undefined || at.col < 0 || at.col >= line.length) return null;
  return TILE_CHARS[line[at.col] ?? '.'] ?? null;
}

/**
 * **宝物**（一支笔，两种落脚处）：甲板格 → `treasures` 列表；墙格 → `G` 字形。
 * 两者点一次都是"放"、再点一次都是"撤"。
 */
export function toggleAnyTreasure(def: LevelDef, at: Cell): LevelDef {
  if (at.face === 'I') return toggleTreasure(def, at);
  return setWallGlyph(def, at, glyphTileAt(def, at) === 'treasure' ? '.' : 'G');
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

/**
 * 删掉甲板某一格。**点方块顶面时抹掉的是方块本身** —— 见下面那段。
 *
 * ## "顶面 = 上一层"是**画**的规矩，不是**擦**的规矩（用户 2026-09-21）
 *
 * 拾取把"点方块顶面"翻译成**上面那一层**（那是叠方块的手势）。画东西时这条正是我们要的，
 * 但**擦**的时候，用户点的是"这块方块"，而顶层 `L+1` 通常是空的 —— 于是
 * `removeDeck` 扑空、什么都没发生。用户的原话：*"橡皮似乎不怎么工作，很难擦掉已经画好的物体。"*
 *
 * 所以擦除多一步**回退到下面一层**：`L` 上没东西就试 `L-1`。一层足够 —— 方块是一层一层叠的，
 * 而"隔着两层去擦"只可能是点歪了，那时**不动**比动更安全。
 */
export function removeDeck(def: LevelDef, at: Cell): LevelDef {
  if (at.face !== 'I') return def;
  const level = at.level ?? 0;
  const before = def.deck ?? [];
  const rest = before.filter((c) => !(c.x === at.col && c.z === at.row && (c.level ?? 0) === level));
  if (rest.length !== before.length) return { ...def, deck: rest };
  // 回退一层（只在"顶面拾取"把目标抬高了时才会走到这里）。
  if (level <= 0) return def;
  const below = before.filter((c) => !(c.x === at.col && c.z === at.row && (c.level ?? 0) === level - 1));
  if (below.length === before.length) return def;
  return { ...def, deck: below };
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

/**
 * **看守**（电脑控制的敌人）：这一格有就撤掉、没有就放一个。
 *
 * 与宝物那支笔同一套手势（一个键既是"放"也是"撤"）。`kind` 由**笔**决定，不由这里猜 ——
 * 于是"这一关该放无人机还是攀爬者"是**用户的选择**，而"这一格有没有敌人"是**数据的现状**。
 *
 * 敌人的出生格**可以不在墙上**（甲板塔上也行，攀爬者会上岛）；站不住由校验的
 * `enemyStandable` 报出来 —— 那是**错误**级（`createSim` 会当场抛）。
 */
export function toggleEnemy(def: LevelDef, at: Cell, kind: EnemyKind): LevelDef {
  // **层也要带上**（甲板塔上的看守）：`Cell` 的层只有面 `'I'` 有意义，省略 = 0。
  const level = at.level ?? 0;
  const cell: Cell = {
    face: at.face,
    col: at.col,
    row: at.row,
    ...(at.face === 'I' && level !== 0 ? { level } : {}),
  };
  const key = cellKey(cell);
  const before = def.enemies ?? [];
  const existing = before.find((e) => cellKey(e.cell) === key);
  const rest = before.filter((e) => cellKey(e.cell) !== key);
  // 同一种 → 撤掉（"点一次放、再点一次撤"）；换了一种 → **替换**（与甲板那支笔同一条规矩）。
  if (existing !== undefined && existing.kind === kind) return { ...def, enemies: rest };
  return { ...def, enemies: [...rest, { kind, cell }] };
}
