import { cellKey, type Cell } from '../types';
import { asCell, type DeckCell, type JointDir } from './deck';
import { faceOf, fromFold, isConsistentCell, seamNeighbour, toFold } from './fold';
import type { Level, TileKind } from './tiles';

/**
 * 通行图：谁和谁能直接走过去。validator 的可达性判定（架构文档 §四-②③⑥）就架在它上面。
 *
 * ## 节点 = **可站立格**，不是"格子"
 *
 * 砖块本身不是节点 —— 玩家站在砖块的**上一层**，不是站在砖块里。
 * 于是一行实心砖 `r0` 之上的 `r1` 才是"地面"。`XX.` 这种行里，
 * 有砖的那两列在 `r1` 可站立，空的那一列在 `r1` 不可站立（是个洞）。
 * 梯和杆是例外：它们**自己就是支撑**，站在梯/杆上不需要下方有砖。
 *
 * ## 边 = 4 种静态邻接（架构文档 §三 graph.ts、§1.5-1）
 *
 * | kind    | 关系                                             |
 * |---------|--------------------------------------------------|
 * | `walk`  | 同面、同行、列 ±1，两端都可站立，且**都不是杆**    |
 * | `climb` | 同面、同列、行 ±1，两端都是梯                     |
 * | `bar`   | 同面、同行、列 ±1，两端都可站立，且**至少一端是杆** |
 * | `seam`  | 折痕两侧最内列、同一行，两端都可站立              |
 *
 * **为什么 walk 与 bar 必须分开**（而不是合成一个"横向相邻"）：
 * 敌人边集是可配置的（`ai/bfs.ts`）—— 无人机不爬梯、某些敌人不会用杆。
 * 拆开之后"把 bar 从边集里去掉"就能精确地问出"只靠地面能不能到"，
 * 合成一个边种就再也问不出来了。
 *
 * **为什么 seam 不因两端是杆而降级成 bar**：跨折痕是独立机制（角色朝向要转 90°，见 §八-4、T7）。
 * 想表达"不许用杆"就删 bar，想表达"两面各自为政"就删 seam，两者互不干扰。
 *
 * ## 本文件**不含"坠落"边**（有意的，别补）
 *
 * 坠落是移动的**结果**（走进空洞 → 下坠到同列第一个可站立格，途中可能落水），
 * 不是静态邻接。它属于 `rules/movement.ts`（T3）与 `world/water.ts` + `rules/drown.ts`（T9）。
 * 把坠落塞进静态图，会让"图"和"运动函数"抢同一份语义 —— 图说能走、函数说不能，
 * 就又回到上一版模型那种"两套数据不一致"的老病（架构文档 §5.1 反面清单）。
 * 测试里有一条 `UPPER` 的断言专门钉住这个边界。
 *
 * ## 顺序是契约
 *
 * 节点生成顺序：行 ↑、全局列 ↑（于是每行内是 A 面再 B 面）。
 * 出边生成顺序：`climb` 上行 → `climb` 下行 → 列 −1 → 列 +1 → `seam`。
 * BFS 靠它保证可复现（T4 的"脚本回放一致"、T12 的 AI 剧本都吃这个）。
 */

export type EdgeKind = 'walk' | 'climb' | 'bar' | 'seam';

export const EDGE_KINDS = ['walk', 'climb', 'bar', 'seam'] as const satisfies readonly EdgeKind[];

export interface Edge {
  readonly from: Cell;
  readonly to: Cell;
  readonly kind: EdgeKind;
}

export interface GraphOptions {
  /**
   * 只生成这些种类的边，默认全部。
   * 用来问受限可达性："只靠地面能不能到" / "不许用杆时还剩什么"。
   */
  readonly kinds?: readonly EdgeKind[];
  /**
   * 要不要把**甲板**（岛台 / 小道）算进来（默认 `true`）。
   *
   * 为什么需要这个开关：T12 的巡逻无人机按用户裁定**只在墙面内**活动。甲板节点、甲板内部的
   * 边、以及小道接头边都是 `buildGraph` **无条件**加的（它们不是 `kinds` 里的边种 ——
   * 甲板格是两个坐标系之外的第二类**节点**），所以"不要甲板"表达不出来。
   *
   * 在 `ai/` 里手写"这一步不许上甲板"是不行的：那等于在 AI 里重新定义一次"什么算合法移动"，
   * 而那份定义已经有主（本文件 + `rules/movement.ts`）—— 两处各写一遍必然漂。
   */
  readonly decks?: boolean;
}

