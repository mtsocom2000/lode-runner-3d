import {
  TURN_SECONDS,
  TWEEN_SECONDS,
  advance,
  aim,
  aimAngle,
  FALL_SEGMENT_SECONDS,
  stepSeconds,
  isDone,
  retarget,
  samePoint,
  sample,
  tweenTo,
  type Tween,
  type Vec3,
} from '../src/render/tween';
import { MOVE_TICKS, TICK_HZ } from '../src/core/sim';

const A: Vec3 = [0, 0, 0];
const B: Vec3 = [10, 0, 0];
const C: Vec3 = [0, 4, 0];

/** 按固定 dt 推进若干帧。 */
function run(tween: Tween, dt: number, frames: number): Tween {
  let t = tween;
  for (let i = 0; i < frames; i++) t = advance(t, dt);
  return t;
}

describe('tween：与玩法节奏的关系', () => {
  it('补间时长**不短于**走一格的时间 —— 否则每格末尾会出现一个静止的死帧', () => {
    const stepSeconds = MOVE_TICKS / TICK_HZ;
    expect(TWEEN_SECONDS).toBeGreaterThanOrEqual(stepSeconds);
  });
});

describe('tween：采样', () => {
  it('起点给 from，走满给 to', () => {
    const t = tweenTo(A, B);
    expect(sample(t)).toEqual(A);
    expect(isDone(t)).toBe(false);

    const done = advance(t, TWEEN_SECONDS);
    expect(sample(done)).toEqual(B);
    expect(isDone(done)).toBe(true);
  });

  it('中途在两端之间，且随时间是单调的（不会来回抖）', () => {
    let t = tweenTo(A, B);
    let prev = -1;
    for (let i = 0; i < 6; i++) {
      t = advance(t, TWEEN_SECONDS / 6);
      const x = sample(t)[0];
      expect(x).toBeGreaterThanOrEqual(prev);
      prev = x;
    }
    expect(prev).toBe(B[0]);
  });

  it('三段轴一起插值（折痕处转身会同时改两个轴）', () => {
    const t = advance(tweenTo(A, C), TWEEN_SECONDS);
    expect(sample(t)).toEqual(C);
  });
});

describe('tween：帧率无关（这条就是"resize 无关"的实质）', () => {
  it('一次 dt=0.15 与 15 次 dt=0.01 落在同一个点上', () => {
    const coarse = advance(tweenTo(A, B), TWEEN_SECONDS);
    const fine = run(tweenTo(A, B), 0.01, 15);
    expect(sample(fine)).toEqual(sample(coarse));
  });

  it('60fps 与 144fps 走同样的秒数 → 同样的位置', () => {
    const at60 = run(tweenTo(A, B), 1 / 60, 9); // 0.15s
    const at144 = run(tweenTo(A, B), 1 / 144, 22); // 0.1528s（已过冲，被夹住）
    expect(sample(at60)).toEqual(sample(at144));
    expect(sample(at60)).toEqual(B);
  });

  it('超过补间时长不会过冲：夹在终点上', () => {
    const t = advance(tweenTo(A, B), TWEEN_SECONDS * 4);
    expect(sample(t)).toEqual(B);
    expect(sample(advance(t, TWEEN_SECONDS)).every(Number.isFinite)).toBe(true);
  });

  it('dt = 0 或负值不倒退（切标签页回来时 dt 会很大，负数则来自时钟回拨）', () => {
    const half = advance(tweenTo(A, B), TWEEN_SECONDS / 2);
    expect(sample(advance(half, 0))).toEqual(sample(half));
    expect(sample(advance(half, -1))).toEqual(sample(half));
  });
});

describe('tween：中途换目标', () => {
  it('从**当前插值位置**重新出发，绝不回跳', () => {
    const half = advance(tweenTo(A, B), TWEEN_SECONDS / 2);
    const before = sample(half);

    const turned = retarget(half, C);
    // 关键：换目标的那一瞬间位置必须连续 —— 否则会看到角色"往后弹一下"。
    expect(sample(turned)).toEqual(before);
    expect(turned.from).toEqual(before);

    // 换目标会**按新距离重算时长**（走一格 → 掉六格不能还用 0.15 秒，见 `retarget`），
    // 所以"走完"要按那个新时长推。
    expect(sample(advance(turned, turned.seconds))).toEqual(C);
  });

  it('连续换目标（每帧一个新格）也一直向前，不会累积回跳', () => {
    let t = tweenTo(A, B);
    let prevX = sample(t)[0];
    for (let i = 1; i <= 5; i++) {
      t = retarget(advance(t, TWEEN_SECONDS / 3), [i * 10, 0, 0]);
      const x = sample(t)[0];
      expect(x).toBeGreaterThanOrEqual(prevX);
      prevX = x;
    }
  });
});

