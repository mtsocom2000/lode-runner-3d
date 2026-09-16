import { describe, expect, it } from 'vitest';
import { CONCEPT_MINIMAL, PLAYER_SPAWN } from '../src/core/level/levels/conceptMinimal';
import { validateLevel, type LevelIssue, type RuleId } from '../src/core/level/validate';
import type { LevelDef } from '../src/core/world/tiles';
import type { Cell } from '../src/core/types';

/**
 * T8 关卡校验的回归夹具。
 *
 * 每条规则**一个反例**，而且反例都尽量只触发那一条 —— 这样断言才能写成"恰好是这组规则"，
 * 而不是"包含某条"。做不到单条的（断梯、悬空出口）就精确断言**两条**，
 * 并把"为什么必然连带"写在注释里 —— 那本身就是设计的一部分。
 *
 * 最后两条是**反向**用例：证明校验没有过严。一条关卡合法就是合法，
 * 不能因为"梯子没通到顶""砖块摆在奇数行"这种设计取向被拦下来。
 */

const def = (fold: number, tiles: readonly string[]): LevelDef => ({
  id: 'TEST',
  name: '测试关',
  fold,
  tiles,
});

/** 规则 id 列表，按 `validateLevel` 的产出顺序 —— 断言顺序也是断言契约的一部分。 */
const rules = (issues: readonly LevelIssue[]): readonly RuleId[] => issues.map((i) => i.rule);

describe('validateLevel —— 正例', () => {
  it('CONCEPT_MINIMAL 通过：0 条问题', () => {
    expect(validateLevel(CONCEPT_MINIMAL, PLAYER_SPAWN)).toEqual([]);
  });

  it('不传出生点就跳过 spawnStandable / unreachable 两条', () => {
    // 同一份数据：传了出生点会报"4 格到不了"，不传就什么都报不出来。
    // 出生点住在关卡文件旁边（PLAYER_SPAWN）而不是 LevelDef 里，
    // 所以"不知道出生点"时必须**沉默**，而不是替它编一个默认值。
    const strayed = def(3, ['X.XXXX', 'E.....']);
    expect(validateLevel(strayed)).toEqual([]);
    expect(rules(validateLevel(strayed, { face: 'A', col: 0, row: 1 }))).toEqual(['unreachable']);
  });
});

describe('validateLevel —— 字形层（交给 parseLevel）', () => {
  it('行长不齐 → parse', () => {
    expect(rules(validateLevel(def(2, ['XXXX', 'XXX'])))).toEqual(['parse']);
  });

  it('非法字形 → parse', () => {
    expect(rules(validateLevel(def(2, ['XX?X', 'XXXX'])))).toEqual(['parse']);
  });

  it('列数不等于 2×fold → parse', () => {
    expect(rules(validateLevel(def(3, ['XXXX', 'XXXX'])))).toEqual(['parse']);
  });
});

