import { cellKey, type Cell } from '../types';
import { openGates } from '../rules/goals';
import { gridStep } from '../rules/movement';
import { walkNeighbours, walkReachable } from '../rules/reach';
import { asCell, deckKey } from '../world/deck';
import { faceOf } from '../world/fold';
import { buildGraph, isBar, isLadder, isSolid, isStandable } from '../world/graph';
import { parseLevel, withGrid, type Level, type LevelDef, type LoadError, type TileKind } from '../world/tiles';

/**
 * 关卡语义校验（T8）。
 *
 * `parseLevel`（`world/tiles.ts`）只看**字形**：行长一致、字形合法、列数 = 2×fold。
 * 这里看**语义**：这张关卡作为一个"能玩通的关"站不站得住。
 *
 * ## 为什么要单独一层
 *
 * 因为本项目出过的坑**全在语义层**，而且当场看着都像没问题：
 *
 * - `DEV_FOLD`：地板上有 4 处缺口，把行走行切成小段 —— 43 个可站立格碎成 **25 个连通分量**，
 *   出生点那一块只有 **2 格**。字形全部合法，`parseLevel` 一声不响，
 *   画面上也"看着有地板"，只有真去走才发现走不通。
 * - **悬空出口**：`E` 画在半空中，玩家走到那一列才发现停不住。
 * - **断梯**：梯子中间空一格。`buildGraph` 的 `climb` 边**要求两端都是梯**，
 *   于是梯子被劈成上下两截，上半截连同它连接的平台成了孤岛。
 *
 * 都不是渲染问题、也不是规则问题，是**关卡数据问题**。所以校验必须独立成层，
 * 而不是散进渲染或 sim —— 那两处都太晚，且都只看得见自己关心的那一面。
 *
 * ## 一次列全，不是遇到第一个就停
 *
 * 返回**所有**问题。这层的用法是"把一张关卡过一遍"，不是"挡在第一个错上"，
 * 所以每个规则都跑完再返回（`parseLevel` 失败是唯一例外 —— 字形都不合法时，
 * 后面那些基于网格的检查没有意义）。
 *
 * ## 与玩法无关的规则一条都不写
 *
 * 这里只说"结构上成立"，不说"好玩"。比如"梯子间隔 6-8 格""宝物必须有 3 个"是设计取向，
 * 不是结构约束 —— 那种判断留在关卡作者（人和后面的 AI）手里，写成硬规则只会挡住合法关卡。
 */
