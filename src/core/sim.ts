import { cellKey, type Cell } from './types';
import { decideDrone } from './ai/drone';
import type { DeckCell, DeckJoint } from './world/deck';
import { faceOf } from './world/fold';
import {
  applyBackfill,
  applyDig,
  DIG_BACKFILL_TICKS,
  fillDrain,
  indexToColRow,
  type PendingFill,
} from './rules/dig';
import { drownPath, type DrownPath } from './rules/drown';
import { openGates, treasureAt, withoutTreasure } from './rules/goals';
import { fallTo, stateAt, step, type Dir, type FallEnd, type MoveMode } from './rules/movement';
import { supportOf } from './world/graph';
import { parseLevel, type Level, type LevelDef, type TileKind } from './world/tiles';
import { isWater } from './world/water';

/**
 * 固定步长模拟：(state, intents) → (state', events[])。
 *
 * ## 三条硬约束
 *
 * 1. **纯函数 + 定步长**。没有 `Date.now()`、没有 `Math.random()`，一切随机性将来都要走显式种子。
 *    所以"同一份 state + 同一串 intents"必然得到同一串帧 —— 这是 T4 的验收（脚本回放一致），
 *    也是 AI 剧本（T12/T15）、通关脚本（T13/T14）能当回归用的前提。
 * 2. **state 是纯数据**。`Level` 带一个闭包 `at()`，闭包不能 JSON 序列化，所以这里不存 `Level`，
 *    而是把它的**裸网格**拷进 state，用 `viewOf()` 临时拼一个查询视图出来。
 *    好处：存盘 / 回放比对 / 断线续玩都只是 `JSON.stringify(state)`。
 *    T11 的挖与回填要改瓦片 —— 那时**复制** `grid` 再改，保持每帧 state 不共享可变数组。
 * 3. **渲染只读 state + events**（架构文档 §三 红线）。本文件不碰 three、也不产生任何渲染概念；
 *    `MOVE_TICKS` 这类数值是**玩法**节奏，视觉平滑（0.15s tween）归 T6。
 *
 * ## 节奏与手感
 *
 * `MOVE_TICKS` 是"走一格要几个 tick"，也就是玩家一秒钟能走几格 —— 这是**唯一**的手感数字，
 * T-SP1 试玩时先调它。撞墙 / 松手**不消耗**步进冷却：否则"贴着墙按方向"再转身会有莫名迟滞。
 *
 * > 给 T7 的接口提醒：输入是**每 tick 采样的电平**（按住=持续有效），不是边沿。
 * > 一次短于 `MOVE_TICKS` 的轻点若恰好落在冷却窗口里就会被漏掉 —— T7 需要把"最近一次的按键方向"
 * > 锁存到下一次能动为止。core 故意不做锁存：那是输入层的事，放进 reducer 会污染回放语义。
 *
 * ## 死亡与重生（T9）
 *
 * 落水**不是终局**，它先扣命、再重生：`lives` 减一 → 实体回出生点、冻 `RESPAWN_TICKS`；
 * 扣到 0 才 `status: 'dead'`。结算写在 `tick` 里而不是 `advance` 里，理由见 `advance` 的注释。
 */

export const TICK_HZ = 60;

/** 走一格需要几个 tick。手感参数，先给 8（7.5 格/秒，接近原版的节奏）。 */
export const MOVE_TICKS = 8;

/** 玩家的命数（T9 的扣命结算 / T13 的 3 命）。落水扣一条，扣到 0 才算真死。 */
export const PLAYER_LIVES = 3;

/**
 * 落水之后在出生点冻几个 tick 才能再动。
 *
 * 为什么不是"立刻原地复活"：**死亡要看得见**。一个 tick 内扣命 + 传送回去，
 * 玩家只会看到"我瞬移了"，看不到自己死过 —— 而 T20 的落水涟漪与死亡反馈正要挂在那一刻。
 * 复用 `cooldown` 表达这段冻结，不引入新的实体状态机（它本来就表示"还要等几个 tick 才能动"）。
 *
 * 30 tick = 半秒：够看清，又不至于让人等。
 */
export const RESPAWN_TICKS = 30;

/**
 * 敌人**倒下**（溺水 / 被埋）到站起来要几个 tick（T12-d）。
 *
 * §八-2 的裁定是"溺水后**延时重生**"，理由写在决议里："保留追击压迫感，不白送玩家"。
 * 取 1 秒（60）：短到不拖节奏，长到玩家看得见"它倒下了、还没回来"。
 */
export const ENEMY_DOWN_TICKS = 60;

/** 实体种类。T12 加 `drone`、T15 加 `stalker` —— 那时只需在这里加一格并补上它的决策函数。 */
export type EntityKind = 'player' | 'drone';

