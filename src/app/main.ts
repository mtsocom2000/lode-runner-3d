import * as THREE from 'three';
import { CONCEPT_MINIMAL, PLAYER_SPAWN } from '../core/level/levels/conceptMinimal';
import { validateLevel } from '../core/level/validate';
import { TICK_HZ, createSim, tick, type SimEvent, type SimState } from '../core/sim';
import { parseLevel } from '../core/world/tiles';
import { createCamera, frameCamera } from '../render/camera';
import { createSyncer } from '../render/meshSync';
import { PLAYER_SIZE, playerAnchor } from '../render/metrics';
import { probePixels } from '../render/probe';
import { createStage } from '../render/scene';
import { createHud } from './hud';
import { createInput } from './input';
import { dirHints, formatDirHints, type ScreenAxes } from '../render/hints';
import { createSelectiveBloom } from '../render/bloom';

const host = document.getElementById('app');
if (!host) throw new Error('找不到 #app 挂载点（index.html 被改坏了？）');

// 关卡先过 parseLevel —— 数据不合法就没有"渲染一个关"这回事，早点炸比看着像空关卡强。
const parsed = parseLevel(CONCEPT_MINIMAL);
if (!parsed.ok) {
  throw new Error(`关卡 ${CONCEPT_MINIMAL.id} 数据不合法：${JSON.stringify(parsed.errors)}`);
}
const level = parsed.level;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
host.appendChild(renderer.domElement);

const camera = createCamera();
const stage = createStage(level);

/** sim 初态。出生点由关卡文件给出 —— 摆错位置是关卡 bug，`createSim` 会当场抛。 */
let state: SimState = createSim(CONCEPT_MINIMAL, PLAYER_SPAWN);

/** 实体层（角色）。它只读 state，不推进 sim。 */
const syncer = createSyncer(stage.scene, level);

/** 键盘（T7）。它只产出 `Intents`，不碰 sim —— 方向映射与"轻点锁存"都在 `./input` 里。 */
const input = createInput();

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
const levelIssues = validateLevel(CONCEPT_MINIMAL, PLAYER_SPAWN);

const hud = createHud(host);

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
  const player = state.entities[0];
  const at =
    player === undefined
      ? '—'
      : `${player.cell.face}:${player.cell.col},${player.cell.row}（${player.mode}）`;
  hud.set([
    '立方角隙 · 折面概念场景（浅色版）',
    `${level.id}：${level.cols}×${level.rows}，fold=${level.fold} —— 每面 ${level.fold}×${level.rows}（正好 3:2）`,
    `砖 ${stage.counts.brick ?? 0}/${stage.counts.brickSlots ?? 0} 槽 ｜ 梯 ${stage.counts.ladder ?? 0} ｜ 杆 ${stage.counts.bar ?? 0} ｜ 芯片 ${stage.counts.chip ?? 0} ｜ 出口 ${stage.counts.exit ?? 0} ｜ 岛台宝物 ${stage.counts.prize ?? 0}`,
    // 命数必须可见：它是玩家做决策要看的第三个数（前面是"还剩几块宝物"和"闸门开没开"）。
    // 之前漏了这一项，代价是**试玩时看不出自己掉没掉命** —— 用户报"角色回到出发点"时，
    // HUD 显示不出来"那是因为摔死重生"，于是只能靠猜。三行数字里它最便宜、信息量最高。
    `角色 ${at} ｜ 命数 ${state.lives} ｜ tick ${state.tick} ｜ ${state.status}`,
    // T13：目标状态。这两个数是玩家做决策要看的 —— "还剩几块"决定还有多远，
    // 闸门开没开决定现在能不能去出口。**刻意不显示宝物在哪**：那是玩家该自己找的。
    `宝物 ${state.treasures.length === 0 ? '已集齐' : `还剩 ${state.treasures.length} 块`} ｜ 出口闸门 ${state.gatesOpen ? '已开' : '封着（集齐才开）'}`,
    '方向键 / WASD 移动 ｜ Z 左挖 / X 右挖 ｜ R 重开本局',
    // 用户反复反馈"WASD 在拐角与岛台上完全不准"。**不换映射** —— 实测在这个相机下
    // 无解（甲板是水平面、方位角又是 45°，两个轴在屏幕上都投成 (±0.7,∓0.3)）；
    // 能做的是把每个键实际会往屏幕哪边走如实报出来。推导见 render/hints.ts。
    ...(player === undefined
      ? []
      : [formatDirHints(dirHints(level, player.cell, player.mode, screenAxes()))]),
    '挖开的地板 4 秒后自己长回来 —— 人还在坑里就会被活埋',
    '取到岛台上那块宝物后，出口两侧的闸门会变成梯子（T13）',
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

/** 常驻提示（终局：等 R 重开）。 */
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
 * 而重开是一次性**命令** —— 把它采样成电平毫无意义（按住 R 不该每 tick 重开一次），
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
  state = createSim(CONCEPT_MINIMAL, PLAYER_SPAWN);
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

window.addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') restart();
});

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h);
  // 两个 composer 的缓冲尺寸也要跟：漏掉它，泛光会按旧尺寸采样（换窗口后糊掉）。
  bloom.setSize(w, h);
  frameCamera(camera, w / h);
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
    sim: { tick: state.tick, status: state.status, entities: state.entities.length },
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
  const player = state.entities[0];
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

