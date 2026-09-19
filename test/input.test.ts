import {
  NO_KEYS,
  REPEAT_DELAY_TICKS,
  consumed,
  createInput,
  digIntent,
  digOfKey,
  digPress,
  digRelease,
  dirOfKey,
  holdBroken,
  keyLabel,
  moveAllowed,
  moveIntent,
  press,
  release,
  released,
  ticked,
  type KeyState,
} from '../src/app/input';
import { MOVE_TICKS, createSim, tick, type SimEvent, type SimState } from '../src/core/sim';
import type { Dir } from '../src/core/rules/movement';
import { CONCEPT_MINIMAL, PLAYER_SPAWN } from '../src/core/level/levels/conceptMinimal';
import { cellKey, type Cell, type Surface } from '../src/core/types';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';
import { createCamera } from '../src/render/camera';
import { cellAnchor } from '../src/render/metrics';

/**
 * T7 的验收。两件事：
 *
 * 1. **键盘状态机**是纯函数，直接测 —— 重点是"轻点不该被冷却窗口吃掉"。
 *    而且不只测状态机自洽：还把它接到**真实的 sim** 上跑一遍，拿"角色有没有动"来判对错。
 *    状态机自己"看起来对"不算数，得看它有没有解决那个具体的手感问题。
 * 2. **折痕对输入透明**这条结论，拿**真相机**的轴钉住（见 src/app/input.ts 的说明）。
 */

// ── 夹具关卡：row0 一层砖，row1 一条走廊，row2 一层砖 ──
const FOLD = 3;
const DEF: LevelDef = {
  id: 'INPUT',
  name: '输入夹具',
  fold: FOLD,
  tiles: ['XXXXXX', '......', 'XXXXXX'],
};
const SPAWN: Cell = { face: 'A', col: 0, row: 1 };

/** 夹具关卡解析出来的 `Level`（折痕那条测试要用 `cellAnchor` 换世界坐标）。 */
const level = (() => {
  const parsed = parseLevel(DEF);
  if (!parsed.ok) throw new Error(`夹具必须合法：${JSON.stringify(parsed.errors)}`);
  return parsed.level;
})();

/** 推进 n 个 tick。重复延迟按 tick 计，所以边界必须能被精确地摆出来。 */
function tickN(state: KeyState, n: number): KeyState {
  let out = state;
  for (let i = 0; i < n; i++) out = ticked(out);
  return out;
}

/**
 * 这几条用例说的是**方向**，而状态机存的是**键**（键 → 方向按面分，见 `KEY_DIRS`）。
 * 用甲板那套键位把它们对上 —— 甲板上四个方向都有键，和以前"直接按方向"一一对应。
 */
const pressDir = (s: KeyState, dir: Dir): KeyState => press(s, keyLabel(dir, 'deck'));
const releaseDir = (s: KeyState, dir: Dir): KeyState => release(s, keyLabel(dir, 'deck'));
const intent = (s: KeyState): Dir | null => moveIntent(s, 'deck');

/**
 * 一枚**假的键盘** + 一个可切换的"我在哪种面"。
 *
 * `createInput` 只用到 `addEventListener` / `removeEventListener`，并把"我在哪种面"做成回调
 * （按下与采样共用它）。于是这里给一个可变的 `surface`，`on()` 模拟玩家跨过一步换了面。
 */
function keyboard(): {
  target: Window;
  send: (type: 'keydown' | 'keyup', key: string) => void;
  at: () => Surface;
  on: (surface: Surface) => void;
} {
  const handlers = new Map<string, (e: unknown) => void>();
  let surface: Surface = 'wall';
  const target = {
    addEventListener: (type: string, fn: (e: unknown) => void) => handlers.set(type, fn),
    removeEventListener: (type: string) => handlers.delete(type),
  } as unknown as Window;
  return {
    target,
    send: (type, key) => handlers.get(type)?.({ key, preventDefault: () => undefined }),
    at: () => surface,
    on: (s) => {
      surface = s;
    },
  };
}