describe('validateLevel —— 结构规则', () => {
  it('奇数高度 → rowsEven', () => {
    // 3 行：r0、r1 两层砖，r2 才是行走行（4 格可站立、横向连通、出口也落得住）。
    // 除了"总高是奇数"之外没有任何毛病，所以恰好只报这一条。
    //
    // 顺带钉住一件事：**砖摆在奇数行不算错**。这里 r1 整行都是砖，校验一个字都没提 ——
    // "砖只出现在偶数行"是关卡作者的节奏，不是结构约束（结构上 r1 是砖，r2 就走得上去）。
    expect(rules(validateLevel(def(2, ['XXXX', 'XXXX', '.E..']), { face: 'A', col: 0, row: 2 }))).toEqual([
      'rowsEven',
    ]);
  });

  it('出生点站不住 → spawnStandable', () => {
    // r0 在 col1 是个洞，所以 r1 col1 悬空；出生点正摆在那里。
    // 5 号规则会跟着跳过（出生点都不是节点，再报"全到不了"只会误导）。
    expect(rules(validateLevel(def(2, ['X..X', 'E...']), { face: 'A', col: 1, row: 1 }))).toEqual([
      'spawnStandable',
    ]);
  });

  it('悬空出口 → exitStandable（并连带 unreachable）', () => {
    // 出口画在 r1 col1，正下方是洞 —— 玩家走到那一列会发现停不住。
    // 连带 unreachable 是**必然**的：出口那一格因此不是节点，
    // 于是 r1 的左右两段被它劈开（col0 与 col3 各自孤立），一条数据错引出两条报告。
    expect(rules(validateLevel(def(2, ['X..X', '.E..']), { face: 'A', col: 0, row: 1 }))).toEqual([
      'exitStandable',
      'unreachable',
    ]);
  });

  it('没有出口 → noExit', () => {
    expect(rules(validateLevel(def(2, ['XXXX', '....']), { face: 'A', col: 0, row: 1 }))).toEqual(['noExit']);
  });

  it('梯子中间断一格 → ladderContinuous（并连带 unreachable）', () => {
    // col1 是 H(r1) / X(r2) / H(r3)：r1 与 r3 不相邻，`climb` 边要求上下两格都是梯，
    // 于是 r3 那一格既上不去也下不来，成了孤岛 —— 连带 unreachable 同样是必然的。
    const broken = def(3, ['XXXXXX', '.H.E..', '.X....', '.H....']);
    const issues = validateLevel(broken, { face: 'A', col: 0, row: 1 });
    expect(rules(issues)).toEqual(['ladderContinuous', 'unreachable']);
    expect(issues[0]?.at).toEqual({ face: 'A', col: 1, row: 2 });
  });
});

describe('validateLevel —— 可达性（本层存在的理由）', () => {
  it('地板一处缺口把行走行切成两段 → unreachable，1 块 4 格', () => {
    // r0 在 col1 缺一块砖：r1 的 col0 与 col2..5 之间没有可站立格相连，
    // 于是出生点（col0）那一块只有 1 格，另外 4 格连成 1 块到不了。
    const issues = validateLevel(def(3, ['X.XXXX', 'E.....']), { face: 'A', col: 0, row: 1 });
    expect(rules(issues)).toEqual(['unreachable']);
    expect(issues[0]?.stranded).toBe(4);
    expect(issues[0]?.components).toBe(1);
  });

  it('地板多处缺口 → 孤岛碎成多块（`DEV_FOLD` 的形状）', () => {
    // r0 是 X.X.X.：只有 col0 / col2 / col4 三处站得住，三者互不相邻。
    // 报"2 格到不了"是不够的 —— 关键是它们**碎成 2 块**：
    // 说明不是漏了一格，而是可达性结构塌了。这正是 `DEV_FOLD`（43 格碎成 25 块）的形状。
    const issues = validateLevel(def(3, ['X.X.X.', 'E.....']), { face: 'A', col: 0, row: 1 });
    expect(rules(issues)).toEqual(['unreachable']);
    expect(issues[0]?.stranded).toBe(2);
    expect(issues[0]?.components).toBe(2);
  });
});

describe('validateLevel —— 反向：别把这些合法关卡拦下来', () => {
  it('只有一格高的梯子合法（不要求梯子通到顶）', () => {
    // "梯子必须从地面通到最顶"是**设计取向**，不是结构约束：
    // 一格梯子照样能站、照样不孤立，所以它必须通过。
    expect(validateLevel(def(2, ['XXXX', '.H.E']), { face: 'A', col: 0, row: 1 })).toEqual([]);
  });

  it('地板末端缺一块砖合法（只要剩下的部分仍然连通）', () => {
    // 反面用例是"地板**中间**开洞 → 把行走行切成两段"（那条报 unreachable）。
    // 开在末端就不同了：剩下的 col0..col2 仍然连成一串，出口也落在实心砖上方。
    // 两条合起来才说明校验判的是**连通性**，而不是"地板必须满宽"。
    expect(validateLevel(def(2, ['XXX.', '..E.']), { face: 'A', col: 0, row: 1 })).toEqual([]);
  });
});

/** 类型层面留个记号：`Cell` 在这里被用到（`issues[0]?.at` 的断言依赖它的形状）。 */
const sample: Cell = { face: 'A', col: 0, row: 1 };
expect(sample.face).toBe('A');
