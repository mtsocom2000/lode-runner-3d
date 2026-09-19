import { halfExtent } from '../src/core/world/fold';
import { supportOf } from '../src/core/world/graph';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';
import type { Cell, Face } from '../src/core/types';
import { BRICK_N, CUBE, DECK_SHIFT, PLAYER_SIZE, cellAnchor, playerAnchor, seamSwing } from '../src/render/metrics';

/**
 * 锚点数学。T6 的验收里有一条"位置对"，这里就是那条的凭据 —— 而且是**纯数学**的：
 * 不需要 WebGL、不需要浏览器，因此可以在每次 `npm test` 里都跑。
 *
 * 断言尽量写成"两个**各自独立**推出来的量必须相等"，而不是"必须等于 1.18"。
 * 前者在常量改动后仍然有效（比如 CUBE 从 0.86 调成 0.8），后者会在每次调参后
 * 变成一条需要手改的噪声 —— 而一条需要手改的断言，迟早会被改成 `expect(true)`。
 */

const FOLD = 3; // 每面 3 列，共 6 列；折痕在 col 2|3 之间
const H = halfExtent(FOLD); // 2.5

const DEF: LevelDef = {
  id: 'METRICS',
  name: '锚点夹具',
  fold: FOLD,
  tiles: [
    'XXXXXX', // r0 实心砖：给 r1 提供"砖面"支撑
    '..H.--', // r1：col2 梯、col4/col5 杆（A 面 col0..2，B 面 col3..5）
    'XXXXXX', // r2 实心砖（自身不可通行，只用来占位）
  ],
};

