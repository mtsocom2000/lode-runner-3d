import type { Cell } from '../types';
import { faceOf, toFold, toWorld } from '../world/fold';
import { asCell } from '../world/deck';
import { isDeckCell, isSolid, supportOf, type Support } from '../world/graph';
import type { Level } from '../world/tiles';

/**
 * 原版移动规则的直接移植：走 / 爬梯 / 松手 / 坠落（架构文档 §1.3-3"规则零翻译"）。
 *
 * ## Dir 是**摊平网格**方向，不是屏幕方向
 *
 * `left` = col−1，`right` = col+1，`up` = row+1，`down` = row−1。
 * 折痕那一跳（网格 col `fold-1` ↔ col `fold`）在这里就是一次普通的 left/right 平移 ——
 * 玩家过折角后**朝向**该转 90°，那是 input 层（T7）拿本地方向系做的事，core 不掺和。
 * 一旦让 core 去管"屏幕上哪边是左"，本文件就不再是原版规则的移植，而会变成一份
 * 只在这个视角下成立的近似 —— 那正是要避免的。
 *
 * ## 两种停驻模式（见 graph.ts 的 Support）
 *
 * - `stand` —— 站在砖面顶上，或攀在梯上。
 * - `hang`  —— **吊在横杆下面**（原版 rope 语义）。杆格可停驻，但停的方式是吊：
 *              能沿杆横移、能松手落下，**不能向上**。
 *              这也是 validator 规则⑦"连杆正下方不得为实心砖"的由来 —— 下方没空就吊不住。
 *
 * ## 坠落
 *
 * 走出边缘（目标格可通行但停不住）→ 沿该列下坠到第一个可停驻格；一路无支撑
 * → 掉出墙体底部 → `water`（架构文档 §1.5-3 途径①）。
 *
 * **坠落是移动的结果，不是图的边**：`world/graph.ts` 只管静态邻接，两者分工在那边有说明。
 * 落水扣命是 T9 的事，这里只负责报出"掉出去了、从哪一列掉的"这个事实。
 */

export type Dir = 'left' | 'right' | 'up' | 'down';

export const DIRS = ['left', 'right', 'up', 'down'] as const satisfies readonly Dir[];

/**
 * **世界上下**（`Z`/`X`）—— 与 `Dir` 分开的第二组输入。
 *
 * 为什么不让 `up`/`down` 兼职：在**墙面**上 `up`/`down` 就是爬梯（那没问题，墙是竖直面）；
 * 但在**甲板**上它们是水平轴（前后走）。如果升降也挤进 `up`/`down`，甲板上就再也说不清
 * "我要上去"该按什么。用户 2026-09-19 的裁定正是这一条：
 *
 * > `awsd` 只控制方向，`Z`/`X` 控制上下；`awsd` 只控制方向，不会转意。
 *
 * 于是本作有三组动作：**面内四方向**（`Dir`）、**挖**（`Dir` 的左右两个）、**世界上下**（`Lift`）。
 * `rise`/`fall` 在两种面上分别是：
 *
 * | 面 | `rise` / `fall` |
 * |---|---|
 * | 墙 A/B | 与 `up`/`down` 等价（爬梯 / 下梯）—— 冗余但无害 |
 * | 甲板 'I' | **换一层**（塔的梯子）；没有那一层就走不动 |
 */
export type Lift = 'rise' | 'fall';

export const LIFTS = ['rise', 'fall'] as const satisfies readonly Lift[];

/** `hang` 只可能出现在杆格上；`stand` 覆盖砖面与梯。 */
export type MoveMode = 'stand' | 'hang';

export interface MoveState {
  readonly cell: Cell;
  readonly mode: MoveMode;
}