export type RuleId =
  /** 字形层就不合法（行长、字形、列数）—— 见 `parseLevel`。 */
  | 'parse'
  /** 高度必须是偶数。 */
  | 'rowsEven'
  /** 出生点得站得住。 */
  | 'spawnStandable'
  /** 敌人出生格得站得住（T12）。 */
  | 'enemyStandable'
  /** 出口得站得住。 */
  | 'exitStandable'
  /** 梯子不能断。 */
  | 'ladderContinuous'
  /** 横杆下方不得为实心（规则⑦）：杆是拿来吊的，下方是砖就吊不住。 */
  | 'barHangable'
  /** 每一格可站立处都要能从出生点走到。 */
  | 'unreachable'
  /** 至少有一个出口（否则这一关赢了也出不去）。 */
  | 'noExit'
  /**
   * 甲板接头指不到实地（T10）。
   *
   * 为什么单开一条而不是让 `unreachable` 去兜：`buildGraph` 对指空的接头是**静默跳过**的，
   * 于是"声明了岛台、忘了接头"会以一句"N 个可站立格到不了出生点"暴露出来 ——
   * 那读起来像关卡的可达性结构崩了，实际只是漏了一行数据。这条把原因直接说清楚。
   */
  | 'deckJointDangling'
  /**
   * 出口闸门必须真的封住、且开了之后真的能到（T13）。
   *
   * 这条把 T13 的验收断言（"集齐前出口不可达"）变成**每张关卡每次校验都成立**的性质，
   * 而不是"某个脚本碰巧跑通"。两个方向都验：未开时就走得到 = 闸门白设；
   * 开了还到不了 = 这一关永远赢不了。
   */
  | 'exitGated'
  /**
   * 接头用了那一格**走得通**的方向 —— 于是它永远进不去（2026-09-19）。
   *
   * `movement.step` 现在是"网格走不通才轮到接头"。所以接头的 `enterDir` 必须是那一格
   * **本来就堵住**的方向。写成走得通的方向，后果有两个，而且都很难查：
   * ①那条走法会被接头吃掉（用户实测：走廊在那一格断开，`col 7 → col 8` 走不了）；
   * ②这个接头本身永远进不去。
   *
   * 判据直接用 `gridStep` —— 与 `step` 内部**同一个函数**，不在这里重写一遍近似
   * （重写就等于给"这一步能不能走"造了第二个出处）。
   */
  | 'jointNeverEntered'
  /**
   * **出口走不到，而这一关又没声明闸门**（T21，规则⑨）—— 这一关**赢不了**。
   *
   * 为什么单开一条：`exitGated` 只管"**声明了**闸门"的关卡（它验"封住 / 开了能到"两个方向）。
   * 一张**没声明闸门**的关卡里出口却走不到，以前只会以 `unreachable` 的**提醒**露一小脸 ——
   * 而它其实是**错误**：玩家集齐宝物也没用，出口根本去不了。
   *
   * 真实案例（用户的 L4）：出口在折痕 B 侧，而 B 侧整片走不到（过折痕那一列没有地板），
   * 校验却只说"有格子走不到，可以不管"。那是我把严重程度判错了，不是文案问题。
   */
  | 'exitUnreachable'
  /**
   * **折痕两侧对不上**（规则⑥）：一边站得住，对面"能进但站不住" —— 走过去就是落水。
   *
   * 同一处坑已经栽过**三次**（L4、`l4-fixed`、用户 2026-09-23 的第三关），每次都是作者
   * 在 `fold-1` / `fold` 这两列里留了一个 `.` —— 而这两列**在画面里是同一个点**，
   * 所以"对面那格是空的"这件事**在画面上完全看不出来**。靠人眼盯不出来，就得由规则盯。
   */
  | 'seamMismatch'
  /** **每一块宝物都要走得到**（T21，规则⑩）—— 取不到就集不齐，集不齐就开不了闸门。 */
  | 'treasureUnreachable';

/**
 * 每条规则的**人话标题**（T21）。用户在编辑器里的原话是"校验出来的问题看的不是很明白"：
 * 面板上原来写的是 `[spawnStandable] 出生点 A:0,1 站不住…` —— 前面那个驼峰 id 是给代码看的，
 * 对人不该要求他先学会这套命名。
 *
 * 放在这里（而不是编辑器里）的理由与 `RuleId` 一样：**一个出处**。
 * 面板、HUD、日志三处都在印同一个 `rule`，谁印谁查这张表。
 */
export const RULE_TITLES: Readonly<Record<RuleId, string>> = {
  parse: '字形层不合法',
  rowsEven: '高度必须是偶数',
  spawnStandable: '出生点站不住',
  enemyStandable: '敌人出生格站不住',
  exitStandable: '出口格站不住',
  ladderContinuous: '梯子断了',
  barHangable: '横杆下方是实心砖（吊不住）',
  unreachable: '有格子走不到',
  noExit: '没有出口',
  deckJointDangling: '接头指不到实地',
  exitGated: '出口闸门没封住 / 封住了出不去',
  jointNeverEntered: '接头永远进不去（方向被走廊占了）',
  exitUnreachable: '出口走不到（这一关赢不了）',
  seamMismatch: '折痕两侧对不上（走过去会落水）',
  treasureUnreachable: '宝物走不到（取不到就开不了闸门）',
};

export interface LevelIssue {
  readonly rule: RuleId;
  /**
   * **这条到底算"错"还是"提醒"**（T21 加）。
   *
   * 用户的追问："这个场景里红色框框我都不认为是非法的，哪里不对了？" —— 他说得对：
   * 这张表里混着两种完全不同的东西，
   *
   * - **错误**：这一关**玩不了**（出生点悬空、没有出口、闸门封死……）—— 必须改；
   * - **提醒**：这一关**能玩**，但有些地方大概是手误或没画完（梯子断了一截、有格子走不到、
   *   杆底下是实心砖……）—— **可以不管**，尤其是"留白/装饰"本来就走不到。
   *
   * 两者都用红框标出来，就等于把"提醒"喊成了"错误" —— 那会让人不信这套校验。
   * 所以编辑器里**红框只标错误**，提醒用灰框（`render/fx.ts`），列表里也分开数。
   */
  readonly severity: 'error' | 'warn';
  /** 人读的一句话，直接进 HUD / 报错信息。 */
  readonly detail: string;
  /** 问题落在哪一格（能定位时给）。 */
  readonly at?: Cell;
  /** 仅 `unreachable`：走到不了的格数。 */
  readonly stranded?: number;
  /** 仅 `unreachable`：这些格彼此碎成几块（`DEV_FOLD` 是 25）。 */
  readonly components?: number;
}

