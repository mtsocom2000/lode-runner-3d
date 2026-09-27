export type Vec3 = readonly [number, number, number];

/**
 * 一格移动的视觉补间时长（秒）。
 *
 * 与玩法节奏的关系：`MOVE_TICKS / TICK_HZ = 8/60 ≈ 0.133s` 走一格。这里取 **0.15** ——
 * 略长于一步，于是连续行走时下一格的补间会**接上**上一格没走完的尾巴，读起来是"滑行"
 * 而不是"一格一顿"。取短于一步（比如 0.1）会看到每格末尾有个静止的死帧。
 */
export const TWEEN_SECONDS = 0.15;

/**
 * **坠落**的补间时长（秒）——**一格一段**，每段与走一格同一尺度（用户 2026-09-23：
 * "从高处落下时，速度太快"）。
 *
 * ## 两次修正（第一版两次都错，记在这里免得再犯）
 *
 * 1. 原先走一格与掉六格**都是** `TWEEN_SECONDS`（0.15s）—— 掉得越多看起来越快，六格时的
 *    速度是走路的六倍，像被弹射出去；
 * 2. 第二版按**总距离**给时长（`√(2d/g)`）—— 于是掉六格要走 1.0 秒**一趟直线**，
 *    中间那几层地皮**直接穿过去了**（`aim` 只会把新目标铺一条直线：下方一层有平台的坠落
 *    因此从空中穿过平台再弹回来），而且那样的"坠落"是匀速的、不像重力。
 *
 * 正确的做法是**分段**：每下落**一格**一段补间，`FALL_SEGMENT_SECONDS` 比走路略长
 * （看得清是"掉"而不是"走"），于是长坠落 = 多段累积，**天然越来越快**（每段一样长、
 * 每段覆盖一格，观感上连续）——不必去模拟加速度，也不会有任何穿插。
 *
 * ## 这**不是**时间膨胀
 *
 * sim 的时钟不受它影响（`tick` 按 `TICK_HZ` 走，与渲染无关）—— 所以"长坠落看着更久"
 * 只是**画得慢一点**：下落期间角色照旧按规则移动、按规则结算落点。规则与观感仍然是两层。
 */
export const FALL_SEGMENT_SECONDS = 0.2;

/**
 * 一个位置补间。`elapsed` 是**已过的秒数**，不是帧数 —— 这是"resize 无关"的全部秘密：
 * 只要时钟按秒走，视口大小、帧率、设备像素比都改变不了补间的位置。
 *
 * `seconds`（这一次要走多久）**存在补间里** —— "多长"是这一次移动的属性；坠落更是**一格一段**
 * （见上），所以它绝不能是全局常量。
 */
export interface Tween {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly elapsed: number;
  readonly seconds: number;
}

export function tweenTo(from: Vec3, to: Vec3, seconds: number = TWEEN_SECONDS): Tween {
  return { from, to, elapsed: 0, seconds };
}

/**
 * 一个"已经在终点"的补间：`from === to`，且时钟已经走满。
 *
 * 用途只有一个：**位置发生了不连续的变化**（重生、将来的关卡切换）时禁止插值 ——
 * 否则角色会被画成一条横穿场景的直线（见 `meshSync` 的 `snapEntities`）。
 *
 * 为什么复用 `Tween` 而不加一个"瞬移"分支：`sample` / `isDone` / `aim` 等消费方一行都不用改，
 * 而且瞬移只发生一帧：下一帧 `aim` 会发现目标没变、原样返回，照常滑。
 */
export function snapTo(to: Vec3): Tween {
  // elapsed === seconds ⇒ 已经走完（sample 直接给 	o）—— 瞬间到位，不插值。
  return { from: to, to, elapsed: TWEEN_SECONDS, seconds: TWEEN_SECONDS };
}

/**
 * 中途换目标：**从当前插值位置**重新出发，绝不回跳。
 *
 * 这是这类同步最典型的手感事故：一格走完之前 sim 又给出下一格，如果直接把 `from`
 * 换成旧起点，角色会先往后退一小段再前进 —— 看起来像卡了一下。
 */
