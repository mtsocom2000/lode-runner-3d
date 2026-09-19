import * as THREE from 'three';
import type { EntityKind, SimState } from '../core/sim';
import type { Level } from '../core/world/tiles';
import { PLAYER_SIZE, playerAnchor } from './metrics';
import { PALETTE } from './palette';
import { advance, aim, sample, snapTo, tweenTo, type Tween, type Vec3 } from './tween';

/**
 * 实体层：把 `SimState.entities` 摆到墙上，并把"格到格"的跳变补成滑动（T6）。
 *
 * ## 为什么补间不能省
 *
 * sim 是定步长 60Hz 的（`MOVE_TICKS = 8` 走一格），渲染则是浏览器给多少帧就多少帧 ——
 * 两者不同频。直接把 state 里的格子坐标贴到 mesh 上，角色会以 7.5 格/秒**瞬移**：
 * 每当 sim 允许移动，位置就陡跳一整格。补间的全部作用就是把这一跳铺开成 0.15s 的滑动。
 *
 * ## 一帧三步
 *
 * 1. `aim` —— 对准新目标；**目标没变就原样返回**（否则每帧重开补间会把角色钉死）；
 * 2. `advance` —— 按**秒**推进（不是按帧）；
 * 3. `sample` —— 取插值位置写进 mesh。
 *
 * 第 2 步按秒推进，是"帧率无关 / resize 无关"的全部秘密：帧率只改变采样的**密度**，
 * 不改变"走到同一时刻时人在哪"。这条性质由 `test/tween.test.ts` 钉着。
 *
 * ## 位置不连续时**不补间**（重生 / 将来的关卡切换）
 *
 * 一帧三步描述的是**连续运动**。但有些位置变化不是运动：落水扣命后实体被直接放回出生点，
 * 而这在 `sim` 里发生在**同一个 tick**（`fall → drowned → respawned`，见 `sim.ts` 的 tick 第⑤步），
 * 中间那条下坠**没有帧**。若照常补间，角色会被画成一条横穿场景的直线 ——
 * 用户报的"跳过缺口，回到起点处"就是这样：从 `col3` 横滑 **3.0 格**回 `col0`，正好从缺口上方掠过。
 *
 * 所以 `update` 收一个 `snapEntities`：这批实体**就地落位**。判据来自**事件流**
 * （`respawned` 是模拟层明写的事实），不是"距离超过多少就算瞬移"那种启发式 ——
 * 后者等于在渲染层重新定义"什么算合法移动"，那是 `graph.ts` 文件头明令禁止的第二份真相。
 *
 * ## 渲染只读 state（架构文档 §三 红线）
 *
 * 本文件不推进 sim、不改 state，只把已经发生的事实画出来。角色的**朝向**（T7：过折痕转 90°）
 * 还没有 —— 那属于输入/朝向层，这里只负责位置。
 */

/** 角色外面那圈发光壳：比身体大一圈，被砖挡住时仍留下一道轮廓。 */
const GLOW_SCALE = 1.45;

/** 发光壳的不透明度。太淡看不见，太浓会把身体糊住。 */
const GLOW_OPACITY = 0.32;

/** 发光壳的渲染序号：晚于全场不透明物 → 光晕压在砖上面（这就是"角色始终可见"）。 */
const GLOW_RENDER_ORDER = 998;

export interface Syncer {
  readonly group: THREE.Group;
  /**
   * 用最新 state 与**本帧真实秒数**更新所有实体。
   *
   * `snapEntities`：本帧**位置不连续**（重生/瞬移）的实体 id。列进来的实体**就地落位**、
   * 不做补间 —— 依据是事件流里的 `respawned`，不是任何距离阈值（见文件头）。
   */
  update(state: SimState, dt: number, opts?: { readonly snapEntities?: ReadonlySet<number> }): void;
  /** 各类实体真正画出来了几个（探针用它核对"声明了就该画出来"，见实现里的说明）。 */
  counts(): Readonly<Record<EntityKind, number>>;
  /**
   * 这个实体的 mesh 现在可见吗；没有这个 id 就是 `null`。
   *
   * 存在的理由与 `positionOf` 同：终局隐藏玩家是**行为**，行为要被断言，
   * 而 `group.visible` 是整组的总开关（第一版就是那么写的，结果无人机跟着一起消失）。
   */
  isVisible(id: number): boolean | null;
  /**
   * 某实体**当前**的世界位置（补间之后、真正写进 mesh 的那个值）。
   *
   * 存在的唯一理由：让探针能拿它与 `playerAnchor` 对账。单测证明锚点算得对，
   * 但"锚点被用上了"这件事只有从这里读出来才算证据（见 tools/probe.mjs 的位置检查）。
   */
  positionOf(id: number): Vec3 | null;
  dispose(): void;
}

/**
 * 同步器挂靠的父节点。**只用到 `add` / `remove`** —— 故意写成结构化类型而不是
 * `THREE.Object3D`：架构红线禁止测试里 import three，而同步层是应该被单测的
 * （`test/meshSync.test.ts` 就给一个两行的壳，见那个"位置不连续"的用例）。
 */
export interface ObjectParent {
  add(object: THREE.Object3D): void;
  remove(object: THREE.Object3D): void;
}

interface Actor {
  readonly kind: EntityKind;
  readonly group: THREE.Group;
  tween: Tween;
}

