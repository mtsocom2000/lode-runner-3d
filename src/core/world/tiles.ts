import type { Cell } from '../types';
import { buildDeck } from './deck';
import type { DeckCell, DeckJoint } from './deck';

/**
 * 瓦片语义与关卡装载。
 *
 * 关卡就是**一张原版 2D 关卡**：一个字符网格。折起来之后 cols 0..fold-1 落到墙 A，
 * cols fold..2×fold-1 落到墙 B（见 fold.ts）。所以这里不做任何折叠相关的事，
 * 只负责"字形 → 语义"和"这份数据合不合法"。
 *
 * 装载失败**不抛异常**，而是返回一份带位置的错误表 —— 因为它要同时服务两条路径：
 * T1 的装载、T8 的关卡校验（validator 要把所有问题一次列全，不是遇到第一个就停）。
 */

/** 瓦片语义。字形与它的对应关系见 TILE_CHARS，与架构文档 §四 的关卡格式一致。 */
export type TileKind = 'dig' | 'hard' | 'empty' | 'ladder' | 'bar' | 'treasure' | 'exit';

/** 7 种字形，一个不多一个不少。 */
export const TILE_CHARS: Readonly<Record<string, TileKind>> = {
  X: 'dig', // 可挖砖
  '=': 'hard', // 硬砖（不可挖）
  '.': 'empty', // 空
  H: 'ladder', // 梯
  '-': 'bar', // 横杆
  G: 'treasure', // 宝物（数据芯片）
  E: 'exit', // 出口
};

/** 与 TILE_CHARS 的键一一对应，供测试与工具遍历。 */
export const TILE_GLYPHS = ['X', '=', '.', 'H', '-', 'G', 'E'] as const;

export interface LevelDef {
  readonly id: string;
  readonly name: string;
  /** 每面的列数（= 折痕的列索引）。于是总列数必须是 2×fold。 */
  readonly fold: number;
  /** 每行一个字符串，行索引 0 = **最底行**。所有行必须等长。 */
  readonly tiles: readonly string[];
  /**
   * 甲板（岛台）的格子。**可选** —— 不带甲板的关卡照旧。
   *
   * 为什么甲板不能写进 `tiles` 的字形里：① `cols` 被 `foldMismatch` 钉死成 2×fold，
   * 网格没有多余列；② `TILE_CHARS` 明写"7 种字形，一个不多一个不少"。
   * 所以甲板只能走**独立字段**（见 `deck.ts` 的文件头）。
   */
  readonly deck?: readonly DeckCell[];
  /**
   * 甲板与墙的接头（显式声明，不由几何推）——理由见 `deck.ts` 的 `DeckJoint`。
   * 本关卡自带自己的连接关系，core 只负责相信它。
   */
  readonly joints?: readonly DeckJoint[];
  /**
   * 出口**闸门**：初始是硬砖、集齐宝物后被 `openExit` 换成梯子的格子（T13）。
   *
   * 为什么**显式声明**而不是"看哪块砖挨着出口就把哪块开掉"：紧挨出口的硬砖可能只是布景
   * （一堵墙、一个角落），推导会把它们一起打开。与甲板接头选"显式声明"是同一条理由
   * （见 `deck.ts` 的 `DeckJoint`）。
   *
   * 为什么**不必去重**（甲板那边 `buildDeck` 要去）：闸门不参与图节点身份 —— 甲板写重复
   * 会变成两个节点，而闸门写重复只是让 `openExit` 对同一格换两次梯，幂等。
   */
  readonly gates?: readonly Cell[];
  /**
   * 待取的**宝物**所在的甲板格（T13）。可选 —— 没有宝物的关卡照旧。
   *
   * 为什么是**甲板格**而不是 `tiles` 里的 `G` 字形：用户的要求是"水中央地台上有一个必须要
   * 取得的宝物"，而地台属于甲板坐标系（面 `'I'`、`(x,z)` 整数格），不是墙的 `(col, row)`。
   * `G` 字形留给**墙上**的宝物（后续关卡用）。
   */
  readonly treasures?: readonly DeckCell[];
}

