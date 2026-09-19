import { DIG_BACKFILL_TICKS, DIG_OCCUPIED_ACCEL } from '../src/core/rules/dig';
import {
  MOVE_TICKS,
  NO_INTENTS,
  PLAYER_LIVES,
  createSim,
  replay,
  tick,
  viewOf,
  wait,
  type Entity,
  type Intents,
  type SimFrame,
  type SimState,
} from '../src/core/sim';
import { cellKey, type Cell } from '../src/core/types';
import type { LevelDef, TileKind } from '../src/core/world/tiles';
import { PIT, cellA, cellB } from './fixtures';

/**
 * T11 在 **sim 层**的行为：挖 / 回填 / 走顶加速 / 活埋。
 *
 * 规则本身的纯函数归 `dig.test.ts`；这里测的是"接进 tick 之后"才存在的问题 ——
 * 顺序（回填比移动先）、state 的不可变性、以及回放能不能逐字节复现。
 */

const SPAWN = cellA(1, 2); // 站在 A:1,1 这块可挖砖上
const HOLE_LEFT = cellA(0, 1); // 往左挖得到的坑
const HOLE_RIGHT = cellB(2, 1); // 往右挖得到的坑（跨到折痕另一侧）

/** 地板是**硬砖**的关卡：`canDig` 该拒绝（护绳之外的另一半判据）。 */
const HARD_FLOOR: LevelDef = { id: 'HARDFLOOR', name: '硬地板', fold: 2, tiles: ['....', '====', '....'] };

function playerOf(frame: SimFrame): Cell {
  const entity = frame.state.entities[0];
  if (entity === undefined) throw new Error('夹具应当有玩家实体');
  return entity.cell;
}

function eventsOf(frame: SimFrame): readonly string[] {
  return frame.events.map((e) => e.kind);
}

function tileAt(state: SimState, cell: Cell): TileKind | undefined {
  return viewOf(state).at(cell.col, cell.row);
}

/** 一次跑完一串意图，返回逐帧。 */
function run(state: SimState, script: readonly Intents[]): readonly SimFrame[] {
  return replay(state, script);
}

function last(frames: readonly SimFrame[]): SimFrame {
  const frame = frames[frames.length - 1];
  if (frame === undefined) throw new Error('脚本不能为空');
  return frame;
}

/** 找出第一帧里报出某个事件的帧（找不到就炸，免得断言静默跳过）。 */
function firstWith(frames: readonly SimFrame[], kind: string): SimFrame {
  const frame = frames.find((f) => f.events.some((e) => e.kind === kind));
  if (frame === undefined) throw new Error(`脚本里没有 ${kind} 事件`);
  return frame;
}

/**
 * 挖是**前/后**（相对朝向），不是绝对左右（2026-09-19 用户裁定："`q` 后挖、`r` 前挖"）。
 * 前/后由 `sim.ts` 用 `facing` 解成真正的 `Dir` —— 出生点初始朝 `right`，所以
 * `front` = 右、`back` = 左。
 */
const digFront: Intents = { move: null, dig: 'front' };
const digBack: Intents = { move: null, dig: 'back' };
const stepLeft: Intents = { move: 'left', dig: null };