export interface Entity {
  readonly id: number;
  readonly kind: EntityKind;
  readonly cell: Cell;
  /** 停驻方式：砖面/梯是 `stand`，横杆是 `hang`（见 rules/movement.ts）。 */
  readonly mode: MoveMode;
  /** 还要等几个 tick 才能再动一格。0 = 本 tick 可以动。重生冻结也走这个。 */
  readonly cooldown: number;
  /**
   * 重生点。玩家的是 `createSim` 的 `spawn` 参数；敌人的是关卡声明的出生格。
   *
   * **为什么要挂在实体上**：§八-2 裁定敌人"溺水后延时重生"，每个实体都得知道自己回哪儿 ——
   * 一个整局的字段表达不了"N 个敌人各自的重生点"。所以玩家的 `spawn` 也不再单独存一份
   * （同一个事实存两处必然漂）。
   */
  readonly home: Cell;
  /**
   * 正在朝哪走。**移动成立后**才更新（撞墙不算）。
   *
   * 为什么现在就进实体：① 无人机的巡逻要"尽量直走、撞墙才转弯"——否则每个 tick 重新决策
   * 会让它在原地发抖；② 玩家的朝向本来就是 T7/§八-4 要的东西（过折痕转 90°），
   * 先在这里落一个字段，免得将来再改一次实体形状。
   */
  readonly facing: Dir;
  /**
   * 还要倒几个 tick 才站起来（T12-d）。`0` = 站着、能动。
   *
   * 只有**敌人**会用到它：§八-2 裁定的"溺水/被埋后延时重生"。这段时间它既不动、
   * 也不参与接触判定（尸体不撞人），到期由 `advance` 的倒计时送回 `home`。
   *
   * 玩家**不走**这条路：玩家的死亡反馈要的是"立刻回到起点"（扣命 → 重生 → 冻结
   * `RESPAWN_TICKS`），而不是躺着等一秒。两者是不同的设计意图，共用一个字段只会把语义搅浑。
   */
  readonly down: number;
}

/**
 * 这一局的结局。`won` 与 `dead` 一样是**终局**：`tick` 开头那条 early-return 一并覆盖它
 * （冻住实体、继续走时钟），所以过关之后不需要任何额外的冻结逻辑。
 */
export type SimStatus = 'playing' | 'dead' | 'won';

/** 全部是纯数据 —— 只有这样才能 `JSON.stringify` 存盘、并在回放里逐字节比对。 */
export interface SimState {
  readonly tick: number;
  readonly levelId: string;
  readonly fold: number;
  readonly cols: number;
  readonly rows: number;
  /** 行主序，长度 cols×rows。T11 的挖/回填会把它换成一份改过的副本。 */
  readonly grid: readonly TileKind[];
  /**
   * 已经挖开、还在等长回来的坑（T11）。
   *
   * **进 state 而不是存在别处的理由**：它是**玩法状态**，不是渲染缓存 —— 一个坑还剩几个
   * tick 会直接影响"敌人会不会掉进来"，所以它必须参与 `replay()` 的逐字节比对。
   * 存在 `Level` 上是不行的（那是静态地形），存在模块级变量里更不行（`replay()` 会串味）。
   */
  readonly fills: readonly PendingFill[];
  /**
   * 甲板（岛台）格，以及它到墙的接头（T10）。
   *
   * **必须在 state 里**，理由与 `spawn` 完全相同：`tick(prev, intents)` 要自足，
   * 而 `viewOf()` 是**从 state 重建 `Level`** 的。甲板如果只留在 `LevelDef` 上，
   * 运行时 `buildGraph(viewOf(state))` 就看不见岛台 —— 小道尽头会直接变成"站不住"。
   */
  readonly deck: readonly DeckCell[];
  readonly joints: readonly DeckJoint[];
  /**
   * 出口闸门（T13）。与 `deck`/`joints` 同一条理由进 state：`viewOf()` 要从 state **重建** `Level`，
   * 而 `goals` 开闸与 `validate` 校验都从 `Level` 读闸门 —— 漏了这一个字段，
   * 运行时"开闸"就没有对象可开（编译器会在这里直接报出来，别绕过去）。
   */
  readonly gates: readonly Cell[];
  /** 待取的宝物（T13，甲板格）。和 `gates` 一样进 state 是为了让 `viewOf()` 能重建出 `Level`。 */
  readonly treasures: readonly DeckCell[];
  /**
   * 出口闸门开过了没有（T13）。
   *
   * **为什么需要这个布尔量，而不能从"宝物空了"现推**：开闸是**一次性转移**（要重写 `grid`），
   * 而 `tick` 的末尾要返回新 state —— 没有这个标记的话，每个 tick 都会重新跑一遍
   * `openGates` 与"刚开闸"的判断，`opened` 事件会被反复报。它也让"已开闸"参与
   * `replay()` 的逐字节比对（否则回放两次得到的事件流会不一样）。
   */
  readonly gatesOpen: boolean;
  readonly status: SimStatus;
  /**
   * 玩家还剩几条命。落水扣一条，扣到 0 → `status` 变 `dead`。
   *
   * 为什么命数挂在 **state 上**而不是 `Entity` 上：现在只有玩家一个实体，而
   * "玩家没命了 = 这一局结束"是关于**这一局**的判断，不是某个角色的属性。
   * T12/T15 的敌人各有各的结局（被打掉 / 掉水里），不该共用这个字段 —— 到那时在
   * `Entity` 上另开一格，而不是把这里的语义撑成"通用血量"。
   */
  readonly lives: number;
  /**
   * 出生点这个字段**没有**了：重生点搬到了 `Entity.home`（T12-a）。
   *
   * 当年它进 state 的理由是对的 —— "`tick(prev, intents)` 必须自足，能不能重生不能取决于
   * 谁在调用"。但 T12 的敌人各自有重生点之后，一个整局的 `spawn` 表达不了这件事，
   * 而"玩家的重生点"与"N 个敌人的重生点"本来就是同一类事实，应该存在同一个地方。
   * 所以 `tick` 的重生一律读 `victim.home` —— 自足性没有任何损失。
   */
  /** 玩家的固定 id（`entities[0]`）。敌人的 id 从 1 起。 */
  readonly entities: readonly Entity[];
}