export interface Graph {
  readonly level: Level;
  readonly kinds: ReadonlySet<EdgeKind>;
  /** 所有可站立格。顺序固定：先墙（行 ↑、列 ↑），再甲板（`level.deck` 的声明顺序）。 */
  readonly nodes: readonly Cell[];
  /** 有向边条数：每条无向邻接会从两端各记一次。 */
  readonly edgeCount: number;
  /** 该格是不是本图的节点。非节点返回 false，不抛异常。 */
  has(c: Cell): boolean;
  /** 该格出发的出边。非节点返回空数组，不返回 undefined（省掉满地的空值判断）。 */
  neighbours(c: Cell): readonly Edge[];
}

const NO_EDGES: readonly Edge[] = [];

/**
 * 甲板格的四邻方向。甲板是**水平面**，四邻在 (x, z) 上取；
 * 墙的 (col, row) 是"沿墙 u × 高度 y"，两套坐标不能互相套用。
 */
const DECK_STEPS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** 实心：可挖砖与硬砖。两者都挡路、都能当支撑；区别只在能不能挖（T11）。 */
export function isSolid(k: TileKind | undefined): boolean {
  return k === 'dig' || k === 'hard';
}

/**
 * 支撑类型。决定了玩家停在这一格时**怎么停**（见 rules/movement.ts）：
 * 砖面是站在顶上，梯是攀着，杆是**吊在下面** —— 三者的动作集不同。
 */
export type Support = 'brick' | 'ladder' | 'bar';

/** 可通行：不是实心、且在网格内。越界（undefined）不算可通行。 */
export function isPassable(k: TileKind | undefined): boolean {
  return k !== undefined && !isSolid(k);
}

export function isLadder(k: TileKind | undefined): boolean {
  return k === 'ladder';
}

export function isBar(k: TileKind | undefined): boolean {
  return k === 'bar';
}

/**
 * 甲板格 → 甲板晶格坐标。**非甲板面（A/B）一律返回 null** —— 那是墙的坐标系，
 * 不能和甲板的 (x, z) 混着用（见 deck.ts 的文件头）。
 */
export function deckCoordOf(c: Cell): DeckCell | null {
  return c.face === 'I' ? { x: c.col, z: c.row } : null;
}

/** 这一格是不是本关**声明过**的甲板格。没声明过的 'I' 格不是地面。 */
export function isDeckCell(level: Level, c: Cell): boolean {
  const d = deckCoordOf(c);
  if (d === null) return false;
  return level.deck.some((k) => k.x === d.x && k.z === d.z);
}

/**
 * 玩家能不能"停"在这一格里，以及**靠什么停**。
 *
 * 四条：①甲板格（面 'I'）单独一条路 —— 岛台本身就是实心地面，踩上去就是站在砖面上；
 * ②这一格本身得是可通行的（砖块内部不是停的地方）；③是梯/杆就直接算数
 * （梯能攀、杆能吊，都不需要下方有砖）；④否则要看**正下方**是不是实心 —— 那是站在砖面顶上的情形。
 * 最底行（row 0）下方越界 → 不是实心 → 停不住（网格下面没有地板，只有水）。
 *
 * ① 必须在 `isConsistentCell` **之前**分支：那个函数按折面的列范围校验，对 'I' 一律 false。
 * 而甲板"下方"是水、没有"下一格砖"可言，所以墙的那条支撑判据对它根本不适用。
 */
export function supportOf(level: Level, c: Cell): Support | null {
  if (c.face === 'I') return isDeckCell(level, c) ? 'brick' : null;
  if (!isConsistentCell(c, level.fold)) return null;
  const here = level.at(c.col, c.row);
  if (!isPassable(here)) return null;
  if (isLadder(here)) return 'ladder';
  if (isBar(here)) return 'bar';
  return isSolid(level.at(c.col, c.row - 1)) ? 'brick' : null;
}

/** 是否可停驻（= 通行图的节点资格）。杆格算可停驻，只是模式是"吊"不是"站"（见 movement.ts）。 */
export function isStandable(level: Level, c: Cell): boolean {
  return supportOf(level, c) !== null;
}

