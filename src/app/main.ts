import * as THREE from 'three';
import { L3, L3_SPAWN } from '../core/level/levels/l3';
import { BLANK } from '../core/level/levels/blank';
import { clearStoredLevel, decodeLevel, loadStoredLevel, storeLevel } from './levelstore';
import { createEditor } from './editor';
import { RULE_TITLES, type LevelIssue } from '../core/level/validate';
import { validateLevel } from '../core/level/validate';
import { TICK_HZ, bridgesOf, createSim, tick, type SimEvent, type SimState } from '../core/sim';
import { parseLevel, type Level, type LevelDef, type TileKind } from '../core/world/tiles';
import { surfaceOf, cellKey, type Cell, type Surface } from '../core/types';
import type { DeckCell } from '../core/world/deck';
import { createCamera, fitCamera } from '../render/camera';
import { createSyncer, type Syncer } from '../render/meshSync';
import { createFx, type Fx } from '../render/fx';
import { cellFromPoint } from '../render/pick';
import { paint } from '../core/level/paint';
import { PLAYER_SIZE, playerAnchor, sameWorldDirection, stepDelta } from '../render/metrics';
import { probePixels } from '../render/probe';
import { createStage, type Stage } from '../render/scene';
import { createHud } from './hud';
import { createInput, keyLabel } from './input';
import { createSfx } from './sfx';
import { dirHints, formatDirHints, type ScreenAxes } from '../render/hints';
import { createSelectiveBloom } from '../render/bloom';
import { feedbackFor } from '../render/feedback';

const host = document.getElementById('app');
if (!host) throw new Error('找不到 #app 挂载点（index.html 被改坏了？）');

/**
 * **这一局用哪张关卡**（T21）。
 *
 * 优先读编辑器存下的草稿，读不到用内置的 L3；**草稿坏掉也退回 L3** —— 编辑器里手改 JSON
 * 很容易改坏，那时最需要的是"还能打开、还能改回去"，而不是白屏。
 *
 * 注意这里只管**字形层**（`parseLevel`）。"玩不玩得了"（出生点站不住）在下面另一处兜 ——
 * 那是编辑器新建空白关卡时的常态，绝不能让它白屏。
 */
function pickLevel(): { readonly def: LevelDef; readonly level: Level } {
  const fallback = parseLevel(L3);
  if (!fallback.ok) {
    throw new Error(`连内置的 L3 都不合法：${JSON.stringify(fallback.errors)}`);
  }
  // `#blank` = 直接从空白关卡开始（不碰草稿）。给编辑器当一个"干净起点"的入口，
  // 也让无头截图能验"空白关卡不会白屏"这一条（`Tab` 是按键，截图工具按不了）。
  if (window.location.hash === '#blank') {
    const blank = parseLevel(BLANK);
    if (blank.ok) return { def: BLANK, level: blank.level };
  }
  const stored = loadStoredLevel();
  if (stored === null) return { def: L3, level: fallback.level };
  const parsedStored = parseLevel(stored);
  if (!parsedStored.ok) return { def: L3, level: fallback.level };
  return { def: stored, level: parsedStored.level };
}

const picked = pickLevel();

/**
 * 这一局的关卡数据（编辑器读写的就是它）。
 *
 * **是 `let`**（T21）：编辑器"应用"时要**当场换一关**（阶段 2 的热重建），而不是刷新页面。
 */
let levelDef: LevelDef = picked.def;
let level: Level = picked.level;
let spawn: Cell = levelDef.spawn ?? L3_SPAWN;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
host.appendChild(renderer.domElement);

const camera = createCamera();

/**
 * **场景容器由这里持有、一生只有一个**（T21）。
 *
 * 换关卡时重建的是**内容**（`createStage(level, scene)` + `dispose()` 清空），容器不换 ——
 * 于是抓着 `scene` 引用的泛光、相机取景都不必跟着重建。这是"热重建"能便宜的前提。
 */
const scene = new THREE.Scene();

/**
 * 选择性泛光（用户裁定"需要"，第二次返工）。
 *
 * **它取代了 `renderer.render(...)`** —— 两条路只能走一条。为什么不能靠调 threshold：
 * 背景板线性亮度 ≈0.81 比所有物体（≈0.20–0.50）都亮，阈值分不开，见 `bloom.ts` 的推导。
 *
 * 声明**放在这里**（scene 一就位就建）而不是文件后半段：它抓着 `scene` 的引用，
 * 而 `resize()`（`buildWorld` 会调）要读它 —— 放在后面就会踩 TDZ
 * （`buildWorld` 可能在模块求值期间就被调用）。冒烟测抓到过这一条。
 */
const bloom = createSelectiveBloom(renderer, scene, camera, {
  width: window.innerWidth,
  height: window.innerHeight,
});

let stage: Stage = createStage(level, scene);

/**
 * sim 初态。出生点摆错、或者整张关卡还没有可站立的位置，`createSim` 都会**当场抛** ——
 * 那是给"内置关卡写错了"准备的闸门。
 *
 * 但**草稿**不一样：编辑器新建的空白关卡必然是这样的（两面板墙 + 水面，一个落脚点都没有）。
 * 那时候白屏是最糟的结局 —— 用户刚按下"新建空白关卡"，最需要的恰恰是**还能看见编辑器**。
 * 所以这里兜住：抛了就进"**只能看、不能玩**"的状态（`state === null`），
 * 场景照旧渲染、编辑器照旧打开、问题照旧列出来。
 */
let state: SimState | null = null;

/** 实体层（角色）。它只读 state，不推进 sim。 */
let syncer: Syncer = createSyncer(scene, level);

/**
 * 特效层（临时记号）与音效（2026-09-19，用户要的"哑火反馈"）。
 *
 * 两者都**只吃事件流**，与 `syncer` 吃状态是两种东西：`syncer` 每帧对账"现在是什么样"，
 * 这两个只关心"刚刚发生了一件事"。
 */
