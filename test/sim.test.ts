import { cellKey, type Cell } from '../src/core/types';
import {
  MOVE_TICKS,
  NO_INTENTS,
  PLAYER_LIVES,
  RESPAWN_TICKS,
  TICK_HZ,
  createSim,
  hold,
  replay,
  tick,
  viewOf,
  wait,
  type Intents,
  type SimFrame,
  type SimState,
} from '../src/core/sim';
import { CLIFF, DROP, JETTY, UPPER, cellA, cellB } from './fixtures';

const spawnUpper = cellA(0, 1); // 梯上，UPPER 的天然出生点
const spawnDrop = cellB(2, 3); // DROP 的高台
const spawnCliff = cellA(1, 3); // CLIFF 的平台边

function playerOf(frame: SimFrame): Cell {
  const entity = frame.state.entities[0];
  if (entity === undefined) throw new Error('夹具应当有玩家实体');
  return entity.cell;
}

function modeOf(frame: SimFrame): string {
  const entity = frame.state.entities[0];
  if (entity === undefined) throw new Error('夹具应当有玩家实体');
  return entity.mode;
}

function eventsOf(frame: SimFrame): readonly string[] {
  return frame.events.map((e) => e.kind);
}

/** 一次跑完，返回帧序列 —— 断言里多数时候只想看最后一帧。 */
function run(state: SimState, script: readonly Intents[]): readonly SimFrame[] {
  return replay(state, script);
}

function last(frames: readonly SimFrame[]): SimFrame {
  const frame = frames[frames.length - 1];
  if (frame === undefined) throw new Error('脚本不能为空');
  return frame;
}

describe('sim：常量与建初态', () => {
  it('定步长 60Hz；走一格 MOVE_TICKS 个 tick（唯一的手感数字）', () => {
    expect(TICK_HZ).toBe(60);
    expect(MOVE_TICKS).toBeGreaterThan(1);
    expect(TICK_HZ / MOVE_TICKS).toBeGreaterThan(1); // 至少每秒能走一格
  });

  it('初态：tick 0、playing、玩家在出生点且站得住', () => {
    const state = createSim(UPPER, spawnUpper);
    expect(state.tick).toBe(0);
    expect(state.status).toBe('playing');
    expect(state.levelId).toBe('UPPER');
    expect(state.entities).toHaveLength(1);
    expect(state.entities[0]).toEqual({
      id: 0,
      kind: 'player',
      cell: spawnUpper,
      mode: 'stand',
      cooldown: 0,
      // T12-a：重生点搬到实体上（敌人的重生点各不同，一个整局的字段表达不了）。
      // 玩家这里必须**等于出生点** —— 它就是玩家重生回哪儿。
      home: spawnUpper,
      // 朝向：开局朝右；移动成立后才更新（这条语义由下面的用例钉住）。
      facing: 'right',
      // 倒地计时（T12-d）：玩家不走"延时重生"那条路，所以恒为 0。
      down: 0,
    });
  });

  it('出生点停不住 / 越界 → 直接报错，不静默造一个会立刻坠落的初态', () => {
    expect(() => createSim(UPPER, cellA(1, 2))).toThrow(); // 砖块内部
    expect(() => createSim(UPPER, cellA(99, 99))).toThrow(); // 越界
  });

  it('关卡数据不合法 → 直接报错（先过 parseLevel 才谈得上模拟）', () => {
    expect(() =>
      createSim({ id: 'bad', name: 'bad', fold: 3, tiles: ['XXXX', 'XXXX'] }, cellA(0, 0)),
    ).toThrow();
  });
});

describe('sim：viewOf（把纯数据 state 拼成 Level 查询视图）', () => {
  it('尺寸与取值跟原关卡一致，越界 undefined', () => {
    const state = createSim(UPPER, spawnUpper);
    const view = viewOf(state);
    expect([view.fold, view.cols, view.rows]).toEqual([2, 4, 4]);
    expect(view.at(0, 0)).toBe('dig'); // r0 的砖
    expect(view.at(0, 1)).toBe('ladder'); // r1 的梯
    expect(view.at(-1, 0)).toBeUndefined();
    expect(view.at(4, 0)).toBeUndefined();
    expect(view.at(0, 4)).toBeUndefined();
  });

  it('读的是 state.grid —— 换掉 grid 视图就跟着变（T11 挖砖的接缝）', () => {
    const state = createSim(UPPER, spawnUpper);
    const dug: SimState = {
      ...state,
      grid: state.grid.map((kind, index) => (index === 0 ? 'empty' : kind)),
    };
    expect(viewOf(state).at(0, 0)).toBe('dig');
    expect(viewOf(dug).at(0, 0)).toBe('empty');
  });
});

