import { cellKey, type Cell } from '../src/core/types';
import {
  EDGE_KINDS,
  buildGraph,
  findPath,
  isBar,
  isLadder,
  isPassable,
  isSolid,
  isStandable,
  reachableFrom,
  type Graph,
} from '../src/core/world/graph';
import { cellA, cellB, load, DROP, JETTY, UPPER } from './fixtures';

/** `kind:face:col,row` 列表 —— 顺带把"出边生成顺序"这个契约也钉住。 */
function outKeys(graph: Graph, cell: Cell): string[] {
  return graph.neighbours(cell).map((edge) => `${edge.kind}:${cellKey(edge.to)}`);
}

describe('graph：瓦片谓词', () => {
  it('实心 = 可挖砖 + 硬砖；其余都不是实心', () => {
    expect(isSolid('dig')).toBe(true);
    expect(isSolid('hard')).toBe(true);
    expect(isSolid('empty')).toBe(false);
    expect(isSolid('ladder')).toBe(false);
    expect(isSolid('bar')).toBe(false);
    expect(isSolid('treasure')).toBe(false);
    expect(isSolid('exit')).toBe(false);
  });

  it('越界（undefined）既不是实心、也不是可通行 —— 不能把网格外当成空地', () => {
    expect(isSolid(undefined)).toBe(false);
    expect(isPassable(undefined)).toBe(false);
  });

  it('可通行 = 有值且非实心', () => {
    expect(isPassable('empty')).toBe(true);
    expect(isPassable('ladder')).toBe(true);
    expect(isPassable('bar')).toBe(true);
    expect(isPassable('treasure')).toBe(true);
    expect(isPassable('exit')).toBe(true);
    expect(isPassable('dig')).toBe(false);
    expect(isPassable('hard')).toBe(false);
  });

  it('梯与杆的判定只认自己', () => {
    expect(isLadder('ladder')).toBe(true);
    expect(isLadder('bar')).toBe(false);
    expect(isBar('bar')).toBe(true);
    expect(isBar('ladder')).toBe(false);
  });
});

describe('graph：isStandable（节点资格）', () => {
  const level = load(UPPER);

  it('砖块内部不是可站的地方 —— 玩家站在砖面**上**一层', () => {
    expect(isStandable(level, cellA(0, 2))).toBe(true); // r2c0 是梯，自支撑
    expect(isStandable(level, cellA(1, 2))).toBe(false); // r2c1 是砖 → 不是站的地方
    expect(isStandable(level, cellA(1, 0))).toBe(false); // r0c1 是砖
  });

  it('砖面上方一格可站；砖面断开处是洞', () => {
    expect(isStandable(level, cellA(0, 1))).toBe(true); // r1c0 是梯
    expect(isStandable(level, cellA(1, 1))).toBe(true); // r1c1 空，下方 r0c1 是砖
    expect(isStandable(level, cellB(2, 1))).toBe(false); // r1c2 是砖 → 墙
    expect(isStandable(level, cellB(2, 3))).toBe(true); // r3c2 空，下方 r2c2 是砖
  });

  it('梯与杆自支撑：下方悬空也能站', () => {
    const jetty = load(JETTY);
    expect(isStandable(jetty, cellA(1, 2))).toBe(true); // 横杆，下方 r1c1 是空
    expect(isStandable(jetty, cellB(2, 2))).toBe(true);
    expect(isStandable(jetty, cellA(1, 1))).toBe(false); // 空且下方 r0c1 是空 → 站不住
  });

  it('网格最底行下方没有地板 → 站不住', () => {
    const drop = load(DROP);
    expect(isStandable(drop, cellA(0, 0))).toBe(false); // r0c0 是砖
    expect(isStandable(drop, cellA(0, 1))).toBe(true); // 站在 r0 的砖面上
  });

  it('面与列对不上的脏数据直接判不可站（不静默当成 A 面）', () => {
    // fold=2 → col 2 属于 B 面；硬说它在 A 面就是脏数据。
    expect(isStandable(level, cellA(2, 1))).toBe(false);
    expect(isStandable(level, cellB(0, 1))).toBe(false);
  });

  it('行越上界不抛异常、判不可站', () => {
    expect(isStandable(level, cellA(0, 99))).toBe(false);
    expect(isStandable(level, cellA(0, -1))).toBe(false);
  });
});