let fx: Fx = createFx(scene, level);
const sfx = createSfx();

/**
 * **上一帧贴给渲染层的网格 / 宝物表**（引用比较用）。
 *
 * 声明在这里（而不是贴着 `stage.setGrid` 那几句）是因为 `buildWorld` 也要读写它们 ——
 * 而 `buildWorld` 可能在模块求值**期间**就被调用。放在后面会踩 TDZ：
 * `ReferenceError: Cannot access '...' before initialization`（冒烟测当场抓到的）。
 */
let lastGrid: readonly TileKind[] = currentGrid();
let lastTreasures: readonly DeckCell[] = currentTreasures();

/** 键盘（T7）。它只产出 `Intents`，不碰 sim —— 方向映射与"轻点锁存"都在 `./input` 里。 */
/**
 * 玩家此刻站在哪种面 —— 输入层用它决定"这个键是什么方向"（键位按面分，见 `input.ts`）。
 * 出处只有 `surfaceOf`；这里只负责"玩家是谁"（与 HUD 那段用的是同一个找法）。
 */
function playerSurface(): Surface {
  const walker = state?.entities.find((e) => e.kind === 'player');
  return walker === undefined ? 'wall' : surfaceOf(walker.cell);
}

const input = createInput(window, playerSurface);

/** 玩家固定是 `entities[0]`（`sim.ts` 的契约），所以 id 恒为 0。 */
const PLAYER_ID = 0;

/**
 * 这一帧里 sim **真的拿玩家的方向做了事**吗？只有真的做了事，才该把输入层锁存的那一下销账。
 *
 * 三种都算"做了事"：`entered`（走了一格）、`fell`（踩空落到下面一格）、
 * `drowned`（朝水里迈了一步、当场淹死）。
 *
 * `drowned` 必须算 —— 否则 T9 扣命重生之后，那一下没销账的按键会让角色在出生点**立刻**
 * 再朝淹死的方向迈一步（这是"锁存"这个机制自带的陷阱：欠着的一步总要在某个时刻兑现）。
 *
 * **`blocked` 刻意不算**：撞墙不产生事件（见 `sim.ts` 的说明）。代价是"对着墙轻点一下、
 * 之后地形又开了"时角色会自己迈一步；换来的是"撞墙不消耗步进冷却"这条手感，以及不必为了
 * 区分"暂时忙（冷却）"和"永久堵（墙）"而给 core 加一个它本来明确不想要的事件。
 *
 * 写成 `switch` 而不是 `some(e => e.kind === ...)`：`SimEvent` 是联合类型，
 * 用 `switch` 之后漏掉某个变体会被 TS 逮住（`gameover` 就没有 `entity` 字段，
 * 用 `.some` 一视同仁地读 `e.entity` 会当场报错 —— 那次报错是对的）。
 */
function actedOn(frame: { readonly events: readonly SimEvent[] }): boolean {
  return frame.events.some((e) => {
    switch (e.kind) {
      case 'entered':
      case 'fell':
      case 'drowned':
      // `buried`（T11 活埋）与 `drowned` **同类**：它也是一次死亡 + 回出生点，
      // 所以同样必须销账。漏掉它的话，重生之后那一下欠着的按键会立刻兑现在出生点上。
      case 'buried':
        return e.entity === PLAYER_ID;
      case 'dug':
        // 挖**不是一步**：不消耗步进冷却（core 里挖与移动是两件事），
        // 而且挖键在输入层就不锁存（见 `input.ts`），这里没有账可销。
        return false;
      case 'filled':
        // 洞自己长回来 —— 谁也没动。
        return false;
      case 'respawned':
        // 重生本身不代表"这一步被兑现了"（它是落水那一步的后果，落水那一步已经销过账）。
        return false;
      case 'gameover':
        return false;
      case 'collected':
        // 采宝是"走到那儿"的**结果**，不是一步 —— 造成它的那一步已经报过 `entered` 销过账了。
        // （玩家恰好生成在宝物上时只会单独出现这一条，那是测试构造的状态，也没有账要销。）
        return false;
      case 'opened':
        // 开闸是环境变化（闸门格从硬砖变梯子）—— 谁也没动。
        return false;
      case 'won':
        // 过关即终局，`tick` 之后会冻住实体；这里没有"欠着的按键"要兑现。
        return false;
    }
  });
}

/**
 * T8 语义校验。`parseLevel`（上面那次）只看字形；这一层看"这张关卡作为一个**能玩通的关**"
 * 站不站得住（可达性 / 悬空出口 / 断梯 …）。
 *
 * 它内部会再 parse 一次 —— 启动时这点开销换来的是"关卡数据只有一个入口"，
 * 不值得为了省这一次而把 parse 结果在几层之间传来传去。
 */
let levelIssues = validateLevel(levelDef, spawn);

const hud = createHud(host);

/**
 * 运行时日志（用户 2026-09-19 要的）：**非预期的东西必须看得见**。
 *
 * 只往 `console` 里报等于没报 —— 用户看到的是一个"行为有点怪但还在跑"的画面，没有任何线索。
 * 这里先接两条全局钩子：未捕获的异常、未处理的 Promise。它们平时不出现，一旦出现就是真问题。
 */
