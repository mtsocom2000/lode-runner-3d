import * as THREE from 'three';

/**
 * 正交、约 45° 轴测、正对墙角棱线，**全程固定**（架构文档 §1.2）。
 * 固定视角是设计前提，不是偷懒：它保证"一眼看清全局"的公平性（§1.3-2）。
 *
 * ## 取景的两个数都是跟着关卡尺寸算的，不是调的
 *
 * 相机方向 `(1, 0.66, 1)` 归一化后，屏幕的两个轴是：
 *
 * - 屏幕右 `∝ (z - x) / √2`（所以折痕那一条竖线正好落在画面正中）
 * - 屏幕上 `∝ -0.299x + 0.906y - 0.299z`
 *
 * 关卡 `fold = 9` → 内容占 `x, z ∈ [-8.5, -0.5]`、`y ∈ [0, 6]`（水面外沿再宽两格），
 * 代入得**屏幕横向 ±6.7、纵向 0.3 ~ 10.5** —— 于是取景需要 半宽 ≳ 6.7、半高 ≳ 5.1。
 *
 * `ORTHO` 是**视锥半径**（非宽屏时横向还会再乘 `aspect / 1.4`）：取 6.5，
 * 横向 7.4、纵向 6.5，两边都留一点呼吸。之前 12.0 是按 14×10 的老关卡定的，
 * 对 `fold = 9` 过宽、空出一大圈；8.0 又偏紧（水面外沿会被切掉）。
 *
 * 纵向中心：内容的屏幕纵向中点在 **5.4**，所以 `LOOK_AT` 的 y 取
 * `(5.4 - 2.691) / 0.906 ≈ 3.0` —— 其中 `2.691` 是 `x = z = -4.5` 那一项的贡献。
 * 这是"上下留白对称"的算法，不是目测调出来的。
 */
export const ORTHO = 6.5;

const LOOK_AT = new THREE.Vector3(-4.5, 3.0, -4.5);

export function createCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-ORTHO, ORTHO, ORTHO, -ORTHO, -100, 500);
  const dir = new THREE.Vector3(1, 0.66, 1).normalize();
  cam.position.copy(dir).multiplyScalar(200);
  cam.lookAt(LOOK_AT);
  return cam;
}

/** 只改视锥、不动机位与朝向 —— 保持"固定视角"这条前提。 */
export function frameCamera(cam: THREE.OrthographicCamera, aspect: number): void {
  cam.left = -ORTHO * Math.max(1, aspect / 1.4);
  cam.right = -cam.left;
  cam.top = ORTHO * Math.max(1, 1.4 / aspect);
  cam.bottom = -cam.top;
  cam.updateProjectionMatrix();
}
