import type { Cell } from '../types';

/**
 * **甲板**（岛台）—— core 里第一个"不在摊平网格上"的可通行表面。
 *
 * ## 它为什么需要一个自己的模块
 *
 * 关卡网格只贴在那两片**竖直**墙上（`tiles.ts` / `fold.ts`）。而岛台按设计悬在
 * **水中央**、是一块**水平**板：它的两个自然下标是 `(x, z)`，不是网格的 `(沿墙u, 高度)`。
 * 用 `Cell` 的 `col/row` 硬装两个水平坐标会立刻开始说谎，所以这里给它一个明确的类型；
 * 只在**跨到图里**的那一刻（T10 步骤④）才折成 `Cell`（面 `'I'`，见 `asCell`）。
 *
 * ## 照抄 `Level` 已有的模式（这不是巧合）
 *
 * `tiles.ts` 里 `Level` 同时给了 `at()` 闭包与 `grid` 裸数组，理由写在那边：
 * **查询走闭包、持有/复制/序列化走裸数组**（因为 `SimState` 必须是纯数据，闭包不能进存档）。
 * 甲板是同一类东西 —— 它也会进 `SimState`（玩家站在上面），所以这里照抄：
 * `cells` 是纯数据数组，`has()` 是查询闭包。
 *
 * ## 单位与坐标
 *
 * 坐标就是**世界 x / z 的格心**（与 `scene.ts` 的 `islandAndJetties` 同一套数）。
 *
 * `level`（2026-09-19 加）是**层**：`0` = 水面上的那一层（岛台/小道，砖心 y = 0.5、顶面 y = 1.0，
 * 正好是墙上"行 1"的行走面）；每 +1 就是再高一整格（砖心 +1）。省略 = `0`。
 *
 * 为什么现在才加它：在那之前甲板是一张**没有厚度**的平板（高度是常数），于是"塔"表达不出来。
 * 加了一层之后，"同一 (x, z) 上叠好几格"就是天然的关卡数据，`cellKey` 会把层编进去
 * （`I:5,3@1`），图/可达性/存档都不用为塔写特例。
 */
export interface DeckCell {
  /** 世界 x 的格心。 */
  readonly x: number;
  /** 世界 z 的格心。 */
  readonly z: number;
  /** 层（省略 = 0）。见上面"单位与坐标"。 */
  readonly level?: number;
}

export interface Deck {
  /**
   * 所有甲板格。**裸数组**：可序列化、可复制（同 `Level.grid` 的理由，见文件头）。
   * 顺序由构造方决定；`buildDeck` 保证"先岛台、后小道"，且各自行列升序。
   */
  readonly cells: readonly DeckCell[];
  /** 这一格是不是甲板（可指定层，省略 = 0）。非甲板返回 false，不抛异常（与 `Graph.has` 一致）。 */
  has(x: number, z: number, level?: number): boolean;
}

/** 甲板格的键。与 `cellKey` 同思路：对象不能直接当 Map/Set 的键。层算进去。 */
export function deckKey(c: DeckCell): string {
  return `${c.x},${c.z}@${c.level ?? 0}`;
}

/**
 * 甲板格 → 图里的 `Cell`。
 *
 * 编码是 **M2**（见 `types.ts` 里 `Face` 的注释）：面 `'I'`，`col = x`、`row = z`，
 * `level` = 层。之所以能这么复用一个 `Cell`，是因为 `cellKey` 与 `parseCell` 的形状本来就装得下
 * `I:-4,-4` —— 于是 `graph` / `validate` / `sim` 里所有认 `Cell` 的代码都不用改类型。
 *
 * **但每个读到这个 `Cell` 的函数都要先问一句"这个判断对面 `'I'` 成立吗"**：
 * 面 `'I'` 的 `col/row` 是 `(x, z)`，不是 A/B 的 `(沿墙u, 高度)`。
 */
export function asCell(c: DeckCell): Cell {
  const level = c.level ?? 0;
  return level === 0
    ? { face: 'I', col: c.x, row: c.z }
    : { face: 'I', col: c.x, row: c.z, level };
}

/** `asCell` 的逆。给"先拿到 `Cell`、再要回 (x,z)"的调用方用。 */
export function fromCell(cell: Cell): DeckCell {
  const level = cell.level ?? 0;
  // 层 0 省略不写 —— 与 `parseCell` 同一条约定：旧数据往返后与加层之前逐字节相同。
  return level === 0 ? { x: cell.col, z: cell.row } : { x: cell.col, z: cell.row, level };
}

