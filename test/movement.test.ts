import { cellKey, type Cell } from '../src/core/types';
import { buildGraph, findPath, supportOf } from '../src/core/world/graph';
import {
  DIRS,
  OPPOSITE_DIR,
  fallTo,
  gridStep,
  stateAt,
  step,
  trail,
  type Dir,
  type MoveState,
  type StepResult,
} from '../src/core/rules/movement';
import { BAROVER, BARSTUB, CLIFF, DROP, JETTY, UPPER, cellA, cellB, load } from './fixtures';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { L1 } from '../src/core/level/levels/l1';
import { L2 } from '../src/core/level/levels/l2';
import { DRONE_STEP } from '../src/core/ai/drone';

/** 站在某格（模式由 supportOf 定：砖/梯 → stand，杆 → hang）。夹具非法时直接炸，不静默。 */
function at(level: ReturnType<typeof load>, cell: Cell): MoveState {
  const state = stateAt(level, cell);
  if (state === null) throw new Error(`夹具里 ${cellKey(cell)} 停不住，测试写错了`);
  return state;
}

/** 把 StepResult 压成可比较的形状，断言读起来才不啰嗦。 */
function shape(result: StepResult): string {
  if (result.kind === 'move') return `move:${result.state.mode}:${cellKey(result.state.cell)}`;
  if (result.kind === 'blocked') return `blocked:${result.reason}`;
  return result.end.kind === 'landed'
    ? `fall:landed:${cellKey(result.end.cell)}`
    : `fall:water:${cellKey(result.end.from)}`;
}

describe('movement：方向表', () => {
  it('四个方向，顺序固定（供 input 层遍历映射）', () => {
    expect([...DIRS]).toEqual(['left', 'right', 'up', 'down']);
  });
});

/**
 * 墙面 ↔ 小道 的接点。**这是原先测试体系的结构性盲区**：`buildGraph` 只遍历墙面格，
 * 甲板不在图里，所以"关卡是一个连通分量"那类断言永远碰不到这段路 —— 用户在试玩里
 * 走不过去（2.1）而 251 例全绿，原因就在这。这一小段是它的第一块覆盖。
 *
 * 判据是双向的：**绿 ⇒ 接点没坏**，2.1 的成因是按键词表（方案 B 能治）；
 * **红 ⇒ 接点真坏**，那是另一条修法。两种结果都算进展。
 *
 * B 面那条曾经真的红过：`up` 在墙面上是**爬梯子**的语义，而接点分支当时排在梯子检查**之后**，
 * 于是 `blocked:not-ladder` —— 修法是把接点循环提到梯子门之前（见 `movement.ts` 里那段说明）。
 *
 * 墙面端的位置随后跟着**半格对齐**（`metrics.ts` 的 `DECK_SHIFT`）挪过：接点列取的是
 * "小道砖正对着的那块墙砖"，概念关卡因此是 `A:3` / `B:14`（`fold = 9`、半格偏移 `+0.5`）。
 */
/**
 * 接头的**两个性质**（2026-09-19，用户实测"沿走廊按 `d`，到中间那一格人却拐上小道"之后）。
 *
 * 老性质是"进门的键 = 沿小道继续的键"（键连续性）。它**被废掉了**：要满足它就必然让接头用上
 * 一个**走得通**的方向，而那正是用户看到的 bug —— 接头**吃掉一条走廊走法**
 *（实测 `A:7,1` 按 `d` 到不了 `col 8`，走廊在那儿断开）。键连续性让位给"不抢走廊"。
 *
 * 现在钉两条：
 * ①**小道那侧照旧**：沿小道走到尽头，那个键仍然能上墙（否则"走得上来却上不去"，用户报过）。
 * ②**墙面那侧不许抢**：`enterDir` 在那一格必须是**堵住**的（`gridStep` 判 `blocked`）——
 *   所以接头只在"没别的路可走"时才生效。这条由 `validate.ts` 的 `jointNeverEntered`
 *   对每张关卡常驻把关，这里对三张关卡再钉一遍。
 */