/**
 * 一个 tick 的玩家意图。这是**输入层与 core 的唯一接口**。
 *
 * `dig` 从 T11 起有人消费了：非 `null` 就表示"本 tick 想朝这个方向挖"。
 * 与 `move` 一样是**电平**（按住 = 持续想挖）—— `applyDig` 对已经挖空的格子返回 `null`，
 * 所以按住不放不会重复触发，不需要在这里做边沿检测。
 */
export interface Intents {
  readonly move: Dir | null;
  readonly dig: Dir | null;
}

export const NO_INTENTS: Intents = { move: null, dig: null };

/**
 * 本 tick 发生的**状态变化**（不是每 tick 都有的噪声）。
 * 撞墙不报事件：想给玩家"为什么动不了"的反馈，直接问 `step()` 就行，
 * 每 tick 往事件流里灌一条 blocked 只会把真正重要的事件淹掉（渲染那边是要读这个流的）。
 */
export type SimEvent =
  | { readonly kind: 'entered'; readonly entity: number; readonly from: Cell; readonly cell: Cell }
  | { readonly kind: 'fell'; readonly entity: number; readonly from: Cell; readonly cell: Cell }
  /**
   * 落水（T9）。带上**途径**与**哪一列**：
   * 途径①是"没看清地形"，途径②是"自己松的手"，T20 的涟漪特效与 T13 的通关脚本都要分开它们。
   */
  | { readonly kind: 'drowned'; readonly entity: number; readonly cell: Cell; readonly path: DrownPath }
  /**
   * 被无人机抓住（T12-c）。用户裁定"**接触即死**"= 原版守卫行为。
   *
   * 单独一条事件而不复用 `drowned`：反馈完全不同（被抓 vs 落水），T20 要分开播；
   * 而且 `by`（谁抓的）是 AI 统计（T19）与将来的击杀反馈要用的。
   */
  | { readonly kind: 'caught'; readonly entity: number; readonly by: number; readonly cell: Cell }
  /** 扣命之后回到出生点。`lives` 是**扣完之后**的剩余命数。 */
  | { readonly kind: 'respawned'; readonly entity: number; readonly cell: Cell; readonly lives: number }
  /**
   * 敌人被**重置回它的家**（T12-c：玩家死亡时追捕重置）。
   *
   * 为什么单开一条而不是复用 `respawned`：`respawned.lives` 是**玩家的剩余命数**，
   * 挂在敌人身上没有意义（语义会立刻变味）。渲染那边两条都当"瞬移"处理。
   */
  | { readonly kind: 'returned'; readonly entity: number; readonly cell: Cell }
  /**
   * 敌人倒下了（T12-d）：溺水或被埋之后，先在地上躺 `ENEMY_DOWN_TICKS`，再回 `home`。
   *
   * 死因本身另有事件（`drowned` / `buried`）—— 这条只说"它现在倒了"，供渲染层做倒地表现。
   */
  | { readonly kind: 'downed'; readonly entity: number; readonly cell: Cell }
  /** 命数归零，这一局结束。 */
  | { readonly kind: 'gameover' }
  /**
   * 挖开了一格（T11）。`cell` 是被挖掉的那一格（**斜下方**那块砖，不是脚下）。
   * 渲染层靠它把那一格从砖改成坑。
   */
  | { readonly kind: 'dug'; readonly entity: number; readonly cell: Cell }
  /** 洞自己长回来了（T11）。`cell` 是长回砖的那一格。 */
  | { readonly kind: 'filled'; readonly cell: Cell }
  /**
   * 被埋（T11）。回填的那一刻，有角色正在坑里。
   *
   * 与原版一致：**坑合上时人还在里面就死**。单独一个事件而不是复用 `drowned` ——
   * 它们的反馈完全不同（水花 vs 土块落下），T20 要分开播。
   */
  | { readonly kind: 'buried'; readonly entity: number; readonly cell: Cell }
  /** 踩到并取走了一块宝物（T13）。`cell` 是那一格（甲板格，面 `'I'`）。 */
  | { readonly kind: 'collected'; readonly entity: number; readonly cell: Cell }
  /**
   * 集齐宝物、闸门开启（T13）。**一次性**事件。
   *
   * 不带 `cell`：闸门是一组格子（本关 4 块），逐个列出没有意义；渲染层收到这条就重画整个网格
   * （`setGrid` 走引用比较，本来就只认"网格换了"这一件事）。
   */
  | { readonly kind: 'opened' }
  /** 触达已开启的出口，过关（T13）。终局事件，出现即 `status: 'won'`。 */
  | { readonly kind: 'won' };

