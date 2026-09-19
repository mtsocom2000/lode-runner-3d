import type { Dir } from '../core/rules/movement';
import { TICK_HZ, type Intents } from '../core/sim';

/**
 * 键盘 → `Intents`（T7）。
 *
 * ## 为什么需要"锁存"（本文件存在的理由之一）
 *
 * core 的输入契约是**每 tick 采样的电平**（按住 = 持续有效），而移动有冷却：走一格要
 * `MOVE_TICKS` 个 tick（`8/60 ≈ 0.13s`）。于是一次比冷却还短的**轻点**，如果恰好落在冷却
 * 窗口里，整段窗口内读到的都是"没按" —— **这一下被整个漏掉**，玩家会觉得"我明明按了它不动"。
 *
 * 解法：把"最近按下过的方向"记下来，直到它**真的被消费掉**（实体动了一次）才清空。
 *
 * 这是**输入层**的职责：core 故意不做锁存 —— 让历史按键去改写 `null` 会污染回放语义
 * （回放脚本里写 `null` 就该是 `null`）。
 *
 * ## 为什么还需要"重复延迟"（同一枚硬币的另一面，2026-09-17 补）
 *
 * 锁存只管住"**点得太短**会被冷却窗口吃掉"。它的反面一直没人管：**按得稍长**。
 *
 * 旧实现是 `moveIntent = lastHeld ?? latched`，只要键还按着，`held` 电平每 `MOVE_TICKS`
 * (8 tick) 就**无条件**换来一格 —— 于是"轻点 / 按住"的分界线落在 **8~9 tick ≈ 150ms**，
 * 而人按键的正常时长就是 80–200ms，**正好骑在这条刀锋上**：玩家以为点了一下，角色走了两格。
 *
 * 在这个概念关卡里那不是手感问题，而是**掉命**：出生点右边第二格就是落水缺口，
 * 走两格 → 落水 → 扣命 → 重生回起点。用户报的"按一下 d 角色移动到梯子上又很快移回来、
 * 按三下就 dead"就是它 —— 见 `test/input.test.ts` 的同名用例（那里用真实关卡钉住了）。
 *
 * 所以再补一条规则：**按下的第一步立即兑现；之后还想走，必须按住满 `REPEAT_DELAY_TICKS`**；
 * 那一次重复之后再交回 `MOVE_TICKS` 的节奏连续走。与桌面端键盘的"重复延迟 + 重复速率"同构。
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
  /**
   * 走到第几个 tick（每次 `intents()` +1）。重复延迟必须按 **tick** 计 —— core 是定步长
   * （`TICK_HZ`），按毫秒计会与实际推进漂开，而这个延迟的全部职责就是把"轻点"与"按住"分开。
   */
  readonly tick: number;
  /** 允许 `held` 电平换下一步的起始 tick。`0` = 不设限（刚按下、或重复已经开始）。 */
  readonly holdArmedAt: number;
}

/**
 * 按住方向的**重复延迟**：第一步兑现之后，要再等多久才允许"按住"换下一步。
 *
 * 取 **250ms**：比正常人按键时长（80–200ms）宽出一截，于是"点一下 = 恰好一格"不再取决于
 * 玩家手速。按住则"立即一步 → 停 250ms → 每 `MOVE_TICKS` 一步"。
 */
export const REPEAT_DELAY_TICKS = Math.round(0.25 * TICK_HZ);

export const NO_KEYS: KeyState = { held: [], latched: null, digHeld: [], tick: 0, holdArmedAt: 0 };

/**
 * 按下（含系统的按键重复）。
 *
 * 系统重复送来的 keydown（同一个键已经在 `held` 里）**原样返回** —— 不能重新锁存、
 * 更不能清掉重复延迟，否则"按住"会被它提前放行（那正是重复延迟要防的事）。
 */
export function press(state: KeyState, dir: Dir): KeyState {
  if (state.held.includes(dir)) return state;
  // 全新的一下：立刻兑现（走 `latched`），并且不设限 —— 之后才需要等。
  return { ...state, held: [...state.held, dir], latched: dir, holdArmedAt: 0 };
}