describe('input：按键 → 方向（**按面分**）', () => {
  it('墙面：`a`/`d` 沿走廊左右，`w`/`s` 上下（爬梯）', () => {
    expect(dirOfKey('a', 'wall')).toBe('left');
    expect(dirOfKey('D', 'wall')).toBe('right');
    expect(dirOfKey('ArrowLeft', 'wall')).toBe('left');
    expect(dirOfKey('ArrowRight', 'wall')).toBe('right');
    expect(dirOfKey('w', 'wall')).toBe('up');
    expect(dirOfKey('S', 'wall')).toBe('down');
    expect(dirOfKey('ArrowUp', 'wall')).toBe('up');
    expect(dirOfKey('ArrowDown', 'wall')).toBe('down');
    expect(dirOfKey('e', 'wall')).toBeNull(); // 墙面上没有斜向可言
  });

  it('甲板：四个屏幕斜向 `w`↖ `e`↗ `s`↙ `d`↘（各自正对一个象限）', () => {
    // ↖ = -x = `left`；↗ = -z = `up`；↙ = +z = `down`；↘ = +x = `right`（见 `DECK_DIR`）。
    expect(dirOfKey('w', 'deck')).toBe('left');
    expect(dirOfKey('e', 'deck')).toBe('up');
    expect(dirOfKey('s', 'deck')).toBe('down');
    expect(dirOfKey('d', 'deck')).toBe('right');
    expect(dirOfKey('A', 'deck')).toBeNull(); // 用户给的四个键里没有 `a`
  });

  it('方向键是 WASD 的**别名**（完全等价，不另立含义）', () => {
    for (const surface of ['wall', 'deck'] as const) {
      expect(dirOfKey('ArrowLeft', surface)).toBe(dirOfKey('a', surface));
      expect(dirOfKey('ArrowUp', surface)).toBe(dirOfKey('w', surface));
      expect(dirOfKey('ArrowDown', surface)).toBe(dirOfKey('s', surface));
      expect(dirOfKey('ArrowRight', surface)).toBe(dirOfKey('d', surface));
    }
  });

  it('别的键一律 null —— 输入层不去猜玩家想干嘛', () => {
    for (const surface of ['wall', 'deck'] as const) {
      for (const key of [' ', 'Enter', 'Shift', 'z', 'x', 'q', 'r', '1']) {
        expect(dirOfKey(key, surface)).toBeNull();
      }
    }
  });
});

/**
 * 键 → 方向按面分，所以**同一个键在两个面上可以是两件事**（`w` 在墙上 = 爬梯、在甲板 = ↖）。
 * 这条钉两层：①纯判据 `moveAllowed`；②接到**真的键盘事件**上跑一遍 ——
 * 因为"按键怎么发出来"和"走法合不合法"是两件事，只有后者被 `movement.step` 管着。
 */