describe('挖（T11）：接进 tick 之后', () => {
  it('一挖：目标砖变空、报 dug、登记一个满额回填倒计时', () => {
    const state = createSim(PIT, SPAWN, PLAYER_LIVES);
    const frame = tick(state, digBack);

    expect(eventsOf(frame)).toContain('dug');
    expect(tileAt(frame.state, HOLE_LEFT)).toBe('pit'); // 挖出来的是「坑」（一格深的口袋），不是空
    expect(frame.state.fills).toHaveLength(1);
    expect(frame.state.fills[0]).toEqual({ index: 1 * 4 + 0, remaining: DIG_BACKFILL_TICKS });
  });

  it('挖是**换新网格**，原 state 一个字节都不动（回放要靠这条）', () => {
    const state = createSim(PIT, SPAWN, PLAYER_LIVES);
    tick(state, digBack);

    expect(tileAt(state, HOLE_LEFT)).toBe('dig');
    expect(state.fills).toHaveLength(0);
  });

  it('挖**斜下方**那一格，不是脚下 —— 站着那块砖不会被挖掉', () => {
    const state = createSim(PIT, SPAWN, PLAYER_LIVES);
    const frame = tick(state, digBack);

    expect(tileAt(frame.state, cellA(1, 1))).toBe('dig'); // 脚下还在，所以人没掉
    expect(playerOf(frame)).toEqual(SPAWN);
  });

  it('前/后跟着**朝向**走：先转身，同一个 `dig` 就挖到另一侧', () => {
    // 这是"前/后"这个设计的核心证据 —— 同一个 `dig: 'back'`，在初始朝向下挖的是左边，
    // 转身（先往左走一步、等冷却过去）之后挖的就是右边（`A:1,1`，出生点脚下那块砖）。
    const frames = run(createSim(PIT, SPAWN, PLAYER_LIVES), [stepLeft, ...wait(MOVE_TICKS), digBack]);
    const dug = firstWith(frames, 'dug');

    expect(playerOf(dug)).toEqual(cellA(0, 2)); // 人没动，只是转了身
    expect(tileAt(dug.state, cellA(1, 1))).toBe('pit');
  });

  it('硬砖挖不动（这条判据不是"实心"能替代的）', () => {
    const state = createSim(HARD_FLOOR, SPAWN, PLAYER_LIVES);
    const frame = tick(state, digBack);

    expect(eventsOf(frame)).toEqual([]);
    expect(frame.state.fills).toEqual([]);
    expect(tileAt(frame.state, HOLE_LEFT)).toBe('hard');
  });

  it('冷却中不许挖 —— 挖是一个动作，不是站姿', () => {
    const state = createSim(PIT, SPAWN, PLAYER_LIVES);
    // 往**左**走一步（`A:0,2`）：这是普通的一格。**不能写 `right`** —— 出生点 `A:1,2` 是
    // 最内列，往右就是跨折痕那一步，而那是**不扣冷却**的（原地转 90°，见 `isSeamStep`）。
    const moved = tick(state, { move: 'left', dig: null });
    expect(eventsOf(moved)).toContain('entered');
    expect(moved.state.entities[0]?.cooldown).toBe(MOVE_TICKS - 1);

    const tried = tick(moved.state, digFront);
    expect(eventsOf(tried)).not.toContain('dug');
    expect(tried.state.fills).toEqual([]);
  });

  it('跨折痕那一步**不扣冷却**：两格在世界同一个位置，等于原地转 90°', () => {
    // 用户 2026-09-19："机器人经过转角的时候明显会停顿一下" —— 就是这一步以前照常扣冷却。
    const state = createSim(PIT, SPAWN, PLAYER_LIVES);
    const crossed = tick(state, { move: 'right', dig: null }); // A:1,2 → B:2,2（折痕）
    expect(playerOf(crossed)).toEqual(cellB(2, 2));
    expect(crossed.state.entities[0]?.cooldown).toBe(0); // 不占用移动间隔
  });

  it('重复按住挖同一个洞不会挖第二次（洞已经空了）', () => {
    const first = tick(createSim(PIT, SPAWN, PLAYER_LIVES), digBack);
    const again = tick(first.state, digBack);

    expect(eventsOf(again)).not.toContain('dug');
    expect(again.state.fills).toHaveLength(1); // 还是那一个，不是两个
  });
});

describe('挖 → 坠 → 入坑（T11 的链）', () => {
  it('挖穿邻居脚下的地板，再走过去就会掉进那个坑里', () => {
    const frames = run(createSim(PIT, SPAWN, PLAYER_LIVES), [digBack, stepLeft]);
    const frame = last(frames);

    expect(eventsOf(firstWith(frames, 'dug'))).toContain('dug');
    expect(eventsOf(frame)).toContain('fell');
    // 掉进**自己挖的那一格**，而不是穿出墙外落水
    expect(playerOf(frame)).toEqual(HOLE_LEFT);
    expect(frame.state.lives).toBe(PLAYER_LIVES);
  });
});

