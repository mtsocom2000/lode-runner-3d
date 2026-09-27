import type { Cell } from '../types';
import type { Dir } from '../rules/movement';
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

/**
 * 瓦片语义。字形与它的对应关系见 TILE_CHARS，与架构文档 §四 的关卡格式一致。
 *
 * `'pit'` **没有字形、也不在 `TILE_CHARS` 里** —— 它不是关卡作者能画的东西，而是**挖的结果**：
 * `rules/dig.ts` 的 `applyDig` 把一格 `'dig'` 变成 `'pit'`，回填时变回来。
 *
 * ## 为什么坑要是一个**瓦片**，而不是"空 + 一张待回填清单"
 *
 * 因为"坑"是一个**地形事实**（一个一格深、有底的口袋），而不是记账：`world/graph.ts` 的
 * `supportOf` 要能只拿 `(level, cell)` 就回答"这一格站得住吗"，`rules/reach.ts` 的可达性、
 * 移动、以及渲染层的砖块层**都只认瓦片表**。把"这里其实是坑"另存一份在 `SimState.fills` 里，
 * 就是同一件事有两个出处 —— 那正是本仓库反复栽过的那类 bug（红线：判据只能有一个出处）。
 *
 * `fills` 仍然存在，但它现在只说一件**不同**的事：**这个坑还有几个 tick 会自己长回来**
 * （以及"有人占着它 → 加速"用的那个倒计时）。地形形状归瓦片表，回填进度归 `fills`。
 *
 * 依据是归档原型 `legacy/canyon.html:92-93` 的 `hAt(x,y)`：`h = Math.max(1, h-1)` ——
 * **挖出来的坑永远不会挖穿世界**，坑底永远留着一格。所以坑是"口袋"，掉进去就出不来了
 * （除非土长回来；那正是原版的 `buriedPlayer()` / `buriedEnemy()`，见同文件 127-129 行）。
 */
export type TileKind = 'dig' | 'hard' | 'empty' | 'ladder' | 'bar' | 'treasure' | 'exit' | 'pit';

/** 7 种字形，一个不多一个不少。`'pit'` 刻意**不在其中**（它是挖出来的，不是画出来的）。 */
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
   * 出口**闸门**：初始是硬砖、集齐宝物后**消失**（变成空格）的格子（T13）。
   *
   * 为什么**显式声明**而不是"看哪块砖挨着出口就把哪块开掉"：紧挨出口的硬砖可能只是布景
   * （一堵墙、一个角落），推导会把它们一起打开。与甲板接头选"显式声明"是同一条理由
   * （见 `deck.ts` 的 `DeckJoint`）。
   *
   * 为什么**不必去重**（甲板那边 `buildDeck` 要去）：闸门不参与图节点身份 —— 甲板写重复
   * 会变成两个节点，而闸门写重复只是让 `openGates` 对同一格清两次，幂等。
   *
   * > 曾经把它们换成**梯子**（"这样一定进得去"），用户集齐宝物后当场问"出口变成了梯子，
   * > 这是怎么回事"。见 `rules/goals.ts` 文件头：现在是**消失**，而"打开之后进不进得去"
   * > 由 `exitGated` 规则负责报出来。
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
  /**
   * 敌人（T12）。可选 —— 没有敌人的关卡照旧（概念场景就是）。
   *
   * 为什么**不进** `Level`：`Level` 是**规则操作的那张几何**（图、支撑、落水判定都只吃它），
   * 而敌人是**实体**（`SimState.entities`），不是地形。`createSim` 直接吃 `LevelDef`，
   * 所以它从这里读出生格就够 —— 往 `Level` 上再挂一份只会多一个没人读的字段。
   */
  readonly enemies?: readonly EnemySpawn[];
  /**
   * 教学 / 玩法提示（T14）：HUD 逐行显示给玩家看的话。
   *
   * 为什么放进**关卡数据**而不是写死在 `main.ts`：提示是**这一关**要教的东西
   * （L1 教"跨折痕 / 走小道 / 挖坑困敌"），换一关就该换一套。写死在 app 里，加 L2/L3 时
   * 会变成一串 `if (levelId === ...)` —— 那是把数据藏进了代码。
   *
   * 与 `enemies` 同一条理由**不进 `Level`**：它不参与任何规则，`createSim` 也不需要它，
   * 只有 HUD 要读 —— 在 `main.ts` 里从 `LevelDef` 读一次即可。
   */
  readonly hints?: readonly string[];
  /**
   * **玩家出生格**（T21，编辑器加）。可选 —— 既有关卡把出生点放在旁边的 `*_SPAWN` 常量里。
   *
   * 为什么现在要收进 `LevelDef`：编辑器保存的关卡必须**自包含** —— 一个 JSON 文件要能完整
   * 描述"从哪儿开始玩"，否则加载之后还得让调用方另配一个出生点，那正是"同一件事两个来源"。
   *
   * 与 `enemies` / `hints` 同一条理由**不进 `Level`**：出生点不参与任何规则运算，
   * `createSim(def, spawn)` 拿它建初态就够。
   */
  readonly spawn?: Cell;
}

export type LoadError =
  | { readonly kind: 'noRows' }
  | { readonly kind: 'ragged'; readonly row: number; readonly expected: number; readonly got: number }
  | { readonly kind: 'badChar'; readonly row: number; readonly col: number; readonly ch: string }
  | { readonly kind: 'foldMismatch'; readonly fold: number; readonly cols: number };

/**
 * 敌人种类。T12 只做 `drone`，T15 加 `stalker`（攀爬者）。
 *
 * 与 `sim.ts` 的 `EntityKind` **同源**：那两个类型说的是同一件事（关卡能声明什么 /
 * 模拟能跑什么），改一个必须改另一个。这里少写一个，关卡就会在解析期被抓；
 * 那边少写一个，`switch` 会被 TS 判为不穷尽。
 */
export type EnemyKind = 'drone' | 'stalker';

/**
 * 关卡里声明的敌人（T12）。
 *
 * 为什么**只声明出生格**、不声明巡逻路线：文档 §A.4 定的是"沿平面匀速巡逻 + 落坑受困"，
 * 巡逻是**行为**不是地形，画在关卡数据里会变成第二份真相（行为该由 `ai/drone.ts` 决定）。
 * 出生格同时也是它的**重生点**（§八-2 裁定：溺水后延时重生）。
 *
 * `facing` 可选：巡逻起步朝哪边。缺省 `right`。
 */
export interface EnemySpawn {
  readonly kind: EnemyKind;
  readonly cell: Cell;
  readonly facing?: Dir;
}

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

/**
 * 换一份网格后的 `Level` 视图。
 *
 * `at` 是**闭包**（捕获的是原 `grid`），所以换网格必须同时换 `at`，否则新网格会被旧 `at` 查回来。
 * 两个消费者：`validate` 要建"闸门已开"的图；`ai/drone` 要用"**地形还完整**"的图规划追击
 * （把正在回填的坑当成还是砖 —— 见 `ai/drone.ts` 里"守卫为什么应该掉进坑里"）。
 */
export function withGrid(level: Level, grid: readonly TileKind[]): Level {
  return {
    ...level,
    grid,
    at: (col, row) =>
      col < 0 || col >= level.cols || row < 0 || row >= level.rows
        ? undefined
        : grid[row * level.cols + col],
  };
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
