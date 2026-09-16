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
 * 坐标就是**世界 x / z 的格心**（与 `scene.ts` 的 `islandAndJetties` 同一套数），
 * 高度是固定的：甲板只有一层砖，砖心 y = 0.5、顶面 y = 1.0 —— 正好是墙上"行 1"的行走面。
 * 高度不放进 `DeckCell`，因为它对整块甲板是个常数，放进去只会给"两块不同高度的甲板"
 * 留一个现在还不需要的口子。
 */
export interface DeckCell {
  /** 世界 x 的格心。 */
  readonly x: number;
  /** 世界 z 的格心。 */
  readonly z: number;
}

export interface Deck {
  /**
   * 所有甲板格。**裸数组**：可序列化、可复制（同 `Level.grid` 的理由，见文件头）。
   * 顺序由构造方决定；`buildDeck` 保证"先岛台、后小道"，且各自行列升序。
   */
  readonly cells: readonly DeckCell[];
  /** 这一格是不是甲板。非甲板返回 false，不抛异常（与 `Graph.has` 一致）。 */
  has(x: number, z: number): boolean;
}

/** 甲板格的键。与 `cellKey` 同思路：对象不能直接当 Map/Set 的键。 */
export function deckKey(c: DeckCell): string {
  return `${c.x},${c.z}`;
}

/**
 * 甲板格 → 图里的 `Cell`。
 *
 * 编码是 **M2**（见 `types.ts` 里 `Face` 的注释）：面 `'I'`，`col = x`、`row = z`。
 * 之所以能这么复用一个 `Cell`，是因为 `cellKey` 与 `parseCell` 的形状本来就装得下
 * `I:-4,-4` —— 于是 `graph` / `validate` / `sim` 里所有认 `Cell` 的代码都不用改类型。
 *
 * **但每个读到这个 `Cell` 的函数都要先问一句"这个判断对面 `'I'` 成立吗"**：
 * 面 `'I'` 的 `col/row` 是 `(x, z)`，不是 A/B 的 `(沿墙u, 高度)`。
 */
export function asCell(c: DeckCell): Cell {
  return { face: 'I', col: c.x, row: c.z };
}

/** `asCell` 的逆。给"先拿到 `Cell`、再要回 (x,z)"的调用方用。 */
export function fromCell(cell: Cell): DeckCell {
  return { x: cell.col, z: cell.row };
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
export interface DeckJoint {
  /** 甲板这一侧的格。 */
  readonly deck: DeckCell;
  /** 墙这一侧的格（面 `'A'` / `'B'`）。 */
  readonly wall: Cell;
  /**
   * 站在 `wall` 这一格上，**按哪个键**能拐上 `deck`（B-1）。
   *
   * 为什么必须显式声明：`movement.ts` 原先用 `|dx| >= |dz|` 从两端坐标**反推**方向，
   * 而接头两端天然差半格（A 接点偏移 `(+1.5, −0.5)`）—— 反推出的 `right` 在屏幕上
   * 既不是"沿墙向右"，也不指向小道（对 A 面来说 +x 是**离开墙**，对 B 面却是**沿墙**），
   * 玩家无从推断。这正是用户报的 2.1/2.2/2.3 同一个根因：同一个按键在不同面上含义不同。
   *
   * 与 `deck` / `wall` 一样，这属于**关卡数据**：哪里能上下、按什么键上下，读关卡就知道。
   *
   * 可选（过渡期）：未声明时 `movement.ts` 退回旧的几何反推 —— 这样既有夹具不必逐个
   * 补字段。夹具补齐后应改为**必填**并删掉那段反推。
   */
  readonly enterDir?: 'left' | 'right' | 'up' | 'down';
}

/** 由一组甲板格建 `Deck`。去重（同一格只留一次），并保留传入顺序。 */
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
    has: (x, z) => keys.has(deckKey({ x, z })),
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
