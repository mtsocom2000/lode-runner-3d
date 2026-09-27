import { describe, expect, it } from 'vitest';
import { L1 } from '../src/core/level/levels/l1';
import { L2 } from '../src/core/level/levels/l2';
import { L3 } from '../src/core/level/levels/l3';
import { CUBE } from '../src/render/metrics';
import { openGates } from '../src/core/rules/goals';
import { collectProps, islandAndJetties } from '../src/render/scene';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';

/**
 * 道具层的两条**生命周期**约束（用户两条反馈的回归）。
 *
 * `collectProps` 是纯数据（`Piece[]`，不碰 three），所以这两件事不需要 WebGL 就能钉住 ——
 * 而它们恰恰是"看得见"那半边：规则层早就对了，错的是**画面没跟着变**。
 */
function load(def: LevelDef): Level {
  const parsed = parseLevel(def);
  if (!parsed.ok) throw new Error(`关卡必须合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

describe('道具层：折痕那一对只画一根（那根"粉红十字"的回归）', () => {
  it('L2 的连杆**不在折痕附近** —— 用户裁定：那个位置不该有连杆（架构文档 §八-11）', () => {
    const level = load(L2);
    // 杆在落水缺口正上方（r1 的 col 5 / col 22），不在交界（col 13/14）。
    expect(collectProps(level, level.grid).bars).toHaveLength(2);
  });

  it('夹具：折痕两侧同一种**有方向**的道具 → 只出一个件（"粉红十字"的直接回归）', () => {
    // `fold = 3`（6 列）：`r1` 的 col 2（A 最内列）与 col 3（B 最内列）各一根杆。
    // 它们在世界**同一个位置**，各自沿自己那面墙的轴 → 画两根就是一个十字。
    const level = load({
      id: 'FOLDBAR',
      name: '折痕连杆夹具',
      fold: 3,
      tiles: ['XXXXXX', '..--.E'],
    });
    expect(level.at(2, 1)).toBe('bar');
    expect(level.at(3, 1)).toBe('bar');
    expect(collectProps(level, level.grid).bars).toHaveLength(1);
  });

  it('对照：L1 没有连杆 → 0 个件', () => {
    const level = load(L1);
    expect(collectProps(level, level.grid).bars).toHaveLength(0);
  });

  it('L3：两处三格缺口各三根杆 + **甲板上的一根杆桥**，一共 7 件', () => {
    // 甲板上的杆不在摊平网格里，所以它们走的是 `collectProps` 里另一段 —— 用户报的
    // "两岛之间只有一根杆，这个没看到"就是那一段的回归。
    const level = load(L3);
    const bars = collectProps(level, level.grid).bars;
    expect(bars).toHaveLength(7); // 3（墙 A）+ 3（墙 B）+ 1（甲板杆桥）
  });

  it('甲板杆的**朝向**由邻居决定：杆桥沿 x → 横着画（`[CUBE, 0.1, 0.1]`）', () => {
    const level = load(L3);
    const bars = collectProps(level, level.grid).bars;
    // 甲板杆桥在 `x = -6`、`z = -7`，世界坐标带 `DECK_SHIFT`(0.5)。
    // 必须**连 z 一起筛**：B 面缺口那根墙杆恰好也在 `x = -5.5`（两套坐标系在那里重合）。
    const bridge = bars.filter((b) => b.p[0] === -6 + 0.5 && b.p[2] === -7 + 0.5);
    expect(bridge).toHaveLength(1);
    expect(bridge[0]?.s).toEqual([CUBE, 0.1, 0.1]);
  });
});

/**
 * 塔的**梯子标记**：它画在哪，玩家就得能站在哪按 `Z` —— 两者错开一格就等于指错路。
 *
 * 用户报过两次：①"没有梯子"（画在板厚里，被板包住）；②"走进梯子无法攀爬，直接从底层穿过"
 * （挪到了柱子**外面**，而 `Z` 生效的是柱子**自己那一格**）。所以这条测试钉的是**位置**。
 */
describe('道具层：塔的梯子标记必须落在"按 Z 生效的那一格"上', () => {
  it('L3 的柱：每层只画**一把**梯子，位置正是柱子离相机最近的那一格', () => {
    const level = load(L3);
    const ladders = islandAndJetties(level).ladders;
    // 柱有 level 0/1/2 三层各自"上面还有一层" → 三把梯子，每把 5 件（2 立柱 + 3 横档）。
    expect(ladders).toHaveLength(3 * 5);
    // 全部落在同一个 (x, z)：柱子离相机最近的那一格（`(-8, -8)`，带 `DECK_SHIFT`）。
    // 允许 ±0.3 —— 梯子的两根**立柱**本来就在格心两侧各偏 0.24（`ladderParts` 的几何）。
    // 关键不是"正好等于格心"，而是**没有偏出这一格**（第一版往外挪了整整半格）。
    for (const piece of ladders) {
      expect(Math.abs(piece.p[0] - (-8 + 0.5))).toBeLessThan(0.3);
      expect(Math.abs(piece.p[2] - (-8 + 0.5))).toBeLessThan(0.3);
    }
  });

  it('对照：没有塔的关卡一把甲板梯子都没有（L1 是平地台）', () => {
    const level = load(L1);
    expect(islandAndJetties(level).ladders).toHaveLength(0);
  });
});

describe('道具层：闸门开了，那两块砖**真的消失**（不是变成梯子）', () => {
  /**
   * 这一组原来断言的是"闸门变成梯子 ⇒ 梯子件变多 4×5"。用户 2026-09-23 集齐宝物后当场问
   * "**出口变成了梯子，这是怎么回事？**" —— 那不是他要的，他要的是他自己说的"障碍物自动消除"。
   *
   * 所以现在断言反过来：开闸之后
   *
   * 1. 闸门那几格**不再有梯子件**（旧行为会凭空多出 20 个件）；
   * 2. 它们也不再是砖 —— 这就意味着"渲染层必须跟着这张新网格走"，否则玩家看到的还是关着。
   *
   * 第 2 条是原来那条回归真正要防的东西（"道具层建一次就不动 ⇒ 变化看不见"），
   * 只是当时用梯子的**增量**来表达它。
   */
  it('开闸后：闸门格既没有梯子件、也不再是砖（变化必须传到渲染层）', () => {
    const level = load(L2);
    const before = collectProps(level, level.grid).ladders.length;
    const opened = openGates(level.grid, level.gates, level.cols);

    expect(level.gates).toHaveLength(4);
    // ① 不凭空造梯子：梯子件一个都不许多（多出来就是又变回"变成梯子"了）。
    expect(collectProps(level, opened).ladders.length).toBe(before);
    // ② 那几格真的空了 —— 砖层与道具层都要按这张新网格重建。
    for (const gate of level.gates) {
      expect(opened[gate.row * level.cols + gate.col]).toBe('empty');
      expect(collectProps(level, opened).bars.length).toBe(collectProps(level, level.grid).bars.length);
    }
  });

  it('宝物被收走之后，那一格不再有件（`treasure → empty` 走同一条重建）', () => {
    // `fold = 3`（6 列）：两颗宝物放在 **col 1 与 col 4** —— 刻意避开折痕那一对（2|3），
    // 因为"折痕去重"只对梯/杆生效，宝物各自都算数。
    const level = load({
      id: 'CHIP',
      name: '宝物夹具',
      fold: 3,
      tiles: ['XXXXXX', '.G..G.', '.....E'],
    });
    expect(collectProps(level, level.grid).treasures.length).toBe(2);
    const cleared = level.grid.map((kind) => (kind === 'treasure' ? ('empty' as const) : kind));
    expect(collectProps(level, cleared).treasures.length).toBe(0);
  });
});