/**
 * 这一次移动里，"这个世界的**甲板**（岛台 / 小道）算不算存在"，以及"哪些坑里有人"。
 *
 * 与 `world/graph.ts` 的 `GraphOptions.decks` 是**同一件事的两半**：那边管"图上有没有甲板节点"，
 * 这边管"走一步的时候认不认接头"。两边必须给同一个答案，所以 drone 的那一份只在
 * `ai/drone.ts` 里写一次（`DRONE_STEP`），`sim` 与 AI 都从那里取。
 *
 * 为什么不能只在图上关掉：图说"追不到甲板上的玩家"（T12-b 的裁定），但**移动**仍然认接头 ——
 * 于是巡逻到接头那一格、朝向正好是 `enterDir` 时，无人机一步就上了小道（用户 2026-09-19 报的
 * "机器人进入岛台后就变傻了"：甲板上没有它的图节点，追不了人，只能在板上打转）。
 */
export interface StepOptions {
  /** 默认 `true`。`false` = 这个行动者"只在墙面内"（无人机）。 */
  readonly decks?: boolean;
  /**
   * **有人的坑**（格键集合）—— 那些坑口可以踩过去（原版"踩其头顶"）。
   * 由 `sim.bridgesOf` 从 state 推出来，是这件事的唯一出处。
   */
  readonly bridges?: ReadonlySet<string>;
}

/**
 * 方向非法时的**具体**原因。分开列而不是一个笼统的 false：
 * T7 要拿它给"为什么动不了"的反馈，测试也要能断言到底是撞墙了还是没梯。
 */
export type BlockReason =
  | 'out' // 走出网格边界
  | 'solid' // 撞上砖
  | 'not-ladder' // 不在梯上，或目标不是梯 —— 原版没有跳跃
  | 'not-hangable' // 吊着却想向上；或杆下方是实心砖，根本吊不住
  | 'nothing-there' // 吊着横移，但杆的尽头之外是空中：得先松手
  | 'no-lift'; // 甲板上想换层，但上面/下面那一层不是甲板（没有"梯子"）

export type FallEnd =
  | { readonly kind: 'landed'; readonly cell: Cell }
  | { readonly kind: 'water'; readonly from: Cell; readonly row: number };

export type StepResult =
  | { readonly kind: 'move'; readonly state: MoveState }
  | { readonly kind: 'fall'; readonly end: FallEnd }
  | { readonly kind: 'blocked'; readonly reason: BlockReason };

function blocked(reason: BlockReason): StepResult {
  return { kind: 'blocked', reason };
}

/** 按全局列建格。列越界返回 null（行越界交给 level.at 的 undefined 处理）。 */
function cellAt(level: Level, col: number, row: number): Cell | null {
  if (col < 0 || col >= level.cols) return null;
  return { face: faceOf(col, level.fold), col, row };
}

/**
 * 这一格能不能停驻；能的话以什么模式停。
 * 出生点/重生点用它把坐标变成合法 state（不合法返回 null，而不是硬造一个会立刻坠落的 state）。
 */
export function stateAt(level: Level, cell: Cell): MoveState | null {
  const support: Support | null = supportOf(level, cell);
  if (support === null) return null;
  return { cell, mode: support === 'bar' ? 'hang' : 'stand' };
}

/**
 * 从 `from`（一个**刚离开支撑**的格：走空的落点、或杆下方那一格）沿本列下坠。
 *
 * 每往下一格都先问"这一格能不能停" —— 梯和杆不实心，但**能接住人**，
 * 所以判定必须用 supportOf 而不是 isSolid。只盯"下方是不是实心"会让坠落穿杆而过。
 * 一路掉到 row 0 还停不住 → 掉出墙体 → 水。
 *
 * `bridges` 一路传下去：坑里有人时，坑口是踩得住的一格
 * （原版"踩其头顶"，见 `world/graph.ts` 的 `supportOf` ⑤）。
 */
export function fallTo(level: Level, from: Cell, bridges?: ReadonlySet<string>): FallEnd {
  let row = from.row;
  for (;;) {
    const cell: Cell = { face: faceOf(from.col, level.fold), col: from.col, row };
    const support: Support | null = supportOf(level, cell, bridges);
    if (support !== null) return { kind: 'landed', cell };
    if (row - 1 < 0) return { kind: 'water', from, row };
    row -= 1;
  }
}

