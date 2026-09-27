import * as THREE from 'three';
import type { Cell } from '../core/types';
import type { Level } from '../core/world/tiles';
import { cellAnchor, guideLine, spanBox } from './metrics';
import { PALETTE } from './palette';

/**
 * 临时特效层（2026-09-19 起，第一件东西是"哑火"记号）。
 *
 * ## 为什么单独一层，而不是塞进 `meshSync` / `scene`
 *
 * 那两个同步器管的是**状态**（实体、网格、道具），它们的输入是 `SimState`；而这里管的是
 * **一次性事件在屏幕上留下的痕迹**，没有对应的状态可言 —— 硬塞进状态同步器就得编一个
 * "特效状态"出来，然后在它该消失的时候再想办法把它删掉。事件流（`SimFrame.events`）
 * 本来就是一次性消息，这一层直接吃它，生命周期只有"创建 → 衰减 → 移除"一条线。
 *
 * T20 会把更多东西（水花、土块、开闸）搬进来 —— 那时这一层会长成真正的 fx 系统；
 * 现在只放**用户点名要的那一个**，不预设结构。
 */

/** 哑火记号的存活时长（秒）。用户给的 0.15s —— 够看见，又不至于拖成动画。 */
export const BLOCKED_FLASH_SECONDS = 0.15;

/** 框比格子略小：正好卡在砖的内侧，读起来是"这一格"，而不是"这一格外面又套了一格"。 */
const FRAME_SCALE = 0.92;

export interface Fx {
  readonly group: THREE.Group;
  /**
   * 在某一格上闪一下"这个动作被拒绝"的记号。
   *
   * **同一格重复调用只刷新倒计时**（种子一次只能挖一格，而按住不放会每 tick 报一次）——
   * 每 tick 新建一个框的话，0.15 秒里会堆出十来个重叠的线框，反而糊成一团。
   */
  blockedFlash(at: Cell): void;
  /**
   * 把"**有问题的格子**"整批标出来（T21，编辑器用）—— 与 `blockedFlash` 的区别是它**常驻**：
   * 一直亮到下一次调用换掉它。`[]` = 全清。
   *
   * 为什么需要它：`validateLevel` 给的每条问题本来就带 `at`（哪一格），但只印在面板文字里，
   * 用户得自己把 `A:0,1` 在场景里找出来 —— 用户的原话是"校验出来的问题看的不是很明白"。
   * 把格子**画出来**，文字与场景才对得上。
   *
   * **红框只给"错误"**（`severity: 'error'`）：用户的追问是"这些红框我都不认为是非法的" ——
   * 他说得对，`validate` 里混着"玩不了"和"大概没画完"两种。提醒用**灰框**：看得见、不喊叫。
   */
  markIssues(marks: readonly { readonly at: Cell; readonly severity: 'error' | 'warn' }[]): void;
  /**
   * **悬停提示**（用户 2026-09-23 的提议）：鼠标停在哪儿，就在那一格上亮一个框，
   * 并在**两面墙上各打一条同高的辅助线**。
   *
   * 为什么需要它：折痕把一面墙折成两面之后，"屏幕上这一点是哪一格"要过一遍拾取换算才说得清
   * （用户为此专门提过"完全看不出来错在哪里"）。框回答"就是这一格"；两条横线回答
   * "这个高度在对面那面墙上落在哪一行" —— 折痕两侧最内列**在画面里重合**，高度是唯一
   * 一眼能对上的量。
   *
   * 颜色借 `player` 蓝：它要读起来像"光标"而不是像地形。调色板契约里每个颜色各有所属，
   * 随便借一个（比如 `bar`）会让探针**谎报**画面上有杆。
   *
   * `null` = 收起来（关掉面板、鼠标离开编辑器时都要调它，否则那两条线会一直挂在那儿）。
   */
  setHover(at: Cell | null, span?: Cell): void;
  /**
   * **溅一串碎屑**（T20）：从某一格炸出去一小撮小方块。
   *
   * 四个调用点都是 sim 已经在报的事件（`dug` / `buried` / `opened` / `drowned`）——
   * 这一层只把事件画出来，不改任何规则（见文件头"只读 state + events"）。
   */
  burst(at: Cell, kind: 'dirt' | 'water' | 'gold'): void;
  /** 每帧推进：衰减、到点移除、常驻记号呼吸。`dt` 是**真实秒数**（与 `meshSync.update` 同一口径）。 */
  update(dt: number): void;
  dispose(): void;
}

