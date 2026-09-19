import type { Dir, Lift } from '../core/rules/movement';
import { TICK_HZ, type DigSide, type Intents } from '../core/sim';
import type { Surface } from '../core/types';

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
 * ## 键位含义**按面分**（用户 2026-09-19 的裁定，`moveAllowed`）
 *
 * 上面那条说"同一个方向键在 A/B 两面做同一件事"—— 那是**同一类面**（都是墙）。跨到**另一类面**
 * （甲板）就不成立了：墙面是竖直的（屏幕上只有 ←→↑↓），甲板是水平的（屏幕上正好是四个斜向）。
 *
 * 用户的原话是"我希望去除掉 awsd 的自动转换……禁止 ws 可以上下爬梯子"。落到这里就是一条：
 * **墙面上的 `w`/`s` 不是移动键** —— 那里的上下是爬梯，归 `Z`/`X`。于是"我要上去"永远只有一个
 * 答案（`Z`），不会因为在墙上就变成 `w`。（吊杆"松手"同理，现在是 `X`。）
 *
 * 判据在 `moveAllowed`；`intents()` 每 tick 收一次"玩家此刻站在哪种面"。
 *
 * ## 纯逻辑与回响分离
 *
 * 键盘状态机（`press` / `release` / `moveIntent` / `consumed`）是**纯函数**，测试直接跑它，
 * 不用起 DOM；`createInput` 只是把它接到真实事件上。
 */

/**
 * 键 → 面内方向。**按面分**（用户 2026-09-19 的裁定）。
 *
 * 一张表两个查询：`dirOfKey`（按下时查"这个键是什么方向"）与 `moveAllowed`（采样时查
 * "这个方向在这个面上有没有键"）。写成**一张表**，是为了让这两个问题不可能给出互相矛盾的答案。
 *
 * ## 为什么按面分
 *
 * 用户的原话：*"我希望去除掉 awsd 的自动转换……a 往左下，w 往左上，s 往右下，d 往右上。"*
 * 最后定为四个**屏幕斜向**：`w`↖ `e`↗ `s`↙ `d`↘。
 *
 * | 面 | 键 → 方向 |
 * |---|---|
 * | **墙面**（竖直面） | `a`/`d` = 沿走廊左右（`∓col`）；`w`/`s` = **上下**（`±row`，也就是爬梯） |
 * | **甲板**（水平面） | `w`↖ `e`↗ `s`↙ `d`↘ —— 四个键各自正对一个屏幕象限 |
 *
 * ## 两面为什么是两套（2026-09-19 用户定稿）
 *
 * 场景是**一张平面折了 90°**，而相机方位恰好 45° —— 两者同构。后果：摊平网格上的同一组方向，
 * 在两面墙上投到屏幕上**是同一个方向**（`col±1` 都水平、`row±1` 都竖直）。所以墙面上
 * `a`/`d` 天然就是"沿走廊前进/后退"，按住 `d` 能一路绕过墙角 —— **折痕对输入是透明的**。
 * （这条有测试钉着：`test/input.test.ts` 拿真实相机矩阵的右轴/上轴验。）
 *
 * 甲板是**水平面**，两个轴在这个 45° 相机下都投成 `(±0.7, ∓0.3)` —— 两个轴都很"横"，
 * 四个方向落成四个**斜向**。于是那里按"物理位置 ↔ 屏幕象限"分配：`w`/`e` 在上排 = 上面两个
 * 方向，`s`/`d` 在下排 = 下面两个方向。
 *
 * ## 丁字路口：`s` 是"拐出立面"的那个键（用户方案 A）
 *
 * 立面上遇到"走廊 ↔ 水面小道"的接口那一格时：**`a`/`d` 照旧沿墙走（路口不抢它们）**，
 * 而 **`s`（向下 / 朝屏幕前方）拐上小道**。玩家在 45° 视角下看到小道是"朝下前方伸出来的"，
 * 手指本能就是按 `s` —— 不用看说明书。
 *
 * 这不是特判，是**规则的自然结果**：接口声明的方向就是 `down`（`LevelDef.joints`），
 * 而那一格"往下"本来堵死（脚下是实心砖、不是梯子），所以 `s` 在那里没有别的意思。
 * 校验规则⑧（`jointNeverEntered`）保证这条前提对每张关卡都成立 —— 接口的方向**必须**是
 * 那一格本来就堵住的方向，否则关卡不合法。
 *
 * 方向键是 `WASD` 的**别名**（完全等价，不另立含义）：`↑`=`w`、`↓`=`s`、`→`=`d`、`←`=`a`。
 */