window.addEventListener('error', (e) => {
  hud.log(`✗ 异常：${e.message} @ ${e.filename}:${e.lineno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  hud.log(`✗ 未处理的 Promise：${String(e.reason)}`);
});
hud.log(`构建 ${__BUILD_STAMP__}`);
hud.log(`关卡 ${levelDef.id}（${level.cols}×${level.rows}, fold=${level.fold}）`);
if (levelIssues.length === 0) hud.log('关卡校验：通过');
else for (const issue of levelIssues) hud.log(`✗ 关卡校验 ${issue.rule}：${issue.detail}`);

/**
 * **换一关**（T21 阶段 2）：数据换掉、场景**当场重建**、sim 重开 —— 不刷新页面。
 *
 * ## 哪些换、哪些不换
 *
 * 不换的是**与关卡无关**的那些：`renderer` / `camera` / `scene`（容器）/ `bloom` / `input` /
 * `hud` / `editor` / `sfx`。换的是**与关卡有关**的：`levelDef` / `level` / `spawn` /
 * `levelIssues` / `stage` / `syncer` / `fx` / `state`。
 *
 * 顺序有讲究：**先解析、再拆旧、最后建新**。反过来的话，一次解析失败就会留下一个**空场景** ——
 * 比报错更难看，而且用户不知道发生了什么。
 *
 * `state` 可能又是 `null`（新关卡仍然"只能看不能玩"）—— 那正是编辑过程中的常态。
 */
function buildWorld(def: LevelDef): void {
  const parsedDef = parseLevel(def);
  if (!parsedDef.ok) {
    // 调用方（编辑器）已经用 `decodeLevel` 拦过一道，走到这里说明是内部调用写错了。
    hud.log(`✗ 换关失败：字形层不合法（${parsedDef.errors.length} 条）`);
    return;
  }

  // ① 数据
  levelDef = def;
  level = parsedDef.level;
  spawn = levelDef.spawn ?? L3_SPAWN;
  levelIssues = validateLevel(levelDef, spawn);

  // ② 拆旧
  syncer.dispose();
  fx.dispose();
  stage.dispose();

  // ③ 建新（同一个 `scene` 容器）
  syncer = createSyncer(scene, level);
  fx = createFx(scene, level);
  stage = createStage(level, scene);

  try {
    state = createSim(levelDef, spawn);
  } catch (e) {
    state = null;
    hud.log(`✗ 这一关现在不能玩：${e instanceof Error ? e.message : String(e)}`);
    hud.log('补上地面 / 出生点，再按「应用」。');
  }

  lastGrid = currentGrid();
  lastTreasures = currentTreasures();
  stage.setGrid(lastGrid);
  stage.setTreasures(lastTreasures);

  // ④ 收尾：关卡尺寸可能变了 → 重新取景；HUD 与输入锁存也要跟上。
  resize();
  input.consume();
  refreshHud();
  syncIssueMarks();
}

/**
 * 把"**有问题的格子**"画到场景里（只在编辑器开着时）。
 *
 * 用户在编辑器里的原话是"校验出来的问题看的不是很明白" —— 面板上每条问题都写着 `A:0,1`，
 * 但那要他自己在场景里找。把格子框出来，文字与画面才对得上。
 *
 * 只列 `at` **存在**的那些：有些问题（`noExit`、`unreachable` 的汇总）落不到某一格上，
 * 硬指一格比不指更误导。
 */
function syncIssueMarks(): void {
  if (!editor.isOpen()) {
    fx.markIssues([]);
    return;
  }
  fx.markIssues(
    levelIssues
      .filter((i): i is LevelIssue & { readonly at: Cell } => i.at !== undefined)
      .map((i) => ({ at: i.at, severity: i.severity })),
  );
}

/**
 * **关卡编辑器**（T21，按 `Tab` 开关）。
 *
 * 阶段 1 做"存取 + 校验"，阶段 2 让"应用"变成**热重建**（`buildWorld`，不刷新页面）——
 * 于是改完立刻看到，"所见即所得"。
 *
 * 编辑期间**把 sim 停住**（见下面 tick 循环里的 `editor.isOpen()`）：不然玩家站在原地，
 * 追兵会把他抓住、屏幕上闪一个 GAME OVER，而用户正在改 JSON。
 */
const editor = createEditor(host, {
  apply(text: string): string | null {
    const decoded = decodeLevel(text);
    if (!decoded.ok) return decoded.error;
    // 存草稿失败**不阻止换关** —— 编辑器照样热重建，只是下次打开时读不到这一版。
    const stored = storeLevel(decoded.def);
    buildWorld(decoded.def);
    editor.show(levelDef, spawn, levelIssues);
    return stored ? null : '已应用，但**存不进浏览器存储**（隐私模式 / 配额满）：下次打开会读不到这一版';
  },
  createBlank(): void {
    clearStoredLevel();
    storeLevel(BLANK);
    buildWorld(BLANK);
    editor.show(levelDef, spawn, levelIssues);
  },
  check(text: string): readonly string[] {
    // 查的是**文本框里的那张**（见 `./editor` 里那条注释）：先用同一个 `decodeLevel` 过字形层，
    // 再拿**同一个** `validateLevel` 查规则 —— 与「应用」走的是同一条判据，不另写一份近似。
    const decoded = decodeLevel(text);
    if (!decoded.ok) return [`✗ 读不出来：${decoded.error}`];
    const def = decoded.def;
    const issues = validateLevel(def, def.spawn);
    if (issues.length === 0) return ['✓ 合法：字形层通过，全部规则通过', `  （${def.id}）`];
    const errors = issues.filter((i) => i.severity === 'error');
    const warns = issues.filter((i) => i.severity === 'warn');
    return [
      `✗ ${errors.length} 个错误、${warns.length} 条提醒：`,
      // **红框 = 错误、灰框 = 提醒**（见 `render/fx.ts`）：提醒可以在，错误必须改。
      ...issues.map((i) => `  ${i.severity === 'error' ? '✗' : '⚠'} ${RULE_TITLES[i.rule]}：${i.detail}`),
    ];
  },
});
hud.log('按 Tab 打开关卡编辑器');

/**
 * **探针跑之前先原地热重建一次**（T21）。
 *
 * `createStage` / `dispose` / `syncer` / `fx` 这一整套重建路径**没有任何单测能覆盖**
 * （它们都要 three，而架构红线禁止测试里 import three）。而 `?probe` 走的是**真实产物** ——
 * 于是最便宜的守门办法就是：探针模式下先重建一遍再出图。
 *
 * 这条不是"为了测试而写的代码"，而是**把探针的范围扩到它本来就该覆盖的地方**：
 * 换关卡之后场景还画不画得出来，是产物级的问题，只有产物级的手段能验。
 */
if (new URLSearchParams(window.location.search).has('probe')) buildWorld(levelDef);

/**
 * **试着起一局**（T21）。起不来就进"只能看、不能玩"。
 *
 * `createSim` 对"出生点站不住"是**当场抛**的 —— 那是给内置关卡写错准备的闸门。
 * 但草稿不一样：编辑器"新建空白关卡"给的正是两面板墙 + 水面、一个落脚点都没有，
 * 而那一刻用户最需要的恰恰是**还能看见编辑器**。所以这里兜住：
 * `state` 留 `null`，场景照旧渲染、编辑器照旧能开、问题照旧列出来。
 */
try {
  state = createSim(levelDef, spawn);
} catch (e) {
  hud.log(`✗ 这一关现在不能玩：${e instanceof Error ? e.message : String(e)}`);
  hud.log('按 Tab 打开编辑器，补上地面 / 出生点，再按「应用并重载」。');
}

// `#edit` 直接打开编辑器（方便收藏、也方便无头截图验它 —— `Tab` 是按键，截图工具按不了）。
// `#blank` 也一并打开：从空白起手本来就是"我要开始画一张"，编辑器不开没有意义。
if (window.location.hash === '#edit' || window.location.hash === '#blank') {
  editor.toggle();
  editor.show(levelDef, spawn, levelIssues);
  syncIssueMarks();
}

/**
 * **编辑器落笔**（T21 阶段 3）：鼠标点一下 → 命中点 → 格子 → 落笔 → 热重建。
 *
 * 三层各司其职（见 `./editor` 的文件头）：命中点 → 格子是 `render/pick.ts`（纯几何），
 * 格子 + 笔 → 新关卡是 `core/level/paint.ts`（纯函数），画出来是 `buildWorld`。
 * **这里只做连接**，一条判据都不重新推。
 *
 * 两个刻意的选择：
 *
 * - **只认左键**：右键留给"擦除"这类后续手势，现在按了什么都不做（比"误画一笔"好）；
 * - **悬停实时报格子**：折痕那一对在世界里重合、拾取只能给一个，所以"我到底指着哪一格"
 *   必须看得见 —— 那条信息就显示在工具栏下面。
 */
const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

/** 屏幕坐标 → 场景里的格子。没射中任何东西 → `null`。 */
function cellUnderPointer(e: MouseEvent): Cell | null {
  const rect = renderer.domElement.getBoundingClientRect();
  pointerNdc.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointerNdc, camera);
  const first = raycaster.intersectObjects(scene.children, true)[0];
  if (first === undefined) return null;
  return cellFromPoint(level, [first.point.x, first.point.y, first.point.z]);
}

/** 编辑器开着、而且不是在点面板的时候，才回答"指着哪一格"。 */
function editorTarget(e: MouseEvent): Cell | null {
  if (!editor.isOpen()) return null;
  if (editor.el.contains(e.target as Node | null)) return null;
  return cellUnderPointer(e);
}

// ── 拖笔：按住左键划过的地方连续落笔（用户 2026-09-21 要的） ──
//
// 两个问题各有各的解，都不是"调个参数"能糊过去的：
//
// - **同一格被重复画**：鼠标停在一格里会连发 `mousemove`。所以记下**这一笔里画过哪些格**，
//   同一格只画一次 —— 否则每次 `mousemove` 都重写一遍同一个字形；
// - **卡顿**：每落一笔就 `buildWorld`（整场重建，几毫秒）。快划一下会连做几十次，
//   于是重建**按帧合并**：落笔立刻进数据（下一笔接着算），画面在下一帧追上。
//   关键是"下一笔"必须从**待建的那一份**接着算（`queued ?? levelDef`），
//   否则同一帧里的几笔会各自从旧数据出发，只剩最后一笔生效。
//
// 状态声明在这些监听器**之前**：延迟执行的函数里读到后面声明的变量，是这类改动最经典的
// TDZ 事故（这一轮已经栽过一次：`buildWorld` 读到后面的 `bloom`）。
let painting = false;
let paintedThisStroke = new Set<string>();
let queued: LevelDef | null = null;
let queuedRaf = 0;

function flushQueued(): void {
  queuedRaf = 0;
  const def = queued;
  queued = null;
  if (def === null) return;
  buildWorld(def);
  editor.show(levelDef, spawn, levelIssues);
}

function schedule(next: LevelDef): void {
  queued = next;
  storeLevel(next);
  if (queuedRaf === 0) queuedRaf = requestAnimationFrame(flushQueued);
}

/** 在某一格落一笔（同一笔里同一格只画一次）。 */
function paintAt(at: Cell): void {
  const key = cellKey(at);
  if (paintedThisStroke.has(key)) return;
  paintedThisStroke.add(key);
  const base = queued ?? levelDef;
  const next = paint(base, editor.brush(), at);
  if (next === base) return; // 画不动（越界 / 同一个字形）→ 不进队列
  schedule(next);
  editor.noteCell(at);
}

window.addEventListener('mousemove', (e) => {
  if (!editor.isOpen()) return;
  const at = editorTarget(e);
  editor.noteCell(at);
  if (painting && at !== null) paintAt(at);
});

renderer.domElement.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  const at = editorTarget(e);
  if (at === null) return;
  painting = true;
  paintedThisStroke = new Set();
  paintAt(at);
});

