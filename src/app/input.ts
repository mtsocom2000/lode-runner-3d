import type { Dir } from '../core/rules/movement';
import type { Intents } from '../core/sim';

/**
 * 键盘 → `Intents`（T7）。
 *
 * ## 为什么需要"锁存"（本文件存在的全部理由）
 *
 * core 的输入契约是**每 tick 采样的电平**（按住 = 持续有效），而移动有冷却：走一格要
 * `MOVE_TICKS` 个 tick（`8/60 ≈ 0.13s`）。于是一次比冷却还短的**轻点**，如果恰好落在冷却
 * 窗口里，整段窗口内读到的都是"没按" —— **这一下被整个漏掉**，玩家会觉得"我明明按了它不动"。
 *
 * 解法：把"最近按下过的方向"记下来，直到它**真的被消费掉**（实体动了一次）才清空。
 * 一次轻点于是必然换来一步，不多不少。
 *
 * 这是**输入层**的职责：core 故意不做锁存 —— 让历史按键去改写 `null` 会污染回放语义
 * （回放脚本里写 `null` 就该是 `null`）。
 *
 * ## 折痕对输入是**透明**的（这条结论有测试钉着）
 *
 * 本相机 `dir = (1, 0.66, 1)` 与 90° 折角**同构**（两者都在 x↔z 交换下不变），于是
 * `col ± 1` 在**两面墙上都投影成屏幕水平移动**，`row ± 1` 都是屏幕竖直移动。
 * 换句话说：同一个方向键在 A/B 两面做的是**同一件事**（在摊平的那张网格上朝同一侧走），
 * 所以这里**不需要**按面翻转映射。
 *
 * `test/input.test.ts` 拿**真相机**的右轴/上轴把这条性质钉住了：谁要是转了相机或改了折角，
 * 那条测试会立刻失败 —— 那时才需要引入"本地方向系"。计划里 T7 的"过折痕转 90°"指的是
 * 角色的**朝向**（一个目前还没有视觉表现的属性），不是按键映射。
 *
 * ## 纯逻辑与回响分离
 *
 * 键盘状态机（`press` / `release` / `moveIntent` / `consumed`）是**纯函数**，测试直接跑它，
 * 不用起 DOM；`createInput` 只是把它接到真实事件上。
 */

/** 方向键 / WASD → core 的摊平网格方向。认不出来返回 null（其它键不归我们管）。 */
export function dirOfKey(key: string): Dir | null {
  switch (key) {
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return 'left';
    case 'ArrowRight':
    case 'd':
    case 'D':
      return 'right';
    case 'ArrowUp':
    case 'w':
    case 'W':
      return 'up';
    case 'ArrowDown':
    case 's':
    case 'S':
      return 'down';
    default:
      return null;
  }
}

/**
 * 挖的方向键（T11）。与移动键**分开**:`Z` = 往左挖、`X` = 往右挖（原版那两个动作键的惯例）。
 *
 * 为什么不做成"方向键 + 修饰键":`Intents.dig` 要的信息只有"朝哪边挖"这一件事,
 * 两个独立键表达得最直白,也不必和方向键的锁存语义纠缠（见下）。
 */
export function digOfKey(key: string): Dir | null {
  switch (key) {
    case 'z':
    case 'Z':
      return 'left';
    case 'x':
    case 'X':
      return 'right';
    default:
      return null;
  }
}

/**
 * 键盘状态。`held` 按**按下顺序**排列（最后一个是最近按下的，优先于更早按下的）；
 * `latched` 是"按下过但还没被消费"的那一下。
 *
 * `digHeld`（T11）与 `held` 是**两套独立状态**：挖键不进 `held`，也不参与 `latched`。
 * 分开的理由见 `createInput` 上方那段（要命的差别在"锁存"上）。
 */
export interface KeyState {
  readonly held: readonly Dir[];
  readonly latched: Dir | null;
  readonly digHeld: readonly Dir[];
}

export const NO_KEYS: KeyState = { held: [], latched: null, digHeld: [] };

/** 按下（含系统的按键重复：重复按同一个键不会在 `held` 里堆两份）。 */
export function press(state: KeyState, dir: Dir): KeyState {
  const held = state.held.includes(dir) ? state.held : [...state.held, dir];
  return { ...state, held, latched: dir };
}

/** 松开。松手**不动** `latched` —— 那一下还没被消费，不能因为松手就丢掉。 */
export function release(state: KeyState, dir: Dir): KeyState {
  if (!state.held.includes(dir)) return state;
  return { ...state, held: state.held.filter((d) => d !== dir) };
}

