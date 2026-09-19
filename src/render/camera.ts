import * as THREE from 'three';

/**
 * 正交、约 45° 轴测、正对墙角棱线，**全程固定**（架构文档 §1.2）。
 * 固定视角是设计前提，不是偷懒：它保证"一眼看清全局"的公平性（§1.3-2）。
 *
 * ## 取景：跟着**关卡数据**算，不是调魔数
 *
 * 相机方向 `(1, 0.66, 1)` 归一化后，屏幕的两个轴是：
 *
 * - 屏幕右 `∝ (z - x) / √2`（所以折痕那一条竖线正好落在画面正中）
 * - 屏幕上 `∝ -0.299x + 0.906y - 0.299z`
 *
 * 这两个轴是**固定**的（视角固定这条前提），但**视锥窗口**必须跟着关卡走：
 * `scene.ts` 给出内容的世界包围盒，`fitCamera` 把 8 个角投到这两条轴上取 min/max 当窗口。
 *
 * 曾经这里是写死的 `ORTHO = 6.5`（按 9×6 / 14×10 那几关的取景调的）。用户要求
 * "做宽 + 再加一层"之后 L1 变成 **20×12**，**顶行的出口直接跑到画面外** ——
 * `probe` 的"声明了出口 ⇒ 画面上必须有那一抹绿"当场报了出来。**取景是数据，不是常数。**
 */

/** `createCamera` 的初始视锥半径 —— 只是"还没 `fitCamera` 之前"的占位，真正的窗口由它定。 */
const ORTHO = 8;

/**
 * 相机看的方向上的一个点。**只用来定朝向**：窗口的中心由 `fitCamera` 按内容算，
 * 所以这个点取视线方向上的哪儿都行（原先写死 y=3.0 是为了"上下留白对称"，那件事现在归 fit）。
 */
const LOOK_AT = new THREE.Vector3(-4.5, 3.0, -4.5);

export function createCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-ORTHO, ORTHO, ORTHO, -ORTHO, -100, 500);
  const dir = new THREE.Vector3(1, 0.66, 1).normalize();
  cam.position.copy(dir).multiplyScalar(200);
  cam.lookAt(LOOK_AT);
  return cam;
}

/** 只改视锥、不动机位与朝向 —— 保持"固定视角"这条前提。 */
export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** 取景留白：内容外再留 6%，免得贴边读起来像被切了。 */
const FRAME_MARGIN = 1.06;

/**
 * 把视锥**撑到刚好装下**给定的世界包围盒 —— 只改视锥，不动机位与朝向（如上的前提）。
 *
 * ## 为什么不再用一个写死的常量（这是被 `probe` 抓出来的真回归）
 *
 * 原先这里有一个 `ORTHO = 6.5`，是按 9×6 / 14×10 那几关的取景调的。用户要求"做宽 + 再加一层"
 * 之后 L1 变成 **20×12**，顶行的**出口直接跑到画面外** —— 而 `probe` 的
 * "关卡里声明了出口 ⇒ 画面上必须有出口那一抹绿"当场报了出来。取景必须跟着**数据**走，
 * 否则每改一次关卡尺寸都得人肉重调一个魔数。
 *
 * ## 怎么算
 *
 * 用相机**自己的两条屏幕轴**（`matrixWorld` 的第 0/1 列）把包围盒的 8 个角投到屏幕平面上，
 * 取它们的 min/max 当作视锥窗口；再把视口更宽/更高的那一侧补齐（正交相机不裁切，
 * 但内容只占一条会读成"被挤扁了"）。于是"整关都在画面里"变成一条**可断言的性质**，
 * 见 `test/camera.test.ts`。
 */
export function fitCamera(cam: THREE.OrthographicCamera, bounds: Bounds, aspect: number): void {
  cam.updateMatrixWorld();
  const e = cam.matrixWorld.elements;
  const right = new THREE.Vector3(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0).normalize();
  const up = new THREE.Vector3(e[4] ?? 0, e[5] ?? 0, e[6] ?? 0).normalize();

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        const v = new THREE.Vector3(x, y, z).sub(cam.position);
        const sx = v.dot(right);
        const sy = v.dot(up);
        if (sx < minX) minX = sx;
        if (sx > maxX) maxX = sx;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
      }
    }
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let hx = ((maxX - minX) / 2) * FRAME_MARGIN;
  let hy = ((maxY - minY) / 2) * FRAME_MARGIN;
  // 视口比内容更宽（或更高）时，把另一侧也撑开，内容才不会被挤成一条。
  if (aspect > hx / hy) hx = hy * aspect;
  else hy = hx / aspect;

  cam.left = cx - hx;
  cam.right = cx + hx;
  cam.bottom = cy - hy;
  cam.top = cy + hy;
  cam.updateProjectionMatrix();
}