window.addEventListener('mouseup', () => {
  if (!painting) return;
  painting = false;
  paintedThisStroke.clear();
  // 松手立刻把队列里那一版画出来，不等下一帧 —— 否则最后落下的几笔要等一拍才出现。
  if (queuedRaf !== 0) {
    cancelAnimationFrame(queuedRaf);
    flushQueued();
  }
});

// 拖出窗口 / 切走标签页时也要收笔，否则回来还在"按住"状态、鼠标一动就落笔。
window.addEventListener('blur', () => {
  painting = false;
  paintedThisStroke.clear();
});

/**
 * 值得进日志的 sim 事件 —— 挑的都是"玩法上出了事"的那种。
 *
 * **不记** `entered` / `fell` / `filled`：那些每走一步都有，会把面板刷屏、把真问题淹掉。
 * 记的每一种都能直接对上用户的一句报障："走过那几块砖的时候它把我埋了" →
 * `t123 buried A:7,1`。
 */
const LOGGED_EVENTS: ReadonlySet<SimEvent['kind']> = new Set([
  'dug',
  'drowned',
  'caught',
  'buried',
  'downed',
  'respawned',
  'returned',
  'collected',
  'opened',
  'won',
  'gameover',
]);

/**
 * 相机的屏幕右轴 / 上轴（世界向量）。方向提示用它把"世界位移"投到屏幕上。
 *
 * 与 `test/input.test.ts` 里钉"折痕对输入透明"那两条用的是**同一对轴**：那边从
 * `matrixWorld.elements` 的两列取（列主序：第 0 列 = 屏幕向右、第 1 列 = 屏幕向上），这里同理。
 */
