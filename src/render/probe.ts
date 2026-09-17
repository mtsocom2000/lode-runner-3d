import type * as THREE from 'three';

/**
 * 像素探针：把"画面上到底出现了什么颜色"变成可断言的数字。
 *
 * 为什么需要它：无头测试能证明"状态对"，但证明不了"像素对"。本仓库的原型阶段
 * 出现过**整片白块**这类只有看图才发现的 bug —— 那种 bug 逃得过全部单测。
 * 所以 T5 的验收里专门有一条"像素探针"。
 *
 * 两个刻意的设计决定：
 *
 * 1. **不拿材质色当期望色。** 渲染出来的像素是受过光、混过背景的，砖块的材质色
 *    0x40607c 打在屏幕上可能接近 0x90b0c8 —— 拿材质色去"最近邻匹配"会把砖判成梯。
 *    所以特征判定一律用**色相规则**（品红只能是横杆、绿只能是出口……），
 *    这些规则受光影响小得多。
 * 2. **同时报出主导色。** 断言之外还留一份"实际渲出了哪几坨颜色"的清单：
 *    探针失败时它直接告诉你画面长什么样，不用再去猜。
 */

export interface DominantColor {
  /** 量化到 5 位/通道后的颜色，形如 `#40607c`。 */
  readonly hex: string;
  readonly count: number;
}

export interface ProbeSummary {
  /** drawingBuffer 尺寸（px）。 */
  readonly size: readonly [number, number];
  /** 实际采样的像素数（按 `step` 跳采）。 */
  readonly sampled: number;
  /** 接近纯白（各通道 > 240）的占比 —— "白块"回归的探测器。 */
  readonly whiteRatio: number;
  /** 出现最多的量化色，按像素数降序，最多 12 条。 */
  readonly dominant: readonly DominantColor[];
  /** 关键特征是否出现在画面里。 */
  readonly features: Readonly<Record<string, boolean>>;
  /**
   * 各特征命中像素的**重心**（只有 count > 0 的特征才有条目）。
   *
   * 为什么光有 `features` 不够：`true` 只说明"这类东西画出来了"，说明不了"画在**该在的地方**"。
   * 有了重心，页面就能把"**算**出来的位置"与"**画**出来的位置"对账 ——
   * 单测能证明 `playerAnchor` 算得对，但证明不了 `meshSync` 真的用了它；这条才是那个证据。
   *
   * 坐标系与 `readPixels` 一致：**原点在左下角**，单位是 drawingBuffer 像素。
   */
  readonly centroids: Readonly<Record<string, FeatureHit>>;
}

/** 某类特征命中像素的统计。 */
export interface FeatureHit {
  readonly count: number;
  readonly x: number;
  readonly y: number;
  /** 命中像素的外接框（左下角坐标系）。重心对不上时，靠它分辨"整体偏移"还是"混进了杂物"。 */
  readonly bbox: readonly [number, number, number, number];
}

/**
 * 色相规则。每条只认一种东西，且都是**只有它会**满足的条件：
 * 品红只有横杆/连杆，绿只有出口，金只有岛台宝物，亮青只有芯片/折痕/梯。
 */