function load(def: LevelDef): Level {
  const parsed = parseLevel(def);
  if (!parsed.ok) throw new Error(`夹具关卡不合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
}

function at(face: Face, col: number, row: number): Cell {
  return { face, col, row };
}

const level = load(DEF);

describe('metrics：cellAnchor —— 格子 → 世界坐标的唯一出口', () => {
  it('法线方向：A 面推到 +x、B 面推到 +z；两面都把列铺在**另一个**轴上', () => {
    const aZ: number[] = [];
    for (let col = 0; col < FOLD; col++) {
      const a = cellAnchor(level, at('A', col, 1));
      expect(a.p[0]).toBeCloseTo(-H + BRICK_N, 10); // A 面：x 恒定 = 墙面 + 砖厚
      aZ.push(a.p[2]);
    }
    expect(new Set(aZ).size).toBe(FOLD); // A 面的列沿 z 排 → 逐列不同

    const bX: number[] = [];
    for (let col = FOLD; col < FOLD * 2; col++) {
      const b = cellAnchor(level, at('B', col, 1));
      expect(b.p[2]).toBeCloseTo(-H + BRICK_N, 10); // B 面：z 恒定
      bX.push(b.p[0]);
    }
    expect(new Set(bX).size).toBe(FOLD); // B 面的列沿 x 排
  });

  it('折痕两侧的**最内列**正好落在折痕上（两面只差一个砖厚）', () => {
    const innermostA = cellAnchor(level, at('A', FOLD - 1, 1));
    const innermostB = cellAnchor(level, at('B', FOLD, 1));

    // A 的最内列：z = 折痕那条线；B 的最内列：x = 折痕那条线。
    expect(innermostA.p[2]).toBeCloseTo(-H, 10);
    expect(innermostB.p[0]).toBeCloseTo(-H, 10);

    // 两面各自沿自己的法线离开折痕，离开的量**相同** —— 这就是"折起来是连续的"。
    expect(innermostA.p[0] - -H).toBeCloseTo(BRICK_N, 10);
    expect(innermostB.p[2] - -H).toBeCloseTo(BRICK_N, 10);
  });

  it('alongZ 就是"该面的列沿 z 排" —— A 面真、B 面假（梯档/横杆的朝向靠它）', () => {
    expect(cellAnchor(level, at('A', 0, 1)).alongZ).toBe(true);
    expect(cellAnchor(level, at('B', FOLD, 1)).alongZ).toBe(false);
  });

  it('y 永远取格心 row + 0.5：行 +1 就是 y +1（不做任何竖直偏移）', () => {
    for (let row = 0; row < level.rows; row++) {
      expect(cellAnchor(level, at('A', 1, row)).p[1]).toBeCloseTo(row + 0.5, 10);
    }
    const low = cellAnchor(level, at('A', 1, 0)).p[1];
    const high = cellAnchor(level, at('A', 1, 2)).p[1];
    expect(high - low).toBeCloseTo(2, 10);
  });

  it('输出全是有限数（别让 NaN 混进变换链，它会在很久以后才发作）', () => {
    for (let col = 0; col < level.cols; col++) {
      expect(cellAnchor(level, at(col < FOLD ? 'A' : 'B', col, 1)).p.every(Number.isFinite)).toBe(true);
    }
  });
});

describe('metrics：playerAnchor —— 三种停驻，三种停法', () => {
  it('夹具本身先站得住：三个测试格各自认出该有的支撑方式', () => {
    expect(supportOf(level, at('A', 0, 1))).toBe('brick');
    expect(supportOf(level, at('A', 2, 1))).toBe('ladder');
    expect(supportOf(level, at('B', 4, 1))).toBe('bar');
  });

  it('站在砖面上：**脚底与下方那格砖的顶面重合**（踩在看得见的那张面上，不是悬空）', () => {
    const standing = at('A', 0, 1);
    const brickBelow = at('A', 0, 0); // supportOf 判 brick 的依据就是这一格

    const body = playerAnchor(level, standing, 'stand');
    const feet = body[1] - PLAYER_SIZE / 2;

    const brick = cellAnchor(level, brickBelow).p;
    const brickTop = brick[1] + CUBE / 2;

    expect(feet).toBeCloseTo(brickTop, 10);
  });

  it('攀在梯上：身体就占本格（梯是自支撑的，脚下没有"那张面"）', () => {
    const ladder = at('A', 2, 1);
    const body = playerAnchor(level, ladder, 'stand');
    expect(body).toEqual(cellAnchor(level, ladder).p);
  });

  it('吊在杆下：**头顶正好贴到杆心**（手就是搭在那儿）', () => {
    const bar = at('B', 4, 1);
    const body = playerAnchor(level, bar, 'hang');
    const head = body[1] + PLAYER_SIZE / 2;
    expect(head).toBeCloseTo(cellAnchor(level, bar).p[1], 10);
  });

  it('三种停驻只在 y 上分岔；法线方向（x/z）完全一致', () => {
    const bar = cellAnchor(level, at('B', 4, 1)).p;
    const hang = playerAnchor(level, at('B', 4, 1), 'hang');
    expect([hang[0], hang[2]]).toEqual([bar[0], bar[2]]);

    const cell = at('A', 0, 1);
    const centre = cellAnchor(level, cell).p;
    const stand = playerAnchor(level, cell, 'stand');
    expect([stand[0], stand[2]]).toEqual([centre[0], centre[2]]);
  });

  it('同一行上，站在砖面与吊在杆下的身体中心**等高** —— 这是 CUBE = 1.0 的算术后果', () => {
    // 都取 row 1 的格子，于是比较的纯粹是"停法差异"，不含行高。
    //
    // 两条偏移**来源不同、数值相同**：
    //   站砖面：`1 - CUBE/2 - PLAYER_SIZE/2` —— 脚踩在下方砖的顶面（y = row）之上；
    //   吊杆下：`PLAYER_SIZE/2`               —— 头顶贴到杆心（y = row + 0.5）。
    // CUBE = 1.0 时前者 = 1 - 0.5 - 0.25 = 0.25，后者 = 0.25，于是两者重合。
    //
    // 砖块之间留缝（CUBE = 0.86）的那一版里它们**不相等**，所以旧断言写的是 `toBeLessThan`。
    // 砖块改成紧贴之后，那条断言描述的是一个**不存在的差异**了。
    // 真正该钉住的是"脚碰上砖顶面"与"头顶碰上杆心"这两条**接触关系**（见前两个用例）——
    // 它们只依赖 PLAYER_SIZE 与 CUBE，不依赖某个巧合。
    const brickCell = at('A', 0, 1);
    const barCell = at('B', 4, 1);
    const stand = playerAnchor(level, brickCell, 'stand')[1];
    const hang = playerAnchor(level, barCell, 'hang')[1];

    expect(stand).toBeCloseTo(hang, 10);
    // 顺带把两个偏移各自的**公式**钉住：将来改 CUBE 时，"等高"可能碰巧还成立，
    // 但这两条不会 —— 数值变了就当场红。
    expect(stand).toBeCloseTo(brickCell.row + 0.5 - (1 - CUBE / 2 - PLAYER_SIZE / 2), 10);
    expect(hang).toBeCloseTo(barCell.row + 0.5 - PLAYER_SIZE / 2, 10);
  });
});

/**
 * 甲板（岛台 / 小道）的锚点。这一组是**用户报的 bug 的回归**：
 *
 * 现象："角色会从某处飞到另一处"、"走不进岛台"。根因不在规则里（`step` 的可达性 BFS 显示
 * 甲板 20/20 格全可达、宝物可达），而在**锚点**：`cellAnchor` 当年只有 A/B 两条分支，
 * `face === 'I'` 落进 B 面那支，于是 `(-7,-4)` 被送进 `toFold` → `u = col - fold = -16` →
 * 世界 `(-24.5, -3.5, -8.5)`。角色一踏进岛台就被画到**房间外、水面下**：
 * 屏幕上就是"飞出去"，人自然以为"走不进去"。
 *
 * 断言写成**关系式**（脚底与墙面行 1 的脚底等高），不写死 1.25：
 * 那个高度是"甲板只有一层砖厚 + 与墙面最低那层砖齐平"的算术后果，常量一改就该自动跟着变。
 */
describe('metrics：甲板格（face I）—— 两个下标就是世界 x/z，高度与墙面行 1 齐平', () => {
  const concept = load(CONCEPT_MINIMAL);
  /** 面 A 那条小道的外侧一格（关卡 `deck` 里的 `{x:-7, z:-4}`）。 */
  const JETTY: Cell = { face: 'I', col: -7, row: -4 };

  it('x/z 用格下标**加半格对齐偏移**（`DECK_SHIFT`）—— 甲板不属于"沿墙 u × 高度 y"那套，绝不能过 toFold/toWorld', () => {
    const p = cellAnchor(concept, JETTY).p;
    // -7/-4 是格下标；-0.5 是"与墙砖半整数晶格对齐"的那半格（否则小道顶在两块砖的缝上）。
    expect([p[0], p[2]]).toEqual([-7 + DECK_SHIFT, -4 + DECK_SHIFT]);
  });

  it('回归：锚点必须落在两片墙围出的房间里（旧 bug 给的是 -24.5 / -8.5）', () => {
    const limit = halfExtent(concept.fold); // 8.5
    const p = cellAnchor(concept, JETTY).p;
    expect(p[0]).toBeGreaterThanOrEqual(-limit);
    expect(p[2]).toBeGreaterThanOrEqual(-limit);
    expect(p[0]).toBeLessThanOrEqual(0);
    expect(p[2]).toBeLessThanOrEqual(0);
  });

  it('站在甲板上：脚底与墙面"行 1"站着时的脚底**等高**（小道才接得上最底层砖块）', () => {
    const deckFeet = playerAnchor(concept, JETTY, 'stand')[1] - PLAYER_SIZE / 2;
    // 行 1 是墙面的行走行：脚下是 r0 那层砖的顶面。
    const wallFeet = playerAnchor(concept, { face: 'A', col: 0, row: 1 }, 'stand')[1] - PLAYER_SIZE / 2;
    expect(deckFeet).toBeCloseTo(wallFeet, 10);
  });

  it('岛台上站着的身体中心，与同一高度的墙面格一样**不悬空**（脚踩顶面）', () => {
    const island: Cell = { face: 'I', col: -3, row: -3 }; // 宝物那一格
    const body = playerAnchor(concept, island, 'stand');
    expect(body[1] - PLAYER_SIZE / 2).toBeCloseTo(
      playerAnchor(concept, { face: 'A', col: 0, row: 1 }, 'stand')[1] - PLAYER_SIZE / 2,
      10,
    );
    expect([body[0], body[2]]).toEqual([-3 + DECK_SHIFT, -3 + DECK_SHIFT]);
  });
});

/**
 * 跨折痕那一步的中途点。用户报的"机器人经过两个侧面转角处路线很奇怪"就是它缺失时的样子：
 * 折痕两侧最内列的两格在世界坐标里是**斜对角**，直线插值会让方块一角插进墙角。
 */
describe('metrics：seamSwing —— 跨折痕一步绕折痕轴转 90°', () => {
  const concept = load(CONCEPT_MINIMAL); // fold = 9 → half = 8.5
  const h = halfExtent(concept.fold);
  const A_INNER: Cell = { face: 'A', col: 8, row: 1 };
  const B_INNER: Cell = { face: 'B', col: 9, row: 1 };

  it('折痕那一对 → 给出 45° 上的中途点（半径 = BRICK_N）', () => {
    const swing = seamSwing(concept, A_INNER, B_INNER);
    expect(swing).not.toBeNull();
    const r = BRICK_N * Math.SQRT1_2;
    expect(swing?.x).toBeCloseTo(-h + r, 10);
    expect(swing?.z).toBeCloseTo(-h + r, 10);
  });

  it('**方向无关**：反过来走给同一点（弧还是那条弧，只是反向走）', () => {
    expect(seamSwing(concept, B_INNER, A_INNER)).toEqual(seamSwing(concept, A_INNER, B_INNER));
  });

  it('中途点落在两格**共用的那一格**里（所以身体不会碰到墙角）', () => {
    // 共用格 = 距折痕 1 格：A:7（u=1）/ B:10 是同一处世界坐标。
    const shared = cellAnchor(concept, { face: 'A', col: 7, row: 1 }).p;
    const swing = seamSwing(concept, A_INNER, B_INNER);
    expect(swing).not.toBeNull();
    expect(Math.abs((swing?.x ?? 0) - shared[0])).toBeLessThan(0.5);
    expect(Math.abs((swing?.z ?? 0) - shared[2])).toBeLessThan(0.5);
  });

  it('普通一步 / 不是折痕对手 → `null`（绝大多数步都是直线）', () => {
    expect(seamSwing(concept, { face: 'A', col: 8, row: 1 }, { face: 'A', col: 7, row: 1 })).toBeNull();
    expect(seamSwing(concept, { face: 'A', col: 8, row: 1 }, { face: 'B', col: 10, row: 1 })).toBeNull();
    expect(seamSwing(concept, { face: 'A', col: 8, row: 1 }, { face: 'B', col: 9, row: 2 })).toBeNull(); // 不同行
  });
});