/**
 * 校验一张关卡。返回空数组 = 通过。
 *
 * `spawn` 是可选的：出生点住在关卡文件旁边（`PLAYER_SPAWN`）而不是 `LevelDef` 里，
 * 所以调用方知道就传、不知道就跳过那两条（`spawnStandable` / `unreachable`）——
 * 而不是在这里编一个默认出生点，那只会让"出生点在哪"有两个答案。
 */
export function validateLevel(def: LevelDef, spawn?: Cell): readonly LevelIssue[] {
  const parsed = parseLevel(def);
  if (!parsed.ok) {
    return [
      {
        rule: 'parse',
        severity: 'error',
        detail: `字形层不合法：${describeErrors(parsed.errors)}`,
        stranded: undefined,
      },
    ];
  }

  const level = parsed.level;
  const issues: LevelIssue[] = [];

  // ① 高度必须是偶数。
  //
  // 关卡的形状是"砖行隔行布置"：砖在 r0/r2/r4…，玩家走在砖的**上一行** r1/r3/r5…。
  // 于是最顶上那一层砖也需要它上面有一行走行才用得起来 —— 总高必须是 2k。
  // 奇数高度意味着最顶层砖的行走面落到了网格外面，那层砖是死的（画得出来、走不上去）。
  if (level.rows % 2 !== 0) {
    issues.push({
      rule: 'rowsEven',
      severity: 'error',
      detail: `高度 ${level.rows} 是奇数：砖行隔行布置要求总高为 2k，否则最顶层砖的行走面落到网格外`,
      stranded: undefined,
    });
  }

  // ② 出生点得站得住。
  //
  // 出生点摆错是**关卡 bug**（不是规则 bug）：`createSim` 也会抛，但那要等到起 sim；
  // 在这里报出来能一次把"哪儿摆错了"说清楚。
  const spawnOk = spawn !== undefined && isStandable(level, spawn);
  if (spawn !== undefined && !spawnOk) {
    issues.push({
      rule: 'spawnStandable',
      severity: 'error',
      detail: `出生点 ${where(spawn)} 站不住（那一格不是梯/杆，且正下方不是实心）`,
      at: spawn,
    });
  }

  // ②-b 敌人的出生格也得站得住（T12）。
  //
  // 与 ② 同一条判据、同一类 bug：`createSim` 也会抛，但那时应用已经起不来了；
  // 在这里报出来，HUD 上能直接看见"是哪个敌人摆错了"。
  for (const [index, enemy] of (def.enemies ?? []).entries()) {
    if (isStandable(level, enemy.cell)) continue;
    issues.push({
      rule: 'enemyStandable',
      severity: 'error',
      detail: `敌人 #${index}（${enemy.kind}）出生格 ${where(enemy.cell)} 站不住（那一格不是梯/杆，且正下方不是实心）`,
      at: enemy.cell,
    });
  }

  // ③ 至少一个出口，且每个出口都得站得住。
  const exits = cellsOf(level, 'exit');
  if (exits.length === 0) {
    issues.push({ rule: 'noExit', severity: 'error', detail: '这张关卡没有出口（E）：赢了也出不去' });
  }
  for (const exit of exits) {
    if (isStandable(level, exit)) continue;
    issues.push({
      rule: 'exitStandable',
      severity: 'error',
      detail: `出口 ${where(exit)} 悬空：玩家走到那儿停不住（正下方不是实心）`,
      at: exit,
    });
  }

  // ④ 梯子不能断。
  //
  // `buildGraph` 的 `climb` 边要求**上下两格都是梯**，所以中间空一格就把梯子劈成两截。
  // 劈开之后未必立刻表现为"到不了"（下半截可能还够得着平台），所以这条要独立报 ——
  // 只靠 ⑤ 会漏掉"看起来断了但其实还能绕"的情形，而那种情形一样是作者手误。
  for (const issue of ladderGaps(level)) issues.push(issue);

  // 规则⑦：横杆下方不得为实心（见 `unsupportedBars`）。与梯子一样是**逐格**结构检查。
  for (const issue of unsupportedBars(level)) issues.push(issue);

  // ⑤ 每一格可站立处都要能从出生点走到。
  //
  // 这是**唯一**一条能挡住 `DEV_FOLD` 那类事故的规则，也是本层存在的主要理由。
  // 出生点自己站不住时跳过 —— 那种情形 ② 已经报了，再报一遍"62/62 全到不了"只会误导。
  if (spawnOk && spawn !== undefined) {
    const unreachable = findUnreachable(level, spawn);
    if (unreachable !== undefined) issues.push(unreachable);

    // ⑤ 查"走不到"，这里查"出口的门禁成不成立"（T13）。两者都以出生点为起点，所以共用
    // 上面那个 `spawnOk` 门槛 —— 出生点自己站不住时可达集是空的，那会让**每个**出口
    // 都报"未开时到不了"，把真正的问题（出生点摆错）淹掉。
    issues.push(...exitGating(level, spawn));
    // ⑨ 没有闸门却走不到出口 = **赢不了**（与 `exitGating` 互斥，见 `exitUnreachable` 的注释）。
    issues.push(...exitReachableWithoutGates(level, spawn));
    // ⑩ 宝物：一块都没有 = 赢不了；有但走不到 = 也赢不了。
    issues.push(...treasureChecks(level, spawn));
  }

  // 甲板接头不依赖出生点，所以放在 `spawn` 判断之外：没有出生点也该查得出坏接头。
  // 放在 `unreachable` **之后**：坏接头是"为什么到不了"的原因，先说结论再说原因。
  issues.push(...danglingJoints(level));
  issues.push(...jointShadowed(level));

  // ⑥ 折痕两侧对不上（**第三次同款事故**，见 `seamMismatch`）。
  // 可达集只在出生点站得住时才有意义 —— 但它只影响**分级**（够得着的陷阱才是错误），
  // 所以这一条不放进上面那个 `spawnOk` 块里：还没放出生点时也该看得见。
  issues.push(
    ...seamFalls(level, spawnOk && spawn !== undefined ? walkReachable(level, spawn).cells : null),
  );

  return issues;
}