export interface SimFrame {
  readonly state: SimState;
  readonly events: readonly SimEvent[];
}

/** 把纯数据的 state 拼成一个 `Level` 查询视图（`grid` 是唯一真相，`at` 只是它的窗口）。 */
export function viewOf(state: SimState): Level {
  const { cols, rows, grid } = state;
  return {
    id: state.levelId,
    name: state.levelId,
    fold: state.fold,
    cols,
    rows,
    grid,
    at: (col, row) => (col < 0 || col >= cols || row < 0 || row >= rows ? undefined : grid[row * cols + col]),
    deck: state.deck,
    joints: state.joints,
    gates: state.gates,
    treasures: state.treasures,
  };
}

/**
 * 把关卡声明的敌人建成实体（T12-a）。出生格必须真的站得住 —— 与玩家出生点同一条判据：
 * 站不住的出生格会让它在第一 tick 就开始坠落，那是关卡 bug，不该被静默吞掉。
 *
 * id 从 **1** 起（玩家固定是 0），因为 `casualty.entity` / 回放 / 渲染都按 id 认人。
 */
function spawnEnemies(level: Level, def: LevelDef): readonly Entity[] {
  return (def.enemies ?? []).map((enemy, index) => {
    const at = stateAt(level, enemy.cell);
    if (at === null) {
      throw new Error(
        `关卡 ${level.id} 的敌人 #${index}（${enemy.kind}）出生格 ${describeCell(enemy.cell)} 停不住`,
      );
    }
    return {
      id: index + 1,
      kind: enemy.kind,
      cell: at.cell,
      mode: at.mode,
      home: at.cell,
      facing: enemy.facing ?? 'right',
      cooldown: 0,
      down: 0,
    };
  });
}

/**
 * 从关卡定义与出生点建初态。关卡必须先通过 `parseLevel`（数据不合法就没有模拟可言），
 * 出生点必须真的站得住 —— 否则第一 tick 就会开始坠落，那是关卡 bug，不该被静默吞掉。
 */
export function createSim(def: LevelDef, spawn: Cell, lives: number = PLAYER_LIVES): SimState {
  const parsed = parseLevel(def);
  if (!parsed.ok) {
    throw new Error(`关卡 ${def.id} 数据不合法：${JSON.stringify(parsed.errors)}`);
  }
  const level = parsed.level;
  const at = stateAt(level, spawn);
  if (at === null) {
    throw new Error(`关卡 ${def.id} 的出生点 ${describeCell(spawn)} 停不住（坑里 / 墙里 / 越界）`);
  }

  return {
    tick: 0,
    levelId: level.id,
    fold: level.fold,
    // 甲板与接头是**这一关的静态地形**，整局不变（T11 挖洞只动 grid），所以直接引用即可。
    deck: level.deck,
    joints: level.joints,
    gates: level.gates,
    treasures: level.treasures,
    cols: level.cols,
    rows: level.rows,
    grid: level.grid,
    // 开局没有任何坑 —— 坑只能由 `tick` 里的挖产生，不存在于关卡数据里。
    fills: [],
    status: 'playing',
    // 开局闸门是关着的（T13）。它由"集齐宝物"打开，不由关卡数据预置。
    gatesOpen: false,
    lives,
    entities: [
      {
        id: 0,
        kind: 'player',
        // 存**规范化之后**的格子（`at.cell`）而不是入参 `spawn`：入参可能带着不一致的 face
        // （比如 `face: 'B'` 但 col 落在 A 半区），而 `stateAt` 给的是这一格真正的身份。
        // 重生点必须是"验证过站得住的那一个"，不能是"调用方写的那一个"。
        cell: at.cell,
        mode: at.mode,
        home: at.cell,
        // 开局朝右。朝向的表现（过折痕转 90°）是 T7/§八-4 的事，这里只落字段。
        facing: 'right',
        cooldown: 0,
        down: 0,
      },
      ...spawnEnemies(level, def),
    ],
  };
}

/** 报错信息里的格子写法，和 `cellKey` 一致（便于对着日志找）。 */
function describeCell(c: Cell): string {
  return `${c.face}:${c.col},${c.row}`;
}

/**
 * 推进实体时它需要知道的**世界上下文**。
 *
 * 目前只有一件事：**玩家在哪**（无人机的追击段要问它）。刻意**不把整个 `SimState`
 * 传下去** —— `advance` 只该知道"动一步需要什么"，把整局状态递给它等于把"谁都能读所有东西"
 * 变成默认。上下文接口小，才看得清依赖。
 *
 * 取的是**本 tick 开始时**的玩家位置（`prev.entities`），于是结果与实体遍历顺序无关 ——
 * 顺序依赖是回放里最难查的一类 bug。
 */
