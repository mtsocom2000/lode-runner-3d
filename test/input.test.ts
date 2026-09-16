import {
  NO_KEYS,
  consumed,
  digIntent,
  digOfKey,
  digPress,
  digRelease,
  dirOfKey,
  moveIntent,
  press,
  release,
  released,
  type KeyState,
} from '../src/app/input';
import { MOVE_TICKS, createSim, tick, type SimState } from '../src/core/sim';
import type { Dir } from '../src/core/rules/movement';
import { toFold, toWorld } from '../src/core/world/fold';
import type { Cell, Face } from '../src/core/types';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';
import { createCamera } from '../src/render/camera';

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

describe('input：按键 → 方向', () => {
  it('方向键与 WASD 都认，且大小写不敏感', () => {
    expect(dirOfKey('ArrowLeft')).toBe('left');
    expect(dirOfKey('ArrowRight')).toBe('right');
    expect(dirOfKey('ArrowUp')).toBe('up');
    expect(dirOfKey('ArrowDown')).toBe('down');
    expect(dirOfKey('a')).toBe('left');
    expect(dirOfKey('D')).toBe('right');
    expect(dirOfKey('w')).toBe('up');
    expect(dirOfKey('S')).toBe('down');
  });

  it('别的键一律 null —— 输入层不去猜玩家想干嘛', () => {
    for (const key of [' ', 'Enter', 'Shift', 'q', '1']) {
      expect(dirOfKey(key)).toBeNull();
    }
  });
});

describe('input：键盘状态机', () => {
  it('按下就有方向；同一个键重复按（系统按键重复）不会在 held 里堆两份', () => {
    const once = press(NO_KEYS, 'right');
    expect(once.held).toEqual(['right']);
    expect(press(once, 'right').held).toEqual(['right']);
  });

  it('按住时**最近按下的**那个方向优先', () => {
    let k = press(NO_KEYS, 'right');
    k = press(k, 'down');
    expect(moveIntent(k)).toBe('down'); // 后按的赢
    k = release(k, 'down');
    expect(moveIntent(k)).toBe('right'); // 松开 down 之后回到还按着的 right
  });

  it('松手**不会**丢掉那一跳的锁存值 —— 锁存的意义正在于此', () => {
    const tapped = release(press(NO_KEYS, 'right'), 'right');
    expect(tapped.held).toEqual([]); // 手指已经抬起来了
    expect(moveIntent(tapped)).toBe('right'); // 但这一下仍然欠着
  });

  it('消费之后锁存清空，但按住的不受影响', () => {
    const tapped = consumed(release(press(NO_KEYS, 'right'), 'right'));
    expect(moveIntent(tapped)).toBeNull();

    const holding = consumed(press(NO_KEYS, 'right'));
    expect(moveIntent(holding)).toBe('right');
  });

  it('失焦时把所有键放掉（否则切回来角色会自己一直走），但保留锁存', () => {
    let k = press(NO_KEYS, 'right');
    k = press(k, 'up');
    const blurred = released(k);
    expect(blurred.held).toEqual([]);
    expect(moveIntent(blurred)).toBe('up');
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
      if (i === 0) keys = press(keys, 'right');
      if (i === 1) keys = release(keys, 'right');
      if (i === 3) keys = release(press(keys, 'right'), 'right'); // 轻点：按下并立刻松开

      // 朴素做法里，"按着"只在轻点那一 tick 为真；其余全 null。
      const move: Dir | null = latched ? moveIntent(keys) : i === 3 ? 'right' : null;

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
    const w = toWorld(toFold({ face: (col < FOLD ? 'A' : 'B') as Face, col, row }, FOLD), FOLD);
    return {
      x: RIGHT.x * w.x + RIGHT.y * w.y + RIGHT.z * w.z,
      y: UP.x * w.x + UP.y * w.y + UP.z * w.z,
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
  it('Z 往左挖、X 往右挖，大小写不敏感；别的键不认', () => {
    expect(digOfKey('z')).toBe('left');
    expect(digOfKey('Z')).toBe('left');
    expect(digOfKey('x')).toBe('right');
    expect(digOfKey('X')).toBe('right');
    // 关键：不能和移动键撞车，否则按方向键会顺手挖一铲
    for (const key of ['ArrowLeft', 'a', 'd', 'w', 's', 'q', ' ']) {
      expect(digOfKey(key)).toBeNull();
    }
  });

  it('挖键与移动键**互不干扰**：按 Z 不会让角色开始走', () => {
    const dug = digPress(NO_KEYS, 'left');
    expect(moveIntent(dug)).toBeNull(); // 没有移动意图
    expect(digIntent(dug)).toBe('left');
  });

  it('两个意图可以同时存在（core 里挖与走本来就是两件事）', () => {
    const k = digPress(press(NO_KEYS, 'up'), 'right');
    expect({ move: moveIntent(k), dig: digIntent(k) }).toEqual({ move: 'up', dig: 'right' });
  });

  it('挖**没有锁存**：松手就失效 —— 与移动键的关键差别', () => {
    const tapped = digRelease(digPress(NO_KEYS, 'right'), 'right');
    expect(digIntent(tapped)).toBeNull(); // 松手即无

    // 对照：同样"按下再松开"的移动键仍然欠着一步（T7 为解决那个问题才引入锁存）
    const moved = release(press(NO_KEYS, 'right'), 'right');
    expect(moveIntent(moved)).toBe('right');
  });

  it('两个挖键同时按住时，最近按下的优先', () => {
    let k = digPress(NO_KEYS, 'left');
    k = digPress(k, 'right');
    expect(digIntent(k)).toBe('right');
    k = digRelease(k, 'right');
    expect(digIntent(k)).toBe('left'); // 松开 right 之后回到还按着的 left
  });

  it('重复按同一个挖键不会堆两份（系统按键重复）', () => {
    const once = digPress(NO_KEYS, 'left');
    expect(digPress(once, 'left').digHeld).toEqual(['left']);
  });

  it('失焦把挖键也放掉 —— 卡住的挖键会一路挖穿地板', () => {
    const blurred = released(digPress(NO_KEYS, 'left'));
    expect(digIntent(blurred)).toBeNull();
  });
});