function screenAxes(): ScreenAxes {
  camera.updateMatrixWorld();
  const e = camera.matrixWorld.elements;
  return {
    right: [e[0] ?? 0, e[1] ?? 0, e[2] ?? 0],
    up: [e[4] ?? 0, e[5] ?? 0, e[6] ?? 0],
  };
}

function refreshHud(): void {
  // `state === null` = 这一关"只能看、不能玩"（见 `state` 那段）。HUD 照旧有内容 ——
  // 用户这时最需要的是**知道为什么不能玩**，而不是一片空白。
  if (state === null) {
    hud.set([
      `立方角隙 · ${level.name}（折面 · 浅色版）`,
      `${level.id}：${level.cols}×${level.rows}，fold=${level.fold}`,
      '⚠ 这一关现在**不能玩**：还没有可站立的出生点。',
      '按 Tab 打开编辑器补上地面 / 出生点，再按「应用并重载」。',
      `构建 ${__BUILD_STAMP__}`,
      ...(levelIssues.length === 0
        ? []
        : [`⚠ 关卡校验 ${levelIssues.length} 条：`, ...levelIssues.map((i) => `  · ${i.detail}`)]),
    ]);
    return;
  }

  const player = state.entities[0];
  const at =
    player === undefined
      ? '—'
      : `${player.cell.face}:${player.cell.col},${player.cell.row}（${player.mode}）`;
  hud.set([
    `立方角隙 · ${level.name}（折面 · 浅色版）`,
    `${level.id}：${level.cols}×${level.rows}，fold=${level.fold} —— 每面 ${level.fold}×${level.rows}`,
    `砖 ${stage.counts.brick ?? 0}/${stage.counts.brickSlots ?? 0} 槽 ｜ 梯 ${stage.counts.ladder ?? 0} ｜ 杆 ${stage.counts.bar ?? 0} ｜ 芯片 ${stage.counts.chip ?? 0} ｜ 出口 ${stage.counts.exit ?? 0} ｜ 岛台宝物 ${stage.counts.prize ?? 0}`,
    // 命数必须可见：它是玩家做决策要看的第三个数（前面是"还剩几块宝物"和"闸门开没开"）。
    // 之前漏了这一项，代价是**试玩时看不出自己掉没掉命** —— 用户报"角色回到出发点"时，
    // HUD 显示不出来"那是因为摔死重生"，于是只能靠猜。三行数字里它最便宜、信息量最高。
    `角色 ${at} ｜ 命数 ${state.lives} ｜ tick ${state.tick} ｜ ${state.status}`,
    // T13：目标状态。这两个数是玩家做决策要看的 —— "还剩几块"决定还有多远，
    // 闸门开没开决定现在能不能去出口。**刻意不显示宝物在哪**：那是玩家该自己找的。
    `宝物 ${state.treasures.length === 0 ? '已集齐' : `还剩 ${state.treasures.length} 块`} ｜ 出口闸门 ${state.gatesOpen ? '已开' : '封着（集齐才开）'}`,
    '方向键 / WASD（墙上 `w`/`s` 上下、`a`/`d` 沿墙；甲板 `w`↖ `s`↘ 纵深、`a`↙ `d`↗ 横向） ｜ 丁字路口按 `S` 拐上小道 ｜ 甲板 `Z`/`X` 换层（塔） ｜ `Q` 后下方挖 / `E` 前下方挖 ｜ `R` 重开',
    // 用户反复反馈"WASD 在拐角与岛台上完全不准"。**不换映射** —— 实测在这个相机下
    // 无解（甲板是水平面、方位角又是 45°，两个轴在屏幕上都投成 (±0.7,∓0.3)）；
    // 能做的是把每个键实际会往屏幕哪边走如实报出来。推导见 render/hints.ts。
    ...(player === undefined
      ? []
      : [
          formatDirHints(
            dirHints(level, player.cell, player.mode, screenAxes(), bridgesOf(state)),
            surfaceOf(player.cell),
            keyLabel,
          ),
        ]),
    // 教学提示（T14）：来自**关卡数据**（`LevelDef.hints`），不写死在 app 里 ——
    // 换一关就换一套（写死会变成一串 `if (levelId === …)`，那是把数据藏进代码）。
    // 原先那两行写死的"挖开的地板 4 秒后…""取到宝物后闸门变梯子"已并入 L1 的 hints。
    ...(levelDef.hints ?? []).map((hint) => `· ${hint}`),
    // 构建时间戳：`dist-single/index.html` 是**产物**，不 `npm run pack` 就不会跟着源码变。
    // 这一行让"我现在跑的到底是哪个构建"变成一眼可见（已经因为这个白绕过两次）。
    `构建 ${__BUILD_STAMP__}（改了源码要 npm run pack 才会变）`,
    ...(state.status === 'won' ? ['★ 过关！'] : []),
    // 校验结果直接进 HUD。关卡不合法**必须看得见** —— 只在控制台里报，等于没报。
    // 通过时这段是空的，HUD 与以前逐字一样。
    ...(levelIssues.length === 0
      ? []
      : [`⚠ 关卡校验 ${levelIssues.length} 条：`, ...levelIssues.map((i) => `  · ${i.detail}`)]),
  ]);
}
refreshHud();