interface AdvanceContext {
  readonly playerCell: Cell | null;
  /**
   * 还在等回填的坑（T11）的格键集合 —— "**落坑受困**"（T12-c）要问它。
   *
   * 为什么由外面算好递进来、而不是在这里读 `SimState`：`advance` 只该知道"动一步需要什么"，
   * 而这个集合是从 `fills` 推出来的**同一份事实**（回填到期的判据也在用它）——
   * 两处各推一遍就会漂成"回填说坑没了、AI 说还在坑里"。
   */
  readonly pits: ReadonlySet<string>;
  /**
   * 本 tick 已经**被埋**的实体 id（① 里判出来的）。
   *
   * 它们这一 tick 不再参与移动：那格已经变回砖，`supportOf` 会算出 null，于是 ③ 会让它
   * **再坠一次、再溺一次水** —— 事件流变成"被埋 → 溺水 → 倒下"这种连死两次的荒唐样子
   * （T12-d 的用例抓到的）。被埋就是这一 tick 的死因，不再接受第二次判定。
   */
  readonly buried: ReadonlySet<number>;
}

/**
 * 这个实体本 tick 想往哪走。
 *
 * 玩家取输入方向；无人机交给 `ai/drone.ts`（巡逻段 + 追击段，用户裁定）。
 * 这里只做**接线**：把"等级 + 它在哪 + 玩家在哪"喂过去，决策本身全在那个模块里。
 */
function decide(entity: Entity, intents: Intents, level: Level, ctx: AdvanceContext): Dir | null {
  if (entity.kind === 'player') return intents.move;
  // **落坑受困**（T12-c，原版守卫的"落坑受困"）：站在坑里就别想动 —— 直到土长回来把它埋掉。
  // 这不是冷却（冷却到期后是**原地继续走**），而是"被困住"：判据是脚下的格还是不是坑。
  if (ctx.pits.has(cellKey(entity.cell))) return null;
  return decideDrone({
    level,
    at: { cell: entity.cell, mode: entity.mode },
    facing: entity.facing,
    playerCell: ctx.playerCell,
  });
}

/**
 * 推进一个实体一个 tick。会往 `events` 里追加本 tick 发生的事。
 *
 * **落水只报事件，不动实体。** 扣命与重生在 `tick` 里结算 —— 因为那是关于**整局**的判断
 * （"还剩几条命""这一局是不是结束了"），不是单体移动的一部分。混进来的话，
 * 将来加敌人时会变成"某个无人机掉水里把玩家传回了出生点"这种荒唐事。
 */
function advance(
  level: Level,
  entity: Entity,
  intents: Intents,
  ctx: AdvanceContext,
  events: SimEvent[],
): Entity {
  // 倒地倒计时（T12-d）：数到 0 就回 `home`。
  // 用 `returned` 而不是 `respawned` —— 与"玩家死亡时追捕重置"同一条事件，于是渲染层的
  // **瞬移**逻辑（`main.ts` 的 snap 集合）自动覆盖它：否则尸体会从倒下处滑过整张地图回家。
  if (entity.down > 1) return { ...entity, down: entity.down - 1 };
  if (entity.down === 1) {
    const home = stateAt(level, entity.home);
    events.push({ kind: 'returned', entity: entity.id, cell: entity.home });
    return { ...entity, down: 0, cell: entity.home, mode: home?.mode ?? entity.mode, cooldown: 0 };
  }

  // 本 tick 已被埋：死因已定，不再接受移动/坠落判定（见 `AdvanceContext.buried`）。
  if (ctx.buried.has(entity.id)) return entity;

  if (entity.cooldown > 0) return { ...entity, cooldown: entity.cooldown - 1 };

  // **脚下的支撑没了就立刻开始坠** —— 在决定方向**之前**判。
  //
  // 不能只靠 `step` 内部那条同样的自检：`decide` 返回 `null` 时（玩家没按键、无人机被困在坑里、
  // 敌人还没想好）根本走不到 `step` 那一步，于是"支撑被挖掉"会表现成**人悬在空中站着**。
  // 这条是被 T12-d 的用例抓出来的（把无人机脚下的砖改成空，它却一动不动、一个事件都不报）。
  if (supportOf(level, entity.cell) === null) {
    return settleFall(level, entity, fallTo(level, entity.cell), 'fall', events);
  }

  const dir = decide(entity, intents, level, ctx);
  if (dir === null) return entity; // 站着不动：不进入冷却，下一 tick 按方向立刻起步

  const result = step(level, { cell: entity.cell, mode: entity.mode }, dir);

  switch (result.kind) {
    case 'blocked':
      // 撞墙/走不出去不算"动过一次"：不消耗冷却，所以贴着墙按住再转身没有迟滞。
      return entity;

    case 'move':
      events.push({
        kind: 'entered',
        entity: entity.id,
        from: entity.cell,
        cell: result.state.cell,
      });
      return {
        ...entity,
        cell: result.state.cell,
        mode: result.state.mode,
        // 移动成立才算"朝这边走"：撞墙不更新（否则贴着墙按住会把朝向刷成墙的方向）。
        facing: dir,
        cooldown: MOVE_TICKS - 1,
      };

    case 'fall':
      // 落水 / 落住的结算只有一份实现（`settleFall`）—— 上面"支撑没了立刻坠"那条也走它，
      // 两处各写一遍必然漂（一处报 `drowned`、另一处忘了报，是这类 bug 的经典形状）。
      return settleFall(level, entity, result.end, drownPath(entity.mode, dir), events);
  }
}

