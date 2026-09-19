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
  /** 每帧推进：衰减、到点移除。`dt` 是**真实秒数**（与 `meshSync.update` 同一个口径）。 */
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

  /** 正在闪的记号。键用 `cellKey` 的风格（同格重复调用要能认出来是同一处）。 */
  const live = new Map<string, { line: THREE.LineSegments; left: number }>();

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
    update(dt: number): void {
      if (live.size === 0) return;
      const step = dt > 0 ? dt : 0;
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
      frameGeo.dispose();
      frameMat.dispose();
    },
  };
}
