import { describe, expect, it } from 'vitest';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { drownPath } from '../src/core/rules/drown';
import { isSolid } from '../src/core/world/graph';
import { step, stateAt, type Dir } from '../src/core/rules/movement';
import { createSim, replay, type SimEvent } from '../src/core/sim';
import { isWater, isWaterLevel, WATER_LEVEL_RANGE, type WaterFall } from '../src/core/world/water';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';
import { cellKey, type Cell } from '../src/core/types';
import { WATER_Y } from '../src/render/metrics';

/**
 * T9 的验收：**两条落水途径各 3 用例 + "水面不可走入"**（任务分解文档 T9 行）。
 *
 * 每个用例的关卡都**就地写在场内**（`lv(...)`）而不是塞进 `fixtures.ts`：
 * 落水是"地形 + 一个动作"共同决定的，把地形摆在断言旁边才看得出这条用例在测什么。
 * 用 `fold = 2`（4 列）的两三行小关卡 —— 足够摆出缺口、杆、以及网格的边界。
 */

/** 就地造一份关卡定义。`createSim` 要 `LevelDef`、断言要 `Level`，两者都从它来。 */
function defOf(tiles: readonly string[]): LevelDef {
  return { id: 'T9', name: 'T9', fold: 2, tiles };
}

/** 解析成 `Level`。数据不合法就当场炸 —— 那是测试自己写错了，不该静默跳过。 */
function lv(tiles: readonly string[]): Level {
  const parsed = parseLevel(defOf(tiles));
  if (!parsed.ok) throw new Error(`测试关卡不合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

/** 从 `level` 与扁平坐标造格（`face` 归 `fold` 决定，不手写 A/B）。 */
function at(level: Level, col: number, row: number): Cell {
  return { face: col < level.fold ? 'A' : 'B', col, row };
}

/** 拿"站得住 + 模式正确"的 state；站不住就炸（又是测试自己写错）。 */
function standOn(level: Level, col: number, row: number) {
  const cell = at(level, col, row);
  const state = stateAt(level, cell);
  if (state === null) throw new Error(`${cellKey(cell)} 应当站得住`);
  return state;
}

/** 断言这一步确实落水，并返回收窄后的 `WaterFall`（靠 `isWater` 的类型谓词，不用 `as`）。 */
function expectWater(level: Level, col: number, row: number, dir: Dir): WaterFall {
  const result = step(level, standOn(level, col, row), dir);
  if (result.kind !== 'fall') throw new Error(`期望坠落，得到 ${result.kind}`);
  expect(isWater(result.end)).toBe(true);
  if (!isWater(result.end)) throw new Error('上面那行已经断言过了，这里只为收窄类型');
  return result.end;
}

// ── 地形（三条，都是从"没有支撑"这件事出发）────────────────────────────────

/** 途径①：地板在 col1 缺一块砖 → 从 col0 往右走就掉下去。 */
const HOLE_TILES: readonly string[] = ['X.XX', 'E...'];
const HOLE = lv(HOLE_TILES);

/** 途径①（高处）：地板与中间平台在同一列都缺砖 → 从 row 3 掉下去也是同一回事。 */
const HOLE_HIGH_TILES: readonly string[] = ['X.XX', 'E...', 'X.XX', 'E...'];
const HOLE_HIGH = lv(HOLE_HIGH_TILES);

/** 途径②：r1 的 col1 是横杆，而它**正下方整列都是空的**（杆下方得有空才吊得住）。 */
const BAR_TILES: readonly string[] = ['....', '.-..'];
const BAR_OVER_VOID = lv(BAR_TILES);

describe('T9 途径①：坠落至水面（3 例）', () => {
  it('① 走进地板缺口 → fall + 终点是水，且落水列记在 `from` 上', () => {
    const end = expectWater(HOLE, 0, 1, 'right');
    // `from` 是**坠落起点**（缺口的邻格，col1）；`row` 是下坠过程中最后探到的行号，
    // 也就是"一路掉到了最底行"（row 0）—— 不是负数。想在画面上定位落水点就用 `from`。
    expect(end.from.col).toBe(1);
    expect(end.from.row).toBe(1);
    expect(end.row).toBe(0);
  });

  it('② 途径归属：站着横移 → `fall`（不是 `bar-release`）', () => {
    expect(drownPath('stand', 'right')).toBe('fall');
    // 对照：同一个方向、吊着的时候也是 `fall` —— 途径②要的是**向下**，不是横向。
    expect(drownPath('hang', 'right')).toBe('fall');
  });

  it('③ 从 row 3 掉进同一列 → 还是途径①（远距离坠落与一步坠落同规则）', () => {
    const end = expectWater(HOLE_HIGH, 0, 3, 'right');
    expect(end.from.row).toBe(3);
    expect(drownPath('stand', 'right')).toBe('fall');
  });

  it('④ 落水**只能**由地板缺口引起：那一列的 r0 必须是缺口', () => {
    // 这条把"水"与"掉出墙体"钉成同一件事：能找到落水点的地方，脚下那列一定通到网格外。
    for (const level of [HOLE, HOLE_HIGH]) {
      const end = expectWater(level, 0, level.rows - 1, 'right');
      expect(isSolid(level.at(end.from.col, 0))).toBe(false);
    }
  });
});

describe('T9 途径②：杆上"下"跳（3 例）', () => {
  it('① 吊在杆上按 down → fall + 终点是水（松手 = 从杆下一格起坠）', () => {
    const end = expectWater(BAR_OVER_VOID, 1, 1, 'down');
    // 落点从杆的**下一格**起算 —— 杆本身不是落脚点。
    expect(end.from.row).toBe(0);
  });

  it('② 途径归属：`hang` + `down` → `bar-release`（只差 mode 与 dir 两件事）', () => {
    expect(drownPath('hang', 'down')).toBe('bar-release');
    // 站着按 down 走不到这条路（stand 模式下 down 只认梯），所以这个组合只可能是松手。
    expect(drownPath('stand', 'down')).toBe('fall');
  });

  it('③ 吊着按 **up** 不落水 —— 那是非法方向，不是死亡（反向对照）', () => {
    const result = step(BAR_OVER_VOID, standOn(BAR_OVER_VOID, 1, 1), 'up');
    expect(result).toEqual({ kind: 'blocked', reason: 'not-hangable' });
  });
});

describe('T9：水面不可走入', () => {
  it('朝网格外的方向走 → `blocked(out)`，不是坠落', () => {
    // 水在**网格之外**（两片墙围起来的中间那块），所以"走进水里"在规则上根本不成立：
    // 网格边界会拦住这一步。这就是用户那句"无论在地面哪一侧，都无法按方向键落入水中"。
    const level = HOLE;
    const edges: readonly (readonly [number, number, Dir])[] = [
      [0, 1, 'left'], // 面 A 最西端往左 = 出网格
      [level.cols - 1, 1, 'right'], // 面 B 最东端往右 = 出网格
    ];
    for (const [col, row, dir] of edges) {
      const result = step(level, standOn(level, col, row), dir);
      expect(result).toEqual({ kind: 'blocked', reason: 'out' });
    }
  });

  it('CONCEPT_MINIMAL 的落水点 = r0 的 col 2 / col 15 两个缺口（各贡献左右两次）', () => {
    // 这条原本断言"落水点数量为 0"，因为那时 r0 满宽实心（当初正是为了修 DEV_FOLD 的连通性）。
    // 现在用户拍板要在地板两端开洞，于是期望值改成**有意的** 4 —— 不是悄悄多出来，
    // 而是明确要求的两个缺口。改这条测试就是那次改动的**记录**。
    //
    // 为什么是 4 而不是 2：一个缺口可以从**两侧**各走进去一次（col1 → col2、col3 → col2），
    // 每个缺口贡献 2 个"走一步就落水"的 (格, 方向)。两个缺口 → 4。
    // 洞口列记在 `result.end.from.col` 上（那是"想踏进去的那一格"，也就是缺口本身）。
    //
    // 为什么连洞口列一起断言：只断言总数的话，把洞开到别处（比如梯子下面）也能凑出 4，
    // 而那种改法会破坏别的东西。**位置**才是这条测试真正在守的契约。
    const parsed = parseLevel(CONCEPT_MINIMAL);
    if (!parsed.ok) throw new Error('CONCEPT_MINIMAL 必须合法');
    const level = parsed.level;

    const holes: number[] = [];
    for (let row = 0; row < level.rows; row++) {
      for (let col = 0; col < level.cols; col++) {
        const state = stateAt(level, at(level, col, row));
        if (state === null) continue;
        for (const dir of ['left', 'right'] as const) {
          const result = step(level, state, dir);
          if (result.kind === 'fall' && isWater(result.end)) holes.push(result.end.from.col);
        }
      }
    }

    // 每个缺口左右各一次 → 洞口列各出现两遍。
    expect([...holes].sort((a, b) => a - b)).toEqual([2, 2, 15, 15]);
    // 出生点的支撑砖**必须**还在 —— 当初正是因为它在 col 0，才没把洞开在最端头。
    expect(isSolid(level.at(0, 0))).toBe(true);
  });
});

describe('T9：扣命结算（走 sim，不是只测规则）', () => {
  it('途径① 走一 tick → drowned(' + "'fall'" + ') + respawned，命数 -1', () => {
    const state = createSim(defOf(HOLE_TILES), at(HOLE, 0, 1));
    const [frame] = replay(state, [{ move: 'right', dig: null }]);
    const events: readonly SimEvent[] = frame?.events ?? [];

    expect(events.map((e) => e.kind)).toEqual(['drowned', 'respawned']);
    const drowned = events[0];
    expect(drowned?.kind === 'drowned' && drowned.path).toBe('fall');
    expect(frame?.state.lives).toBe(2);
  });

  it('途径② 走一 tick → 途径记成 bar-release', () => {
    const state = createSim(defOf(BAR_TILES), at(BAR_OVER_VOID, 1, 1));
    const [frame] = replay(state, [{ move: 'down', dig: null }]);
    const drowned = frame?.events[0];
    expect(drowned?.kind === 'drowned' && drowned.path).toBe('bar-release');
  });
});

describe('T9：水位与渲染共用一个真相', () => {
  it('`render` 的 WATER_Y 落在 core 给的水位区间里', () => {
    // 规则说"掉出墙体就是水"，渲染把水面画在某个 y 上。两个数字各写一遍必然会漂
    // （本仓库历次 bug 的形状），所以 `world/water.ts` 给出**区间约束**，这里拿它去卡渲染值。
    expect(isWaterLevel(WATER_Y)).toBe(true);
    expect(WATER_Y).toBeGreaterThan(WATER_LEVEL_RANGE.min);
    expect(WATER_Y).toBeLessThan(WATER_LEVEL_RANGE.max);
  });
});