/**
 * 甲板的四向步。`(dx, dz)` 是甲板**晶格**的两个轴 —— 与墙的 `(col, row)` 不是一个坐标系。
 *
 * ## 为什么 `up`/`down` 是**反着**的（2026-09-19，用户反馈后定）
 *
 * 甲板是**水平面**，而这个相机是 45° 俯视墙角 —— 于是甲板上的四个轴向在屏幕上**全都投成斜的**
 * （实测每个都是 `(±0.7, ∓0.3)`）。也就是说甲板上不存在"按 W 就往屏幕正上方"这回事，
 * 只能把四个键**尽量**分配到各自那个屏幕象限里。
 *
 * 早先的版本是把整组键位**转了 45°**：`right→右下`（读起来像"右"，没问题）、
 * `up→左下`（读起来是"左下方" ✗ —— 用户的原话："进入岛台以后按 w 变成了往视觉上的左下方走，
 * 更加反直觉"）。现在把 `up`/`down` 对调：`up→右上`、`down→左下`，四个键各自落在自己的象限
 * （`d`↘ / `w`↗ / `a`↖ / `s`↙）。
 *
 * **配套**：B 面小道的接头 `enterDir` 跟着从 `up` 改成 `down` —— 进门的键必须和"进门后沿着小道
 * 继续走"的键是同一个（A 面是 `d` 进、`d` 继续；B 面现在 `s` 进、`s` 继续）。
 *
 * 若手感相反（按"左"却往另一边走），**只翻这里的符号**即可：选择集中在这一处，
 * 就是为了让那种调整只动一行，而不是散进下面的逻辑里。
 */
const DECK_DIR: Readonly<Record<Dir, { readonly dx: number; readonly dz: number }>> = {
  right: { dx: 1, dz: 0 },
  left: { dx: -1, dz: 0 },
  up: { dx: 0, dz: -1 },
  down: { dx: 0, dz: 1 },
};

/**
 * 反向。两处要用：这里的"小道往外"、以及 `ai/drone.ts` 巡逻时的"尽量不掉头"。
 * 只此一份 —— 两份反向表迟早会有一份忘了改。
 */
export const OPPOSITE_DIR: Readonly<Record<Dir, Dir>> = {
  left: 'right',
  right: 'left',
  up: 'down',
  down: 'up',
};

/**
 * 甲板格 `(x, z)` 上"**沿小道往外**"的方向（= 走向墙面那一侧）；`null` = 不是小道尽头。
 *
 * 判据只有一条：这一格在甲板上的邻居**恰好只有一个**（小道是 1 宽，尽头就一个来路），
 * 那个方向就是"往里"，反向就是"往外"。**甲板数据是唯一出处**，不掺世界坐标。
 *
 * 为什么要这么算（用户 2026-09-19）：*"沿着岛台小道从岛台方向跑去右侧墙，…走到最后一格，
 * 但是无法走到右侧墙面的格子上，按任何键都走不上去。"* —— 那时"往外"是从墙面格与甲板砖的
 * 世界坐标差里取主导轴，而 **B 面接头上 dx 与 dz 正好是 ±0.5 的平手**，靠 `>=` 的先后把平
 * 破给了 x，于是"沿小道按 `w` 过来、到尽头却必须按 `d` 才上得去"（`w` 被拒）。同一个 bug 的
 * 另一半见 `DECK_DIR` 上方那段。
 */
function jettyOutward(level: Level, x: number, z: number): Dir | null {
  const inward = DIRS.filter((d) => {
    const s = DECK_DIR[d];
    return level.deck.some((c) => c.x === x + s.dx && c.z === z + s.dz);
  });
  if (inward.length !== 1) return null; // 尽头之外（孤格 / 不规则形状）→ 由调用方回退
  return OPPOSITE_DIR[inward[0] as Dir];
}