describe('graph：UPPER —— 节点与出边（顺序是契约）', () => {
  const graph = buildGraph(load(UPPER));

  it('节点顺序：行 ↑、全局列 ↑（B 面列号是全局列，不是面内列号）', () => {
    expect(graph.nodes.map(cellKey)).toEqual([
      'A:0,1',
      'A:1,1',
      'B:3,1',
      'A:0,2',
      'B:3,2',
      'A:0,3',
      'A:1,3',
      'B:2,3',
      'B:3,3',
    ]);
    expect(graph.edgeCount).toBe(16); // 8 条无向邻接各从两端记一次
  });

  it('梯只接梯：climb 边两端都是梯，且上下都算', () => {
    expect(outKeys(graph, cellA(0, 1))).toEqual(['climb:A:0,2', 'walk:A:1,1']);
    expect(outKeys(graph, cellA(0, 2))).toEqual(['climb:A:0,3', 'climb:A:0,1']);
    expect(outKeys(graph, cellA(0, 3))).toEqual(['climb:A:0,2', 'walk:A:1,3']);
  });

  it('墙挡住横向：B 面底层单独一格，接不上任何东西（只接自己的梯）', () => {
    expect(outKeys(graph, cellB(3, 1))).toEqual(['climb:B:3,2']);
  });

  it('折痕边：A 最内列 ↔ B 最内列、同一行（r3），且只在两端都可站时才有', () => {
    expect(outKeys(graph, cellA(1, 3))).toEqual(['walk:A:0,3', 'seam:B:2,3']);
    expect(outKeys(graph, cellB(2, 3))).toEqual(['walk:B:3,3', 'seam:A:1,3']);
  });

  it('折痕那一跳标成 seam 而不是 walk —— 移动是存在的，只是过折角要转身 90°', () => {
    // 摊平图里 col1 和 col2 数值相邻；折起来之后它仍是一次横向平移（T3 的 step 就这么走），
    // 但跨的是折角，所以在这里单独标 seam（T7 负责把朝向转 90°）。
    expect(outKeys(graph, cellA(1, 3)).some((k) => k.startsWith('walk:B'))).toBe(false);
    expect(outKeys(graph, cellA(1, 3)).some((k) => k.startsWith('seam:B'))).toBe(true);
    expect(outKeys(graph, cellB(2, 3)).some((k) => k.startsWith('walk:A'))).toBe(false);
    expect(outKeys(graph, cellB(2, 3)).some((k) => k.startsWith('seam:A'))).toBe(true);
  });

  it('不是节点就没有出边，也不抛异常', () => {
    expect(graph.has(cellB(2, 1))).toBe(false); // 墙，不是节点
    expect(graph.neighbours(cellB(2, 1))).toEqual([]);
    expect(outKeys(graph, cellB(2, 1))).toEqual([]);
  });

  it('边是对称的：每条出边都有同 kind 的反向边（否则 BFS 会单向漏格）', () => {
    for (const node of graph.nodes) {
      for (const edge of graph.neighbours(node)) {
        const back = graph.neighbours(edge.to).some((e) => cellKey(e.to) === cellKey(node));
        expect({ from: cellKey(node), to: cellKey(edge.to), hasBack: back }).toEqual({
          from: cellKey(node),
          to: cellKey(edge.to),
          hasBack: true,
        });
      }
    }
  });

  it('重复构建结果逐条一致（BFS 可复现的前提）', () => {
    const again = buildGraph(load(UPPER));
    expect(again.nodes.map(cellKey)).toEqual(graph.nodes.map(cellKey));
    expect(again.edgeCount).toBe(graph.edgeCount);
    for (const node of graph.nodes) {
      expect(outKeys(again, node)).toEqual(outKeys(graph, node));
    }
  });
});

describe('graph：BFS', () => {
  const graph = buildGraph(load(UPPER));

  it('跨折痕只能绕行：A 底层 → B 底层的最短路要走满 8 格（上梯-横穿-跨痕-下梯）', () => {
    const path = findPath(graph, cellA(0, 1), cellB(3, 1));
    expect(path?.map(cellKey)).toEqual([
      'A:0,1',
      'A:0,2',
      'A:0,3',
      'A:1,3',
      'B:2,3',
      'B:3,3',
      'B:3,2',
      'B:3,1',
    ]);
  });

  it('断路：被墙隔开的那一格到不了（就算只差一列）', () => {
    const reach = reachableFrom(graph, cellA(0, 1));
    expect(reach.has(cellKey(cellB(2, 1)))).toBe(false); // r1c2 是墙，压根不是节点
  });

  it('绕行：A:1 底层上到顶层只能借道 col0 的梯', () => {
    const path = findPath(graph, cellA(1, 1), cellA(1, 3));
    expect(path?.map(cellKey)).toEqual(['A:1,1', 'A:0,1', 'A:0,2', 'A:0,3', 'A:1,3']);
  });

  it('删掉 seam 边 → 两面各自封闭（证明跨折痕就是这条边在起作用）', () => {
    const noSeam = buildGraph(load(UPPER), { kinds: ['walk', 'climb', 'bar'] });
    const reach = reachableFrom(noSeam, cellA(0, 1));
    expect(reach.size).toBe(5); // A:0,1 A:1,1 A:0,2 A:0,3 A:1,3
    expect([...reach].some((k) => k.startsWith('B:'))).toBe(false);
  });

  it('只留 walk → 连梯都上不去，可达集合只剩底层一格', () => {
    const walkOnly = buildGraph(load(UPPER), { kinds: ['walk'] });
    const reach = reachableFrom(walkOnly, cellA(0, 1));
    expect([...reach].sort()).toEqual(['A:0,1', 'A:1,1']);
  });

  it('起点不是节点 → 空集（不把非法起点当成合法落点）', () => {
    expect(reachableFrom(graph, cellB(2, 1)).size).toBe(0);
    expect(findPath(graph, cellB(2, 1), cellA(0, 1))).toBeNull();
  });

  it('起终点相同 → 单格路径；无路 → null', () => {
    expect(findPath(graph, cellA(0, 1), cellA(0, 1))?.map(cellKey)).toEqual(['A:0,1']);
    expect(findPath(graph, cellA(0, 1), cellA(99, 99))).toBeNull();
  });
});