describe('sim：步进节奏', () => {
  const start = createSim(UPPER, spawnUpper);

  it('第 1 个 tick 就落格，之后要等满 MOVE_TICKS 才能再落一格', () => {
    const frames = run(start, hold('up', MOVE_TICKS + 1));

    expect(cellKey(playerOf(frames[0] as SimFrame))).toBe('A:0,2'); // tick 1：走上去
    expect(eventsOf(frames[0] as SimFrame)).toEqual(['entered']);

    for (let i = 1; i <= MOVE_TICKS - 1; i++) {
      expect(cellKey(playerOf(frames[i] as SimFrame))).toBe('A:0,2'); // 冷却中：原地
      expect(eventsOf(frames[i] as SimFrame)).toEqual([]);
    }

    const ninth = frames[MOVE_TICKS] as SimFrame; // tick 9：冷却到点，再走一格
    expect(cellKey(playerOf(ninth))).toBe('A:0,3');
    expect(ninth.state.tick).toBe(MOVE_TICKS + 1);
  });

  it('撞墙**不**消耗冷却 —— 贴着墙按住再转身没有迟滞', () => {
    // A:1,1 往右是 UPPER 的墙（r1 的 col2），往左是梯。
    const frames = run(createSim(UPPER, cellA(1, 1)), [...hold('right', 3), ...hold('left', 1)]);

    for (let i = 0; i < 3; i++) {
      expect(cellKey(playerOf(frames[i] as SimFrame))).toBe('A:1,1');
      expect(eventsOf(frames[i] as SimFrame)).toEqual([]); // 撞墙不产生事件
    }
    // 关键：第 4 个 tick 就能走 —— 前 3 次撞墙没有把冷却吃满。
    expect(cellKey(playerOf(frames[3] as SimFrame))).toBe('A:0,1');
  });

  it('松手也**不**消耗冷却 —— 停下再按能立刻起步', () => {
    const frames = run(start, [...wait(3), ...hold('up', 1)]);
    for (let i = 0; i < 3; i++) expect(playerOf(frames[i] as SimFrame)).toEqual(spawnUpper);
    expect(cellKey(playerOf(frames[3] as SimFrame))).toBe('A:0,2');
  });

  it('站着不动时 tick 照走（时钟不回退）', () => {
    const frames = run(start, wait(5));
    expect(last(frames).state.tick).toBe(5);
    expect(playerOf(last(frames))).toEqual(spawnUpper);
    expect(frames.every((f) => f.events.length === 0)).toBe(true);
  });
});

describe('sim：坠落与落水', () => {
  it('走空 → 坠落并落到平台上：一条 fell 事件，模式跟着落点走', () => {
    const frames = run(createSim(DROP, spawnDrop), hold('left', 1));
    const frame = frames[0] as SimFrame;

    expect(eventsOf(frame)).toEqual(['fell']);
    expect(frame.events[0]).toEqual({
      kind: 'fell',
      entity: 0,
      from: spawnDrop,
      cell: cellA(1, 1),
    });
    expect(cellKey(playerOf(frame))).toBe('A:1,1');
    expect(modeOf(frame)).toBe('stand');
  });

  it('一路无支撑 → 落水：一条 drowned（途径①）+ 扣命 + 回出生点', () => {
    const frames = run(createSim(CLIFF, spawnCliff), hold('right', 1));
    const frame = frames[0] as SimFrame;

    expect(eventsOf(frame)).toEqual(['drowned', 'respawned']);
    expect(frame.events[0]).toEqual({ kind: 'drowned', entity: 0, cell: cellB(2, 3), path: 'fall' });
    // T9：落水**不是终局** —— 扣一条命、回出生点，这一局继续（扣到 0 才 dead）。
    expect(frame.state.status).toBe('playing');
    expect(frame.state.lives).toBe(PLAYER_LIVES - 1);
    expect(frame.events[1]).toEqual({
      kind: 'respawned',
      entity: 0,
      cell: spawnCliff,
      lives: PLAYER_LIVES - 1,
    });
    expect(frame.state.entities[0]?.cell).toEqual(spawnCliff);
    // 重生冻结：没有它，玩家只会看到"我瞬移了"、看不到自己死过（T20 的涟漪要挂在这段时间上）。
    expect(frame.state.entities[0]?.cooldown).toBe(RESPAWN_TICKS);
  });

  it('重生冻结恰好 RESPAWN_TICKS：冻满之后 cooldown 归零', () => {
    const drowned = run(createSim(CLIFF, spawnCliff), hold('right', 1));
    const frames = run(last(drowned).state, wait(RESPAWN_TICKS + 1));

    // 冻满之前：一格不动、一条事件也没有（`wait` 不给方向，所以这条断言与"哪边能走"无关）。
    for (let i = 0; i < RESPAWN_TICKS - 1; i++) {
      expect(playerOf(frames[i] as SimFrame)).toEqual(spawnCliff);
      expect(eventsOf(frames[i] as SimFrame)).toEqual([]);
    }
    // 冻满那一 tick：`cooldown` 归零 —— 下一 tick 按方向立刻能动。
    expect(playerOf(frames[RESPAWN_TICKS - 1] as SimFrame)).toEqual(spawnCliff);
    expect(frames[RESPAWN_TICKS - 1]?.state.entities[0]?.cooldown).toBe(0);
  });

  it('命扣到 0 才 status dead：之后实体冻住、事件为空，但时钟继续走', () => {
    // 1 命起局，落一次水就到底。
    const first = run(createSim(CLIFF, spawnCliff, 1), hold('right', 1));
    const frame = first[0] as SimFrame;
    expect(frame.state.lives).toBe(0);
    expect(frame.state.status).toBe('dead');
    expect(eventsOf(frame)).toEqual(['drowned', 'gameover']);

    const frames = run(frame.state, hold('right', 5));
    expect(last(frames).state.status).toBe('dead');
    expect(last(frames).state.tick).toBe(6);
    expect(playerOf(last(frames))).toEqual(spawnCliff);
    expect(frames.every((f) => f.events.length === 0)).toBe(true);
  });

  it('横杆能接住坠落 —— 掉在杆上进入 hang 而不是穿过去落水', () => {
    // JETTY 只有 r0..r2：从网格外沿 col1 往下，r2 是横杆。
    const frames = run(createSim(JETTY, cellA(0, 2)), hold('right', 2));
    // 第一步走上杆（hang），第二步往右是空中 → nothing-there（被拒），所以还在杆上
    expect(playerOf(frames[0] as SimFrame)).toEqual(cellA(1, 2));
    expect(modeOf(frames[0] as SimFrame)).toBe('hang');
    expect(playerOf(last(frames))).toEqual(cellA(1, 2));
  });
});