/**
 * **甲板与墙的接头**：一个甲板格与一个墙格相邻、可以直接跨过去。
 *
 * ## 为什么要显式声明，而不是由几何推出来
 *
 * 甲板与墙是**两种不同的表面**（水平 vs 竖直），"它们在这一处相接"这件事不是
 * 网格邻接能算出来的 —— 要算就得知道甲板离墙面多远，而那依赖**渲染层的外观常量**
 * （`BRICK_N` / `CUBE`）。
 *
 * 让 core 去依赖外观常量是错的：`BRICK_N` 是"砖从墙面浮起多少"，改它是调画面；
 * 而"这里能走过去"是**规则**。把两者绑在一起，就会重演本仓库的老病
 * ——同一件事有两个来源（架构文档 §5.1）。
 *
 * 所以接头由**关卡数据显式给出**，core 只负责相信它。好处有三：
 * ① 外观常量留在渲染层，core 干净；② 连接关系可审（读关卡就知道哪儿能上下）；
 * ③ 与"别在这里伪造可达性"同一条纪律 —— 但这是**真的**可达性，不是渲染层的假动作。
 */
/**
 * 接头两端的方向记号。与 `rules/movement.ts` 的 `Dir` **同构但不 import 它** ——
 * `world/` 不该反向依赖 `rules/`（`movement → graph → deck` 会绕成环）。
 * 结构相同的字面量联合，赋值时天然兼容。
 */
export type JointDir = 'left' | 'right' | 'up' | 'down';

export interface DeckJoint {
  /** 甲板这一侧的格。 */
  readonly deck: DeckCell;
  /** 墙这一侧的格（面 `'A'` / `'B'`）。 */
  readonly wall: Cell;
  /**
   * 站在 `wall` 这一格上，**按哪个键**能拐上 `deck`（B-1）。**必填**。
   *
   * ## 它是权威数据，不是可以反推的装饰（这一段是踩过坑之后收口的）
   *
   * 原先 `movement.ts` 用 `|dx| >= |dz|` 从两端坐标**反推**方向，而接头两端天然差半格
   * （A 接点偏移 `(+1.5, −0.5)`）—— 反推出的 `right` 在屏幕上既不是"沿墙向右"、
   * 也不指向小道（对 A 面来说 +x 是**离开墙**，对 B 面却是**沿墙**），玩家无从推断。
   * 这正是用户报的 2.1/2.2/2.3 同一个根因：同一个按键在不同面上含义不同。
   *
   * 于是字段加上了，但**一直没有人读它** —— 反推那段留在 `movement.ts` 里照旧生效，
   * 而已声明的值纯属摆设（写错了也没人发现）。现在按当初的计划收口：
   * **`movement.ts` 直接读这个值**，反推那段删掉；`world/graph.ts` 建图时也读同一个值
   * （那一格"被接头吃掉"的方向不该出现在图里 —— 否则图会承诺一条 `step` 不会走的边，
   * 见 `rules/reach.ts` 的文件头里 L1 走廊被切断那个实例）。
   *
   * **它没法在 core 里校验**："这个方向对不对"取决于**渲染出来的**小道长在哪一侧，
   * 而那个布局（`JETTY_U`）是渲染层的常量，core 看不见也不该看见。所以与 `gates` 一样：
   * 关卡显式声明，core 相信它；关卡注释负责说明它为什么是这个值。
   */
  readonly enterDir: JointDir;
}

/** 由一组甲板格建 `Deck`。去重（同一格**同一层**只留一次），并保留传入顺序。 */
export function buildDeck(cells: readonly DeckCell[]): Deck {
  const keys = new Set<string>();
  const kept: DeckCell[] = [];
  for (const c of cells) {
    const k = deckKey(c);
    if (keys.has(k)) continue;
    keys.add(k);
    kept.push(c);
  }

  return {
    cells: kept,
    has: (x, z, level = 0) => keys.has(deckKey({ x, z, level })),
  };
}

/**
 * 矩形甲板的一批格子（含首含尾）。`buildDeck` 之前用它铺一块矩形面。
 *
 * 为什么单独一个函数：岛台是矩形、小道是 1×N 的退化矩形 —— 两者都能用它表达，
 * 于是"甲板由哪些格子组成"这件事不必写两遍。
 */
export function rectCells(x0: number, z0: number, x1: number, z1: number): readonly DeckCell[] {
  const out: DeckCell[] = [];
  const [xa, xb] = x0 <= x1 ? [x0, x1] : [x1, x0];
  const [za, zb] = z0 <= z1 ? [z0, z1] : [z1, z0];
  for (let z = za; z <= zb; z++) {
    for (let x = xa; x <= xb; x++) out.push({ x, z });
  }
  return out;
}