describe('input：同一个键在两个面上的含义', () => {
  it('`moveAllowed` 跟着键位表走：墙上四个方向都有（只有 `e` 没有），甲板也没有 `a`', () => {
    for (const surface of ['wall', 'deck'] as const) {
      for (const dir of ['left', 'right', 'up', 'down'] as const) {
        expect(moveAllowed(dir, surface)).toBe(true);
      }
    }
    expect(moveAllowed('up', 'wall')).toBe(true); // 墙面上的 `up` 就是爬梯
    expect(dirOfKey('a', 'deck')).toBeNull();
    expect(dirOfKey('e', 'wall')).toBeNull();
  });

  it('真的按 `w`：甲板上是 `left`（↖ = -x），墙面上是 `up`（爬梯）', () => {
    const kb = keyboard();
    const input = createInput(kb.target, kb.at);

    kb.on('deck');
    kb.send('keydown', 'w');
    expect(input.intents().move).toBe('left');

    // 走上墙：**同一个键换了含义**（甲板的 ↖ → 墙面的爬梯）。这是按面分的本意。
    kb.on('wall');
    expect(input.intents().move).toBe('up');

    kb.on('deck');
    expect(input.intents().move).toBe('left');
  });

  it('真的按 `a`：墙面上是 `left`；甲板上没有这个键', () => {
    const kb = keyboard();
    const input = createInput(kb.target, kb.at);

    kb.send('keydown', 'a');
    expect(input.intents().move).toBe('left');

    kb.on('deck');
    expect(input.intents().move).toBeNull();
  });

  it('`Z`/`X` 在墙面上什么都不做 —— 墙上的上下**只有一个答案**（`w`/`s`）', () => {
    // 用户 2026-09-19："关掉"。于是 `Z`/`X` 的含义是"甲板换层（塔）"，不是"世界上下"的通用写法。
    const kb = keyboard();
    const input = createInput(kb.target, kb.at);

    kb.send('keydown', 'x'); // 想往下
    kb.on('wall');
    expect(input.intents().lift).toBeNull();

    kb.on('deck'); // 走上塔下：同一个键这才有含义
    expect(input.intents().lift).toBe('fall');
  });
});

describe('input：键盘状态机', () => {
  it('按下就有方向；同一个键重复按（系统按键重复）不会在 held 里堆两份', () => {
    const once = pressDir(NO_KEYS, 'right');
    expect(once.held).toEqual(['d']);
    expect(pressDir(once, 'right').held).toEqual(['d']);
  });

  it('按住时**最近按下的**那个方向优先', () => {
    let k = pressDir(NO_KEYS, 'right');
    k = pressDir(k, 'down');
    expect(intent(k)).toBe('down'); // 后按的赢
    k = releaseDir(k, 'down');
    expect(intent(k)).toBe('right'); // 松开 down 之后回到还按着的 right
  });

  it('松手**不会**丢掉那一跳的锁存值 —— 锁存的意义正在于此', () => {
    const tapped = releaseDir(pressDir(NO_KEYS, 'right'), 'right');
    expect(tapped.held).toEqual([]); // 手指已经抬起来了
    expect(intent(tapped)).toBe('right'); // 但这一下仍然欠着
  });

  it('消费之后锁存清空；但按住**不会**立刻再给一步（2026-09-17 改，见下）', () => {
    const tapped = consumed(releaseDir(pressDir(NO_KEYS, 'right'), 'right'));
    expect(intent(tapped)).toBeNull();

    // ⚠️ **这条断言被改过，是有意的。** 原文是：
    //     const holding = consumed(pressDir(NO_KEYS, 'right'));
    //     expect(intent(holding)).toBe('right');
    // 也就是"走完第一步、只要还按着就立刻再走一格" —— 那**正是**用户报的必现 bug：
    // 按一下 d 走两格，而出生点右边第二格是落水缺口 → 落水 → 扣命（见本文件下方同名用例）。
    // 现在按住要等 `REPEAT_DELAY_TICKS`：`held` 本身没被动到，只是这一 tick 不放行。
    const holding = consumed(pressDir(NO_KEYS, 'right'));
    expect(holding.held).toEqual(['d']); // 按住状态仍在（`consume` 不碰 `held`）
    expect(intent(holding)).toBeNull(); // 但下一步要等延迟
    expect(intent(tickN(holding, REPEAT_DELAY_TICKS))).toBe('right'); // 到点就恢复
  });

  it('失焦时把所有键放掉（否则切回来角色会自己一直走），但保留锁存', () => {
    let k = pressDir(NO_KEYS, 'right');
    k = pressDir(k, 'up');
    const blurred = released(k);
    expect(blurred.held).toEqual([]);
    expect(intent(blurred)).toBe('up');
  });
});