/**
 * 在甲板上走一步。
 *
 * 为什么不能复用下面那套算术：`cellAt` 用 `faceOf(col, fold)` 造格、`level.at` 读摊平网格 ——
 * 两者都建立在 `(col, row)` 上，而甲板格的两个下标是 `(x, z)`、属于面 `'I'`。
 * 拿 `(col ± 1, row ± 1)` 去推甲板，得到的只会是墙上的格，且 `level.at` 在甲板的坐标上是越界。
 *
 * 三条去向：①甲板内部的四邻；②接头跨到墙面；③都没有 → **阻止**。
 *
 * ③ 是阻止而不是坠落，这是用户定的规则：**玩家不能主动走入水里**。
 * 落水只保留两条途径（见 `core/rules/drown.ts`）：墙上的地板缺口、吊杆松手。
 * 甲板没有"天然断裂处"这种东西，它的边缘就是边界。
 */
function stepOnDeck(level: Level, state: MoveState, dir: Dir): StepResult {
  const x = state.cell.col;
  const z = state.cell.row;
  const myLevel = state.cell.level ?? 0;
  const step = DECK_DIR[dir];

  // ① 甲板内部的四邻：目标必须在**同一层**的 `level.deck` 里。
  if (level.deck.some((d) => d.x === x + step.dx && d.z === z + step.dz && (d.level ?? 0) === myLevel)) {
    return {
      kind: 'move',
      // `asCell` 负责"层 0 省略不写"这条约定（与 `parseCell` 同一个口径）。
      state: { cell: asCell({ x: x + step.dx, z: z + step.dz, level: myLevel }), mode: 'stand' },
    };
  }

  // ② 接头：甲板端 → 墙面端。接头只在**底层**（小道接的是水面上的那一层）。
  //    **方向 = 沿小道"往外"**（`jettyOutward`：甲板自己的数据说了算）—— 也就是"玩家沿着小道
  //    走过来时按的那个键"。这一条取代了原先"从世界坐标差取主导轴"的写法：B 面接头上
  //    dx 与 dz 是 ±0.5 的平手，靠 `>=` 破给了 x，于是"按 `w` 沿小道过来、到尽头却必须按 `d`"
  //    （用户报的"按任何键都走不上去"）。几何回退只在形状不规则（不是 1 宽的小道尽头）时用到。
  const outward = jettyOutward(level, x, z);
  for (const joint of level.joints) {
    if (joint.deck.x !== x || joint.deck.z !== z) continue;
    if ((joint.deck.level ?? 0) !== myLevel) continue; // 接头只在它声明的那一层

    if (outward !== null) {
      if (outward !== dir) continue;
    } else {
      // 回退：按世界坐标差的主导轴（墙面格的世界坐标只问 `toWorld` —— 唯一出处）。
      const wp = toWorld(toFold(joint.wall, level.fold), level.fold);
      const dx = wp.x - x;
      const dz = wp.z - z;
      const toward: Dir =
        Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 'right' : 'left') : dz > 0 ? 'up' : 'down';
      if (toward !== dir) continue;
    }

    const support: Support | null = supportOf(level, joint.wall);
    if (support === null) return blocked('out');
    return {
      kind: 'move',
      state: { cell: joint.wall, mode: support === 'bar' ? 'hang' : 'stand' },
    };
  }

  // ③ 甲板边缘 —— 阻止（理由见上面那段"为什么是阻止"）。
  return blocked('out');
}

/**
 * **世界上下**（`Z`/`X`）。与 `step` 并列的第二入口 —— 单独一个函数，因为它表达的是
 * "沿**面的法线**走"，而 `step` 表达的是"在**面内**走"。
 *
 * | 面 | `rise` / `fall` |
 * |---|---|
 * | 墙 A/B | 等价于 `up`/`down`（爬梯 / 下梯）→ 直接转交给 `step` |
 * | 甲板 'I' | 换一层：目标 = 同 `(x, z)` 的 `level ± 1`，**必须真是甲板格** |
 *
 * 甲板上"上面那一层是不是甲板"这个判断，就是"玩家心里的梯子"这件事的**唯一出处** ——
 * 渲染层照它画梯子标记（见 `render/scene.ts` 的 `deckLadders`），不再有第二份数据。
 */