export const KEY_DIRS: Readonly<Record<Surface, readonly (readonly [string, Dir])[]>> = {
  wall: [
    ['a', 'left'],
    ['A', 'left'],
    ['ArrowLeft', 'left'],
    ['d', 'right'],
    ['D', 'right'],
    ['ArrowRight', 'right'],
    ['w', 'up'], // 爬梯
    ['W', 'up'],
    ['ArrowUp', 'up'],
    ['s', 'down'], // 下梯 / 吊杆松手 / 丁字路口拐上小道
    ['S', 'down'],
    ['ArrowDown', 'down'],
  ],
  deck: [
    ['w', 'left'], // ↖（-x）
    ['W', 'left'],
    ['ArrowUp', 'left'],
    ['e', 'up'], // ↗（-z）
    ['E', 'up'],
    ['s', 'down'], // ↙（+z）
    ['S', 'down'],
    ['ArrowDown', 'down'],
    ['d', 'right'], // ↘（+x）
    ['D', 'right'],
    ['ArrowRight', 'right'],
  ],
};

/** 这个键在这个面上是什么方向；没有这个键（或这个面上它不做事）就是 `null`。 */
export function dirOfKey(key: string, surface: Surface): Dir | null {
  for (const [k, dir] of KEY_DIRS[surface]) if (k === key) return dir;
  return null;
}

/**
 * 这个方向在这个面上**有没有键**。采样时用它挡掉"上个面锁存下来的方向" ——
 * 比如在甲板上按 `e`（= `up`）之后走上墙，那个 `up` 不能在墙上变成爬梯。
 */
export function moveAllowed(dir: Dir, surface: Surface): boolean {
  return KEY_DIRS[surface].some(([, d]) => d === dir);
}

/**
 * 反向查询：给 HUD 的"屏幕方向"那行显示按键名（取表里的第一个别名，也就是字母那个）。
 */
export function keyLabel(dir: Dir, surface: Surface): string {
  return KEY_DIRS[surface].find(([, d]) => d === dir)?.[0] ?? '?';
}

/** 这个键**在某个面上**是移动键吗（按下时用它筛掉不认识的键）。 */
export function isMoveKey(key: string): boolean {
  return KEY_DIRS.wall.some(([k]) => k === key) || KEY_DIRS.deck.some(([k]) => k === key);
}

/**
 * **世界上下**的键（`Z`/`X`，2026-09-19）。用户裁定：`awsd` 只控制方向、`z`/`x` 控制上下，
 * 两者不互相兼职 —— 于是"我要上塔"和"我要往前走"是两件互不干扰的事。
 *
 * 为什么不是方向键的 `↑`/`↓`：方向键在本作里是 `WASD` 的**别名**（两套都能用）。若把 `↑`
 * 拿去做升降、而 `w` 是"往北"，两套输入就**分裂**了 —— 用方向键的人会莫名其妙。
 *
 * `z` = 上（`rise`）、`x` = 下（`fall`）。想反过来只改这两行。
 */
export function liftOfKey(key: string): Lift | null {
  switch (key) {
    case 'z':
    case 'Z':
      return 'rise';
    case 'x':
    case 'X':
      return 'fall';
    default:
      return null;
  }
}

/**
 * 挖的键（T11）：**`Q` 后挖、`R` 前挖**（用户 2026-09-19 裁定）。
 *
 * "前/后"而不是"左/右"：本作是折面，同一个"左"在两面墙上指的是不同的世界方向，而"前/后"
 * 跟着**朝向**走 —— 折一下不会反过来。朝向由角色脚下的**箭头**指示（见 `render/meshSync.ts`）。
 *
 * 为什么不做成"方向键 + 修饰键"：`Intents.dig` 要的信息只有"朝哪边挖"这一件事，两个独立键
 * 表达得最直白，也不必和方向键的锁存语义纠缠（见下）。
 *
 * 键位变迁：`Z`/`X` → `Q`/`E`（挖与走同一条肌肉）→ `Q`/`R`（`E` 被甲板的 ↗ 拿走了）。
 */