/**
 * 死亡 / 终局的大字提示。**钩子早就在事件流里**（`sim.ts` 的 `SimEvent`：
 * `drowned` / `buried` / `respawned` / `gameover`）—— 这里只是把它显示出来。
 *
 * 为什么非有不可：落水在 `sim` 里是**同一个 tick** 内完成的（扣命 → 重生回起点），
 * 画面上除了"命数少 1"没有任何可见事件，于是玩家只能靠猜（用户的原话：
 * "死了以后至少应该有个短暂的 UI 提示或者过渡，好知道死了"）。
 *
 * 计时用**壁钟**（`performance.now()`，与 rAF 的时间戳同源），不是 tick 数：
 * 提示该显示多久是给人看的，不该随帧率或补 tick 变化。
 */
const DEATH_FLASH_MS = 1200;

/** 计时中的大字提示的到期时刻；`null` = 当前没有计时中的提示（可能是常驻那条）。 */
let bannerUntil: number | null = null;

/** 限时提示（死亡反馈）。 */
function flash(text: string, ms: number): void {
  hud.flash(text);
  bannerUntil = performance.now() + ms;
}

/** 常驻提示（终局：等 `Backspace` 重开）。 */
function flashForever(text: string): void {
  hud.flash(text);
  bannerUntil = null;
}

/**
 * 重开这一局（T21 的状态机收口）。
 *
 * ## 为什么它不在 `input.ts`
 *
 * 那一层的契约是"**每 tick 采样的电平**意图"（移动 / 挖），有一整套纯函数状态机与 19 条测试。
 * 而重开是一次性**命令** —— 把它采样成电平毫无意义（按住不该每 tick 重开一次），
 * 也犯不着为它动那一层的契约。所以在这里直接监听：一次按键就是一次动作。
 *
 * ## 为什么要它
 *
 * 没有它的话，`gameover` 与 `won` 之后这一局**没有任何出口**，只能刷新页面 ——
 * 而 HUD 那时正写着"★ 过关！"，那句话会变成一条死路。这也是 `SimStatus` 的两个终局态
 * 第一次真正需要一条"回去"的路。
 *
 * ## 网格为什么不用手动重贴
 *
 * `createSim` 每次都从 `parseLevel` 拿一份**新的** `grid` 数组，所以下面循环里那条
 * `state.grid !== lastGrid` 的引用比较自然会认出来并重贴（闸门也就会重新封上）。
 */
function restart(): void {
  // "只能看、不能玩"的关卡没有可重开的东西 —— 别在这里再抛一次（那会把白屏换成一个崩溃提示）。
  if (state === null) return;
  state = createSim(levelDef, spawn);
  // 重开要**把输入层那笔欠账销掉**（`latched`）：否则重开前刚按下的那一下会被
  // 欠到新一局，在第一步兑现成一个玩家没想要的方向。`consume` 只清 `latched`、
  // 不动 `held` —— 正按着不放的方向应当继续有效，这与 `input.ts` 里
  // "松手不动 latched、消费才清 latched" 是同一套语义。
  input.consume();
  // 收掉 GAME OVER / 过关那条**常驻**提示（限时提示到点会自己收，见 loop 里那段）。
  hud.flash(null);
  bannerUntil = null;
  refreshHud();
}

/**
 * 重开的键（`R`，用户 2026-09-19 定稿）。`R` 一度让给"前挖"，甲板改用经典等轴测映射之后
 * `E` 空出来、"前挖"回到 `E`，`R` 于是回到它通用的位置。
 */
const RESTART_KEY = 'r';

window.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() !== RESTART_KEY) return;
  // 编辑器开着的时候不抢键：那时用户可能在 JSON 里写 `"r"`。
  if (editor.isOpen()) return;
  e.preventDefault();
  restart();
});

/**
 * `Tab` 开关编辑器；`Esc` 关掉。
 *
 * **焦点在编辑器里时不抢 `Tab`** —— 那里面有 `<textarea>`，`Tab` 该是正常的焦点移动。
 * 所以判据是"事件目标在编辑器面板之外"。
 */
window.addEventListener('keydown', (e) => {
  const insideEditor = editor.el.contains(e.target as Node | null);
  if (e.key === 'Escape' && editor.isOpen()) {
    editor.toggle();
    syncIssueMarks();
    return;
  }
  if (e.key !== 'Tab' || insideEditor) return;
  e.preventDefault();
  if (editor.toggle()) editor.show(levelDef, spawn, levelIssues);
  syncIssueMarks();
});

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  // 两个 composer 的缓冲尺寸也要跟：漏掉它，泛光会按旧尺寸采样（换窗口后糊掉）。
  bloom.setSize(w, h);
  // 视锥跟着**关卡内容**走（`stage.bounds`）—— 写死过一个 6.5 的半径，
  // 关卡放大到 20×12 时顶行的出口直接跑到画面外（`probe` 报的）。
  fitCamera(camera, stage.bounds, w / h);
}

