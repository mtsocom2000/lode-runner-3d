import { halfExtent } from '../src/core/world/fold';
import { supportOf } from '../src/core/world/graph';
import { DIRS, OPPOSITE_DIR, step } from '../src/core/rules/movement';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { parseLevel, type Level, type LevelDef } from '../src/core/world/tiles';
import type { Cell, Face } from '../src/core/types';
import { BRICK_N, CUBE, DECK_SHIFT, PLAYER_SIZE, cellAnchor, glintStrips, guideLine, playerAnchor, sameWorldDirection, stepDelta } from '../src/render/metrics';

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

  it('折痕两侧最内列**贴在折痕线之外**（各离折痕半格）—— 差这半格就是"走进墙里"', () => {
    const innermostA = cellAnchor(level, at('A', FOLD - 1, 1));
    const innermostB = cellAnchor(level, at('B', FOLD, 1));

    // A 的最内列：法线方向推到墙面 + 半砖，**沿墙方向离折痕半格**（贴在外面，不骑在折痕上）。
    expect(innermostA.p[2]).toBeCloseTo(-H + CUBE / 2, 10);
    expect(innermostB.p[0]).toBeCloseTo(-H + CUBE / 2, 10);

    // 两面各自沿自己的法线离开折痕，离开的量**相同** —— 这就是"折起来是连续的"。
    expect(innermostA.p[0] - -H).toBeCloseTo(BRICK_N, 10);
    expect(innermostB.p[2] - -H).toBeCloseTo(BRICK_N, 10);
  });

  it('折痕那一对落在**世界同一个位置** —— 折一步 = 原地转 90°（`BRICK_N = CUBE/2` 的等价说法）', () => {
    const a = cellAnchor(level, at('A', FOLD - 1, 1)).p;
    const b = cellAnchor(level, at('B', FOLD, 1)).p;
    expect(a[0]).toBeCloseTo(b[0], 10);
    expect(a[2]).toBeCloseTo(b[2], 10);
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
 * `stepDelta`：**按某个方向走一步的世界位移**。两个消费者 —— HUD 的方向提示（投影成 `→↑`）
 * 与角色的**朝向箭头**（转成 yaw）—— 共用它，所以"提示说往右、箭头却指别处"不可能发生。
 */
describe('metrics：stepDelta —— 一步的世界位移（HUD 提示与朝向箭头共用）', () => {
  const concept = load(CONCEPT_MINIMAL);

  it('甲板上：`up` 是 −z、`down` 是 +z（2026-09-19 对调过 —— 用户："按 w 往左下方走，反直觉"）', () => {
    const island: Cell = { face: 'I', col: -3, row: -3 };
    const up = stepDelta(concept, island, 'stand', 'up');
    const down = stepDelta(concept, island, 'stand', 'down');
    expect(up?.delta[0]).toBeCloseTo(0, 10);
    expect(up?.delta[2]).toBeCloseTo(-1, 10);
    expect(down?.delta[2]).toBeCloseTo(1, 10);
  });

  it('跨折痕那一步：位移**不是 0**，而是"转过弯之后"的方向（原地转 90°）', () => {
    // 概念关卡的最内列 `A:8`：往 right 就是跨折痕。直接取那一步会得到零向量（两格同点），
    // 所以 `stepDelta` 会再看一步 —— 这就是朝向箭头与 HUD 提示在拐角处的口径。
    const foldCell: Cell = { face: 'A', col: 8, row: 1 };
    const r = stepDelta(concept, foldCell, 'stand', 'right');
    expect(r).not.toBeNull();
    expect(Math.hypot(r?.delta[0] ?? 0, r?.delta[2] ?? 0)).toBeCloseTo(1, 10);
  });

  it('走不了的方向 → `null`（HUD 画 `×`，箭头保持上一次朝向）', () => {
    // 出生点左边就是网格外。
    expect(stepDelta(concept, { face: 'A', col: 0, row: 1 }, 'stand', 'left')).toBeNull();
  });
});

/**
 * "按住不放"要不要跨过这一步继续 —— `main.ts` 用它决定是否掐掉按住。
 *
 * **门**（甲板 ↔ 墙面）两侧的键含义不同 → 掐；**折痕**（A ↔ B）是同一条走廊折了一下 → 不掐
 * （"沿走廊一直走就能过去"那条教学照旧）。
 */
describe('metrics：水面高光条（"5 条"必须真的是 5 条）', () => {
  it('条数 5、**彼此不重叠**：沿 z 排开，而且间隔大于自身厚度', () => {
    const strips = glintStrips(-7, 8);
    expect(strips).toHaveLength(5);
    const zs = strips.map((s) => s.p[2]).sort((a, b) => a - b);
    for (let i = 1; i < zs.length; i++) {
      const gap = (zs[i] ?? 0) - (zs[i - 1] ?? 0);
      // 自身在 z 上的厚度是 0.16 —— 间隔必须明显大于它，否则首尾相叠就又是一根长线。
      expect(gap).toBeGreaterThan(0.16 * 2);
    }
  });

  it('**长度方向与排列方向垂直**：每条沿 x 长、沿 z 薄（第一版正是这一条反了）', () => {
    for (const s of glintStrips(0, 10)) {
      expect(s.s[0]).toBeGreaterThan(s.s[2]); // 长在 x
      expect(s.s[2]).toBeLessThan(0.2); // 薄在 z
    }
  });

  it('居中：最中间那条落在中心上，两侧对称', () => {
    const zs = glintStrips(-3, 6).map((s) => s.p[2]);
    expect(zs[2]).toBe(-3);
    expect((zs[0] ?? 0) + (zs[4] ?? 0)).toBeCloseTo(-6, 10); // 关于中心对称
  });
});

describe('metrics：跨面的那一步之后，按住的键还有没有意义', () => {
  it('门（甲板 → 墙面）：按住的键在新表面上**不再指向原方向** → 该掐', () => {
    const lv = load(CONCEPT_MINIMAL);
    for (const joint of lv.joints) {
      const deckCell: Cell = { face: 'I', col: joint.deck.x, row: joint.deck.z };
      // "沿小道走来的那个键" = 在**小道自己那侧**求：唯一那个"走到另一格甲板"的方向，取反向。
      //（2026-09-19 之前这里是 `enterDir` 的反向 —— 那时两者是同一个键；现在 `enterDir` 必须是
      // "那一格堵住的方向"，与沿小道走的键**无关**了，见 `movement.ts` 的 `jointStep`。）
      const along = DIRS.filter((d) => {
        const r = step(lv, { cell: deckCell, mode: 'stand' }, d);
        return r.kind === 'move' && r.state.cell.face === 'I';
      });
      expect(along).toHaveLength(1);
      const outward = OPPOSITE_DIR[along[0] as (typeof DIRS)[number]];
      const before = stepDelta(lv, deckCell, 'stand', outward);
      const after = stepDelta(lv, joint.wall, 'stand', outward);
      expect(before).not.toBeNull();
      if (after === null) continue; // 那个键在墙面上根本走不动（B 面 `w` = 爬梯）→ 自然就停住
      expect(sameWorldDirection(before!.delta, after.delta)).toBe(false);
    }
  });

  it('折痕（A ↔ B）：两边给的是**同一个**世界方向 → 不掐', () => {
    const lv = load(CONCEPT_MINIMAL);
    const inner: Cell = { face: 'A', col: 8, row: 1 };
    const partner: Cell = { face: 'B', col: 9, row: 1 };
    const before = stepDelta(lv, inner, 'stand', 'right');
    const after = stepDelta(lv, partner, 'stand', 'right');
    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(sameWorldDirection(before!.delta, after!.delta)).toBe(true);
  });

  it('`sameWorldDirection` 本体：同轴为真、垂直为假', () => {
    expect(sameWorldDirection([1, 0, 0], [2, 0, 0.01])).toBe(true);
    expect(sameWorldDirection([1, 0, 0], [0, 0, 1])).toBe(false);
    expect(sameWorldDirection([1, 0, 0], [-1, 0, 0])).toBe(false);
    expect(sameWorldDirection([0, 0, 0], [1, 0, 0])).toBe(false); // 零向量不算方向
  });
});

describe('guideLine —— 悬停辅助线（用户报过"偏出去半面墙"）', () => {
  it('A 面那一条：**以两端中点为心**，且盖住首尾两格', () => {
    // 第一版把中心取成"第一个格子的锚点"，于是整条线偏出去半面墙、还长出场景外。
    // 这一条钉的就是那个中点 —— 纯函数才测得出来，看着像不像当时骗过了我。
    const first = cellAnchor(level, { face: 'A', col: 0, row: 1 }).p;
    const last = cellAnchor(level, { face: 'A', col: FOLD - 1, row: 1 }).p;
    const g = guideLine(level, 'A', 1);
    expect(g.p[2]).toBeCloseTo((first[2] + last[2]) / 2, 6); // z 方向居中
    expect(g.p[1]).toBeCloseTo(first[1], 6); // 与那一行同高
    const half = g.s[2] / 2;
    expect(g.p[2] - half).toBeLessThanOrEqual(Math.min(first[2], last[2]));
    expect(g.p[2] + half).toBeGreaterThanOrEqual(Math.max(first[2], last[2]));
    expect(g.s[2]).toBeGreaterThan(1); // 长边在 z 上（A 面的列沿 z）
    expect(g.s[0]).toBe(g.s[1]);
    expect(g.s[0]).toBeLessThan(0.2); // 细
    // 另一条轴：落在**砖的外侧**（埋进砖里就看不见了）。
    expect(Math.abs(g.p[0] - first[0])).toBeGreaterThan(0.3);
  });

  it('B 面那一条：长边在 x 上（两面墙互相垂直），同样以中点为心', () => {
    const first = cellAnchor(level, { face: 'B', col: FOLD, row: 1 }).p;
    const last = cellAnchor(level, { face: 'B', col: FOLD * 2 - 1, row: 1 }).p;
    const g = guideLine(level, 'B', 1);
    expect(g.p[0]).toBeCloseTo((first[0] + last[0]) / 2, 6);
    expect(g.p[1]).toBeCloseTo(first[1], 6);
    const half = g.s[0] / 2;
    expect(g.p[0] - half).toBeLessThanOrEqual(Math.min(first[0], last[0]));
    expect(g.p[0] + half).toBeGreaterThanOrEqual(Math.max(first[0], last[0]));
    expect(g.s[1]).toBe(g.s[2]);
    expect(Math.abs(g.p[2] - first[2])).toBeGreaterThan(0.3);
  });
});