/**
 * 规则⑥：**折痕两侧对不上**。
 *
 * ## 为什么这条必须由工具来盯
 *
 * 折痕两侧最内列（`fold - 1` 与 `fold`）**在世界里是同一个点**（见 `fold.ts` 的
 * `halfExtent`）。所以"过折痕"不是走一格，而是**原地转 90°**：从 A 侧那一列跨到 B 侧那一列，
 * 位置一动不动。而**站得住与否是逐格算的** —— `supportOf` 只看**自己那一列的下面那一格**。
 *
 * 于是出现这样一种格：A:13,2 站得住（(13,1) 有砖），B:14,2 也能走进去但站不住（(14,1) 是空的）。
 * 两格重合在画面上是同一个点 —— 玩家看不出自己在哪一侧，**走过去就掉下去**。
 *
 * 用户这一关（`U-Seam` 夹具）正是：`r1` 的平台在 col 8..13 与 15..19 各铺了一段，
 * 中间 col 14 空了一格。作者修的时候眼睛盯着的是"砖够不够"，而这一格的问题在**隔壁那一列**。
 *
 * ## 只报"能进但站不住"，不报"对面是砖"
 *
 * 对面是砖（`=`/`X`）时跨过去是**被挡住**，那是墙、是正常地形；只有"走进去然后掉下去"
 * 才是陷阱。这条区分是规则的全部要点 —— 少了它，折痕上任何一堵墙都会报一次。
 *
 * ## 分级
 *
 * 够得着（可达）才是**错误**：玩家真会踩上去。够不着的（还没放出生点、或那一片本来就走不到）
 * 只作**提醒** —— 它仍是同一个手误，只是暂时不咬人。
 */
