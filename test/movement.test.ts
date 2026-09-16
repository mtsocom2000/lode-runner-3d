import { cellKey, type Cell } from '../src/core/types';
import { buildGraph, findPath, supportOf } from '../src/core/world/graph';
import {
  DIRS,
  fallTo,
  stateAt,
  step,
  trail,
  type Dir,
  type MoveState,
  type StepResult,
} from '../src/core/rules/movement';
import { BAROVER, BARSTUB, CLIFF, DROP, JETTY, UPPER, cellA, cellB, load } from './fixtures';

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
