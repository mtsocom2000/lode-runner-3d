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
 * 一个位置补间。`elapsed` 是**已过的秒数**，不是帧数 —— 这是"resize 无关"的全部秘密：
 * 只要时钟按秒走，视口大小、帧率、设备像素比都改变不了补间的位置。
 */
export interface Tween {
  readonly from: Vec3;
  readonly to: Vec3;
  readonly elapsed: number;
}

export function tweenTo(from: Vec3, to: Vec3): Tween {
  return { from, to, elapsed: 0 };
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
  return { from: to, to, elapsed: TWEEN_SECONDS };
}

/**
 * 中途换目标：**从当前插值位置**重新出发，绝不回跳。
 *
 * 这是这类同步最典型的手感事故：一格走完之前 sim 又给出下一格，如果直接把 `from`
 * 换成旧起点，角色会先往后退一小段再前进 —— 看起来像卡了一下。
 */
export function retarget(tween: Tween, to: Vec3): Tween {
  return { from: sample(tween), to, elapsed: 0 };
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
  return { ...tween, elapsed: Math.min(TWEEN_SECONDS, tween.elapsed + step) };
}

export function isDone(tween: Tween): boolean {
  return tween.elapsed >= TWEEN_SECONDS;
}

/** 采样当前位置。`elapsed = 0` 给 `from`，`elapsed ≥ TWEEN_SECONDS` 给 `to`。 */
export function sample(tween: Tween): Vec3 {
  const k = TWEEN_SECONDS <= 0 ? 1 : Math.min(1, tween.elapsed / TWEEN_SECONDS);
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

function lerp(a: number, b: number, k: number): number {
  return a + (b - a) * k;
}