/** 本 tick 该朝哪走：按住的话以**最近按下的**那个为准；只点过一下则用锁存值。 */
export function moveIntent(state: KeyState): Dir | null {
  const lastHeld = state.held[state.held.length - 1];
  return lastHeld ?? state.latched;
}

/** 消费掉锁存：实体真的动了一次之后调用。`held` 不受影响（按住要持续有效）。 */
export function consumed(state: KeyState): KeyState {
  return state.latched === null ? state : { ...state, latched: null };
}

/**
 * 全部放开（切标签页 / 失焦时用）。**挖键也一起放** —— 卡住的挖键比卡住方向更糟：
 * 方向卡住只是自己走，挖键卡住会一路挖穿地板。锁存值保留（那一下仍然欠玩家一步）。
 */
export function released(state: KeyState): KeyState {
  if (state.held.length === 0 && state.digHeld.length === 0) return state;
  return { ...state, held: [], digHeld: [] };
}

/** 按下挖键（T11）。与 `press` 分开：挖键不进 `held`，也不写 `latched`。 */
export function digPress(state: KeyState, dir: Dir): KeyState {
  return state.digHeld.includes(dir) ? state : { ...state, digHeld: [...state.digHeld, dir] };
}

/** 松开挖键。松手即失效 —— 挖**没有**锁存（理由见 `createInput` 上方那段）。 */
export function digRelease(state: KeyState, dir: Dir): KeyState {
  return state.digHeld.includes(dir) ? { ...state, digHeld: state.digHeld.filter((d) => d !== dir) } : state;
}

/** 本 tick 想往哪挖；两个都按住时**最近按下的**优先。没按就是 `null`。 */
export function digIntent(state: KeyState): Dir | null {
  return state.digHeld[state.digHeld.length - 1] ?? null;
}

export interface Input {
  /** 每个 sim tick 调一次 —— 输入是**电平**，不是边沿。 */
  intents(): Intents;
  /** 实体动过一次之后调一次，把锁存的那一下销账。 */
  consume(): void;
  dispose(): void;
}

/**
 * 把状态机接到真实键盘上。`target` 可注入，测试里给一个假的。
 *
 * ## 挖键**故意不锁存**（与移动键的唯一分歧）
 *
 * 移动有锁存，是因为"轻点被冷却窗口吃掉"会让玩家觉得按键失灵（见文件头）。
 * 挖键不做同样的事，理由有两条：
 *
 * 1. **挖是破坏性动作，且与位置强相关**。锁存的意思是"这一下欠着，之后某个 tick 兑现"。
 *    移动兑现成"挪一格"无所谓；挖却可能在玩家已经走开两格**之后**才落地 —— 变成
 *    "我没想挖这里，它自己挖了"。宁可丢一次，也不要错挖。
 * 2. core 侧本来就有幂等保护：`applyDig` 对已经挖空的格子返回 `null`，按住不放不会重复触发。
 *
 * 代价是"冷却中轻点挖键"会被漏掉一次。这条**记进 T-SP1 的试玩清单**：
 * 如果试玩时觉得挖键也钝，再给它加锁存（`KeyState` 旁边加一个 `digLatched` 即可，
 * 不必动 core）。
 */
export function createInput(target: Window = window): Input {
  let keys = NO_KEYS;

  const onKeyDown = (e: KeyboardEvent): void => {
    const dig = digOfKey(e.key);
    if (dig !== null) {
      e.preventDefault();
      keys = digPress(keys, dig);
      return;
    }
    const dir = dirOfKey(e.key);
    if (dir === null) return;
    e.preventDefault(); // 方向键默认会滚页面
    keys = press(keys, dir);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    const dig = digOfKey(e.key);
    if (dig !== null) {
      keys = digRelease(keys, dig);
      return;
    }
    const dir = dirOfKey(e.key);
    if (dir === null) return;
    keys = release(keys, dir);
  };
  // 失焦必须放开所有键：否则切走再回来会"卡住一个按住的方向"，角色自己一直走。
  // `released` 连挖键一起放（卡住的挖键会一路挖过去）。
  const onBlur = (): void => {
    keys = released(keys);
  };

  target.addEventListener('keydown', onKeyDown);
  target.addEventListener('keyup', onKeyUp);
  target.addEventListener('blur', onBlur);

  return {
    intents: (): Intents => ({ move: moveIntent(keys), dig: digIntent(keys) }),
    consume: (): void => {
      keys = consumed(keys);
    },
    dispose: (): void => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    },
  };
}