/**
 * 坠落的结算：落水只报事件（扣命/重生归 `tick` 管），落住了就更新格子并进入冷却。
 *
 * `path` 由调用方给：站着走空是 `fall`，吊在杆上按"下"松手是 `bar-release` ——
 * 这个区分只有在"动作发生前的状态"里才看得出（见 `rules/drown.ts` 的文件头）。
 */
function settleFall(
  level: Level,
  entity: Entity,
  end: FallEnd,
  path: DrownPath,
  events: SimEvent[],
): Entity {
  if (isWater(end)) {
    // `isWater` 是**类型谓词**：这个分支之后 `end` 一定收窄成 `landed`，读 `.cell` 不需要断言。
    events.push({ kind: 'drowned', entity: entity.id, cell: end.from, path });
    return entity;
  }
  const landed = stateAt(level, end.cell);
  events.push({ kind: 'fell', entity: entity.id, from: entity.cell, cell: end.cell });
  return {
    ...entity,
    cell: end.cell,
    mode: landed === null ? entity.mode : landed.mode,
    cooldown: MOVE_TICKS - 1,
  };
}

/** 有没有实体正好站在这一格上。列行**必须连面一起比**：甲板格（面 `'I'`）与墙面格可以有相同的列行数字。 */
function occupantOf(
  entities: readonly Entity[],
  face: Cell['face'],
  col: number,
  row: number,
): Entity | undefined {
  return entities.find((e) => e.cell.face === face && e.cell.col === col && e.cell.row === row);
}

/**
 * 推进**一个**坑的倒计时，并在到期时让它长回来。返回更新后的网格与待回填记录。
 *
 * 为什么倒计时（`remaining`）而不是到期时刻（`at`）：**坑被占住时要加速**（`fillDrain`），
 * 而"有没有人站在坑里"每 tick 都在变 —— 绝对时刻只在登记时算得了一次（见 `dig.ts`）。
 */
function tickFill(
  fill: PendingFill,
  grid: readonly TileKind[],
  entities: readonly Entity[],
  cols: number,
  fold: number,
  events: SimEvent[],
): { grid: readonly TileKind[]; fill: PendingFill | null } {
  const { col, row } = indexToColRow(fill.index, cols);
  const face = faceOf(col, fold);

  // 「谁在坑里」同时决定**加速**与**被埋** —— 这两件事在原型里本来就是同一个条件
  // （`legacy/canyon.html:125-129` 用的是同一个 `player.x===o.x && player.y===o.y`），
  // 所以这里只查一次，免得两处判断将来漂开。
  const occupant = occupantOf(entities, face, col, row);

  const remaining = fill.remaining - fillDrain(occupant !== undefined);
  if (remaining > 0) return { grid, fill: { index: fill.index, remaining } };

  // 到期。坑里有人就是**活埋** —— 原版语义：土落下来的时候人还在里面，就死。
  if (occupant !== undefined) {
    events.push({ kind: 'buried', entity: occupant.id, cell: occupant.cell });
  }

  // 无论坑里有没有人，土都照落。占住的那一位交给 `tick` 末尾的结算挪走（重生）。
  // 反过来做（有人就不填、下 tick 再试）会让一个**不重生**的占住者（T12 的敌人）
  // 把这个坑永远卡在"待回填"里 —— 每个 tick 报一次活埋，永不停。
  const next = applyBackfill(grid, fill.index);
  events.push({ kind: 'filled', cell: { face, col, row } });
  return { grid: next, fill: null };
}

/**
 * 一帧。纯函数：同一个 (state, intents) 永远给同一帧。
 *
 * 一个 tick 里的顺序是**规则的一部分**，不是实现细节：
 * ① 回填 → ② 挖 → ③ 移动 → ④ 结算。理由逐条写在下面。
 */
