import { describe, expect, it } from 'vitest';
import { L1 } from '../src/core/level/levels/l1';
import { L2 } from '../src/core/level/levels/l2';
import { openGates } from '../src/core/rules/goals';
import { collectProps } from '../src/render/scene';
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
  it('L2 的跨折痕横杆：两个 `bar` 格在世界同一个位置 → 只出一个件', () => {
    const level = load(L2);
    // 关卡数据里确实是两根（col 13 与 col 14）。
    expect(level.at(13, 3)).toBe('bar');
    expect(level.at(14, 3)).toBe('bar');
    // 但只画一根：两根各自沿自己那面墙的轴、又都穿过同一个点，画出来是个十字。
    expect(collectProps(level, level.grid).bars).toHaveLength(1);
  });

  it('对照：L1 没有横杆 → 0 个件', () => {
    const level = load(L1);
    expect(collectProps(level, level.grid).bars).toHaveLength(0);
  });
});

describe('道具层：闸门开了真的会多出梯子（"通天梯"的回归）', () => {
  it('把 `gates` 换成梯子之后，梯子件**变多**（以前建一次就不动 → 看不见）', () => {
    const level = load(L2);
    const before = collectProps(level, level.grid).ladders.length;
    const opened = openGates(level.grid, level.gates, level.cols);
    const after = collectProps(level, opened).ladders.length;

    // 四块闸门 → 四格梯子，每格 5 个件（2 立柱 + 3 横档）。
    expect(level.gates).toHaveLength(4);
    expect(after - before).toBe(4 * 5);
  });

  it('芯片被收走之后，那一格不再有件（`treasure → empty` 走同一条重建）', () => {
    // `fold = 3`（6 列）：两颗芯片放在 **col 1 与 col 4** —— 刻意避开折痕那一对（2|3），
    // 因为"折痕去重"只对梯/杆生效，芯片各自都算数。
    const level = load({
      id: 'CHIP',
      name: '芯片夹具',
      fold: 3,
      tiles: ['XXXXXX', '.G..G.', '.....E'],
    });
    const withChips = collectProps(level, level.grid).chips.length;
    expect(withChips).toBe(2);
    const cleared = level.grid.map((kind) => (kind === 'treasure' ? ('empty' as const) : kind));
    expect(collectProps(level, cleared).chips.length).toBe(0);
  });
});