/**
 * 像素探针的页面侧钩子。只在 `?probe=1` 时跑 —— 正常玩不付这份开销。
 * 结果塞进一个隐藏的 `<pre id="probe">`，由 `tools/probe.mjs` 用 `--dump-dom` 抠出来。
 */
const probeRequested = new URLSearchParams(window.location.search).has('probe');
let probed = false;

function reportProbe(): void {
  if (probed) return;
  probed = true;

  const summary = probePixels(renderer);
  // 把"state 说角色在哪"和"像素说角色在不在"**一起**报出去 —— 两者对不上时，
  // 一眼就能分出是模拟错了还是渲染错了。这正是探针存在的意义。
  const payload = {
    level: level.id,
    // 场景（砖/梯/杆/芯片/出口/宝物）来自 `stage`，**实体**（玩家/无人机）来自 `syncer` ——
    // 两边都是**渲染层自己的账**，探针据此判断"声明了就该画出来"。
    counts: { ...stage.counts, ...syncer.counts() },
    // "只能看、不能玩"的关卡没有 sim —— 探针照旧出数（`null` 就是它的答案），
    // 而不是让探针自己崩掉。
    sim:
      state === null
        ? null
        : { tick: state.tick, status: state.status, entities: state.entities.length },
    playerExpect: playerExpectation(),
    ...summary,
  };

  const pre = document.createElement('pre');
  pre.id = 'probe';
  pre.style.display = 'none';
  pre.textContent = `PROBE:${JSON.stringify(payload)}`;
  document.body.appendChild(pre);
}

/**
 * 定步长累加器（T4 的契约）：sim 按 `TICK_HZ` 走，渲染则浏览器给多少帧就走多少帧。
 *
 * 一次 dt 最多补 `MAX_CATCHUP_MS` 的 tick —— 切标签页回来时 `now - last` 可能是好几秒，
 * 不夹住的话会当场跑几百个 tick 把页面卡死。
 */
/**
 * 把"**算**出来的角色位置"投影成屏幕像素，交给探针去跟"**画**出来的那一坨"对账。
 *
 * 这条链路专治本项目的老病：单测能证明 `playerAnchor` 算得对，却证明不了 `meshSync` 真的用了它 ——
 * 两处各自自洽、合起来不对，正是历次 bug 的共同形状。有了这个投影，"角色到底站在哪"
 * 就从"我看了一眼觉得没问题"变成了一个可断言的数字。
 *
 * 坐标系必须与 `readPixels` 一致（原点**左下角**），所以 y 用 `(ndc.y + 1) / 2`。
 */
function playerExpectation(): {
  x: number;
  y: number;
  halfPx: number;
  /** `meshSync` 真正写进 mesh 的那个位置（补间之后）。 */
  mesh: { x: number; y: number } | null;
} | null {
  const player = state?.entities[0];
  if (player === undefined) return null;

  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const toPx = (p: readonly [number, number, number]): { x: number; y: number } => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera); // render() 已刷新相机矩阵
    return { x: ((v.x + 1) / 2) * w, y: ((v.y + 1) / 2) * h };
  };

  const anchor = playerAnchor(level, player.cell, player.mode);
  const centre = toPx(anchor);
  const above = toPx([anchor[0], anchor[1] + PLAYER_SIZE / 2, anchor[2]]);

  const meshAt = syncer.positionOf(player.id);
  return {
    x: centre.x,
    y: centre.y,
    halfPx: Math.abs(above.y - centre.y),
    mesh: meshAt === null ? null : toPx(meshAt),
  };
}

const STEP_MS = 1000 / TICK_HZ;
const MAX_CATCHUP_MS = 250;

let last = 0;
let acc = 0;
let frames = 0;

/**
 * 上一次贴给墙的瓦片表（T11）。用**引用比较**做变更检测 —— 这不是侥幸：
 * `SimState.grid` 是不可变数组，只有 `applyDig` / `applyBackfill` 会换出新数组，
 * 其余每一帧都原样沿用 `prev.grid`。所以"引用变了"⇔"内容变了"，比逐格 diff 便宜且精确。
 */
/**
 * **现在**该画哪张网格 / 哪张宝物表（T21）。
 *
 * 写成函数而不是就地取值的理由很实在：`state` 在模块顶层被 TS 收窄成 `null`（它只在后面的
 * 函数里被赋值，TS 不做跨函数推断），于是 `state.grid` 在那里是 `never`。放进函数里读，
 * TS 用的是**声明类型**（`SimState | null`），收窄问题自然消失。
 *
 * `state === null`（只能看不能玩）时给的就是**关卡原始数据** —— 那正是"编辑器里的样子"。
 */
function currentGrid(): readonly TileKind[] {
  return state?.grid ?? level.grid;
}
function currentTreasures(): readonly DeckCell[] {
  return state?.treasures ?? level.treasures;
}

/**
 * 把关卡的**初始状态**推给渲染层。
 *
 * `createStage(level)` 只能读到**关卡原始数据**（`level.grid` / `level.treasures`），
 * 而 `state` 才是真相：重开一局、将来的换关、以及任何"开局就不是原始状态"的场合
 * （比如闸门已开）都可能与关卡文件不同。少了这一步，会看到"闸门开了却没有梯子"
 * "宝物已经取走了却还画着" —— 两件都真实发生过（用户："取了宝物没有任何反应"。）
 */
stage.setGrid(lastGrid);
stage.setTreasures(lastTreasures);