export function digOfKey(key: string): DigSide | null {
  switch (key) {
    case 'q':
    case 'Q':
      return 'back';
    case 'r':
    case 'R':
      return 'front';
    default:
      return null;
  }
}

/**
 * 键盘状态。**记的是键，不是方向** —— 因为"键 → 方向"是**按面分**的（见 `KEY_DIRS`），
 * 同一个键在墙上和甲板上可以是两件事（甚至什么都不做）。把方向存进来就等于在最开始那一刻
 * 把含义钉死，之后跨过一条折痕它就变成错的了。
 *
 * `held` 按**按下顺序**排列（最后一个是最近按下的，优先于更早按下的）；
 * `latched` 是"按下过但还没被消费"的那一下。
 *
 * `digHeld`（T11）与 `held` 是**两套独立状态**：挖键不进 `held`，也不参与 `latched`。
 * 分开的理由见 `createInput` 上方那段（要命的差别在"锁存"上）。挖键记的是"前/后"（`DigSide`）,
 * 那个含义是**相对朝向**的，与面无关 —— 所以它不需要跟着面重新解释。
 */
export interface KeyState {
  readonly held: readonly string[];
  readonly latched: string | null;
  readonly digHeld: readonly DigSide[];
  /** 按着的升降键（`Z`/`X`）。与移动键一样锁存，免得轻点被冷却窗口吃掉。 */
  readonly liftHeld: Lift | null;
  readonly liftLatched: Lift | null;
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

export const NO_KEYS: KeyState = {
  held: [],
  latched: null,
  digHeld: [],
  liftHeld: null,
  liftLatched: null,
  tick: 0,
  holdArmedAt: 0,
};

/**
 * 按下（含系统的按键重复）。存的是**键名** —— 含义等到采样那一刻再按"我在哪种面"解释。
 *
 * 系统重复送来的 keydown（同一个键已经在 `held` 里）**原样返回** —— 不能重新锁存、
 * 更不能清掉重复延迟，否则"按住"会被它提前放行（那正是重复延迟要防的事）。
 */
export function press(state: KeyState, key: string): KeyState {
  if (state.held.includes(key)) return state;
  // 全新的一下：立刻兑现（走 `latched`），并且不设限 —— 之后才需要等。
  return { ...state, held: [...state.held, key], latched: key, holdArmedAt: 0 };
}

/** 松开。松手**不动** `latched` —— 那一下还没被消费，不能因为松手就丢掉。 */
export function release(state: KeyState, key: string): KeyState {
  if (!state.held.includes(key)) return state;
  return { ...state, held: state.held.filter((d) => d !== key) };
}

/**
 * 本 tick 该朝哪走：按住的话以**最近按下的**那个键为准；只点过一下则用锁存值。
 * 键 → 方向按 `surface` 解释（`dirOfKey`）—— 所以这个键**在这个面上没有含义**时给 `null`。
 *
 * **重复延迟在这里生效**：按住时若还没到 `holdArmedAt`，这一步不放行 —— 那就是"按得稍长
 * 就多走一格"的堵口。刚按下的第一步不受影响：它走 `latched`，而 `latched` 是被 `consumed`
 * 清掉之后才可能落进这条分支的。
 */
export function moveIntent(state: KeyState, surface: Surface): Dir | null {
  const lastHeld = state.held[state.held.length - 1];
  const key = lastHeld ?? state.latched;
  if (key === null || key === undefined) return null;
  if (lastHeld !== undefined && state.tick < state.holdArmedAt) return null;
  return dirOfKey(key, surface);
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
    liftLatched: null,
    holdArmedAt: fromLatch ? state.tick + REPEAT_DELAY_TICKS : 0,
  };
}

/**
 * **掐掉"按住不放"**（见 `holdBroken`）。升降键一起掐 —— 它也是"按住"。
 */
export function holdBroken(state: KeyState): KeyState {
  return { ...state, holdArmedAt: Number.POSITIVE_INFINITY, liftHeld: null };
}

/**
 * 全部放开（切标签页 / 失焦时用）。**挖键也一起放** —— 卡住的挖键比卡住方向更糟：
 * 方向卡住只是自己走，挖键卡住会一路挖穿地板。锁存值保留（那一下仍然欠玩家一步）。
 */
export function released(state: KeyState): KeyState {
  if (state.held.length === 0 && state.digHeld.length === 0 && state.liftHeld === null) return state;
  return { ...state, held: [], digHeld: [], liftHeld: null };
}