/** 松开。松手**不动** `latched` —— 那一下还没被消费，不能因为松手就丢掉。 */
export function release(state: KeyState, dir: Dir): KeyState {
  if (!state.held.includes(dir)) return state;
  return { ...state, held: state.held.filter((d) => d !== dir) };
}

/**
 * 本 tick 该朝哪走：按住的话以**最近按下的**那个为准；只点过一下则用锁存值。
 *
 * **重复延迟在这里生效**：按住时若还没到 `holdArmedAt`，这一步不放行 —— 那就是"按得稍长
 * 就多走一格"的堵口。刚按下的第一步不受影响：它走 `latched`，而 `latched` 是被 `consumed`
 * 清掉之后才可能落进这条分支的。
 */
export function moveIntent(state: KeyState): Dir | null {
  const lastHeld = state.held[state.held.length - 1];
  if (lastHeld === undefined) return state.latched;
  if (state.tick < state.holdArmedAt) return null;
  return lastHeld;
}

/**
 * 推进一个 tick 的时钟。**每个 sim tick 调一次**（在 `createInput.intents()` 里做）。
 *
 * 为什么按 tick 而不是毫秒：core 是定步长，按毫秒计会与实际推进漂开；而这个延迟的唯一职责
 * 就是把"轻点"与"按住"分开，漂一点就等于白做。
 */
export function ticked(state: KeyState): KeyState {
  return { ...state, tick: state.tick + 1 };
}

/**
 * 消费掉锁存：实体真的动了一次之后调用。`held` 不受影响（按住要继续有效）。
 *
 * 顺带决定**下一次重复要不要等延迟**：刚兑现的是"按下的第一步"（`latched` 还在）⇒ 要等；
 * 兑现的是"重复步"（`latched` 已经是 null）⇒ 不再加延迟，节奏交回 core 的冷却（`MOVE_TICKS`）。
 * 于是按住的手感是"立即一步 → 停 250ms → 每 133ms 一步"，与键盘重复同构。
 */
export function consumed(state: KeyState): KeyState {
  const fromLatch = state.latched !== null;
  return {
    ...state,
    latched: null,
    holdArmedAt: fromLatch ? state.tick + REPEAT_DELAY_TICKS : 0,
  };
}

/**
 * 掐掉"按住不放"：直到玩家**松手再按**为止，`held` 不再换下一步（`latched` 保持不动 ——
 * 那一下仍然欠玩家）。
 *
 * 用在**跨接头的转折**上：门（甲板 ↔ 墙面）两侧的键含义不同，按住不放会被带着拐进另一条
 * 走廊（用户 2026-09-19："按着 a 键会在到达墙面时自动转换方向，这是不对的"）。
 * 折痕**不**掐 —— 那是同一条走廊折了一下，教学里就写着"沿走廊一直走就能过去"。
 *
 * 实现上把 `holdArmedAt` 顶到无穷：`press` 对已经按住的键是**原样返回**（系统重复不清延迟），
 * 所以只有真正"松手再按"才会把它复位成 0。
 */
export function holdBroken(state: KeyState): KeyState {
  return { ...state, holdArmedAt: Number.POSITIVE_INFINITY };
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
  /**
   * 掐掉"按住不放"（见 `holdBroken`）。`main.ts` 在**跨接头且世界方向改变**的那一步之后调它。
   */
  breakHold(): void;
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
    intents: (): Intents => {
      // 先走时钟：一次采样 = 一个 tick，重复延迟按它计。
      keys = ticked(keys);
      return { move: moveIntent(keys), dig: digIntent(keys) };
    },
    consume: (): void => {
      keys = consumed(keys);
    },
    breakHold: (): void => {
      keys = holdBroken(keys);
    },
    dispose: (): void => {
      target.removeEventListener('keydown', onKeyDown);
      target.removeEventListener('keyup', onKeyUp);
      target.removeEventListener('blur', onBlur);
    },
  };
}