function seamFalls(level: Level, reachable: ReadonlySet<string> | null): readonly LevelIssue[] {
  const issues: LevelIssue[] = [];
  const left = level.fold - 1;
  const right = level.fold;
  if (left < 0 || right >= level.cols) return issues;

  for (let row = 0; row < level.rows; row++) {
    const a: Cell = { face: 'A', col: left, row };
    const b: Cell = { face: 'B', col: right, row };
    const aHolds = isStandable(level, a);
    const bHolds = isStandable(level, b);
    if (aHolds === bHolds) continue;

    const here = aHolds ? a : b;
    const over = aHolds ? b : a;
    // 对面是砖 → 那是墙，不是陷阱（这条区分见上面的注释）。
    if (isSolid(level.at(over.col, over.row))) continue;

    // 缺的是**对面那一列的支撑格**：补上它，对面就站得住了。
    // （对面能走进来 ⇒ 它自己那格是通的 ⇒ 它的支撑格一定在界内，`row - 1 >= 0` 成立。）
    const missing: Cell = { face: over.face, col: over.col, row: row - 1 };
    const mine: Cell = { face: here.face, col: here.col, row: row - 1 };
    const trapped = reachable !== null && reachable.has(cellKey(here));
    issues.push({
      rule: 'seamMismatch',
      severity: trapped ? 'error' : 'warn',
      detail:
        `折痕两侧对不上：${where(here)} 站得住，对面 ${where(over)} **能走进去但站不住**` +
        `（两格在画面里是同一个点，看不出区别）—— 从这一侧过去就是落水。` +
        `在编辑器的折痕那一列（col ${left} / ${right}）任意一侧点一下即可：**落笔会两面一起画**` +
        `（旧版编辑器画不到 B 面那一列，这是那时候留下的洞）；手工改 JSON 的话，就在 ${where(missing)} 补一块砖、` +
        `或把 ${where(mine)} 拆掉。`,
      at: missing,
    });
  }
  return issues;
}

/** 网格里所有等于 `kind` 的格。顺序固定（行 ↑、列 ↑），与 `buildGraph` 一致。 */
function cellsOf(level: Level, kind: TileKind): readonly Cell[] {
  const out: Cell[] = [];
  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      if (level.at(col, row) !== kind) continue;
      out.push(cellOf(level, col, row));
    }
  }
  return out;
}

/** 造一个 `Cell`。面的归属是纯函数，所以这里不必手写 A/B 判断。 */
function cellOf(level: Level, col: number, row: number): Cell {
  return { face: col < level.fold ? 'A' : 'B', col, row };
}

/**
 * 把一格写成能贴进报错信息的字符串。
 *
 * 甲板格（面 `'I'`）单独写：它的两个下标是 `(x, z)`，直接套 `I:-1,0` 会读成"面 I 的第 -1 列"，
 * 而 `-1` 在墙的坐标系里是越界值 —— 那是**另一个坐标系**，混着写会让人去查错地方。
 */
function where(c: Cell): string {
  if (c.face === 'I') return `甲板(${c.col}, ${c.row})`;
  return `${c.face}:${c.col},${c.row}`;
}

/**
 * 甲板接头必须**两端都落到实处**（T10）。
 *
 * `buildGraph` 对指空的接头是静默跳过的（见 graph.ts 里那段注释：关卡数据错了，不该悄悄补一条边）。
 * 静默是对的 —— 但静默之后得有**人**说话，否则"漏了一行接头"会伪装成关卡可达性崩了。
 */
function danglingJoints(level: Level): readonly LevelIssue[] {
  const declared = new Set(level.deck.map((k) => deckKey(k)));
  const issues: LevelIssue[] = [];

  for (const joint of level.joints) {
    const deckSide = deckKey(joint.deck);
    if (!declared.has(deckSide)) {
      issues.push({
        rule: 'deckJointDangling',
        severity: 'error',
        detail: `接头的甲板端 (${joint.deck.x}, ${joint.deck.z}) 不在 level.deck 里：这条边连不上，岛台会变成走不到的孤岛`,
        at: asCell(joint.deck),
      });
      continue;
    }
    if (!isStandable(level, joint.wall)) {
      issues.push({
        rule: 'deckJointDangling',
        severity: 'error',
        detail: `接头的墙面端 ${where(joint.wall)} 站不住（越界、实心、或下方没有支撑）：小道得从一块能站人的砖接出去`,
        at: joint.wall,
      });
    }
  }

  return issues;
}

/**
 * 接头的方向必须是那一格**本来就堵住**的方向（规则⑧，2026-09-19）。
 *
 * 判据用 `gridStep` —— 与 `step` 内部同一个函数。**不在这里重写"这一步能不能走"**：
 * 那样就出现了第二个出处，两份迟早漂开（本仓库的老毛病，见 `rules/reach.ts` 的文件头）。
 */
