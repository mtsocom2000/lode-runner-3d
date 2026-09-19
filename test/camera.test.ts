import { describe, expect, it } from 'vitest';
import { createCamera, fitCamera, type Bounds } from '../src/render/camera';

/**
 * 取景：**"整关都在画面里"是一条可断言的性质**，不是一个魔数。
 *
 * 这条测试的来历：L1 从 14×10 放大到 20×12 之后，顶行的出口跑到了画面外 ——
 * 原因是 `camera.ts` 里写死过一个视锥半径（按更小的关卡调的）。`probe` 先报了出来
 * （"声明了出口，但画面上没有那一抹绿"），这里再把它钉成一条**通用**断言：
 * 无论关卡多大，`fitCamera` 之后包围盒的 8 个角都必须落在视锥内。
 *
 * ## 刻意**不 import three**
 *
 * 与 `input.test.ts` 里"只借相机的矩阵、不碰 three"同一个理由（架构红线禁测试里 import three）。
 * 正交相机的投影是纯算术：把世界点投到相机的两条屏幕轴上，再按视锥窗口归一就是 NDC ——
 * 那正是 `OrthographicCamera` 的投影矩阵在做的事（`x → (2x - (r+l)) / (r-l)`）。
 */
type Cam = ReturnType<typeof createCamera>;

function ndc(cam: Cam, p: readonly [number, number, number]): { x: number; y: number } {
  const e = cam.matrixWorld.elements;
  const col = (i: number): readonly [number, number, number] => [
    e[i * 4] ?? 0,
    e[i * 4 + 1] ?? 0,
    e[i * 4 + 2] ?? 0,
  ];
  const right = col(0);
  const up = col(1);
  const v: readonly [number, number, number] = [
    p[0] - cam.position.x,
    p[1] - cam.position.y,
    p[2] - cam.position.z,
  ];
  const sx = v[0] * right[0] + v[1] * right[1] + v[2] * right[2];
  const sy = v[0] * up[0] + v[1] * up[1] + v[2] * up[2];
  const cx = (cam.left + cam.right) / 2;
  const hx = (cam.right - cam.left) / 2;
  const cy = (cam.bottom + cam.top) / 2;
  const hy = (cam.top - cam.bottom) / 2;
  return { x: (sx - cx) / hx, y: (sy - cy) / hy };
}

function expectAllInside(bounds: Bounds, aspect: number): void {
  const cam = createCamera();
  fitCamera(cam, bounds, aspect);
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const p = ndc(cam, [x, y, z]);
        expect(Math.abs(p.x)).toBeLessThanOrEqual(1.0001);
        expect(Math.abs(p.y)).toBeLessThanOrEqual(1.0001);
      }
    }
  }
}

describe('camera：视锥跟着关卡包围盒走（写死过半半径，被 probe 抓过）', () => {
  /** 小关卡（概念场景那一档）。 */
  const small: Bounds = { min: [-9.3, -0.2, -9.3], max: [1.2, 7.4, 1.2] };
  /** 大关卡（L1 放大后那一档）。 */
  const large: Bounds = { min: [-10.3, -0.2, -10.3], max: [1.2, 13.4, 1.2] };

  it('小关卡：8 个角全在视锥内（宽屏 / 方屏 / 竖屏都试）', () => {
    expectAllInside(small, 16 / 9);
    expectAllInside(small, 4 / 3);
    expectAllInside(small, 3 / 4);
  });

  it('大关卡（20×12）：同样全在视锥内 —— 这正是回归的那一条', () => {
    expectAllInside(large, 16 / 9);
    expectAllInside(large, 3 / 4);
  });

  it('内容越多，视锥越大（不是恒定半径）', () => {
    const cam = createCamera();
    fitCamera(cam, small, 16 / 9);
    const smallHeight = cam.top - cam.bottom;
    fitCamera(cam, large, 16 / 9);
    expect(cam.top - cam.bottom).toBeGreaterThan(smallHeight);
  });
});