describe('movement：接头的两个性质（不抢走廊 / 小道那侧仍能上墙）', () => {
  for (const [name, def] of [
    ['L1', L1],
    ['L2', L2],
    ['概念关卡', CONCEPT_MINIMAL],
  ] as const) {
    it(`${name}：两处接头都满足`, () => {
      const lv = load(def);
      const joints = lv.joints;
      expect(joints.length).toBeGreaterThan(0);
      for (const joint of joints) {
        const deckCell: Cell = { face: 'I', col: joint.deck.x, row: joint.deck.z };

        // ② 墙面那侧：那个方向必须堵住，而且按下去确实进得了小道。
        expect(gridStep(lv, { cell: joint.wall, mode: 'stand' }, joint.enterDir).kind).toBe('blocked');
        expect(step(lv, { cell: joint.wall, mode: 'stand' }, joint.enterDir)).toEqual({
          kind: 'move',
          state: { cell: deckCell, mode: 'stand' },
        });

        // ① 小道那侧：唯一那个"走到另一格甲板"的方向，其反向就是上墙的键。
        const inward = DIRS.filter((d) => {
          const r = step(lv, { cell: deckCell, mode: 'stand' }, d);
          return r.kind === 'move' && r.state.cell.face === 'I';
        });
        expect(inward).toHaveLength(1); // 小道是 1 宽：尽头只有一个前进方向
        const outward = OPPOSITE_DIR[inward[0] as Dir];
        const out = step(lv, { cell: deckCell, mode: 'stand' }, outward);
        expect(out).toEqual({ kind: 'move', state: { cell: joint.wall, mode: 'stand' } });
      }
    });
  }
});

/** 墙面 → 小道的接点本体（概念关卡的 2.1）。 */
describe('movement：墙面 → 小道的接点（概念关卡的 2.1）', () => {
  const sim = load(CONCEPT_MINIMAL);

  it('A 面接点：站在 A:4,1 按 `down` 拐上小道，落到 I:-7,-4', () => {
    // 为什么是 `down` 而不是 `right`（2026-09-19 改）：`A:4,1` 那一格**往右是通的**（能走到
    // `A:5,1`），接头要是占了 `right`，那条走廊就走不了了。`down` 在那一格是堵死的
    //（脚下是砖不是梯），所以它谁都不抢 —— 见上面那条性质②。
    expect(shape(step(sim, at(sim, cellA(4, 1)), 'down'))).toBe('move:stand:I:-7,-4');
  });

  it('B 面接点：站在 B:13,1 按 down 拐上小道，落到 I:-4,-7', () => {
    // B 面本来就是 `down`（小道沿 +z 伸出去，而甲板的 `down` 就是 +z）—— 它一直是"谁都不抢"的
    // 那一侧，只是 A 面写错了。两处现在一致。
    expect(shape(step(sim, at(sim, cellB(13, 1)), 'down'))).toBe('move:stand:I:-4,-7');
  });

  it('`decks: false`（无人机）**不认接头**：同一步只走到隔壁墙格，走不上小道', () => {
    // 用户 2026-09-19 报的"机器人进入岛台后就变傻了"：巡逻到接头那一格、朝向正好是
    // `enterDir` 时它一步跨上了小道 —— 而甲板上没有它的图节点（`decks:false`），于是追不了人、
    // 只能在板上打转。修法是让**移动**也知道这件事（`StepOptions.decks`），
    // 而不只是图那一半。
    expect(shape(step(sim, at(sim, cellA(4, 1)), 'right', DRONE_STEP))).toBe('move:stand:A:5,1');
    // B 面接点的 `enterDir` 是 `down`：不允许接头之后，那里只是一段普通砖面 → 爬不了、走不动。
    expect(shape(step(sim, at(sim, cellB(13, 1)), 'down', DRONE_STEP))).toBe('blocked:not-ladder');
  });
});

describe('movement：stateAt', () => {
  const upper = load(UPPER);
  const jetty = load(JETTY);

  it('砖面顶上与梯上是 stand；杆上是 hang', () => {
    expect(stateAt(upper, cellA(1, 1))).toEqual({ cell: cellA(1, 1), mode: 'stand' }); // 砖面
    expect(stateAt(upper, cellA(0, 2))).toEqual({ cell: cellA(0, 2), mode: 'stand' }); // 梯
    expect(stateAt(jetty, cellA(1, 2))).toEqual({ cell: cellA(1, 2), mode: 'hang' }); // 杆
  });

  it('停不住的格返回 null —— 不硬造一个会立刻坠落的 state', () => {
    expect(stateAt(upper, cellA(1, 2))).toBeNull(); // 砖块内部
    expect(stateAt(upper, cellA(99, 99))).toBeNull(); // 越界
  });
});

