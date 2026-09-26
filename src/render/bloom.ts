import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

/**
 * **选择性**泛光（用户裁定"需要"泛光；第二次返工）。
 *
 * ## 为什么不是"调阈值"（第一版失败的原因，实测数据）
 *
 * 第一版用普通 `UnrealBloomPass` + 调 `threshold`，用户反馈：
 * "我能看到背景的白色泛光强烈，但是游戏场景里基本没什么变化。"
 *
 * 从 `probe` 报出的主导色换算成**线性**亮度：
 *
 * | 元素 | 实测 sRGB | 线性 |
 * |---|---|---|
 * | 背景板 `PALETTE.bg` | `#e8e8e0` | **≈ 0.81** |
 * | 场景物体（砖面等） | `#807868` … `#b8b098` | **≈ 0.20 – 0.50** |
 *
 * **背景比场景里所有物体都亮。** 于是阈值这条路在原理上就堵死了：阈值低到能吃到
 * 物体（≤0.5），背景（0.81）必然被吃得更狠；阈值高到放过背景（>0.81），物体一个都
 * 不发光 —— **两者在同一根轴上分不开。**
 *
 * （第一版还有个更基础的错误：`threshold` 比的是**线性**亮度、不是 sRGB。浅色场景的
 * 亮面换算到线性只有 0.78–0.83，第一版给 0.9 时**一个像素都不发光**。）
 *
 * ## 现在的做法：背景根本不参与泛光
 *
 * `scene.ts` 的背景是 `scene.background = new THREE.Color(PALETTE.bg)` —— **一个颜色、
 * 不是几何体**。所以不必用官方那个"把其余物体换成暗材质"的复杂做法，只要：
 *
 * 1. **泛光那一遍**：临时 `scene.background = null`（黑底不发光）⇒ 物体成为缓冲里
 *    唯一亮的東西，泛光只从物体取样；
 * 2. **合成那一遍**：正常渲染（背景照旧）＋ 把泛光纹理**加法**叠上去；
 * 3. 最后过 `OutputPass` 做线性 → sRGB（缺了它整体会偏暗偏灰）。
 *
 * 好处：不再需要拿 `threshold` 做取舍 —— "物体有通灵感"与"背景干净"同时成立。
 */
const BLOOM = {
  /**
   * 线性亮度阈值。物体亮面约 0.20–0.50。
   *
   * 第三次调整：0.35 → **0.42**。用户反馈"物体太亮/发光过头" —— 0.35 时几乎**所有**
   * 受光面都过线，等于给整块砖加了层辉光。抬高到 0.42 只留更亮的那些面。
   */
  threshold: 0.42,
  /**
   * 溢光强度。合成是 `base + 1.0 * bloom`，所以这个数**线性**放大辉光。
   *
   * 第三次调整：0.6 → **0.28**（约砍一半）。理由同上：用户要的是"通灵感"，不是"发光"。
   */
  strength: 0.28,
  /** 溢光扩散半径。给小值以保住场景的边界。 */
  radius: 0.4,
} as const;

/** 加法合成 `base + bloom`（取自 three 官方 `webgl_postprocessing_unreal_bloom_selective`）。 */
const ADD_BLOOM_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const ADD_BLOOM_FRAGMENT = /* glsl */ `
  uniform sampler2D baseTexture;
  uniform sampler2D bloomTexture;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(baseTexture, vUv) + vec4(1.0) * texture2D(bloomTexture, vUv);
  }
`;

/** 选择性泛光的渲染器：两个 composer ＋ 一帧的完整渲染。 */
export interface SelectiveBloom {
  /** 一帧的完整渲染：先出泛光缓冲（背景摘掉），再合成上屏（背景恢复）。 */
  readonly render: () => void;
  /** 视口变化时同步两个 composer 的缓冲尺寸。 */
  readonly setSize: (width: number, height: number) => void;
  /**
   * 释放两个 composer 名下的 **GPU 缓冲**（T21）。
   *
   * 换关卡时场景要重建，而泛光抓着的是**场景对象的引用** —— 场景容器不换，泛光就不必重建；
   * 但万一哪天要重建它，这里得有个正经的释放口，否则每换一次关卡就漏一组 render target。
   */
  readonly dispose: () => void;
}

export function createSelectiveBloom(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  size: { readonly width: number; readonly height: number },
): SelectiveBloom {
  const renderPass = new RenderPass(scene, camera);

  // ① 泛光缓冲：背景置空渲染 —— 黑底不发光，于是泛光只从物体取样。
  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.renderToScreen = false;
  bloomComposer.setSize(size.width, size.height);
  bloomComposer.addPass(renderPass);
  bloomComposer.addPass(
    new UnrealBloomPass(
      new THREE.Vector2(size.width, size.height),
      BLOOM.strength,
      BLOOM.radius,
      BLOOM.threshold,
    ),
  );

  // ② 合成：正常渲染（背景照旧）＋ 加法叠加泛光纹理 ＋ 输出色彩空间转换。
  const addBloom = new ShaderPass(
    new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture },
      },
      vertexShader: ADD_BLOOM_VERTEX,
      fragmentShader: ADD_BLOOM_FRAGMENT,
    }),
    'baseTexture',
  );
  const finalComposer = new EffectComposer(renderer);
  finalComposer.setSize(size.width, size.height);
  finalComposer.addPass(renderPass);
  finalComposer.addPass(addBloom);
  finalComposer.addPass(new OutputPass());

  // 背景开关：**只在泛光那一遍**摘掉它；合成那一遍必须恢复，否则背景会变黑。
  const background = scene.background;
  const render = (): void => {
    scene.background = null;
    bloomComposer.render();
    scene.background = background;
    finalComposer.render();
  };

  const setSize = (width: number, height: number): void => {
    bloomComposer.setSize(width, height);
    finalComposer.setSize(width, height);
  };

  /**
   * `EffectComposer.dispose()` 会释放它自己的 render target；泛光那张纹理是
   * `bloomComposer.renderTarget2` 的纹理 —— 归 `dispose()` 管，这里不重复释放。
   * 两种情况都包在 `try` 里：不同 three 版本上 composer 的方法名不完全一样，
   * 而"释放不掉"远不该让换关卡失败。
   */
  const dispose = (): void => {
    try {
      bloomComposer.dispose();
      finalComposer.dispose();
    } catch {
      // 见上。
    }
  };

  return { render, setSize, dispose };
}