export type LoadError =
  | { readonly kind: 'noRows' }
  | { readonly kind: 'ragged'; readonly row: number; readonly expected: number; readonly got: number }
  | { readonly kind: 'badChar'; readonly row: number; readonly col: number; readonly ch: string }
  | { readonly kind: 'foldMismatch'; readonly fold: number; readonly cols: number };

export interface Level {
  readonly id: string;
  readonly name: string;
  readonly fold: number;
  readonly cols: number;
  readonly rows: number;
  /**
   * 行主序的瓦片表，长度 cols×rows，行 0 = 最底。
   *
   * 为什么除了 `at()` 还留一份**裸数组**：`at` 是闭包，闭包不能 JSON 序列化，
   * 而 `SimState` 必须是纯数据（要能存盘 / 做回放比对）；T11 的挖/回填也要**复制**它来改。
   * 所以"查询"走 `at`，"持有/复制/序列化"走 `grid`。
   */
  readonly grid: readonly TileKind[];
  /** 越界返回 undefined —— 调用方必须显式处理边界，不能拿到一个"看起来像空砖"的值。 */
  at(col: number, row: number): TileKind | undefined;
  /**
   * 甲板格。没有甲板的关卡是**空数组**（不是 undefined）—— 与 `game.nodes` 那条
   * "非节点返回 false / 空数组，不返回 undefined"同一个理由：省掉满地的空值判断。
   */
  readonly deck: readonly DeckCell[];
  /** 甲板与墙的接头。没有就是空数组。 */
  readonly joints: readonly DeckJoint[];
  /** 出口闸门（T13）。没有就是空数组 —— 与 `deck` 同一条"空数组而非 undefined"的理由。 */
  readonly gates: readonly Cell[];
  /** 待取的宝物（T13）。没有就是空数组。 */
  readonly treasures: readonly DeckCell[];
}

export type ParseResult =
  | { readonly ok: true; readonly level: Level }
  | { readonly ok: false; readonly errors: readonly LoadError[] };

export function parseLevel(def: LevelDef): ParseResult {
  const errors: LoadError[] = [];

  const rows = def.tiles.length;
  if (rows === 0) return { ok: false, errors: [{ kind: 'noRows' }] };

  const cols = def.tiles[0]?.length ?? 0;

  def.tiles.forEach((line, row) => {
    if (line.length !== cols) {
      errors.push({ kind: 'ragged', row, expected: cols, got: line.length });
    }
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === undefined) continue;
      if (TILE_CHARS[ch] === undefined) errors.push({ kind: 'badChar', row, col, ch });
    }
  });

  if (cols !== def.fold * 2) {
    errors.push({ kind: 'foldMismatch', fold: def.fold, cols });
  }

  if (errors.length > 0) return { ok: false, errors };

  // 只有全部合法才建格子表 —— 避免"半份数据"被当成可用关卡传下去。
  const grid: TileKind[] = [];
  for (const line of def.tiles) {
    for (const ch of line) {
      const kind = TILE_CHARS[ch];
      if (kind !== undefined) grid.push(kind);
    }
  }

  const at = (col: number, row: number): TileKind | undefined => {
    if (col < 0 || col >= cols || row < 0 || row >= rows) return undefined;
    return grid[row * cols + col];
  };

  // 甲板走 `buildDeck` 而不是直接透传 `def.deck`：它会**去重**（同一格写两次不该变成两个节点），
  // 且返回的是纯数据，`Level` 依然可序列化。
  const deck = buildDeck(def.deck ?? []).cells;

  return {
    ok: true,
    level: {
      id: def.id,
      name: def.name,
      fold: def.fold,
      cols,
      rows,
      grid,
      at,
      deck,
      joints: def.joints ?? [],
      gates: def.gates ?? [],
      treasures: def.treasures ?? [],
    },
  };
}