describe('input：重复延迟（点一下只走一格，按住才连走）', () => {
  it('按下的第一步立即兑现；之后要等满延迟才给重复步', () => {
    let k = pressDir(NO_KEYS, 'right');
    expect(intent(k)).toBe('right'); // 第一步：立刻（走 `latched`）

    k = consumed(k); // 第一步被兑现 → 开始计重复延迟
    expect(intent(k)).toBeNull();
    k = tickN(k, REPEAT_DELAY_TICKS - 1);
    expect(intent(k)).toBeNull(); // 差一个 tick 也不放行
    k = ticked(k);
    expect(intent(k)).toBe('right'); // 到点放行
  });

  it('第一次重复之后不再加延迟，节奏交回 core 的冷却（MOVE_TICKS）', () => {
    let k = consumed(pressDir(NO_KEYS, 'right'));
    k = tickN(k, REPEAT_DELAY_TICKS);
    expect(intent(k)).toBe('right');
    k = consumed(k); // 这一步来自 `held`（`latched` 早已是 null）
    expect(intent(k)).toBe('right'); // 不再等 —— 连走速度由 MOVE_TICKS 决定
  });

  it('松手早于延迟 → 那一步之后不会再有第二步（旧实现会多走一格）', () => {
    const tap = consumed(releaseDir(pressDir(NO_KEYS, 'right'), 'right'));
    expect(tap.held).toEqual([]); // 手指已抬起
    expect(intent(tickN(tap, REPEAT_DELAY_TICKS * 3))).toBeNull(); // 松了就绝不会再自己走
  });

  it('系统按键重复不会清掉延迟（否则按住会被它提前放行）', () => {
    let k = consumed(pressDir(NO_KEYS, 'right')); // 已进入倒计时
    k = tickN(k, 3);
    k = pressDir(k, 'right'); // 系统重复送来的同一个 keydown
    k = ticked(k);
    expect(intent(k)).toBeNull(); // 延迟没被它清掉
    k = tickN(k, REPEAT_DELAY_TICKS);
    expect(intent(k)).toBe('right'); // 该到点还是到点
  });

  it('连点两下 = 各自一步（延迟只约束"按住"，不约束"重新按"）', () => {
    let k = consumed(pressDir(NO_KEYS, 'right')); // 第一下已兑现
    k = tickN(k, 3); // 还压在延迟里
    k = releaseDir(k, 'right');
    k = pressDir(k, 'right'); // 重新按一下
    expect(intent(k)).toBe('right'); // 新按下立刻给意图，不必等
  });

  it('延迟与 core 的冷却同量级：250ms 比 MOVE_TICKS(133ms) 宽，所以"点按"不再取决于手速', () => {
    // 这条是**契约的性质**而不是实现细节：延迟必须明显大于一格的冷却，
    // 否则"点一下"与"按住"会重新粘在一起（旧 bug 的形状）。
    expect(REPEAT_DELAY_TICKS).toBeGreaterThan(MOVE_TICKS);
    expect(REPEAT_DELAY_TICKS).toBeGreaterThanOrEqual(12); // ≥200ms @60Hz
  });
});

describe('input：轻点不该被冷却窗口吃掉（这条是 T7 存在的理由）', () => {
  /**
   * 同一个手势跑两遍：
   *   - `latched = true`  → 走 `press/release/moveIntent/consumed` 这套（我们的实现）
   *   - `latched = false` → "朴素"做法：只看本 tick 是否按着
   *
   * 手势：tick 0 按住"右"走一格（于是进入冷却）→ tick 1 松手 → **tick 3 在冷却窗口里轻点一下"右"**。
   * 冷却一共 `MOVE_TICKS` 个 tick，所以那个轻点发生在窗口**中间**。
   */
  function runTapDuringCooldown(latched: boolean): SimState {
    let keys: KeyState = NO_KEYS;
    let state = createSim(DEF, SPAWN);

    for (let i = 0; i < MOVE_TICKS * 3; i++) {
      if (i === 0) keys = pressDir(keys, 'right');
      if (i === 1) keys = releaseDir(keys, 'right');
      if (i === 3) keys = releaseDir(pressDir(keys, 'right'), 'right'); // 轻点：按下并立刻松开

      // 朴素做法里，"按着"只在轻点那一 tick 为真；其余全 null。
      const move: Dir | null = latched ? intent(keys) : i === 3 ? 'right' : null;

      const before = state.entities[0];
      state = tick(state, { move, dig: null }).state;
      const after = state.entities[0];
      if (latched && before !== undefined && after !== undefined && after.cell.col !== before.cell.col) {
        keys = consumed(keys); // 真的动了才算销账
      }
    }
    return state;
  }

  it('不锁存：那一下轻点**白白丢掉**，角色只走了一格', () => {
    const player = runTapDuringCooldown(false).entities[0];
    expect(player?.cell.col).toBe(1);
  });

  it('锁存：同一次轻点换来**整整一步**，角色走到第二格', () => {
    const player = runTapDuringCooldown(true).entities[0];
    expect(player?.cell.col).toBe(2);
  });
});