export function tick(prev: SimState, intents: Intents): SimFrame {
  const nextTick = prev.tick + 1;

  // 一局结束就冻住实体，但**继续走时钟** —— 时钟是回放与限时判定（T13）的基准，
  // 不能因为一次死亡就停摆（否则同一份脚本会算出不同的 tick 数）。
  if (prev.status !== 'playing') {
    return { state: { ...prev, tick: nextTick }, events: [] };
  }

  const events: SimEvent[] = [];

  // ── ① 回填（T11）──
  // 排在移动**之前**：判定"谁踩在坑口上 / 谁在坑里"用的是上一 tick 结束时的站位，
  // 这样"走进去 → 正好合上 → 被埋"这条链是确定的，不取决于同 tick 内的先后。
  let grid: readonly TileKind[] = prev.grid;
  const fills: PendingFill[] = [];
  for (const fill of prev.fills) {
    const stepped = tickFill(fill, grid, prev.entities, prev.cols, prev.fold, events);
    grid = stepped.grid;
    if (stepped.fill !== null) fills.push(stepped.fill);
  }

  // ── ② 挖（T11）──
  // 排在移动**之前**：这一 tick 挖开的洞，同 tick 的移动就该看得见，否则
  // "挖了顺势跳下去"会比预期慢一帧。冷却中不许挖 —— 挖是一个**动作**，不是站姿。
  const digger = prev.entities.find((e) => e.kind === 'player' && e.cooldown === 0);
  if (digger !== undefined && intents.dig !== null) {
    const dug = applyDig(viewOf({ ...prev, grid }), digger.cell, intents.dig);
    if (dug !== null) {
      grid = dug.grid;
      fills.push({ index: dug.index, remaining: DIG_BACKFILL_TICKS });
      events.push({ kind: 'dug', entity: digger.id, cell: dug.cell });
    }
  }

  // ── ③ 移动 ──
  // `level` 用 ② 之后的 grid 重建：移动必须看见刚挖出来的坑。
  const level = viewOf({ ...prev, grid });
  // 无人机的追击要问"玩家在哪"。取**本 tick 开始时**的位置（`prev.entities`），
  // 于是与实体遍历顺序无关 —— 顺序依赖是回放里最难查的一类 bug。
  const player = prev.entities.find((e) => e.kind === 'player');
  // 坑的格键集合：由**最终**的 `fills`（①回填 + ②新挖之后）推出来，与回填到期的判据同源。
  const pits = new Set(
    fills.map((fill) => {
      const { col, row } = indexToColRow(fill.index, prev.cols);
      return cellKey({ face: faceOf(col, prev.fold), col, row });
    }),
  );
  // ①里已经"被埋"的实体，本 tick 不再参与移动（见 `AdvanceContext.buried`）。
  const buriedIds = new Set(
    events.filter((e) => e.kind === 'buried').map((e) => e.entity),
  );
  const ctx: AdvanceContext = { playerCell: player?.cell ?? null, pits, buried: buriedIds };
  const entities: Entity[] = [];
  for (const entity of prev.entities) {
    entities.push(advance(level, entity, intents, ctx, events));
  }

  // ── ④ 采宝 → 开闸 → 过关（T13）──
  //
  // **顺序是规则**：先看有没有踩到宝物，再据此决定开不开闸，最后才判过关。
  // 反过来（先判过关再开闸）会漏掉"同一 tick 里捡到最后一颗、又正好站在出口上"的那种帧 ——
  // 那一 tick 闸门还没开，判定就写不成。
  //
  // 采宝排在**移动之后**：宝是走到的结果，不是主动动作（与挖不同 —— 挖是按键意图）。
  let treasures: readonly DeckCell[] = prev.treasures;
  let gatesOpen = prev.gatesOpen;
  const walker = entities.find((e) => e.kind === 'player');

  if (walker !== undefined) {
    const hit = treasureAt(treasures, walker.cell);
    if (hit !== undefined) {
      treasures = withoutTreasure(treasures, hit);
      events.push({ kind: 'collected', entity: walker.id, cell: walker.cell });

      // 开闸**只在"取走最后一块"这一刻**触发 —— 判据挂在**采集动作**上，而不是每 tick 去看
      // "列表空了没"。差别在**没有宝物的关卡**上：那时 `treasures.length === 0` 从第 1 tick
      // 起就成立，闸门会在玩家什么都还没做时"开"掉，`opened` 也成了开局噪声。
      // （那种关卡本身也是坏的：声明了闸门却没有宝物，`exitGated` 会报"开了还到不了"。）
      if (!gatesOpen && treasures.length === 0) {
        grid = openGates(grid, prev.gates, prev.cols);
        gatesOpen = true;
        events.push({ kind: 'opened' });
      }
    }

    // 过关只看"闸门已开"这一个条件，不再重复问"宝物集齐没"：`gatesOpen` 就是它的等价状态，
    // 而"未开闸时站在出口上"这件事本身不该发生（`validateLevel` 的 `exitGated` 保证了
    // 那个出口在那个时刻**根本走不到**）。多重条件在这里只会给"哪天绕过了校验"留后门。
    //
    // 面守卫是必须的：`level.at` 收的是墙的 `(col, row)`，拿甲板格去查会查错格子
    // （与 `treasureAt` 里那条是同一条理由）。
    const onExit = walker.cell.face !== 'I' && level.at(walker.cell.col, walker.cell.row) === 'exit';
    if (gatesOpen && onExit) {
      events.push({ kind: 'won' });
      return {
        state: {
          ...prev,
          tick: nextTick,
          grid,
          fills,
          entities,
          treasures,
          gatesOpen,
          status: 'won',
        },
        events,
      };
    }
  }

  // ── ⑤ 结算：被抓 / 落水 / 活埋 ──
  //
  // 一次只结一个：同一 tick 里又落水又被埋在物理上要求同一个人占两个格，不可能。
  // `buried` 在 ① 里入列、`drowned` 在 ③ 里入列，所以 `find` 会先看到 `buried`。
  //
  // **被抓（T12-c）在这里判**，不放在移动那一步：接触是移动的**结果**，与"踩空落水"同级。
  // 于是它天然复用下面那一整套扣命/重生，不必另写一条死亡路径。
  const activePlayer = entities.find((e) => e.kind === 'player');
  if (activePlayer !== undefined) {
    const enemy = entities.find(
      (e) =>
        e.kind !== 'player' &&
        // 已经倒下的不算（尸体不撞人）
        e.down === 0 &&
        // **坑里的不算**：这是"玩家可踩其头顶跨越"（T12-c）的前提 —— 原版里守卫落坑受困时，
        // 玩家正是靠踩它过去；如果坑里也算被抓，这条经典玩法反而变成"靠近就死"。
        !ctx.pits.has(cellKey(e.cell)) &&
        cellKey(e.cell) === cellKey(activePlayer.cell),
    );
    if (enemy !== undefined) {
      events.push({ kind: 'caught', entity: activePlayer.id, by: enemy.id, cell: activePlayer.cell });
    }
  }

  const casualty = events.find(
    (e): e is Extract<SimEvent, { kind: 'drowned' | 'buried' | 'caught' }> =>
      e.kind === 'drowned' || e.kind === 'buried' || e.kind === 'caught',
  );
  if (casualty === undefined) {
    return { state: { ...prev, tick: nextTick, grid, fills, entities, treasures, gatesOpen }, events };
  }

  // 只对 **player** 扣命：现在场上只有玩家，但写成显式判断，免得加敌人那天变成
  // "无人机淹死了、玩家少一条命"。敌人的落水 / 被埋是 T12 的事（架构文档 §八-2），
  // 到时候在下面那个 early-return 的分支里长出来。
  const victim = prev.entities.find((e) => e.id === casualty.entity);
  if (victim === undefined) {
    return { state: { ...prev, tick: nextTick, grid, fills, entities, treasures, gatesOpen }, events };
  }
  if (victim.kind !== 'player') {
    // 敌人：§八-2 裁定的"**延时重生**" —— 先原地倒下 `ENEMY_DOWN_TICKS`（这段时间它不动、
    // 也不撞人），到期由 `advance` 的倒计时送回 `home`。
    // 走 `map` 而不是直接改某一项：将来多敌人时，别的敌人不该被连累。
    const downed = entities.map((e) =>
      e.id === casualty.entity ? { ...e, down: ENEMY_DOWN_TICKS } : e,
    );
    events.push({ kind: 'downed', entity: casualty.entity, cell: victim.cell });
    return {
      state: { ...prev, tick: nextTick, grid, fills, entities: downed, treasures, gatesOpen },
      events,
    };
  }

  const lives = prev.lives - 1;
  if (lives <= 0) {
    events.push({ kind: 'gameover' });
    return {
      state: {
        ...prev,
        tick: nextTick,
        grid,
        fills,
        entities,
        treasures,
        gatesOpen,
        lives: 0,
        status: 'dead',
      },
      events,
    };
  }

  // 还有命：全体回出生点。目前只有玩家一个实体，但用 map 而不是直接改 entities[0] ——
  // 这样"T12 加进来的敌人不该被玩家连累传走"这件事不用靠人记得。
  // 还有命：玩家回出生点，**敌人也回各自的出生点**（T12-c 的"追捕重置"）。
  //
  // 为什么敌人也必须回：接触即死之后，"守在出生点的无人机"会把三条命**连锁**带走 ——
  // 玩家在重生冻结里根本动不了，只能看着它一格一格撞上来（我第一版想用"重生期间不判接触"
  // 挡住它，但那个窗口只覆盖了重生那一 tick，实测毫无作用）。让追捕在死亡那一刻**重置**，
  // 才是唯一不依赖关卡作者小心的做法；关卡那边还要配合一条：出生点别紧挨某个敌人的家。
  //
  // 敌人用 `returned` 而不是 `respawned`：后者的 `lives` 字段是玩家的命数，挂给敌人会变味。
  // 两条事件在渲染层都当**瞬移**处理 —— 否则敌人会从被杀的地方滑过整张地图回家。
  const home = stateAt(level, victim.home);
  const respawned = entities.map((e) => {
    if (e.id === casualty.entity) {
      events.push({ kind: 'respawned', entity: e.id, cell: victim.home, lives });
      return { ...e, cell: victim.home, mode: home?.mode ?? e.mode, cooldown: RESPAWN_TICKS };
    }
    if (e.kind === 'player') return e;
    const enemyHome = stateAt(level, e.home);
    events.push({ kind: 'returned', entity: e.id, cell: e.home });
    return { ...e, cell: e.home, mode: enemyHome?.mode ?? e.mode, cooldown: RESPAWN_TICKS };
  });

  return {
    state: { ...prev, tick: nextTick, grid, fills, entities: respawned, treasures, gatesOpen, lives },
    events,
  };
}

/** 跑一串意图，逐帧返回 —— 这就是"回放"：喂同样的脚本，必然得到同样的帧序列。 */
export function replay(start: SimState, script: readonly Intents[]): readonly SimFrame[] {
  const frames: SimFrame[] = [];
  let state = start;
  for (const intents of script) {
    const frame = tick(state, intents);
    frames.push(frame);
    state = frame.state;
  }
  return frames;
}

/** `ticks` 个 tick 一直朝 `dir`（按住不放）。写回放脚本用。 */
export function hold(dir: Dir, ticks: number = MOVE_TICKS): readonly Intents[] {
  return Array.from({ length: ticks }, () => ({ move: dir, dig: null }));
}

/** `ticks` 个 tick 什么也不按。 */
export function wait(ticks: number): readonly Intents[] {
  return Array.from({ length: ticks }, () => NO_INTENTS);
}
