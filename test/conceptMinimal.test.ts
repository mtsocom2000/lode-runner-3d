import { cellKey, type Cell } from '../src/core/types';
import { CONCEPT_MINIMAL, PLAYER_SPAWN } from '../src/core/level/levels/conceptMinimal';
import { openGates } from '../src/core/rules/goals';
import { faceOf } from '../src/core/world/fold';
import { buildGraph, reachableFrom } from '../src/core/world/graph';
import { parseLevel, type Level } from '../src/core/world/tiles';

/**
 * 概念验证关卡的**形状契约**。
 *
 * 这个文件存在的唯一理由：上一张 `DEV_FOLD` 悄悄退化成了一张走不通的关卡
 * （43 个可站立格碎成 25 个连通分量，出生点只能走 2 格），而当时**没有任何测试会发现它** ——
 * 直到人工试玩才发现。所以"整张关卡是一个连通分量"必须是断言，不是印象。
 *
 * 这几条断言同时锁住了用户口头提的那几个数（3:2 宽高比、梯子贯通、砖块可挖）——
 * 以后谁要改关卡尺寸，改到违反这些性质就会当场红。
 *
 * T13 起多了一条**出口门禁**的契约（见下方最后一条 it）：用户裁定走"物理门"，
 * 所以"出口在集齐宝物前走不到、开闸后走得到"成了这张关卡必须成立的性质。
 * 它同时也是 `validateLevel` 的 `exitGated` 规则 —— 这里再独立钉一次，
 * 免得哪天有人为了方便把校验规则摘掉，而关卡悄悄退化回"出口敞着"。
 */
function load(): Level {
  const parsed = parseLevel(CONCEPT_MINIMAL);
  if (!parsed.ok) throw new Error(`关卡数据不合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

/** 关卡里所有某种瓦片的格子。 */
function cellsOf(kind: string): readonly Cell[] {
  const level = load();
  const out: Cell[] = [];
  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      if (level.at(col, row) === kind) out.push({ face: faceOf(col, level.fold), col, row });
    }
  }
  return out;
}

describe('CONCEPT_MINIMAL：形状契约', () => {
  it('每个侧面的宽高比正好是 3:2（用户明确要求的那条）', () => {
    const level = load();
    // 每面宽 = fold 列、高 = rows 行，所以 fold/rows 就是宽高比。
    expect(level.fold / level.rows).toBeCloseTo(3 / 2, 10);
    // 契约：总列数必须是 2×fold（parseLevel 也查这条，这里再钉一次口径）。
    expect(level.cols).toBe(level.fold * 2);
  });

  it('硬砖只出现在声明过的闸门格上（"砖块都可以打洞"——闸门是例外）', () => {
    const level = load();
    // T13 给两个出口各夹了两块闸门硬砖。**它们必须是硬砖**：闸门要是能挖穿，门就白设了。
    // 所以这条从"一个硬砖都没有"收紧成"硬砖只准出现在声明过的闸门格上" ——
    // 保住了用户原要求的精神（地形砖块一律可挖），又不给闸门开后门。
    const hard = cellsOf('hard').map(cellKey);
    const declared = new Set(level.gates.map(cellKey));
    expect(hard.length).toBe(4);
    for (const key of hard) expect(declared.has(key)).toBe(true);
  });

  it('可站立格数 = 56（3 条行走行 × 18 + 2 层梯格 × 4 − 2 个落水缺口 − 4 个闸门）', () => {
    // 数字写死是有意的：地形一改就该红，逼人重新确认一遍连通性。
    // 62 → 60 是**有意**的：r0 在 col 2 / col 15 各开了一个落水缺口（用户拍板）。
    // 60 → 56 也是**有意**的：T13 在 r5 给两个出口各夹了两块闸门硬砖（用户裁定"物理门"）。
    // 硬砖不是可站立格，那 4 格从图上消失 —— 这正是"门封住了"的机制本身（见 `supportOf`）。
    // 只数**墙**格（面 `A`/`B`）：甲板（面 `'I'`）是图的第二来源，不属于这张 18×6 网格的
    // 统计口径。T10 之前 `nodes.length` 恰好等于墙格数，所以这条断言以前是"歪打正着"成立的；
    // 现在必须显式把甲板排除，否则这个数会被甲板撑大、失去它本来要钉住的地形含义。
    expect(buildGraph(load()).nodes.filter((c) => c.face !== 'I').length).toBe(56);
  });
});

describe('CONCEPT_MINIMAL：走得通（这是上一张关卡栽掉的地方）', () => {
  it('除两个被闸门封住的出口外，整张关卡是**一个**连通分量', () => {
    const graph = buildGraph(load());
    // 出口**故意**到不了（T13 物理门），所以它们各自成一格孤岛。把它们排除之后，
    // "剩下的一切都连在一起"这条才仍然是本文件要守的性质 ——
    // 不排除的话，这条断言会因为**设计意图**而红，而不是因为关卡碎了。
    const gated = new Set(cellsOf('exit').map(cellKey));
    const remain = graph.nodes.filter((n) => !gated.has(cellKey(n)));
    const seen = new Set<string>();
    let components = 0;
    for (const node of remain) {
      if (seen.has(cellKey(node))) continue;
      components += 1;
      for (const key of reachableFrom(graph, node)) seen.add(key);
    }
    expect(components).toBe(1);
  });

  it('除两个出口外，从出生点能走到**每一个**可站立格', () => {
    const graph = buildGraph(load());
    expect(graph.has(PLAYER_SPAWN)).toBe(true);
    const exits = cellsOf('exit').length;
    expect(reachableFrom(graph, PLAYER_SPAWN).size).toBe(graph.nodes.length - exits);
  });

  it('两个出口未开时都走不到、开闸后都走得到（T13 物理门）', () => {
    const level = load();
    const exits = cellsOf('exit');
    expect(exits.length).toBe(2);
    expect(level.gates.length).toBe(4); // 每个出口左右各一块

    const before = reachableFrom(buildGraph(level), PLAYER_SPAWN);
    for (const exit of exits) expect(before.has(cellKey(exit))).toBe(false);

    // 开闸用**真正会跑的那个函数**（`openGates` 也是 sim 与 `validateLevel` 用的），
    // 绝不在这里重写一遍"闸门开了会怎样"：两份实现漂开之后，这条断言就只是在自我安慰。
    const openedGrid = openGates(level.grid, level.gates, level.cols);
    const opened: Level = {
      ...level,
      grid: openedGrid,
      at: (col, row) =>
        col < 0 || col >= level.cols || row < 0 || row >= level.rows
          ? undefined
          : openedGrid[row * level.cols + col],
    };
    const after = reachableFrom(buildGraph(opened), PLAYER_SPAWN);
    for (const exit of exits) expect(after.has(cellKey(exit))).toBe(true);
  });

  it('四条梯子的每一格都走得到（梯子真的从地面贯到顶）', () => {
    const graph = buildGraph(load());
    const reach = reachableFrom(graph, PLAYER_SPAWN);
    const ladders = cellsOf('ladder');
    // 4 列梯子 × 5 行（r1..r5）
    expect(ladders.length).toBe(20);
    for (const cell of ladders) expect(reach.has(cellKey(cell))).toBe(true);
  });
});