describe('graph：JETTY —— 杆接续与跨折痕杆', () => {
  const level = load(JETTY);
  const graph = buildGraph(level);

  it('节点就是那 4 格：两块平台面 + 两格横杆', () => {
    expect(graph.nodes.map(cellKey)).toEqual(['A:0,2', 'A:1,2', 'B:2,2', 'B:3,2']);
    expect(graph.edgeCount).toBe(6); // 3 条无向邻接（杆-杆-杆、杆-平台 ×2、跨痕杆）
  });

  it('杆接续：接上横杆的那一跳算 bar，不算 walk', () => {
    expect(outKeys(graph, cellA(0, 2))).toEqual(['bar:A:1,2']);
    expect(outKeys(graph, cellB(3, 2))).toEqual(['bar:B:2,2']);
    expect(outKeys(graph, cellA(1, 2))).toEqual(['bar:A:0,2', 'seam:B:2,2']);
  });

  it('跨折痕的那一跳是 seam，不因为两端是杆就降级成 bar', () => {
    // 想表达"不许用杆"删 bar，想表达"两面各自为政"删 seam —— 两者互不干扰。
    const kinds = graph.neighbours(cellA(1, 2)).map((e) => e.kind);
    expect(kinds).toContain('seam');
    expect(kinds).not.toContain('walk');
  });

  it('删掉 bar 边 → 横杆接续断掉，两块平台各自孤立', () => {
    const noBar = buildGraph(level, { kinds: ['walk', 'climb', 'seam'] });
    expect(reachableFrom(noBar, cellA(0, 2)).size).toBe(1); // 只剩自己
  });

  it('删掉 seam 边 → 两面各玩各的（横杆也只在各自面内生效）', () => {
    const noSeam = buildGraph(level, { kinds: ['walk', 'climb', 'bar'] });
    expect([...reachableFrom(noSeam, cellA(0, 2))].sort()).toEqual(['A:0,2', 'A:1,2']);
  });

  it('边集齐全时四格连成一线', () => {
    const reach = reachableFrom(graph, cellA(0, 2));
    expect(reach.size).toBe(4);
    expect(findPath(graph, cellA(0, 2), cellB(3, 2))?.map(cellKey)).toEqual([
      'A:0,2',
      'A:1,2',
      'B:2,2',
      'B:3,2',
    ]);
  });
});

describe('graph：DROP —— 坠落**不在**静态图里（边界断言）', () => {
  const graph = buildGraph(load(DROP));

  it('节点只含真正能站的格', () => {
    expect(graph.nodes.map(cellKey)).toEqual(['A:0,1', 'A:1,1', 'B:2,1', 'B:3,1', 'B:2,3', 'B:3,3']);
    expect(graph.edgeCount).toBe(8);
  });

  it('同列直落两格不算相邻 —— 坠落是移动的结果，归 T3/T9', () => {
    // B:2,3 正下方隔一格就是可站的 B:2,1；静态图里两者之间不该有边。
    expect(outKeys(graph, cellB(2, 3))).toEqual(['walk:B:3,3']);
    expect(findPath(graph, cellB(2, 3), cellB(2, 1))).toBeNull();
  });

  it('高台与地板是两个连通块（坠落能力不在图里，所以确实到不了）', () => {
    expect(reachableFrom(graph, cellA(0, 1)).size).toBe(4);
    expect(reachableFrom(graph, cellB(2, 3)).size).toBe(2);
  });
});

describe('graph：默认边集', () => {
  it('恰好 4 种边，默认全开', () => {
    expect([...EDGE_KINDS]).toEqual(['walk', 'climb', 'bar', 'seam']);
    const graph = buildGraph(load(JETTY));
    expect([...graph.kinds].sort()).toEqual(['bar', 'climb', 'seam', 'walk']);
  });

  it('传入的边集会变成 kinds（供 ai/bfs.ts 的可配置边集使用）', () => {
    const graph = buildGraph(load(JETTY), { kinds: ['walk'] });
    expect([...graph.kinds]).toEqual(['walk']);
    expect(graph.nodes).toHaveLength(4); // 节点不受边集影响
    expect(graph.edgeCount).toBe(0);
  });
});