/** 折痕对面的对手格。非最内列（u ≠ 0）返回 null —— 判定交给 fold.ts，这里不重算。 */
function seamPartner(level: Level, c: Cell): Cell | null {
  const partner = seamNeighbour(toFold(c, level.fold));
  return partner === null ? null : fromFold(partner, level.fold);
}

export function buildGraph(level: Level, opts: GraphOptions = {}): Graph {
  const kinds = new Set<EdgeKind>(opts.kinds ?? EDGE_KINDS);
  const adjacency = new Map<string, Edge[]>();
  const nodes: Cell[] = [];

  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      const cell: Cell = { face: faceOf(col, level.fold), col, row };
      if (!isStandable(level, cell)) continue;
      nodes.push(cell);
      adjacency.set(cellKey(cell), []);
    }
  }

  // 甲板是节点的**第二个来源**（T10）。上面那对 `rows × cols` 循环永远扫不到它 ——
  // 甲板格的两个下标是 (x, z)、属于面 'I'，和墙的 (col, row) 不是一个坐标系。
  // 放在墙之后：`nodes` 的顺序仍然完全确定（甲板顺序由 `level.deck` 定，parseLevel 已定序）。
  //
  // `decks: false` 时整块跳过 —— 于是"只在墙面内"的图连甲板**节点**都没有，
  // `has(甲板格)` 为 false、路径也不会从甲板穿过去（见 GraphOptions.decks）。
  const decksOn = opts.decks !== false;
  const deckCells: Cell[] = decksOn ? level.deck.map(asCell) : [];
  for (const cell of deckCells) {
    const key = cellKey(cell);
    if (adjacency.has(key)) continue; // 已去过重，这里再兜一层，避免重复节点
    nodes.push(cell);
    adjacency.set(key, []);
  }

  const climbOn = kinds.has('climb');
  const horizontalOn = kinds.has('walk') || kinds.has('bar');
  const seamOn = kinds.has('seam');

  /**
   * 接头墙面端"被吃掉"的那个方向：在那一格 `step` 会**优先走接头上小道**
   * （`movement.ts` 的接头循环排在网格邻居之前），所以图里不该有朝那个方向的**出边** ——
   * 否则图会承诺一条 `step` 不会走的边，也就是"图说能走、玩家走不到"
   * （见 `rules/reach.ts` 的文件头：L1 的底层走廊就是这么被切断的）。
   *
   * 只跳过**出边**，不跳反向：从邻格走进接点那一格是**真的能走** —— 接头只在"站在那一格"
   * 的时候才生效。`decks: false` 时不跳：那时接头边根本不在图里，"吃掉"也就无从谈起。
   */
  const captured: ReadonlyMap<string, JointDir> = decksOn
    ? new Map(level.joints.map((joint) => [cellKey(joint.wall), joint.enterDir]))
    : new Map();

  for (const cell of nodes) {
    const out = adjacency.get(cellKey(cell));
    if (out === undefined) continue;

    if (climbOn && isLadder(level.at(cell.col, cell.row))) {
      for (const dy of [1, -1]) {
        const dir: JointDir = dy === 1 ? 'up' : 'down';
        if (captured.get(cellKey(cell)) === dir) continue;
        const target: Cell = { face: cell.face, col: cell.col, row: cell.row + dy };
        if (!isLadder(level.at(target.col, target.row))) continue;
        if (!isStandable(level, target)) continue;
        out.push({ from: cell, to: target, kind: 'climb' });
      }
    }

    if (horizontalOn) {
      for (const dc of [-1, 1]) {
        const dir: JointDir = dc === 1 ? 'right' : 'left';
        if (captured.get(cellKey(cell)) === dir) continue;
        const target: Cell = { face: cell.face, col: cell.col + dc, row: cell.row };
        // 折痕那一列（col fold-1 ↔ fold）**移动层面是一次正常的横向平移** ——
        // T3 的 step() 就是按 col±1 走过去的。这里特意把它排除在 walk/bar 之外，
        // 只为给它一个单独的 seam 标签：跨过的是折角，T7 要在这里把朝向转 90°。
        // 换句话说它不是"走不过去"，是"走得转个身"（架构文档 §1.5-1、§八-4）。
        if (!isConsistentCell(target, level.fold)) continue;
        if (!isStandable(level, target)) continue;
        const touchesBar = isBar(level.at(cell.col, cell.row)) || isBar(level.at(target.col, target.row));
        const kind: EdgeKind = touchesBar ? 'bar' : 'walk';
        if (kinds.has(kind)) out.push({ from: cell, to: target, kind });
      }
    }

    if (seamOn) {
      const target = seamPartner(level, cell);
      if (target !== null && isStandable(level, target)) {
        out.push({ from: cell, to: target, kind: 'seam' });
      }
    }
  }

  // 甲板内部的 walk：岛台是 4×4 的砖面，站在上面能横向挪。
  // **只连甲板↔甲板** —— 甲板格不与墙的 col±1 相邻（不同坐标系），跨过去要走接头。
  if (horizontalOn && decksOn) {
    for (const cell of deckCells) {
      const out = adjacency.get(cellKey(cell));
      if (out === undefined) continue;
      for (const [dx, dz] of DECK_STEPS) {
        const target = asCell({ x: cell.col + dx, z: cell.row + dz });
        if (!adjacency.has(cellKey(target))) continue;
        out.push({ from: cell, to: target, kind: 'walk' });
      }
    }
  }

  // 小道接缝：甲板 ↔ 墙（T10）。**显式声明**，不由几何推 —— 理由见 deck.ts 的 `DeckJoint`。
  // 用户已定：这条是 `walk` 边（走上去取宝物），不是 `seam`（seam 专指折角那一次转身）。
  // 两端缺一就不连：接头指向一个不存在的地面，是关卡数据错了，不该悄悄补一条边。
  if (horizontalOn && decksOn) {
    for (const joint of level.joints) {
      const deckSide = asCell(joint.deck);
      const a = adjacency.get(cellKey(deckSide));
      const b = adjacency.get(cellKey(joint.wall));
      if (a === undefined || b === undefined) continue;
      a.push({ from: deckSide, to: joint.wall, kind: 'walk' });
      b.push({ from: joint.wall, to: deckSide, kind: 'walk' });
    }
  }

  let edgeCount = 0;
  for (const edges of adjacency.values()) edgeCount += edges.length;

  return {
    level,
    kinds,
    nodes,
    edgeCount,
    has: (c) => adjacency.has(cellKey(c)),
    neighbours: (c) => adjacency.get(cellKey(c)) ?? NO_EDGES,
  };
}