/**
 * 选择性泛光（用户裁定"需要"，第二次返工）。创建在这里是因为 `renderer` / `stage` /
 * `camera` 到这一步都已就位，而它必须在 `resize()`（文件末尾那次调用）之前存在。
 *
 * **它取代了 `renderer.render(...)`** —— 两条路只能走一条。为什么不能靠调 threshold：
 * 背景板线性亮度 ≈0.81 比所有物体（≈0.20–0.50）都亮，阈值分不开，见 `bloom.ts` 的推导。
 */
const bloom = createSelectiveBloom(renderer, stage.scene, camera, {
  width: window.innerWidth,
  height: window.innerHeight,
});

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
let lastGrid = state.grid;

function loop(now: number): void {
  if (last === 0) last = now;
  const elapsedMs = Math.min(Math.max(now - last, 0), MAX_CATCHUP_MS);
  last = now;
  acc += elapsedMs;

  // 每个 tick 采一次输入**电平**：一次 dt 可能跨好几个 tick，"按住"在这几个 tick 里都有效。
  // 输入锁存：兑现了才销账 —— 否则轻点会被冷却窗口吃掉。
  //
  // 顺带把"本帧哪些实体瞬移了"收出来（目前只有重生这一种）。事件流现在有两个消费者：
  // 输入销账、同步层的就地落位（T20 的特效会是第三个）。
  let snapped: Set<number> | null = null;
  while (acc >= STEP_MS) {
    const frame = tick(state, input.intents());
    state = frame.state;
    acc -= STEP_MS;
    if (actedOn(frame)) input.consume();
    for (const event of frame.events) {
      if (event.kind === 'respawned' || event.kind === 'returned') {
        // `returned` = 敌人被重置回家（玩家死亡时的追捕重置）。它同样是**瞬移** ——
        // 不列进来的话，敌人会从被杀的地方滑过整张地图回家（就是那个"飞"的坑）。
        if (snapped === null) snapped = new Set<number>();
        snapped.add(event.entity);
        continue;
      }
      // 死亡 / 终局的可见反馈（见 `flash` 的注释）。注意 `drowned` 与 `gameover` 会在
      // **同一个 tick** 里先后出现（前者在移动那步、后者在结算那步），所以"常驻"要写在后面 ——
      // 否则终局那条会被"落水 −1 命"盖掉。
      if (event.kind === 'drowned') flash('落 水 ｜ 命数 −1', DEATH_FLASH_MS);
      else if (event.kind === 'buried') flash('被 活 埋 ｜ 命数 −1', DEATH_FLASH_MS);
      else if (event.kind === 'caught') flash('被 抓 住 ｜ 命数 −1', DEATH_FLASH_MS);
      else if (event.kind === 'gameover') flashForever('GAME OVER —— 按 R 重开');
      else if (event.kind === 'won') flashForever('★ 过 关 ！');
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

  stage.update(now / 1000);
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
