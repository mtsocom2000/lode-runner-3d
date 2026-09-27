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
 * **坠落**的补间时长（秒）——**与距离成正比**（用户 2026-09-23："从高处落下时，速度太快"）。
 *
 * ## 为什么不能沿用 `TWEEN_SECONDS`
 *
 * 走一格与掉六格原来都是 0.15 秒 —— 于是"掉得越多看起来越快"，掉六格时速度是走路的六倍，
 * 像被弹射出去。重力是**匀加速**，观感上"掉得远就该久一点"，而不是恒定时间。
 *
 * 按 `√(2d/g)` 给时长（`FALL_G = 12` 格/秒²，与"一格一跳"的手感对得上）：
 * 掉 1 格 ≈ 0.41s、3 格 ≈ 0.71s、6 格 ≈ 1.0s。**匀加速本身不在这一步模拟**（补间仍是
 * 匀速 + 缓出），这里只把**时长**按距离给对：远掉明显更久、近掉不拖沓。上下都有夹子 ——
 * 太短像瞬移，太长会让"掉十几格"变成等动画。
 */
export const FALL_G = 12;
export const FALL_MIN_SECONDS = 0.18;
export const FALL_MAX_SECONDS = 1.2;

export function fallSeconds(from: Vec3, to: Vec3): number {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const raw = Math.sqrt((2 * Math.max(d, 0)) / FALL_G);
  return Math.min(FALL_MAX_SECONDS, Math.max(FALL_MIN_SECONDS, raw));
}

/**
 * 一个位置补间。`elapsed` 是**已过的秒数**，不是帧数 —— 这是"resize 无关"的全部秘密：
 * 只要时钟按秒走，视口大小、帧率、设备像素比都改变不了补间的位置。
 *
 * `seconds`（这一次要走多久）**存在补间里**，而不是像第一版那样到处读全局 `TWEEN_SECONDS`：
 * 坠落要按距离算时长（见 `fallSeconds`），而"多长"是这一次移动的属性，不是全局常量。
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
  // **时长跟着新目标重算**：中途换目标（走一格 → 掉六格）时，若沿用旧的 0.15 秒，
  // 那一次坠落又会快到像瞬移。重算的判据与 `tweenTo` 同一处（`fallSeconds`）。
  return { from: sample(tween), to, elapsed: 0, seconds: fallSeconds(sample(tween), to) };
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