describe('input：出生点按一下 d 不该死（用户报告的必现 bug）', () => {
  /**
   * 用户的原话：刷新后按一下 `d`，角色移动到梯子上又很快移回来，按三下就 `dead`。
   *
   * 机制：`CONCEPT_MINIMAL` 的出生点 `A:0,1` 右边一格是**梯脚** `A:1,1`（安全，
   * 由 `r0 col1 = X` 撑着），再右边一格 `col2` 的 `r0` 是缺口 —— 从 `col1` 再走一步就
   * 一路无支撑 → 落水 → 扣命 → 重生回出生点。所以"按一次键走两格"就必然掉命，
   * 而"很快移回来"就是**重生**。
   *
   * 这里用**真实**的输入状态机驱动**真实**的关卡，把"按下后一直不松"的 tick 数扫一遍。
   * 边界是 `MOVE_TICKS`(8)：旧实现里第 9 个 tick 冷却刚归零，`held` 电平立刻换来第二步。
   */
  function holdFrom(start: SimState, dir: Dir, ticks: number): { state: SimState; events: readonly SimEvent[]; cells: string[] } {
    let keys = pressDir(NO_KEYS, dir); // 按下，期间不松手
    let state = start;
    const events: SimEvent[] = [];
    const cells: string[] = [];
    for (let i = 0; i < ticks; i++) {
      // **必须对齐 `createInput.intents()`**：它每个 tick 先推时钟再算意图。
      // 少了这一行，`holdArmedAt` 就永远到不了点 —— 按住再也走不动（测试会假绿/假红）。
      keys = ticked(keys);
      const before = state.entities[0];
      const frame = tick(state, { move: intent(keys), dig: digIntent(keys) });
      state = frame.state;
      events.push(...frame.events);

      const after = state.entities[0];
      if (before !== undefined && after !== undefined && after.cell.col !== before.cell.col) {
        keys = consumed(keys); // 真的动了才销账（与 main.ts 的 actedOn 同义）
      }
      if (after !== undefined) {
        const key = cellKey(after.cell);
        if (cells[cells.length - 1] !== key) cells.push(key); // 只记"变了的时候"，否则每个没动的 tick 都会重复一次
      }
    }
    return { state, events, cells };
  }

  /** 都短于 250ms 的重复延迟。其中 **9** 正是旧实现出事的那一档（`MOVE_TICKS + 1`）。 */
  const SHORT_PRESSES = [1, 2, 4, 8, 9, 12, 14];

  it('短按（< 重复延迟）→ 只走到梯脚 A:1,1，命数不减、没有落水', () => {
    for (const n of SHORT_PRESSES) {
      const { state, events, cells } = holdFrom(createSim(CONCEPT_MINIMAL, PLAYER_SPAWN), 'right', n);
      const player = state.entities[0];
      expect({
        ticks: n,
        lives: state.lives,
        status: state.status,
        cell: player === undefined ? '?' : cellKey(player.cell),
        drowned: events.some((e) => e.kind === 'drowned'),
        trace: cells.join(' > '),
      }).toEqual({
        ticks: n,
        lives: 3,
        status: 'playing',
        cell: 'A:1,1',
        drowned: false,
        trace: 'A:1,1',
      });
    }
  });

  it('对照：一直按住 → 仍会走进 col2 的缺口掉命（危险没有被修掉，测试也不是空跑）', () => {
    const { state, events } = holdFrom(createSim(CONCEPT_MINIMAL, PLAYER_SPAWN), 'right', 60);
    expect(events.some((e) => e.kind === 'drowned')).toBe(true);
    // 不写死死几次：重生后键**还按着**，所以会反复走下去送命（60 tick 里死了两次 → 1 条命）。
    // 这条只钉"危险仍在"，不钉节奏 —— 节奏是上面那条短按用例的事。
    expect(state.lives).toBeLessThan(3);
  });
});