describe('movement：横向走', () => {
  const upper = load(UPPER);

  it('同面相邻且两端都停得住 → 走过去', () => {
    expect(shape(step(upper, at(upper, cellA(1, 1)), 'left'))).toBe('move:stand:A:0,1');
    expect(shape(step(upper, at(upper, cellB(2, 3)), 'right'))).toBe('move:stand:B:3,3');
  });

  it('撞砖 → solid（不是"走不过去"这种笼统结果）', () => {
    // r1 的 col2 是墙；A:1,1 往右那一格正是它。r2 的 col1 也是砖。
    expect(shape(step(upper, at(upper, cellA(1, 1)), 'right'))).toBe('blocked:solid');
    expect(shape(step(upper, at(upper, cellA(0, 2)), 'right'))).toBe('blocked:solid');
  });

  it('出网格边界 → out', () => {
    expect(shape(step(upper, at(upper, cellA(0, 1)), 'left'))).toBe('blocked:out');
    expect(shape(step(upper, at(upper, cellB(3, 3)), 'right'))).toBe('blocked:out');
  });

  it('**跨折痕就是一次普通的 left/right** —— col fold-1 ↔ fold 直接走过去', () => {
    // A:1,3（u=0）往右进 B:2,3（u=0）。core 不管朝向，那是 T7 的事。
    expect(shape(step(upper, at(upper, cellA(1, 3)), 'right'))).toBe('move:stand:B:2,3');
    expect(shape(step(upper, at(upper, cellB(2, 3)), 'left'))).toBe('move:stand:A:1,3');
  });
});

describe('movement：爬梯', () => {
  const upper = load(UPPER);

  it('梯接梯才能上下，且双向', () => {
    expect(shape(step(upper, at(upper, cellA(0, 1)), 'up'))).toBe('move:stand:A:0,2');
    expect(shape(step(upper, at(upper, cellA(0, 3)), 'down'))).toBe('move:stand:A:0,2');
  });

  it('不在梯上按上下 → not-ladder（没有跳跃，也不下钻砖块）', () => {
    expect(shape(step(upper, at(upper, cellA(1, 1)), 'up'))).toBe('blocked:not-ladder');
    expect(shape(step(upper, at(upper, cellA(1, 1)), 'down'))).toBe('blocked:not-ladder');
  });

  it('梯的尽头之上不是梯 → not-ladder（不会凭空爬到网格外）', () => {
    expect(shape(step(upper, at(upper, cellA(0, 3)), 'up'))).toBe('blocked:not-ladder');
    expect(shape(step(upper, at(upper, cellA(0, 1)), 'down'))).toBe('blocked:not-ladder');
  });
});

describe('movement：坠落（图里没有、运动里才有）', () => {
  it('走出边缘 → 沿本列下坠，落到第一个可停驻格（DROP 那一跳还顺带跨了折痕）', () => {
    const drop = load(DROP);
    // B:2,3 往左 → A:1,3 停不住 → 沿 col1 掉到 A:1,1（r0 的砖面上）
    expect(shape(step(drop, at(drop, cellB(2, 3)), 'left'))).toBe('fall:landed:A:1,1');
  });

  it('一路无支撑 → 掉出墙体 → water（§1.5-3 途径①）', () => {
    const cliff = load(CLIFF);
    const result = step(cliff, at(cliff, cellA(1, 3)), 'right');
    expect(shape(result)).toBe('fall:water:B:2,3');
    expect(result).toEqual({
      kind: 'fall',
      end: { kind: 'water', from: cellB(2, 3), row: 0 },
    });
  });

  it('杆能接住下坠的人 —— 判定必须问"能不能停"，只盯"下方是否实心"会穿杆而过', () => {
    const jetty = load(JETTY);
    // JETTY 只有 3 行（r0..r2）。从 r3（网格外）沿 col1 下坠：r2 是横杆 → 停在杆上。
    expect(fallTo(jetty, cellA(1, 3))).toEqual({ kind: 'landed', cell: cellA(1, 2) });
    expect(supportOf(jetty, cellA(1, 2))).toBe('bar');
  });

  it('传进来一个停不住的格 → 按物理开始坠，而不是抛异常', () => {
    const upper = load(UPPER);
    const illegal: MoveState = { cell: cellA(1, 2), mode: 'stand' }; // 砖块内部
    expect(shape(step(upper, illegal, 'left'))).toBe('fall:landed:A:1,1');
  });
});