function jointShadowed(level: Level): readonly LevelIssue[] {
  const declared = new Set(level.deck.map((k) => deckKey(k)));
  const issues: LevelIssue[] = [];

  for (const joint of level.joints) {
    // 甲板端不存在的接头由 `deckJointDangling` 报，这里不重复。
    if (!declared.has(deckKey(joint.deck))) continue;

    const grid = gridStep(level, { cell: joint.wall, mode: 'stand' }, joint.enterDir);
    if (grid.kind === 'blocked') continue;

    issues.push({
      rule: 'jointNeverEntered',
      severity: 'error',
      detail:
        `接头 ${where(joint.wall)} 声明用 \`${joint.enterDir}\` 上小道，可是那一格这个方向**走得通**` +
        `（${grid.kind === 'fall' ? '会掉下去' : '是一步正常的移动'}）—— ` +
        `接头只在网格走不通时才生效，所以它永远进不去，而且会**吃掉那条走法**（走廊会在这一格断开）`,
      at: joint.wall,
    });
  }

  return issues;
}

/**
 * 规则⑩：**每一块宝物都要走得到**（T21）。
 *
 * 取不到就集不齐，集不齐就开不了闸门 —— 所以这是"赢不了"级别。
 * 墙上（字形 `G`）与甲板（`treasures`）两类**等价**，都要查。用户明确提过"宝物的可达性"
 * 要能测，这条就是。
 *
 * > 曾经在这里加过一条"**一块宝物都没有** = 错误"，方向反了：真正的矛盾在模型里 ——
 * > `exitGated` 把"没声明闸门的关卡"当成**不设门**，而 sim 里出口却永远锁着。
 * > 正确的修法是让 sim 跟上：**没有宝物 ⇒ 出口一开始就是开的**（见 `createSim`）。
 */
function treasureChecks(level: Level, spawn: Cell): readonly LevelIssue[] {
  if (level.treasures.length === 0 && !level.grid.includes('treasure')) return [];

  const issues: LevelIssue[] = [];
  const wallCells: Cell[] = [];
  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      if (level.at(col, row) === 'treasure') wallCells.push({ face: faceOf(col, level.fold), col, row });
    }
  }

  const reachable = walkReachable(level, spawn).cells;
  for (const cell of level.treasures.map(asCell)) {
    if (reachable.has(cellKey(cell))) continue;
    issues.push({
      rule: 'treasureUnreachable',
      severity: 'error',
      detail: `地台上的宝物 ${where(cell)} 从出生点走不到 —— 取不到就集不齐，集不齐就开不了闸门`,
      at: cell,
    });
  }
  for (const cell of wallCells) {
    if (reachable.has(cellKey(cell))) continue;
    issues.push({
      rule: 'treasureUnreachable',
      severity: 'error',
      detail: `墙上的宝物 ${where(cell)} 从出生点走不到 —— 取不到就集不齐，集不齐就开不了闸门`,
      at: cell,
    });
  }
  return issues;
}

/**
 * 规则⑨：**没声明闸门时，出口必须从出生点走得到**（T21）。
 *
 * 与 `exitGating` 的分工：声明了闸门 → 那边管（它验"封住 / 开了能到"两个方向）；
 * **没声明闸门** → 这里管"能不能走到"。两边都跑也无害（闸门那半边在没闸门时直接返回）。
 *
 * 判据用 `walkReachable` —— 与"格子走不到"和"闸门开了能不能到"是**同一个**函数，
 * 三处不各算一套。
 */
function exitReachableWithoutGates(level: Level, spawn: Cell): readonly LevelIssue[] {
  if (level.gates.length > 0) return []; // 交给 `exitGating`
  const exits = cellsOf(level, 'exit');
  if (exits.length === 0) return []; // 没出口由 `noExit` 报
  const reachable = walkReachable(level, spawn).cells;
  const issues: LevelIssue[] = [];
  for (const exit of exits) {
    if (reachable.has(cellKey(exit))) continue;
    issues.push({
      rule: 'exitUnreachable',
      severity: 'error',
      detail: `出口 ${where(exit)} 从出生点**走不到**（这一关又没声明闸门）—— 集齐宝物也没用，这一关赢不了`,
      at: exit,
    });
  }
  return issues;
}

/**
 * 出口闸门（T13）：每个出口必须**未开时到不了、开了之后到得了**。
 *
 * 验的是 `openGates` 这个**真正会跑的函数** —— 不是这里重写一遍的近似。两份实现迟早漂开，
 * 那时这条规则就成了摆设：它说"能过关"，而 sim 跑的是"过不了"。
 */