describe('input：掐掉"按住不放"（跨接头的转折）', () => {
  it('掐掉之后按住不再换下一步；**松手再按**才恢复', () => {
    let k = pressDir(NO_KEYS, 'left');
    k = tickN(k, 1);
    expect(intent(k)).toBe('left'); // 按下的第一步立即兑现
    k = consumed(k);
    k = holdBroken(k); // main.ts 在"跨接头且世界方向改变"的那一步之后调它
    k = tickN(k, 120); // 按住很久
    expect(intent(k)).toBeNull(); // 一直不出手（否则会被带着拐进另一条走廊）
    k = releaseDir(k, 'left');
    k = pressDir(k, 'left');
    expect(intent(k)).toBe('left'); // 松手再按 → 立刻兑现
  });

  it('没掐的时候按住照旧连走（对照，免得这条规则把"按住"整个废掉）', () => {
    let k = pressDir(NO_KEYS, 'left');
    k = tickN(k, 1);
    k = consumed(k);
    k = tickN(k, REPEAT_DELAY_TICKS);
    expect(intent(k)).toBe('left');
  });
});

describe('input：折痕对输入是透明的（拿真相机的轴钉住）', () => {
  // 这里**故意不 import three**：eslint 的架构红线只放行 `src/render`、`src/app`，
  // 免得哪天有人把 three 拖进 core 的测试里。我们要的只是 `matrixWorld` 的两列数字，
  // 从 `elements`（列主序）直接取即可 —— 与 `Vector3.setFromMatrixColumn` 读的是同一个东西。
  const cam: ReturnType<typeof createCamera> = createCamera();
  cam.updateMatrixWorld(true);

  const elements = cam.matrixWorld.elements;
  const element = (i: number): number => {
    const v = elements[i];
    if (v === undefined) throw new Error(`matrixWorld.elements 缺第 ${i} 项`);
    return v;
  };
  /** 列主序：第 i 列 = `elements[4i .. 4i+2]`。第 0 列是"屏幕向右"、第 1 列是"屏幕向上"。 */
  const axis = (i: number): { x: number; y: number; z: number } => ({
    x: element(i * 4),
    y: element(i * 4 + 1),
    z: element(i * 4 + 2),
  });
  const RIGHT = axis(0);
  const UP = axis(1);

  const project = (col: number, row: number): { x: number; y: number } => {
    // 用**真的**"格 → 世界坐标"换算（`cellAnchor`，含砖厚/半格偏移）——
    // 折痕两侧最内列**在世界同一个位置**这件事，正是靠那一层偏移才成立的
    // （见 `metrics.BRICK_N` 的说明）。只比 `toWorld` 的格心会少掉那半格。
    const [x, y, z] = cellAnchor(level, { face: col < FOLD ? 'A' : 'B', col, row }).p;
    return {
      x: RIGHT.x * x + RIGHT.y * y + RIGHT.z * z,
      y: UP.x * x + UP.y * y + UP.z * z,
    };
  };

  it('col + 1 在两面墙上都是往屏幕右边走', () => {
    for (let col = 0; col < FOLD * 2 - 1; col++) {
      const here = project(col, 1).x;
      const next = project(col + 1, 1).x;
      if (col === FOLD - 1) {
        // 折痕那一跳：两侧最内列的**格心是同一个点**（这就是"折起来"的含义）——
        // 屏幕上不前不后，只是承载它的墙从 A 换成了 B。
        expect(next).toBeCloseTo(here, 10);
      } else {
        expect(next).toBeGreaterThan(here);
      }
    }
  });

  it('row + 1 在两面墙上都是往屏幕上方走', () => {
    for (const col of [1, FOLD + 1]) {
      for (let row = 0; row < 3; row++) {
        expect(project(col, row + 1).y).toBeGreaterThan(project(col, row).y);
      }
    }
  });

  it('夹具本身站得住（不然上面那两条测的是空气）', () => {
    const parsed = parseLevel(DEF);
    expect(parsed.ok).toBe(true);
    // 出生点必须能站住：createSim 站不住会当场抛。
    expect(() => createSim(DEF, SPAWN)).not.toThrow();
  });
});