export function stepLift(level: Level, state: MoveState, lift: Lift, opts: StepOptions = {}): StepResult {
  const cell = state.cell;
  if (cell.face !== 'I') {
    // 墙面：`rise`/`fall` 就是爬梯 / 下梯（`step` 里已有那套判据，别在这里重写）。
    return step(level, state, lift === 'rise' ? 'up' : 'down', opts);
  }

  const target = asCell({
    x: cell.col,
    z: cell.row,
    level: (cell.level ?? 0) + (lift === 'rise' ? 1 : -1),
  });
  if (!isDeckCell(level, target)) return blocked('no-lift');
  return { kind: 'move', state: { cell: target, mode: 'stand' } };
}

/**
 * 走一步。纯函数：不改任何东西，只回答"这一步会怎样"。
 *
 * 前置条件：`state` 只能由本函数的 `move` 结果、`stateAt`、或 `trail` 产生。
 * 万一传进来一个停不住的格子，按物理处理 —— 直接开始坠落（而不是抛异常）。
 */
export function step(level: Level, state: MoveState, dir: Dir, opts: StepOptions = {}): StepResult {
  const cell = state.cell;

  // 甲板格单独走一条路。**必须放在 `fallTo` 之前**：那个函数内部会 `faceOf` 重造格，
  // 对甲板格会造出错误的 A/B 面（甲板边缘该阻止、不该坠落，本来也不进 `fallTo`）。
  if (cell.face === 'I') return stepOnDeck(level, state, dir);

  if (supportOf(level, cell, opts.bridges) === null) {
    return { kind: 'fall', end: fallTo(level, cell, opts.bridges) };
  }

  // 甲板接头**优先于**网格邻居，也**优先于下面的上下梯门**（B-1 修）。
  //
  // 为什么必须在梯门之前：接头的墙面端可能要用 `up` / `down` 才能拐上小道（B 面接点就是
  // `enterDir: 'up'`，因为小道朝 +z）。而下面那个门在 stand 态"脚下不是梯就立刻
  // `return blocked('not-ladder')`" —— 接点端恰好不是梯，于是**永远到不了这段循环**。
  // 实测量到的就是 `blocked:not-ladder`（见 test/movement.test.ts 的接点两条）。
  //
  // 提前是**安全**的：循环首句只为**声明过的接点墙面端**匹配，其余格子一律 `continue`，
  // 所以对"不是接点端"的格子行为一字不变。
  //
  // 另外它也必须**优先于**网格邻居：不加这段的话，接头的墙面端是**单向门** ——
  // `stepOnDeck` 能把你从小道送回墙上，但你再也上不去（从墙这边按过去只会走到隔壁墙格，
  // 接头的墙面端两侧通常都有网格邻居）。图里 `buildGraph` 是从接头两端各连一条边的，
  // 移动层必须同样双向。
  //
  // `opts.decks === false` 的行动者（无人机）**不认接头**：它的世界里没有甲板（见 `StepOptions`）。
  if (opts.decks !== false) {
    for (const joint of level.joints) {
      const w = joint.wall;
      if (w.face !== cell.face || w.col !== cell.col || w.row !== cell.row) continue;
      if (joint.enterDir !== dir) continue;
      return {
        kind: 'move',
        state: { cell: { face: 'I', col: joint.deck.x, row: joint.deck.z }, mode: 'stand' },
      };
    }
  }

  if (dir === 'up' || dir === 'down') {
    if (state.mode === 'hang') return stepOnBar(level, state, dir);
    // stand：只有梯能上下。
    if (supportOf(level, cell, opts.bridges) !== 'ladder') return blocked('not-ladder');

    const target = cellAt(level, cell.col, dir === 'up' ? cell.row + 1 : cell.row - 1);
    if (target === null) return blocked('not-ladder');
    if (supportOf(level, target, opts.bridges) !== 'ladder') return blocked('not-ladder');
    return { kind: 'move', state: { cell: target, mode: 'stand' } };
  }

  const target = cellAt(level, dir === 'left' ? cell.col - 1 : cell.col + 1, cell.row);
  if (target === null) return blocked('out');
  if (isSolid(level.at(target.col, target.row))) return blocked('solid');

  const support: Support | null = supportOf(level, target, opts.bridges);
  if (state.mode === 'hang') {
    if (support === 'bar') return { kind: 'move', state: { cell: target, mode: 'hang' } };
    if (support === 'brick' || support === 'ladder') {
      return { kind: 'move', state: { cell: target, mode: 'stand' } };
    }
    // 杆的尽头之外是空中：吊着不能凭空横移出去，得先松手（松手 = 按"下"）。
    return blocked('nothing-there');
  }

  if (support === null) return { kind: 'fall', end: fallTo(level, target, opts.bridges) };
  return { kind: 'move', state: { cell: target, mode: support === 'bar' ? 'hang' : 'stand' } };
}

