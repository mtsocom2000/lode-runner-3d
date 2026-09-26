import * as THREE from 'three';
import type { Cell } from '../core/types';
import type { Level } from '../core/world/tiles';
import { cellAnchor } from './metrics';
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
   */
  markIssues(cells: readonly Cell[]): void;
  /** 每帧推进：衰减、到点移除、常驻记号呼吸。`dt` 是**真实秒数**（与 `meshSync.update` 同一口径）。 */
  update(dt: number): void;
  dispose(): void;
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
   * 常驻的"问题格"记号材质。**同色**（`blocked` = "这里不对"），但**不共用**：
   * `opacity` 长在材质上，而这一类记号要一起呼吸 —— 与闪烁那一族共用的话，
   * 两者会互相改写对方的不透明度。
   */
  const issueMat = new THREE.LineBasicMaterial({
    color: PALETTE.blocked,
    transparent: true,
    opacity: 0.9,
  });

  /** 正在闪的记号。键用 `cellKey` 的风格（同格重复调用要能认出来是同一处）。 */
  const live = new Map<string, { line: THREE.LineSegments; left: number }>();

  /** 常驻的"问题格"记号（编辑器用）。与 `live` 分开：一个是过客、一个是常驻。 */
  const marked: THREE.LineSegments[] = [];
  /** 呼吸用的累计时间 —— 常驻记号要有一点动静，否则在一屏浅色里容易被当成画错了的线。 */
  let pulse = 0;

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
    markIssues(cells: readonly Cell[]): void {
      // 整批替换：先把上一次的清掉。**不做差分** —— 问题的集合每次校验都可能整体变，
      // 差分的收益（省几个线框）远小于"残留一个旧记号"的代价。
      for (const line of marked) {
        group.remove(line);
        line.geometry = frameGeo; // 几何是共用的，别跟着销毁
      }
      marked.length = 0;
      for (const at of cells) {
        const line = new THREE.LineSegments(frameGeo, issueMat);
        const anchor = cellAnchor(level, at);
        line.position.set(anchor.p[0], anchor.p[1], anchor.p[2]);
        line.renderOrder = 997;
        group.add(line);
        marked.push(line);
      }
    },
    update(dt: number): void {
      const step = dt > 0 ? dt : 0;

      // 常驻记号：慢呼吸（0.6~1.0 之间来回），让人一眼看出"这是标出来的，不是画错的"。
      if (marked.length > 0) {
        pulse += step;
        issueMat.opacity = 0.6 + 0.4 * Math.abs(Math.sin(pulse * 1.6));
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
      frameGeo.dispose();
      frameMat.dispose();
      issueMat.dispose();
    },
  };
}