describe('input：挖键（T11）', () => {
  it('`Q` 后挖、`R` 前挖，大小写不敏感；别的键不认', () => {
    // 键位变迁：`Z`/`X` → `Q`/`E`（挖与走同一条肌肉）→ `Q`/`R`（2026-09-19）。
    // `E` 被甲板的 ↗ 拿走了；`R` 原本是"重开本局"，重开挪去了 `Backspace`。
    expect(digOfKey('q')).toBe('back');
    expect(digOfKey('Q')).toBe('back');
    expect(digOfKey('r')).toBe('front');
    expect(digOfKey('R')).toBe('front');
    // 关键：不能和移动键 / 升降键撞车，否则按方向键会顺手挖一铲
    for (const key of ['ArrowLeft', 'a', 'd', 'w', 's', 'e', 'z', 'x', 'Backspace', ' ']) {
      expect(digOfKey(key)).toBeNull();
    }
  });

  it('挖键与移动键**互不干扰**：按 Q 不会让角色开始走', () => {
    const dug = digPress(NO_KEYS, 'back');
    expect(intent(dug)).toBeNull(); // 没有移动意图
    expect(digIntent(dug)).toBe('back');
  });

  it('两个意图可以同时存在（core 里挖与走本来就是两件事）', () => {
    const k = digPress(pressDir(NO_KEYS, 'up'), 'front');
    expect({ move: intent(k), dig: digIntent(k) }).toEqual({ move: 'up', dig: 'front' });
  });

  it('挖**没有锁存**：松手就失效 —— 与移动键的关键差别', () => {
    const tapped = digRelease(digPress(NO_KEYS, 'front'), 'front');
    expect(digIntent(tapped)).toBeNull(); // 松手即无

    // 对照：同样"按下再松开"的移动键仍然欠着一步（T7 为解决那个问题才引入锁存）
    const moved = releaseDir(pressDir(NO_KEYS, 'right'), 'right');
    expect(intent(moved)).toBe('right');
  });

  it('两个挖键同时按住时，最近按下的优先', () => {
    let k = digPress(NO_KEYS, 'back');
    k = digPress(k, 'front');
    expect(digIntent(k)).toBe('front');
    k = digRelease(k, 'front');
    expect(digIntent(k)).toBe('back'); // 松开 front 之后回到还按着的 back
  });

  it('重复按同一个挖键不会堆两份（系统按键重复）', () => {
    const once = digPress(NO_KEYS, 'back');
    expect(digPress(once, 'back').digHeld).toEqual(['back']);
  });

  it('失焦把挖键也放掉 —— 卡住的挖键会一路挖穿地板', () => {
    const blurred = released(digPress(NO_KEYS, 'back'));
    expect(digIntent(blurred)).toBeNull();
  });
});