/**
 * 建一个同步器。几何体与材质**全实体共用** —— 实体最多几个，共用省下的不是性能，
 * 而是"每个实体各持一份材质"这种日后必然出错的自由度。
 *
 * `level` 只用来定折痕（`fold`）—— 它必须与喂进来的 state 是同一关，这是调用方的前提。
 */
export function createSyncer(parent: ObjectParent, level: Level): Syncer {
  const group = new THREE.Group();
  parent.add(group);

  const box = new THREE.BoxGeometry(PLAYER_SIZE, PLAYER_SIZE, PLAYER_SIZE);

  /**
   * 外发光壳：与身体同色、半透明、只画背面 —— 身体四周留一圈轮廓，被砖挡住也还看得见。
   * （`player` 的像素规则正是靠"壳盖在身体上恒等于身体色"这条性质，见 `probe.ts`。）
   */
  const glowOf = (color: number): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: GLOW_OPACITY,
      side: THREE.BackSide,
      depthTest: false,
      depthWrite: false,
    });

  /**
   * 每种实体**一份**材质（不是每个实体一份）。身体一律 unlit：角色在任何光线下都是
   * 同一个颜色，探针的色相规则就认这个。按 `kind` 共用，所以再加一个敌人不会再多一份材质。
   */
  const bodyMat: Readonly<Record<EntityKind, THREE.MeshBasicMaterial>> = {
    player: new THREE.MeshBasicMaterial({ color: PALETTE.player }),
    drone: new THREE.MeshBasicMaterial({ color: PALETTE.drone }),
  };
  const glowMat: Readonly<Record<EntityKind, THREE.MeshBasicMaterial>> = {
    player: glowOf(PALETTE.player),
    drone: glowOf(PALETTE.drone),
  };

  const actors = new Map<number, Actor>();

  function spawn(id: number, kind: EntityKind, at: Vec3): Actor {
    const g = new THREE.Group();

    const body = new THREE.Mesh(box, bodyMat[kind]);
    body.castShadow = true;
    g.add(body);

    const glow = new THREE.Mesh(box, glowMat[kind]);
    glow.scale.setScalar(GLOW_SCALE);
    glow.renderOrder = GLOW_RENDER_ORDER;
    g.add(glow);

    g.position.set(at[0], at[1], at[2]);
    group.add(g);

    // 首次出现**不滑入**：`from === to` 于是 `sample` 直接给目标点，人就地站好。
    const actor: Actor = { kind, group: g, tween: tweenTo(at, at) };
    actors.set(id, actor);
    return actor;
  }

  return {
    group,
    update(state: SimState, dt: number, opts?: { readonly snapEntities?: ReadonlySet<number> }): void {
      const alive = new Set<number>();
      const snap = opts?.snapEntities;

      // 终局时不把**玩家**的尸体留在原地装作还活着。用户报过"命数减为 0 之后还渲染了一个角色
      // 在梯子上" —— 那其实是留在**落水那一格**（紧挨梯子）的尸体，而它和活人长得一模一样
      // （`sim.ts` 的终局分支沿用当时的 entities，不重生）。
      //
      // **只隐藏玩家**：第一版写的是整组 `group.visible`，于是无人机也一起消失了 ——
      // 死一次就看不到是谁撞的你。T20 会换成正经的死亡表现；这里先做到"不骗人"。

      for (const entity of state.entities) {
        alive.add(entity.id);
        const target = playerAnchor(level, entity.cell, entity.mode);
        const actor = actors.get(entity.id) ?? spawn(entity.id, entity.kind, target);

        actor.group.visible = !(entity.kind === 'player' && state.status === 'dead');

        // 不连续的一帧：就地落位。否则 `aim` 会把这一跳铺成一条世界坐标直线 ——
        // 用户报的"跳过缺口回到起点"就是死亡+重生被画成了 3.0 格的横滑。
        actor.tween =
          snap?.has(entity.id) === true ? snapTo(target) : advance(aim(actor.tween, target), dt);

        const p = sample(actor.tween);
        actor.group.position.set(p[0], p[1], p[2]);
      }

      // 复活 / 换关之后 state 里没有的实体要收掉 —— 否则会留下一个永远不动的"幽灵"。
      for (const [id, actor] of actors) {
        if (alive.has(id)) continue;
        group.remove(actor.group);
        actors.delete(id);
      }
    },
  positionOf(id: number): Vec3 | null {
    const actor = actors.get(id);
    if (actor === undefined) return null;
    const p = actor.group.position;
    return [p.x, p.y, p.z];
  },
  /**
   * 各类实体**真正画出来了**几个。探针拿它判断"关卡声明了无人机 ⇒ 画面上就该有无人机"：
   * 这是**渲染层自己的账**（不是从关卡字符串反推），与色相判定同源 —— 见 `tools/probe.mjs`
   * 里 `EXPECTED_FEATURES` 的说明。
   */
  counts(): Readonly<Record<EntityKind, number>> {
    const out: Record<EntityKind, number> = { player: 0, drone: 0 };
    for (const actor of actors.values()) out[actor.kind] += 1;
    return out;
  },
  isVisible(id: number): boolean | null {
    const actor = actors.get(id);
    return actor === undefined ? null : actor.group.visible;
  },
  dispose(): void {
    parent.remove(group);
    box.dispose();
    for (const m of Object.values(bodyMat)) m.dispose();
    for (const m of Object.values(glowMat)) m.dispose();
    actors.clear();
  },
};
}