describe('回填（T11）', () => {
  it('到期自己长回来：砖复原、报 filled、倒计时清单清空', () => {
    const frames = run(createSim(PIT, SPAWN, PLAYER_LIVES), [digFront, ...wait(DIG_BACKFILL_TICKS)]);
    const filled = firstWith(frames, 'filled');
    const frame = last(frames);

    expect(tileAt(frame.state, HOLE_RIGHT)).toBe('dig');
    expect(frame.state.fills).toEqual([]);
    // 坑里没人 → 只有 filled，没有 buried
    expect(eventsOf(filled)).toEqual(['filled']);
    expect(frame.state.lives).toBe(PLAYER_LIVES);
  });

  it('还没到期时**不会**长回来（差一个 tick 都不行）', () => {
    const frames = run(createSim(PIT, SPAWN, PLAYER_LIVES), [digFront, ...wait(DIG_BACKFILL_TICKS - 1)]);
    const frame = last(frames);

    expect(tileAt(frame.state, HOLE_RIGHT)).toBe('pit');
    expect(frame.state.fills).toHaveLength(1);
    expect(frame.state.fills[0]?.remaining).toBe(1);
  });

  it('活埋：坑合拢时人还在里面 → 死一次、回出生点、坑照样填上', () => {
    const frames = run(createSim(PIT, SPAWN, PLAYER_LIVES), [
      digBack,
      stepLeft,
      ...wait(DIG_BACKFILL_TICKS + 10),
    ]);

    const buried = firstWith(frames, 'buried');
    expect(eventsOf(buried)).toContain('filled'); // 土照落
    expect(eventsOf(buried)).toContain('respawned');
    expect(buried.state.lives).toBe(PLAYER_LIVES - 1);

    // 而且它**加速**合拢了 —— 人一掉进坑里，倒数就从 1/tick 变成 4/tick。
    // 这条把"加速"从上面的公式钉到**真实的一条链**上：不靠手工摆位也会更早被埋。
    const buriedAt = frames.findIndex((f) => f.events.some((e) => e.kind === 'buried'));
    expect(buriedAt).toBeGreaterThan(-1);
    expect(buriedAt).toBeLessThan(DIG_BACKFILL_TICKS);

    const frame = last(frames);
    expect(playerOf(frame)).toEqual(SPAWN); // 被挪回出生点
    expect(tileAt(frame.state, HOLE_LEFT)).toBe('dig'); // 坑填上了，没有留一个永久的洞
    expect(frame.state.fills).toEqual([]); // 也没有留一条永远填不上的记录
  });

  it('坑被占住 → 4× 加速；占着坑**正上方**不算（这条差别是手册措辞与原型行为的差距）', () => {
    const dug = tick(createSim(PIT, SPAWN, PLAYER_LIVES), digFront);
    const hole = cellB(2, 1); // 挖出来的那一格
    const above = cellB(2, 2); // 它的正上方

    const player = dug.state.entities[0];
    if (player === undefined) throw new Error('夹具应当有玩家实体');
    /** 把玩家挪到指定格（`mode` 沿用出生时的 `stand`）。 */
    const withPlayerAt = (cell: Cell): SimState => ({
      ...dug.state,
      entities: [{ ...player, cell } satisfies Entity],
    });

    // ① 站在**坑里** → 加速。这正是文档那句"以身填坑"：掉进去的人加速把自己埋掉
    //    （原型 `legacy/canyon.html:125` 用的就是 `player.x===o.x && player.y===o.y`）。
    const inside = tick(withPlayerAt(hole), NO_INTENTS);
    expect(inside.state.fills[0]?.remaining).toBe(DIG_BACKFILL_TICKS - DIG_OCCUPIED_ACCEL);

    // ② 占着坑**正上方** → **不**加速。这条是防回归的钉子：手册把规则叫"走顶加速"，
    //    很容易读成"踩着坑口跑过去"，而原型的条件其实在坑**里**（与活埋同一个条件）。
    const perched = tick(withPlayerAt(above), NO_INTENTS);
    expect(perched.state.fills[0]?.remaining).toBe(DIG_BACKFILL_TICKS - 1);

    // ③ 对照：坑附近没人 → 同样只扣 1
    const plain = tick(dug.state, NO_INTENTS);
    expect(plain.state.fills[0]?.remaining).toBe(DIG_BACKFILL_TICKS - 1);
  });
});

describe('回放（T11）', () => {
  it('同一串意图跑两遍，逐帧 state 完全一致（挖改的是网格，尤其容易漂）', () => {
    const script: readonly Intents[] = [
      digBack,
      stepLeft,
      ...wait(30),
      digFront,
      ...wait(DIG_BACKFILL_TICKS + 5),
      { move: 'up', dig: null },
    ];
    const a = run(createSim(PIT, SPAWN, PLAYER_LIVES), script);
    const b = run(createSim(PIT, SPAWN, PLAYER_LIVES), script);

    expect(a).toHaveLength(b.length);
    for (let i = 0; i < a.length; i += 1) {
      expect(JSON.stringify(a[i]?.state)).toBe(JSON.stringify(b[i]?.state));
    }
  });

  it('回填倒计时是**纯数据**：JSON 往返之后接着跑，结果与不往返一致', () => {
    const script: readonly Intents[] = [digFront, ...wait(5)];
    const straight = run(createSim(PIT, SPAWN, PLAYER_LIVES), script);
    const mid = straight[2];
    if (mid === undefined) throw new Error('脚本至少要 3 帧');
    expect(cellKey(playerOf(mid))).toBe(cellKey(SPAWN)); // 顺带钉住"这几帧人没动"

    const revived: SimState = JSON.parse(JSON.stringify(mid.state)) as SimState;
    const tail = [5, 100, DIG_BACKFILL_TICKS].map((n) => JSON.stringify(last(run(revived, wait(n))).state));
    const same = [5, 100, DIG_BACKFILL_TICKS].map((n) => JSON.stringify(last(run(mid.state, wait(n))).state));

    expect(tail).toEqual(same);
  });
});