describe('movement：横杆状态机（T3 验收的 5 个用例）', () => {
  const jetty = load(JETTY);
  const stub = load(BARSTUB);
  const over = load(BAROVER);

  it('① 从砖面走上横杆 → 进入 hang（抓杆）', () => {
    expect(shape(step(jetty, at(jetty, cellA(0, 2)), 'right'))).toBe('move:hang:A:1,2');
  });

  it('② 沿杆横移保持 hang（跨折痕那一步也一样）', () => {
    expect(shape(step(jetty, at(jetty, cellA(1, 2)), 'right'))).toBe('move:hang:B:2,2');
    expect(shape(step(jetty, at(jetty, cellB(2, 2)), 'left'))).toBe('move:hang:A:1,2');
  });

  it('③ 从杆走到相邻的砖面/梯 → 回到 stand（松手落地）', () => {
    expect(shape(step(jetty, at(jetty, cellB(2, 2)), 'right'))).toBe('move:stand:B:3,2');
    expect(shape(step(jetty, at(jetty, cellA(1, 2)), 'left'))).toBe('move:stand:A:0,2');
  });

  it('④ 杆上按"下" → 松手坠落；落点不是岛台/砖面就一路落水（§1.5-3 途径②）', () => {
    const result = step(jetty, at(jetty, cellA(1, 2)), 'down');
    expect(shape(result)).toBe('fall:water:A:1,1');
    expect(result).toEqual({ kind: 'fall', end: { kind: 'water', from: cellA(1, 1), row: 0 } });
  });

  it('⑤ 杆的尽头之外是空中 → 横移被拒（得先松手，不能凭空飘出去）', () => {
    expect(shape(step(stub, at(stub, cellA(0, 2)), 'right'))).toBe('move:hang:A:1,2');
    expect(shape(step(stub, at(stub, cellA(1, 2)), 'right'))).toBe('blocked:nothing-there');
  });

  it('吊着不能向上', () => {
    expect(shape(step(jetty, at(jetty, cellA(1, 2)), 'up'))).toBe('blocked:not-hangable');
  });

  it('杆正下方是实心砖（规则⑦反例）→ 进杆允许，松手非法；好坏交给 validator 判', () => {
    // 运动层只管"这一步能不能走"。关卡本身违法该被 T8 的 validate 拦下 —— 不在这里静默修掉。
    expect(shape(step(over, at(over, cellA(0, 2)), 'right'))).toBe('move:hang:A:1,2');
    expect(shape(step(over, at(over, cellA(1, 2)), 'down'))).toBe('blocked:not-hangable');
  });
});

describe('movement：trail 轨迹', () => {
  const upper = load(UPPER);

  it('走-爬-横穿-跨折痕-下梯：8 格轨迹', () => {
    const dirs: readonly Dir[] = ['up', 'up', 'right', 'right', 'right', 'down', 'down'];
    const run = trail(upper, at(upper, cellA(0, 1)), dirs);

    expect(run.outcome).toBe('move');
    expect(run.steps).toHaveLength(dirs.length);
    expect(run.end).toEqual({ cell: cellB(3, 1), mode: 'stand' });
    expect(cellKey(run.end.cell)).toBe('B:3,1');
  });

  it('轨迹与通行图的最短路一致 —— "图说能走"和"真的能走"必须是同一件事', () => {
    const dirs: readonly Dir[] = ['up', 'up', 'right', 'right', 'right', 'down', 'down'];
    const run = trail(upper, at(upper, cellA(0, 1)), dirs);

    // 逐步还原途经的格子：起点 + 每一步 move 的落点
    const walked: string[] = [cellKey(run.start.cell)];
    for (const s of run.steps) {
      if (s.result.kind === 'move') walked.push(cellKey(s.result.state.cell));
    }

    const graph = buildGraph(upper);
    const shortest = findPath(graph, cellA(0, 1), cellB(3, 1));
    expect(shortest?.map(cellKey)).toEqual(walked);
  });

  it('撞上非法方向就停在原地，并记下原因', () => {
    const run = trail(upper, at(upper, cellA(1, 1)), ['up']);
    expect(run.outcome).toBe('blocked');
    expect(run.end).toEqual({ cell: cellA(1, 1), mode: 'stand' });
    expect(run.steps[0]?.result).toEqual({ kind: 'blocked', reason: 'not-ladder' });
  });

  it('坠落但落住了会**接着走**（原版常态）', () => {
    const drop = load(DROP);
    const run = trail(drop, at(drop, cellB(2, 3)), ['left', 'right']);
    expect(run.outcome).toBe('move'); // 第一步是 fall-landed，第二步照走
    expect(run.end.cell).toEqual(cellB(2, 1));
  });

  it('落水即中止，end 停在落水前那一格', () => {
    const cliff = load(CLIFF);
    const run = trail(cliff, at(cliff, cellA(1, 3)), ['right', 'left']);
    expect(run.outcome).toBe('fall-water');
    expect(run.end.cell).toEqual(cellA(1, 3)); // 第二个 'left' 根本没机会执行
    expect(run.steps).toHaveLength(1);
  });

  it('空方向串 = 原地不动', () => {
    const run = trail(upper, at(upper, cellA(0, 1)), []);
    expect(run.outcome).toBe('move');
    expect(run.steps).toHaveLength(0);
    expect(run.end.cell).toEqual(cellA(0, 1));
  });
});