function exitGating(level: Level, spawn: Cell): readonly LevelIssue[] {
  const exits = cellsOf(level, 'exit');
  if (exits.length === 0) return []; // 没出口由 `noExit` 报，不在这里重复

  // **只有声明了闸门才校验**（T13）。一条关卡完全不设闸门 = "出口一开始就能走"，
  // 那是**设计取向**（这一关想不想做"集齐才开"的谜题），不是结构错误 ——
  // 本文件头的宪章是"与玩法无关的规则一条都不写"。
  // 反过来，一旦声明了 `gates`，作者就是在明确要求"集齐前封住"：那时两个方向都必须成立，
  // 而且**每一个**出口都要成立（闸门只封住半边、漏了另一边的出口，是最容易犯的手误）。
  if (level.gates.length === 0) return [];

  // 与 `findUnreachable` 同一条判据：**按移动规则**问"走不走得到"，不用静态图
  // （否则"图说能到、玩家到不了"这类事故照样漏过去，见 `rules/reach.ts` 的文件头）。
  const before = walkReachable(level, spawn).cells;
  const opened = withGrid(level, openGates(level.grid, level.gates, level.cols));
  const after = walkReachable(opened, spawn).cells;

  const issues: LevelIssue[] = [];
  for (const exit of exits) {
    const key = cellKey(exit);
    if (before.has(key)) {
      issues.push({
        rule: 'exitGated',
        severity: 'error',
        detail: `出口 ${where(exit)} 一开始就走得到：闸门没封住它（集齐宝物前它必须是到不了的）`,
        at: exit,
      });
      continue;
    }
    if (!after.has(key)) {
      issues.push({
        rule: 'exitGated',
        severity: 'error',
        detail: `出口 ${where(exit)} 闸门全开之后仍然到不了：这一关赢不了（查 gates 是不是声明全了）`,
        at: exit,
      });
    }
  }
  return issues;
}

/** 断梯：某一列里梯格的行号不连续。每个缺口报一条。 */
function ladderGaps(level: Level): readonly LevelIssue[] {
  const issues: LevelIssue[] = [];

  for (let col = 0; col < level.cols; col++) {
    const rows: number[] = [];
    for (let row = 0; row < level.rows; row++) {
      if (isLadder(level.at(col, row))) rows.push(row);
    }
    if (rows.length === 0) continue;

    // rows 天然升序（上面那个循环就是从 0 往上扫的），所以只要比相邻两个。
    for (let i = 1; i < rows.length; i++) {
      const below = rows[i - 1];
      const above = rows[i];
      if (below === undefined || above === undefined) continue;
      if (above === below + 1) continue;
      issues.push({
        rule: 'ladderContinuous',
        severity: 'warn',
        detail: `第 ${col} 列的梯子在 r${below} 与 r${above} 之间断了（缺 r${below + 1}）：climb 边要求上下两格都是梯，这一列被劈成两截`,
        at: cellOf(level, col, below + 1),
      });
    }
  }

  return issues;
}

/**
 * 规则⑦（设计文档 §四）：**横杆下方不得为实心**。
 *
 * 为什么要有它：吊着的人**占的是杆下面那一格**（`playerAnchor` 的 `hang` 分支把身体中心
 * 下移 `HANG_DROP`，见 `render/metrics.ts`）—— 杆下若是砖，那个人就悬在砖里。原版同样的道理
 * （杆是用来吊的，不是用来站的），归档原型 `cargo` 那版也把这条当硬规则。
 *
 * 这条规则**一直没有实现**（L1 里没有杆，所以从没暴露）；L2 的"跨折痕横杆"正是按它摆的 ——
 * 杆下面那两格 `r2` 特意挖空（见 `levels/l2.ts` 的图纸）。补上它是为了让**下一个人**改关卡时
 * 不会悄悄把砖填回去，直到玩家吊上去才发现卡在砖里。
 *
 * "锚在砖面之上一层"那半句是**外观**（渲染把杆画在格心，上方有没有砖都不影响"吊"这个动作），
 * 所以这里只判可判定的这一半。
 */
function unsupportedBars(level: Level): readonly LevelIssue[] {
  const issues: LevelIssue[] = [];
  for (let row = 1; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      if (!isBar(level.at(col, row))) continue;
      if (!isSolid(level.at(col, row - 1))) continue; // 下方不是实心 → 吊得住
      issues.push({
        rule: 'barHangable',
        severity: 'warn',
        detail: `横杆 ${where(cellOf(level, col, row))} 的正下方是实心砖：吊着的人会卡在砖里（规则⑦"连杆下方非实心"）`,
        at: cellOf(level, col, row),
      });
    }
  }
  return issues;
}