const FEATURE_RULES: Readonly<Record<string, (r: number, g: number, b: number) => boolean>> = {
  /** 品红：横杆 / 连杆（0xff4fd0）。 */
  bar: (r, g, b) => r > 150 && b > 130 && g < r * 0.62 && g < b * 0.72,
  /** 绿：出口（0x37e068）。 */
  exit: (r, g, b) => g > 110 && g > r * 1.28 && g > b * 1.15,
  /** 亮青：数据芯片 / 折痕 / 梯（0x4fe6ff / 0xbfe6ff）。 */
  cyan: (r, g, b) => b > 170 && g > 150 && r < b * 0.86,
  /** 金：岛台宝物（0xf0c04a）。 */
  prize: (r, g, b) => r > 150 && g > 105 && b < 115 && r >= g,
  /**
   * 饱和蓝：角色（`PALETTE.player` = 0x2f6fd0 = 47,111,208）。
   *
   * 角色的身体是 **unlit**（`MeshBasicMaterial`，不打光），所以它的颜色是全画面里**最可预测**的一个。
   *
   * ## 这条规则改过一次 —— 因为判据的**前提**变了（重要教训）
   *
   * 原版是"贴着 (47,111,208) 的 ±14 小盒"，并写明"越紧越对"：外发光壳与身体**同色**、
   * 只是半透明（`0.32*C + 0.68*dst`），壳盖在身体上时混合结果**恒等于 C**，盖在任何别处
   * 都不等于 C —— 那是个**定义**，不是容差。推理没错。
   *
   * 但那句话只在**帧未经后处理**时成立。加选择性泛光之后，泛光会往角色身上**加光**，
   * 身体像素不再等于 C，于是探针报"画面上没有角色"——而截图里角色明明在那儿。
   * （**同一个坑踩过两次**：调色板换浅色版时 player 改色、规则没跟着改，也是这个症状。）
   *
   * > **教训：探针失败先怀疑规则过期 —— 而且"紧"要紧在**不变量**上，
   * > 不要紧在一个只在特定渲染路径下成立的绝对值上。**
   *
   * ## 现在的判据：只比**通道差**（对加法泛光、色彩空间转换都不变）
   *
   * 关键事实：**壳盖在任何东西上都不够"蓝"，而身体恒为强蓝。** 算术上界：
   * 壳盖在最亮的东西（纯白 255）上 → `0.32*C + 0.68*255 = (188, 209, 240)`，`b - r = 52`；
   * 盖在砖上、水面上只会更低（砖 ≈ (151, 172, 196) → 45）。而身体 `b - r = 208 - 47 = 161`。
   * 于是 `b - r > 90` 把"壳盖杂物"**整类**排除，离身体仍有 ≈1.8× 余量。
   * `b - g > 50` 再排掉同属亮青的芯片/梯（`0x4fe6ff` 的 `b - g` 只有 25，身体有 97）。
   *
   * 泛光加的光近似**白色** ⇒ 对这两个**差值**影响很小（先增、极端时才截断），
   * 所以这条判据**不随泛光强度重标**。若它哪天又失败，先看 `dominant` 里有没有强蓝簇 ——
   * 有簇就说明是规则过期，没簇才是角色真没画出来。
   *
   * > **改 `PALETTE.player` 的色相仍要回看这里**（palette.ts 文件头写的"同一份契约的两端"）。
   */
  player: (r, g, b) => b - r > 90 && b - g > 50,
  /**
   * 紫罗兰：巡逻无人机（`PALETTE.drone` = 0x8467b8 = 132,103,184）。
   *
   * 它是场景里**独一份**的色相（选色时逐一排除了 bar 的陶土红、exit/prize/chip/player 的绿金青蓝，
   * 见 `palette.ts` 的说明），所以这条规则只需要把"紫"卡出来，不必贴绝对值 ——
   * 与 `player` 那条同一条理由：**紧在因后处理而不变的关系上，不紧在一个绝对色值上**。
   */
  drone: (r, g, b) => b > 150 && r > 90 && r > g && b > g * 1.4,
};

/**
 * 渲染一帧已完成后读回像素并统计。要求 renderer 建的时候带了
 * `preserveDrawingBuffer: true`，否则帧末读回来可能是空的。
 *
 * `step` 默认 **1**（逐像素）：重心与外接框是要拿去**断言**的，跳采会让小目标（角色只有
 * 二十来个像素）的质心偏差到十几像素 —— 那时探针测的是采样网格，不是画面。
 * 全画布读一遍在这个尺寸下是百万级循环，一次性开销，可以忽略。
 */
export function probePixels(renderer: THREE.WebGLRenderer, step = 1): ProbeSummary {
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const buf = new Uint8Array(w * h * 4);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);

  const hist = new Map<string, number>();
  /** 每类特征：命中数 + 坐标和（算重心）+ 外接框。 */
  interface Bucket {
    count: number;
    sx: number;
    sy: number;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }
  const hit: Record<string, Bucket> = {};
  for (const key of Object.keys(FEATURE_RULES)) {
    hit[key] = { count: 0, sx: 0, sy: 0, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  }

  let sampled = 0;
  let white = 0;

  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const r = buf[i] ?? 0;
      const g = buf[i + 1] ?? 0;
      const b = buf[i + 2] ?? 0;
      sampled++;

      if (r > 240 && g > 240 && b > 240) white++;

      for (const [key, rule] of Object.entries(FEATURE_RULES)) {
        const bucket = hit[key];
        if (bucket === undefined || !rule(r, g, b)) continue;
        bucket.count += 1;
        bucket.sx += x;
        bucket.sy += y;
        if (x < bucket.minX) bucket.minX = x;
        if (y < bucket.minY) bucket.minY = y;
        if (x > bucket.maxX) bucket.maxX = x;
        if (y > bucket.maxY) bucket.maxY = y;
      }

      // 量化到 5 位/通道再统计，免得抗锯齿把每种颜色都打散成几万个孤点。
      const qr = r & 0xf8;
      const qg = g & 0xf8;
      const qb = b & 0xf8;
      const hex = `#${((qr << 16) | (qg << 8) | qb).toString(16).padStart(6, '0')}`;
      hist.set(hex, (hist.get(hex) ?? 0) + 1);
    }
  }

  const dominant = [...hist.entries()]
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);

  const features: Record<string, boolean> = {};
  const centroids: Record<string, FeatureHit> = {};
  for (const [key, bucket] of Object.entries(hit)) {
    features[key] = bucket.count > 0;
    if (bucket.count > 0) {
      centroids[key] = {
        count: bucket.count,
        x: bucket.sx / bucket.count,
        y: bucket.sy / bucket.count,
        bbox: [bucket.minX, bucket.minY, bucket.maxX, bucket.maxY],
      };
    }
  }

  return {
    size: [w, h],
    sampled,
    whiteRatio: sampled === 0 ? 0 : white / sampled,
    dominant,
    features,
    centroids,
  };
}