/**
 * **粒子族**（T20）：碎砖、水花、亮片 —— 一小撮受重力的小方块，短命、到点就收。
 *
 * ## 为什么是"一个网格 + 一批位置"，而不是每个粒子一个 mesh
 *
 * 一次挖掘能溅出十几块，`drowned` 的水花也是一把 —— 每个粒子建一个 `Mesh` 会在画面里
 * 塞进几十个**独立绘制调用**。这里用一个 `InstancedMesh` 装同一批粒子（与砖层同一套做法），
 * 到达上限就直接丢——**没人在乎第 25 块碎砖去哪了**。
 *
 * ## 为什么不做碰撞
 *
 * 粒子只在**视觉上**飞一下：地面高度取发射点，飞出去之后不再判断脚下 ——"落地"就是寿命到了。
 * 真做碰撞要读地形、要判层，而这一层**只读事件、不读规则**（与 `fx` 其它东西同一条纪律）。
 */
interface Spark {
  readonly mesh: THREE.InstancedMesh;
  readonly born: number;
  readonly ox: number;
  readonly oy: number;
  readonly oz: number;
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  readonly life: number;
  readonly size: number;
}

export function createFx(parent: THREE.Object3D, level: Level): Fx {
  const group = new THREE.Group();
  parent.add(group);

  // 单位盒的**棱边**：不是一个实心方块，是"细框"。`EdgesGeometry` 顺手去掉了面对角线。
  const frameGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(FRAME_SCALE, FRAME_SCALE, FRAME_SCALE));
  const frameMat = new THREE.LineBasicMaterial({
    color: PALETTE.blocked,
    transparent: true,
    opacity: 1,
  });
  /**
   * 常驻的"问题格"材质，**两种严重程度两个材质**：
   *
   * - **错误**（玩不了）用 `blocked` 深红 —— 与"这个动作被拒绝"同一个色，一个含义；
   * - **提醒**（大概没画完）用 `shell` 灰 —— 看得见、不喊叫。
   *
   * 与闪烁那一族**不共用**材质：`opacity` 长在材质上，共用的话两边会互相改写。
   */
  const issueMat = new THREE.LineBasicMaterial({
    color: PALETTE.blocked,
    transparent: true,
    opacity: 0.9,
  });
  const warnMat = new THREE.LineBasicMaterial({
    color: PALETTE.shell,
    transparent: true,
    opacity: 0.9,
  });

  /** 正在闪的记号。键用 `cellKey` 的风格（同格重复调用要能认出来是同一处）。 */
  const live = new Map<string, { line: THREE.LineSegments; left: number }>();

  /** 常驻的"问题格"记号（编辑器用）。与 `live` 分开：一个是过客、一个是常驻。 */
  const marked: THREE.LineSegments[] = [];
  /** 呼吸用的累计时间 —— 常驻记号要有一点动静，否则在一屏浅色里容易被当成画错了的线。 */
  let pulse = 0;

  /**
   * **悬停那一套**（框 + 两面各一条同高辅助线）。三个网格只建一次、靠 `visible` 开关 ——
   * 鼠标每动一下都重建几何的话，拖笔时会以每秒几十次的频率分配/释放 GPU 资源。
   *
   * 位置**全部由 `cellAnchor` 推出来**（它是几何的唯一出处）：辅助线的两端取那一行**首尾两格**
   * 的锚点，于是"墙有多宽"这件事不必在这里再写一遍 `halfExtent`/`fold` 的算法。
   */
  /**
   * 悬停框用**单位盒**：单格时整体缩到 `FRAME_SCALE`，Shift 拖矩形时缩成盖住整片的那一块
   * （见 `spanBox`）—— 同一个网格、只改 `scale`，不必两种几何。
   */
  const hoverFrame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: PALETTE.player, transparent: true, opacity: 0.95 }),
  );
  const guideMat = new THREE.MeshBasicMaterial({ color: PALETTE.player, transparent: true, opacity: 0.3 });
  const guideA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), guideMat);
  const guideB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), guideMat);
  guideMat.depthWrite = false; // 细杆不该改写深度，免得它自己在砖上留下一条暗纹
  for (const o of [hoverFrame, guideA, guideB]) {
    o.visible = false;
    o.renderOrder = 998; // 与记号同一档：线框被挡住就该看不见
    group.add(o);
  }
  const GUIDES: readonly THREE.Mesh[] = [guideA, guideB];

  /**
   * **粒子**（T20）。三种碎屑各有一个材质，几何共用一个单位立方体 —— 粒子的大小靠
   * `InstancedMesh` 的矩阵给，不必为每种尺寸各建一个几何。
   */
  const sparkGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16);
  const sparkMat = {
    // 碎砖用 `ink`（砖轮廓线那一族的中灰）：它要读成"这块砖被打碎了"，不是新地形。
    dirt: new THREE.MeshLambertMaterial({ color: PALETTE.ink }),
    // 水花借**水面**那一族色（同色系才是水），不借 `player`（那是角色）。
    water: new THREE.MeshLambertMaterial({ color: PALETTE.rim }),
    // 亮片借 `prize` 暖金：与宝物同一档"值得的东西"。
    gold: new THREE.MeshLambertMaterial({ color: PALETTE.prize }),
  };
  const sparks: Spark[] = [];
  /** 粒子总数上限：一次挖能溅十几块，同时来几发就到了几十 —— 到这个数就不再新发。 */
  const SPARK_CAP = 96;
  const SPARK_LIFE = 0.6;
  /** 每一发溅出几颗。8 颗足够"一撮"，又不至于把 96 的上限一口吃满。 */
  const SPARKS_PER_BURST = 8;
  /** 这一层自己的时钟（秒）。粒子用它算年龄 —— 与 `update` 的 `dt` 同源。 */
  let elapsed = 0;

  const keyOf = (c: Cell): string => `${c.face}:${c.col},${c.row}@${c.level ?? 0}`;

  return {
    group,
    blockedFlash(at: Cell): void {
      const key = keyOf(at);
      const existing = live.get(key);
      if (existing !== undefined) {
        existing.left = BLOCKED_FLASH_SECONDS; // 刷新，不另起一个
        return;
      }
      const line = new THREE.LineSegments(frameGeo, frameMat);
      const anchor = cellAnchor(level, at);
      line.position.set(anchor.p[0], anchor.p[1], anchor.p[2]);
      // 画在透明物之后、光晕之前：它是个线框，被任何东西挡住都该看不见。
      line.renderOrder = 997;
      group.add(line);
      live.set(key, { line, left: BLOCKED_FLASH_SECONDS });
    },
    markIssues(marks): void {
      // 整批替换：先把上一次的清掉。**不做差分** —— 问题的集合每次校验都可能整体变，
      // 差分的收益（省几个线框）远小于"残留一个旧记号"的代价。
      for (const line of marked) group.remove(line);
      marked.length = 0;
      for (const mark of marks) {
        const line = new THREE.LineSegments(frameGeo, mark.severity === 'error' ? issueMat : warnMat);
        const anchor = cellAnchor(level, mark.at);
        line.position.set(anchor.p[0], anchor.p[1], anchor.p[2]);
        line.renderOrder = 997;
        group.add(line);
        marked.push(line);
      }
    },
    setHover(at, span): void {
      if (at === null) {
        for (const o of [hoverFrame, ...GUIDES]) o.visible = false;
        return;
      }
      // 给了 `span`（Shift 拖矩形中）→ 框**盖住这两格圈起来的整片**：松手前就看得见要铺哪一片。
      const box =
        span === undefined
          ? { p: cellAnchor(level, at).p, s: [FRAME_SCALE, FRAME_SCALE, FRAME_SCALE] }
          : spanBox(level, at, span);
      hoverFrame.position.set(box.p[0], box.p[1], box.p[2]);
      hoverFrame.scale.set(box.s[0], box.s[1], box.s[2]);
      hoverFrame.visible = true;

      // 甲板格没有"行高"可言（它是另一套坐标），所以只给框、不给辅助线。
      if (at.face === 'I') {
        for (const g of GUIDES) g.visible = false;
        return;
      }
      const row = at.row;
      /**
       * **乙**：指着的那面墙画一小段（指针左右各 `TICK_HALF` 格，"我在这儿"），
       * **另一面墙画整行**（"这个高度在对面落在哪一行"）。用户选定的就是这一版 ——
       * 两面都画整行时他当场说不对（"射到右边墙上那条较长，射到左边墙上那条较短"）。
       */
      for (const [mesh, face] of [
        [guideA, 'A'],
        [guideB, 'B'],
      ] as const) {
        const line =
          face === at.face ? guideLine(level, face, row, { tickAtCol: at.col }) : guideLine(level, face, row);
        mesh.position.set(line.p[0], line.p[1], line.p[2]);
        mesh.scale.set(line.s[0], line.s[1], line.s[2]);
        mesh.visible = true;
      }
    },
    burst(at, kind): void {
      if (sparks.length >= SPARK_CAP) return; // 满就丢 —— 没人在乎第 25 块碎砖去哪了
      const anchor = cellAnchor(level, at);
      // 从那一格的**中心往上一格**炸开（挖砖时队首在格子里，闸门/水花则在格面上）。
      const [ox, oy, oz] = anchor.p;
      const mesh = new THREE.InstancedMesh(sparkGeo, sparkMat[kind], SPARKS_PER_BURST);
      mesh.renderOrder = 998;
      mesh.frustumCulled = false; // 实例位置每帧在变，交给包围盒剔除会闪
      group.add(mesh);
      sparks.push({
        mesh,
        born: elapsed,
        ox,
        oy,
        oz,
        // 初速：向上为主、横向随意撒开（用序号当"随机种子"—— 这里不需要真随机，
        // 只要每一颗的初速不同，看起来就是一撮而不是一块）。
        vx: Math.sin(sparks.length * 12.9898) * 1.6,
        vy: 3.2,
        vz: Math.cos(sparks.length * 78.233) * 1.6,
        life: SPARK_LIFE,
        size: 1,
      });
    },
    update(dt: number): void {
      const step = dt > 0 ? dt : 0;
      elapsed += step;
      // ── 粒子：抛物线飞一小会儿、越飞越小、到点连网格一起收掉 ──
      //
      // 不做碰撞（见 `Spark`）："落地"就是寿命到了。位置每帧**重算**而不是积分 ——
      // 这样它永远是同一条抛物线，掉帧也不会跑偏。
      for (let i = sparks.length - 1; i >= 0; i--) {
        const s = sparks[i];
        if (s === undefined) continue;
        const age = elapsed - s.born;
        const k = age / s.life;
        if (k >= 1) {
          group.remove(s.mesh);
          s.mesh.dispose();
          sparks.splice(i, 1);
          continue;
        }
        const m = new THREE.Matrix4();
        const shrink = (1 - k) * s.size;
        for (let n = 0; n < SPARKS_PER_BURST; n++) {
          const angle = n * 2.399963; // 黄金角：均匀撒开，不会挤成一条线
          const outward = s.vx * Math.cos(angle) + s.vz * Math.sin(angle);
          const px = s.ox + outward * age;
          const py = s.oy + s.vy * age - 6 * age * age; // 6 格/秒² 的"感觉上"的重力
          const pz = s.oz + outward * age * 0.6;
          m.compose(
            new THREE.Vector3(px, py, pz),
            new THREE.Quaternion(),
            new THREE.Vector3(shrink, shrink, shrink),
          );
          s.mesh.setMatrixAt(n, m);
        }
        s.mesh.instanceMatrix.needsUpdate = true;
      }

      // 常驻记号：慢呼吸（0.6~1.0 之间来回），让人一眼看出"这是标出来的，不是画错的"。
      if (marked.length > 0) {
        pulse += step;
        const breathe = 0.6 + 0.4 * Math.abs(Math.sin(pulse * 1.6));
        issueMat.opacity = breathe;
        warnMat.opacity = breathe;
      }

      if (live.size === 0) return;
      for (const [key, entry] of live) {
        entry.left -= step;
        if (entry.left <= 0) {
          group.remove(entry.line);
          live.delete(key);
          continue;
        }
        // 用一个材质共用：淡出取**剩余时间**的比例 —— `opacity` 是材质上的属性，
        // 所以同时有多个记号在闪时，读到的是最新一次写入。这与"同格只闪一个"是同一条取舍：
        // 画面里几乎永远只有一个记号（玩家同一时刻只挖一边），不值得为它开一堆材质。
        frameMat.opacity = entry.left / BLOCKED_FLASH_SECONDS;
      }
    },
    dispose(): void {
      for (const [, entry] of live) group.remove(entry.line);
      live.clear();
      for (const line of marked) group.remove(line);
      marked.length = 0;
      hoverFrame.geometry.dispose();
      (hoverFrame.material as THREE.Material).dispose();
      guideA.geometry.dispose();
      guideB.geometry.dispose();
      guideMat.dispose();
      frameGeo.dispose();
      frameMat.dispose();
      issueMat.dispose();
    },
  };
}