export function retarget(tween: Tween, to: Vec3): Tween {
  // **时长跟着新目标重算**：走一格 → 掉六格时若沿用旧的 0.15 秒，那一次坠落又会快到像瞬移。
  // 判据是"这一跳是不是**往下一格以上**"（坠落）：是就按**一格一段**给（见文件头），
  // 于是长坠落由同步层**逐格推进**（`meshSync`），不会有直线穿插。
  return { from: sample(tween), to, elapsed: 0, seconds: stepSeconds(sample(tween), to) };
}

/** 这一跳该用多长：**往下超过一格**（坠落）用坠落那一档，其余（走位 / 往上 / 斜走）用走路那一档。 */
export function stepSeconds(from: Vec3, to: Vec3): number {
  const down = from[1] - to[1];
  const sideways = Math.abs(to[0] - from[0]) > 1e-9 || Math.abs(to[2] - from[2]) > 1e-9;
  return down > 1e-9 && !sideways ? FALL_SEGMENT_SECONDS : TWEEN_SECONDS;
}

/**
 * 把补间对准新目标 —— **目标没变就原样返回**。
 *
 * 同步层每帧都会调它，所以"没变就不动"这件事必须在这里保证：若每帧都重开补间，
 * `elapsed` 会被反复清零，角色看起来像被钉在原地 —— 一格也走不完。
 * 于是这个判断不是优化，是正确性的一部分。
 */
export function aim(tween: Tween, to: Vec3): Tween {
  return samePoint(tween.to, to) ? tween : retarget(tween, to);
}

/** 推进时钟。负数与超大 dt 都被夹住（标签页切回来时 dt 会很大，不该让它跳过补间）。 */
export function advance(tween: Tween, dt: number): Tween {
  const step = dt > 0 ? dt : 0;
  return { ...tween, elapsed: Math.min(tween.seconds, tween.elapsed + step) };
}

export function isDone(tween: Tween): boolean {
  return tween.elapsed >= tween.seconds;
}

/** 采样当前位置。`elapsed = 0` 给 `from`，`elapsed ≥ seconds` 给 `to`。 */
export function sample(tween: Tween): Vec3 {
  const k = tween.seconds <= 0 ? 1 : Math.min(1, tween.elapsed / tween.seconds);
  const eased = 1 - (1 - k) ** 3; // ease-out cubic：起步快、收尾缓
  return [
    lerp(tween.from[0], tween.to[0], eased),
    lerp(tween.from[1], tween.to[1], eased),
    lerp(tween.from[2], tween.to[2], eased),
  ];
}

/** 两个坐标是否同一个点。补间换目标前要先问这个 —— 否则每帧都会重开补间。 */
export function samePoint(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * 朝向的视觉补间时长（秒）。取 **0.08**（用户 2026-09-19 的建议）。
 *
 * 为什么需要它：**跨折痕那一步是"原地转 90°"**（位移为 0，见 `isSeamStep`）—— 逻辑上完全正确，
 * 但朝向记号直接跳 90° 看起来就是"卡了一下"。90° 本身是瞬间发生的（不是走出来的），
 * 所以给一个**比一步还短**的旋转补间：眼睛读到的是一次利落的"贴墙拐弯"，而不是停顿。
 */
export const TURN_SECONDS = 0.08;

/**
 * 把角度朝目标转一步，**走最短路**（`-π` 与 `+π` 是同一个方向）。
 *
 * 只做"每帧挪一点"，不做插值曲线：角度的起止每帧都可能变（玩家随时转身），
 * 而这里要的只是"别跳"。`seconds <= 0` 时直接到位。
 */
export function aimAngle(current: number, target: number, dt: number, seconds = TURN_SECONDS): number {
  if (seconds <= 0) return target;
  const full = Math.PI * 2;
  // 归一化到 (-π, π]：这样下面那句"走最短路"只需比较正负。
  const delta = ((((target - current) % full) + full + Math.PI) % full) - Math.PI;
  const step = ((dt > 0 ? dt : 0) / seconds) * Math.PI;
  if (Math.abs(delta) <= step) return target;
  return current + Math.sign(delta) * step;
}

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}