/**
 * 吊在杆上：只能沿杆横移（在上面的横向分支里），或按"下"**松手**。
 *
 * 松手不是"从杆上走下去"，是离开支撑开始坠 —— 所以从杆的**下一格**起算（§1.5-3 途径②）。
 * 杆下方若是实心砖，连吊都吊不住（validator 规则⑦要抓的就是这种关卡），直接判非法。
 */
function stepOnBar(level: Level, state: MoveState, dir: Dir): StepResult {
  if (dir === 'up') return blocked('not-hangable');

  const cell = state.cell;
  if (isSolid(level.at(cell.col, cell.row - 1))) return blocked('not-hangable');

  const below: Cell = { face: cell.face, col: cell.col, row: cell.row - 1 };
  return { kind: 'fall', end: fallTo(level, below) };
}

export type TrailOutcome = 'move' | 'fall-landed' | 'fall-water' | 'blocked';

export interface TrailStep {
  readonly dir: Dir;
  readonly result: StepResult;
}

export interface Trail {
  readonly start: MoveState;
  /** 结束时的状态。落水时是**落水前最后那个状态**（水里的位置由那一步的 `result` 给出）。 */
  readonly end: MoveState;
  readonly steps: readonly TrailStep[];
  readonly outcome: TrailOutcome;
}

/**
 * 按方向串跑一遍，用于轨迹断言（T3 验收）与 T13 的无头通关脚本。
 *
 * 中止条件：撞上非法方向（`blocked`）或落水（`fall-water`）。
 * 坠落但落住了（`fall-landed`）会**接着走** —— 掉下去还能继续走，这是原版的常态。
 */
export function trail(level: Level, start: MoveState, dirs: readonly Dir[]): Trail {
  let current = start;
  const steps: TrailStep[] = [];
  let outcome: TrailOutcome = 'move';

  for (const dir of dirs) {
    const result = step(level, current, dir);
    steps.push({ dir, result });

    if (result.kind === 'move') {
      outcome = 'move';
      current = result.state;
      continue;
    }
    if (result.kind === 'fall') {
      if (result.end.kind === 'landed') {
        // 落点一定是可停驻格（fallTo 只这么返回），复用 stateAt 定模式：
        // 掉在杆上就是 hang，掉在砖面/梯上就是 stand —— 不在两处各写一遍。
        const landed = stateAt(level, result.end.cell);
        if (landed !== null) current = landed;
        outcome = 'fall-landed';
        continue;
      }
      outcome = 'fall-water';
      break;
    }
    outcome = 'blocked';
    break;
  }

  return { start, end: current, steps, outcome };
}