describe('tween：aimAngle（朝向的平滑，用户 2026-09-19）', () => {
  it('走**最短路**：从 0 转到 -90°（等价 +270°）是往负方向走，不绕远', () => {
    // 跨折痕那一步正好是 90°；`atan2` 给的角度会在 ±π 之间跳，取模必须归一化。
    const target = -Math.PI / 2;
    const step = aimAngle(0, target, TURN_SECONDS / 2);
    expect(step).toBeLessThan(0); // 往负方向（近的那边）
    expect(Math.abs(step)).toBeCloseTo(Math.PI / 2, 10);
  });

  it('π 附近不绕圈：从 +170° 到 -170° 只走 20°（不是 340°）', () => {
    const from = (170 * Math.PI) / 180;
    const to = (-170 * Math.PI) / 180;
    // 一步的时间够转 180°，所以直接到位 —— 关键是它**到了目标**，而不是绕另一头慢慢转。
    expect(aimAngle(from, to, TURN_SECONDS)).toBeCloseTo(to, 10);
  });

  it('时间按秒走：`TURN_SECONDS` 之内转完 90°，且帧率无关', () => {
    const target = -Math.PI / 2;
    expect(aimAngle(0, target, TURN_SECONDS * 2)).toBe(target); // 过冲也被夹在目标上

    let fine = 0;
    const frames = 8; // 8 帧 × TURN_SECONDS/8 = TURN_SECONDS
    for (let i = 0; i < frames; i++) fine = aimAngle(fine, target, TURN_SECONDS / frames);
    expect(fine).toBeCloseTo(target, 10);
  });

  it('已经对准就原样返回；没时间/`seconds <= 0` 时不动或直接到位', () => {
    expect(aimAngle(1, 1, 1 / 60)).toBe(1);
    expect(aimAngle(0, Math.PI * 2, 1 / 60)).toBe(Math.PI * 2); // 同一个方向的另一种写法
    expect(aimAngle(0, 2, 0)).toBe(0); // dt = 0：一帧没过去，不该转
    expect(aimAngle(0, 2, 1 / 60, 0)).toBe(2); // 不给时长 = 直接到位
  });
});

describe('tween：samePoint', () => {
  it('逐分量比较 —— 它是"要不要换目标"的判据，不能靠引用相等', () => {
    expect(samePoint([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(samePoint([1, 2, 3], [1, 2, 3.0001])).toBe(false);
    // 两个内容相同的**不同数组**必须判为同一点：坐标每帧都是新造的。
    expect(samePoint([1.5, 0, -2], [...[1.5, 0, -2]] as unknown as Vec3)).toBe(true);
  });
});

describe('tween：aim（同步层每帧都会调它）', () => {
  it('目标没变就**原样返回同一个对象** —— 否则每帧重开补间会把角色钉在原地', () => {
    const t = advance(tweenTo(A, B), TWEEN_SECONDS / 3);
    expect(aim(t, B)).toBe(t); // 引用相等：连"新造一个等价对象"都不该发生
  });

  it('坐标每帧都是新造的数组，也照样判得出"没变"', () => {
    const t = advance(tweenTo(A, B), TWEEN_SECONDS / 4);
    expect(aim(t, [B[0], B[1], B[2]])).toBe(t);
  });

  it('目标变了才换，且从**当前插值位置**出发（不回跳）', () => {
    const t = advance(tweenTo(A, B), TWEEN_SECONDS / 2);
    const next = aim(t, C);
    expect(next).not.toBe(t);
    expect(sample(next)).toEqual(sample(t)); // 换目标那一瞬间位置连续
    expect(next.to).toEqual(C);
  });

  it('连续 20 帧"喂同一个目标"不会把 elapsed 清零（走得到终点）', () => {
    let t = tweenTo(A, B);
    for (let i = 0; i < 20; i++) t = advance(aim(t, B), 1 / 60);
    expect(sample(t)).toEqual(B);
  });
});

describe('tween：坠落是**一格一段**（用户 2026-09-23："从高处落下时，速度太快"）', () => {
  it('往下超过一格 → 按坠落那一档（比走路长，看得清是"掉"）', () => {
    expect(stepSeconds([0, 6, 0], [0, 5, 0])).toBe(FALL_SEGMENT_SECONDS);
    expect(FALL_SEGMENT_SECONDS).toBeGreaterThan(TWEEN_SECONDS);
  });

  it('走路 / 往上 / 斜走 → 仍是走路那一档（阶梯子格的斜落不该被拖慢）', () => {
    expect(stepSeconds([0, 6, 0], [1, 6, 0])).toBe(TWEEN_SECONDS); // 平移
    expect(stepSeconds([0, 6, 0], [0, 7, 0])).toBe(TWEEN_SECONDS); // 往上
    expect(stepSeconds([0, 6, 0], [1, 5, 0])).toBe(TWEEN_SECONDS); // 斜的（横向也动了）
  });

  it('**每一段都一样长** —— 长坠落靠"多段"变慢，不靠单段拉长（那会直线穿插）', () => {
    // 这一段是两次修正的教训：按**总距离**给时长会让补间直奔终点，掉一层平台的坠落
    // 从空中穿过平台再弹回来。分段之后每段都只是"相邻两格之间"，穿不过任何东西。
    expect(stepSeconds([0, 9, 0], [0, 8, 0])).toBe(stepSeconds([0, 2, 0], [0, 1, 0]));
  });

  it('`retarget` 会按新一跳的性质给时长（走 → 掉，时长要跟着换档）', () => {
    const walking = advance(tweenTo([0, 6, 0], [1, 6, 0]), TWEEN_SECONDS / 2);
    const at = sample(walking); // 当前插值位置（`retarget` 从这里重新出发）
    // 横向还在动 ⇒ 仍是走位那一档。
    expect(retarget(walking, [at[0], at[1], at[2]]).seconds).toBe(TWEEN_SECONDS);
    // **正下方**那一格 ⇒ 换成坠落档。
    expect(retarget(walking, [at[0], at[1] - 1, at[2]]).seconds).toBe(FALL_SEGMENT_SECONDS);
  });
});