/**
 * 从出生点出发走不到的可站立格。
 *
 * 还顺手把"这些孤岛彼此碎成几块"算出来 —— 那才是诊断的关键数字：
 * `DEV_FOLD` 的 43 格碎成 **25 块**（最大一块只有 4 格），说明不是"漏了两格"，
 * 而是整张关卡的可达性结构不成立。只报"有 41 格到不了"会让人以为补个梯子就行。
 */
function findUnreachable(level: Level, spawn: Cell): LevelIssue | undefined {
  // **按移动规则**判定，不用静态图 —— 理由见 `rules/reach.ts` 的文件头：
  // 曾经这里用 `buildGraph` + `reachableFrom`，于是甲板接头那一类"横向移动被接头吃掉"的
  // 事故会漏过去（图连了边、`step` 走不到），表现为"校验说全过、玩家走不到"。
  const reachable = walkReachable(level, spawn).cells;
  // 静态图仍然要建：它的 `nodes` 就是"哪些格该被走到"的**清单**（节点 = 可站立格）。
  const graph = buildGraph(level);

  // 出口**故意**可以到不了 —— T13 的闸门封的就是它。所以这里把出口排除，交给 `exitGating`
  // 单独负责（那边也管相反的方向："开了之后必须到得了"）。不排除的话，
  // "集齐宝物前出口不可达"这条**设计意图**会被报成关卡事故。
  const gated = new Set(cellsOf(level, 'exit').map(cellKey));
  const stranded = graph.nodes.filter((node) => {
    const key = cellKey(node);
    return !reachable.has(key) && !gated.has(key);
  });
  const first = stranded[0];
  if (first === undefined) return undefined;

  const { count, largest } = componentsAmong(level, stranded);
  return {
    rule: 'unreachable',
    severity: 'warn',
    // 文案按用户的追问改写过："红色框框我都不认为是非法的" —— 这条**不是非法**，
    // 它说的是"从出生点走不过去"。留白、装饰、暂时没接上的平台都长这样，所以把
    // "可以不管"直接写进话里，别让人以为非改不可。
    detail: `${stranded.length}/${graph.nodes.length} 个可站立格从出生点走不过去（彼此碎成 ${count} 块，最大 ${largest} 格）；如果那些格子本来就只是留白 / 装饰，可以不管`,
    at: first,
    stranded: stranded.length,
    components: count,
  };
}

/** 只在这些格之间做连通分量（用**移动规则**的相邻关系，见 `rules/reach.ts`）：`allowed` 之外的不算，所以孤岛不会"绕出去"。 */
function componentsAmong(
  level: Level,
  seeds: readonly Cell[],
): { readonly count: number; readonly largest: number } {
  const allowed = new Set(seeds.map(cellKey));
  const seen = new Set<string>();
  let count = 0;
  let largest = 0;

  for (const seed of seeds) {
    if (seen.has(cellKey(seed))) continue;
    count += 1;

    let size = 0;
    const queue: Cell[] = [seed];
    seen.add(cellKey(seed));
    for (let head = 0; head < queue.length; head++) {
      const current = queue[head];
      if (current === undefined) continue;
      size += 1;
      for (const next of walkNeighbours(level, current)) {
        const key = cellKey(next);
        if (!allowed.has(key) || seen.has(key)) continue;
        seen.add(key);
        queue.push(next);
      }
    }
    if (size > largest) largest = size;
  }

  return { count, largest };
}

/** `LoadError[]` → 人读的一句话。带位置，因为"第几行第几列"是唯一能让人去改的东西。 */
function describeErrors(errors: readonly LoadError[]): string {
  return errors
    .map((error) => {
      switch (error.kind) {
        case 'noRows':
          return '没有任何行';
        case 'ragged':
          return `第 ${error.row} 行长度 ${error.got}，应为 ${error.expected}`;
        case 'badChar':
          return `第 ${error.row} 行第 ${error.col} 列有非法字形 ${JSON.stringify(error.ch)}`;
        case 'foldMismatch':
          return `fold=${error.fold} 要求 ${error.fold * 2} 列，实际 ${error.cols} 列`;
      }
    })
    .join('；');
}