describe('sim：回放', () => {
  const start = createSim(UPPER, spawnUpper);
  const CROSS: readonly Intents[] = [
    ...hold('up'),
    ...hold('up'),
    ...hold('right'),
    ...hold('right'),
    ...hold('right'),
    ...hold('down'),
    ...hold('down'),
  ];

  it('走-爬-横穿-跨折痕-下梯：七个落格，终点 B:3,1', () => {
    const frames = run(start, CROSS);
    expect(cellKey(playerOf(last(frames)))).toBe('B:3,1');
    expect(last(frames).state.tick).toBe(CROSS.length);

    const entered = frames.flatMap((f) => f.events.filter((e) => e.kind === 'entered'));
    expect(entered).toHaveLength(7);
  });

  it('跨折痕那一跳在事件里看得见（A:1,3 → B:2,3）', () => {
    const frames = run(start, CROSS);
    const crossed = frames
      .flatMap((f) => f.events)
      .find((e) => e.kind === 'entered' && cellKey(e.from) === 'A:1,3');
    expect(crossed).toEqual({
      kind: 'entered',
      entity: 0,
      from: cellA(1, 3),
      cell: cellB(2, 3),
    });
  });

  it('同一份 state + 同一串 intents → 逐帧完全一致', () => {
    const a = run(start, CROSS);
    const b = run(start, CROSS);
    expect(b).toEqual(a);
  });

  it('中途存盘（JSON 往返）再续跑，与一口气跑完的终点一致', () => {
    const half = Math.floor(CROSS.length / 2);
    const head = run(start, CROSS.slice(0, half));
    const mid = last(head).state;

    const revived = JSON.parse(JSON.stringify(mid)) as SimState;
    expect(revived).toEqual(mid); // SimState 必须是纯数据，能原样往返

    const tail = run(revived, CROSS.slice(half));
    expect(playerOf(last(tail))).toEqual(playerOf(last(run(start, CROSS))));
  });

  it('空脚本 = 原地不动', () => {
    const frames = run(start, []);
    expect(frames).toHaveLength(0);
    expect(createSim(UPPER, spawnUpper).tick).toBe(0);
  });
});

describe('sim：意图辅助', () => {
  it('hold / wait 长度正确，wait 不含方向', () => {
    expect(hold('left')).toHaveLength(MOVE_TICKS);
    expect(hold('left', 3)).toHaveLength(3);
    expect(wait(4)).toHaveLength(4);
    expect(wait(2)).toEqual([NO_INTENTS, NO_INTENTS]);
  });

  it('tick 是纯函数：不修改传进来的 state', () => {
    const before = createSim(UPPER, spawnUpper);
    const snapshot = JSON.parse(JSON.stringify(before)) as SimState;
    tick(before, { move: 'up', dig: null });
    expect(before).toEqual(snapshot);
  });
});