/** 按下升降键。与移动键同理**锁存**：轻点一下不该被冷却窗口吃掉。 */
export function liftPress(state: KeyState, lift: Lift): KeyState {
  return state.liftHeld === lift ? state : { ...state, liftHeld: lift, liftLatched: lift };
}

/** 松开升降键。锁存值保留（那一下仍然欠玩家）。 */
export function liftRelease(state: KeyState, lift: Lift): KeyState {
  return state.liftHeld !== lift ? state : { ...state, liftHeld: null };
}

/** 本 tick 想上升/下降；没按就是 `null`。 */
export function liftIntent(state: KeyState): Lift | null {
  return state.liftHeld ?? state.liftLatched;
}

/** 按下挖键（T11）。与 `press` 分开：挖键不进 `held`，也不写 `latched`。 */
export function digPress(state: KeyState, side: DigSide): KeyState {
  return state.digHeld.includes(side) ? state : { ...state, digHeld: [...state.digHeld, side] };
}

/** 松开挖键。松手即失效 —— 挖**没有**锁存（理由见 `createInput` 上方那段）。 */
export function digRelease(state: KeyState, side: DigSide): KeyState {
  return state.digHeld.includes(side)
    ? { ...state, digHeld: state.digHeld.filter((d) => d !== side) }
    : state;
}

/** 本 tick 想往哪挖；两个都按住时**最近按下的**优先。没按就是 `null`。 */
export function digIntent(state: KeyState): DigSide | null {
  return state.digHeld[state.digHeld.length - 1] ?? null;
}

export interface Input {
  /**
   * 每个 sim tick 调一次 —— 输入是**电平**，不是边沿。
   *
   * 不用传"我在哪种面"：那是 `createInput` 的 `at` 回调（与按下时用的是**同一个**回调，
   * 于是不可能出现"按下按 A 面、采样按 B 面"的自相矛盾）。
   */
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
 *
 * ## `at`：为什么"我在哪种面"是个**回调**
 *
 * 键 → 方向是**按面分**的（见 `KEY_DIRS`），所以每次**采样**都要知道"我在墙上还是甲板上"。
 * 状态机存的是**键名**（`KeyState.held`），含义在采样那一刻才解释 —— 存方向就等于在按下那一刻
 * 把它钉死，跨过一条折痕之后那个方向就是错的了。
 *
 * 做成回调而不是采样时传参：调用方（`main.ts`）给的实现是 `surfaceOf(player.cell)` ——
 * 那是"我在哪种面"的唯一出处，输入层不必自己去问 sim。
 */
export function createInput(target: Window = window, at: () => Surface = () => 'wall'): Input {
  let keys = NO_KEYS;

  const onKeyDown = (e: KeyboardEvent): void => {
    const lift = liftOfKey(e.key);
    if (lift !== null) {
      e.preventDefault();
      keys = liftPress(keys, lift);
      return;
    }
    const dig = digOfKey(e.key);
    if (dig !== null) {
      e.preventDefault();
      keys = digPress(keys, dig);
      return;
    }
    // 移动键存的是**键名**，含义等采样时按面解释 —— 所以这里只问"它是不是一个移动键"，
    // 不问"它在这个面上是什么方向"（那正是不能在这一层回答的问题）。
    if (!isMoveKey(e.key)) return;
    e.preventDefault(); // 方向键默认会滚页面
    keys = press(keys, e.key);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    const lift = liftOfKey(e.key);
    if (lift !== null) {
      keys = liftRelease(keys, lift);
      return;
    }
    const dig = digOfKey(e.key);
    if (dig !== null) {
      keys = digRelease(keys, dig);
      return;
    }
    keys = release(keys, e.key); // 不在 `held` 里就是空操作
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
      const dig = digIntent(keys);
      const lift = liftIntent(keys);
      const surface = at();
      const move = moveIntent(keys, surface);
      if (move === null && keys.latched !== null && dirOfKey(keys.latched, surface) === null) {
        // 这一下**在当前面上没有对应的键**（在墙上按 `w`、或在甲板上按 `a`）→ 当它没按过、别欠着，
        // 否则换个面之后它会被兑现成一步玩家没想要的走法。
        // `held` 不动：真按着不放的人，走回那个面时这个键就重新有含义了。
        keys = { ...keys, latched: null };
      }
      return { move, dig, lift };
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