function loop(now: number): void {
  if (last === 0) last = now;
  const elapsedMs = Math.min(Math.max(now - last, 0), MAX_CATCHUP_MS);
  last = now;
  acc += elapsedMs;

  // "只能看、不能玩"（出生点站不住）→ 没有 sim 可推，只画场景。
  // 编辑器开着 → **sim 停住**（见 `editor` 那段）。`acc` 照样清空：留着它的话，关掉编辑器的
  // 那一帧会一次性补跑几十个 tick（追兵瞬间扑上来），那是"暂停"最经典的坑。
  if (state === null || editor.isOpen()) acc = 0;
  if (state === null) {
    fx.update(elapsedMs / 1000);
    stage.update(now / 1000);
    bloom.render();
    requestAnimationFrame(loop);
    return;
  }

  // 每个 tick 采一次输入**电平**：一次 dt 可能跨好几个 tick，"按住"在这几个 tick 里都有效。
  // 输入锁存：兑现了才销账 —— 否则轻点会被冷却窗口吃掉。
  //
  // 顺带把"本帧哪些实体瞬移了"收出来（目前只有重生这一种）。事件流现在有两个消费者：
  // 输入销账、同步层的就地落位（T20 的特效会是第三个）。
  let snapped: Set<number> | null = null;
  // 玩家是谁 —— 死亡提示只该为**玩家**亮。见下面那段"必须看是谁"。
  const playerId = state.entities.find((e) => e.kind === 'player')?.id;
  while (acc >= STEP_MS) {
    const intents = input.intents();
    const frame = tick(state, intents);
    state = frame.state;
    acc -= STEP_MS;
    if (actedOn(frame)) input.consume();
    for (const event of frame.events) {
      // 运行时日志：带 tick 与格号 —— 用户报"走过那几块砖的时候出的问题"时，这就是那句可直接对上话。
      if (LOGGED_EVENTS.has(event.kind)) {
        const where = 'cell' in event && event.cell !== null ? ` ${cellKey(event.cell)}` : '';
        hud.log(`t${frame.state.tick} ${event.kind}${where}`);
      }
      if (event.kind === 'digBlocked') {
        // **哑火反馈**（用户 2026-09-19）：按了挖、那一铲落在空处。
        // 只做两件事，不做文字弹窗 —— 完全没反应会让玩家怀疑"按键失灵"，而弹字太打扰节奏。
        // 记号落在**目标格**上（`event.cell`），顺便教会玩家"这一铲是往哪儿去的"。
        sfx.dryFire();
        if (event.cell !== null) fx.blockedFlash(event.cell);
      }
      if (event.kind === 'respawned' || event.kind === 'returned') {
        // `returned` = 敌人被重置回家（玩家死亡时的追捕重置）。它同样是**瞬移** ——
        // 不列进来的话，敌人会从被杀的地方滑过整张地图回家（就是那个"飞"的坑）。
        if (snapped === null) snapped = new Set<number>();
        snapped.add(event.entity);
        continue;
      }
      // **跨接头的转折要掐掉"按住不放"**（用户 2026-09-19："按着 a 键会在到达墙面时自动
      // 转换方向，这是不对的"）。判据是世界方向：门两侧的键含义不同，按住不放会被带着拐进
      // 另一条走廊；而**折痕**是同一条走廊折了一下（`stepDelta` 两边给同一个方向）→ 不掐，
      // "沿走廊一直走就能过去"那条教学照旧成立。
      //
      // 高度（`bridges`）与方向无关，这里传 `undefined` 即可 —— 只看 x/z。
      if (event.kind === 'entered' && intents.move !== null && event.from.face !== event.cell.face) {
        const before = stepDelta(level, event.from, 'stand', intents.move);
        const after = stepDelta(level, event.cell, 'stand', intents.move);
        if (before !== null && after !== null && !sameWorldDirection(before.delta, after.delta)) {
          input.breakHold();
        }
      }
      // 死亡 / 终局的可见反馈。文案与"该不该亮"都在 `render/feedback.ts` 里（纯函数、可测）——
      // 那段映射以前写在这里，于是"机器人被活埋 → 提示玩家命 −1"这种 bug 没有测试能拦。
      const note = feedbackFor(event, playerId);
      if (note === null) continue;
      if (note.sticky) flashForever(note.text);
      else flash(note.text, DEATH_FLASH_MS);
    }
  }

  // 限时提示到点就收掉（壁钟口径，与 tick 数无关）。放在 tick 循环之后、画之前生效。
  if (bannerUntil !== null && now >= bannerUntil) {
    hud.flash(null);
    bannerUntil = null;
  }

  // 瓦片变了才重贴（T11）。放在 tick 循环**之后**：一次 dt 可能跨好几个 tick，
  // 中间那些帧的中间态没必要画出来，只看这一帧结束时的地形。
  if (state.grid !== lastGrid) {
    stage.setGrid(state.grid);
    lastGrid = state.grid;
  }
  // 宝物收走一颗就少一颗（T13）。与地形同一个道理：`state.treasures` 是事实，渲染层照着画。
  if (state.treasures !== lastTreasures) {
    stage.setTreasures(state.treasures);
    lastTreasures = state.treasures;
  }

  stage.update(now / 1000);
  // 特效层的时钟是**真实秒数**（与 `syncer` 同一个口径）：记号该在 0.15s 后消失，
  // 而那是"画面上过了多久"，不是"游戏推进了几 tick"。
  fx.update(elapsedMs / 1000);
  // 重生是**瞬移**，补间必须就地落位：`sim` 把 `fall → drowned → respawned` 压在同一个 tick 里，
  // 照常插值会把这一跳画成一条横穿场景的直线（用户报的"跳过缺口，回到起点处"）。
  syncer.update(state, elapsedMs / 1000, snapped === null ? undefined : { snapEntities: snapped });
  // 走选择性泛光而不是 `renderer.render` —— 泛光要靠它。两条路只能选一条。
  bloom.render();

  frames += 1;
  // 等第 2 帧再读：第 1 帧的阴影贴图可能还没成形。
  if (probeRequested && frames >= 2) reportProbe();
  else if (frames % 30 === 0) refreshHud(); // HUD 只给眼睛看，30 帧刷一次足够

  requestAnimationFrame(loop);
}

window.addEventListener('resize', resize);
resize();
requestAnimationFrame(loop);