/**
 * 从 start 出发能站到的所有格（含 start 自己），返回 cellKey 集合。
 * 返回集合而非数组：调用方多是 `reachable.has(cellKey(treasure))` 这种询问。
 * start 不是节点时返回**空集**（不是"含 start"）—— 别把非法起点当成合法落点。
 */
export function reachableFrom(graph: Graph, start: Cell): ReadonlySet<string> {
  const seen = new Set<string>();
  if (!graph.has(start)) return seen;

  seen.add(cellKey(start));
  const queue: Cell[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === undefined) continue;
    for (const edge of graph.neighbours(current)) {
      const key = cellKey(edge.to);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(edge.to);
    }
  }
  return seen;
}

/**
 * 最短路径（按边数），无路返回 null。
 * 两端任一是非节点就返回 null —— 问"到不了的地方怎么走"是没有答案的。
 */
export function findPath(graph: Graph, start: Cell, goal: Cell): readonly Cell[] | null {
  if (!graph.has(start) || !graph.has(goal)) return null;

  const startKey = cellKey(start);
  const goalKey = cellKey(goal);
  if (startKey === goalKey) return [start];

  const cameFrom = new Map<string, Cell>();
  const seen = new Set<string>([startKey]);
  const queue: Cell[] = [start];

  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === undefined) continue;
    for (const edge of graph.neighbours(current)) {
      const key = cellKey(edge.to);
      if (seen.has(key)) continue;
      seen.add(key);
      cameFrom.set(key, current);
      if (key === goalKey) return rebuildPath(cameFrom, start, goal);
      queue.push(edge.to);
    }
  }
  return null;
}

function rebuildPath(cameFrom: Map<string, Cell>, start: Cell, goal: Cell): readonly Cell[] {
  const path: Cell[] = [goal];
  let cursor = goal;
  while (cellKey(cursor) !== cellKey(start)) {
    const previous = cameFrom.get(cellKey(cursor));
    if (previous === undefined) return path.slice().reverse();
    path.push(previous);
    cursor = previous;
  }
  return path.reverse();
}
