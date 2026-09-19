import { DIRS, stateAt, step, type Dir, type MoveMode } from '../core/rules/movement';
import type { Cell } from '../core/types';
import type { Level } from '../core/world/tiles';
import { playerAnchor } from './metrics';
import type { Vec3 } from './tween';

/**
 * 方向提示（用户反复反馈的第 3 点：WASD 在**拐角**与**岛台**上"完全不准"）。
 *
 * ## 为什么不是"换个映射"，而是把真相报出来
 *
 * 实测（把每个方向的位移投到相机的右轴/上轴，用的工具与 `input.test.ts` 里钉"折痕对输入透明"
 * 那两条完全相同）：
 *
 * | 位置 | right | left | up | down |
 * |---|---|---|---|---|
 * | 墙 A `A:4,1` | `(0.7, 0.3)` ✓ | `(-0.7,-0.3)` ✓ | — | — |
 * | 墙 A `A:8,1`（折痕最内列） | `(-0.8, 0.0)` ✗ | `(-0.7,-0.3)` | — | — |
 * | 甲板 `I:-3,-3` | `(0.7,-0.3)` | `(-0.7, 0.3)` | `(-0.7,-0.3)` ✗ | `(0.7, 0.3)` ✗ |
 *
 * 墙面正常，是因为墙的"行"是**世界 y**（= 屏幕上下，精确）。而**甲板是水平面**，
 * 这个相机的方位角又是 45°：平面上的两个轴在屏幕上都投成 `(±0.7, ∓0.3)` ——
 * **两个轴都很"横"**。于是按 `d` 和按 `w` 在屏幕上都是"往左右走"，只是一个略向下、一个略向上。
 * 折痕最内列同理：`A:8` 按 `d`（跨折痕）在屏幕上往**左**。
 *
 * 结论：**"让每个键都对准屏幕方向"在这个相机下无解** —— 换映射只是换个方向错。
 * 能做的、也对**所有**位置都成立的，是把"这个键实际会把你带向屏幕的哪个方位"如实报出来。
 * 所以这里输的是**两个分量**（→↑ 这种），而不是一个 8 向箭头：
 * 甲板上 `d` 与 `w` 的差别**恰恰只在那个上下分量上**，压成一个箭头就把它抹掉了。
 *
 * ## 顺带把"会落水"标出来
 *
 * 用户踩过的那一坑（"按 2 下 d 就掉进缺口"）本该在按之前就看得见。落水是**两个动作之一**
 * 里最要紧的一条信息，所以它单独成一条，而不是混在方位记号里。
 */

/** 相机的屏幕坐标轴（世界向量）。由调用方从 `camera.matrixWorld` 取（见 `main.ts`）。 */
export interface ScreenAxes {
  readonly right: Vec3;
  readonly up: Vec3;
}

export interface DirHint {
  readonly dir: Dir;
  /** 屏幕方位记号，如 `→↓`；`×` = 这一步走不了（撞墙 / 出界 / 没梯）。 */
  readonly glyph: string;
  /** 这一步会**落水**（扣命）。 */
  readonly danger: boolean;
}

/**
 * 位移在某个轴上小于它就算"没有这个方向"。一格的世界位移约 `CUBE`(1.0)，
 * 所以 0.15 是"不足六分之一格"—— 肉眼在那个量级上分辨不出偏差。
 */
const NEGLIGIBLE = 0.15;

const H = (sx: number): string => (sx > NEGLIGIBLE ? '→' : sx < -NEGLIGIBLE ? '←' : '');
const V = (sy: number): string => (sy > NEGLIGIBLE ? '↑' : sy < -NEGLIGIBLE ? '↓' : '');

/** 键位记号（与 WASD 一致；`core` 的 `up/down` 在这里才第一次与键名绑定）。 */
const KEY: Readonly<Record<Dir, string>> = { up: 'w', down: 's', left: 'a', right: 'd' };

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** 两点的距离（用来识别"这一步其实没动" —— 跨折痕那一跳）。 */
function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 四个方向各自会走到屏幕的哪个方位。**纯函数**（只吃 `level` + 当前格 + 屏幕轴），
 * 所以能直接在无头测试里断言 `test/hints.test.ts`。
 */
export function dirHints(
  level: Level,
  at: Cell,
  mode: MoveMode,
  axes: ScreenAxes,
  bridges?: ReadonlySet<string>,
): readonly DirHint[] {
  const base = playerAnchor(level, at, mode, bridges);
  const opts = { bridges };

  return DIRS.map((dir): DirHint => {
    const result = step(level, { cell: at, mode }, dir, opts);

    let to: Vec3 | null = null;
    let danger = false;
    if (result.kind === 'move') {
      to = playerAnchor(level, result.state.cell, result.state.mode);
      // **跨折痕那一步的位移是 0**（两格在世界同一个位置 —— 见 `metrics.BRICK_N`），
      // 直接报方位会得到 `·`，对玩家等于没说。玩家要的是"按下去之后我会往屏幕的哪边走"，
      // 所以这一步之后再走一步、报那一步的方位（那正是他松手再按时会看到的）。
      if (distance(to, base) < NEGLIGIBLE) {
        const next = step(level, result.state, dir, opts);
        if (next.kind === 'move') {
          to = playerAnchor(level, next.state.cell, next.state.mode);
        } else if (next.kind === 'fall') {
          if (next.end.kind === 'landed') {
            to = playerAnchor(level, next.end.cell, stateAt(level, next.end.cell)?.mode ?? 'stand');
          } else {
            danger = true;
            to = playerAnchor(level, next.end.from, result.state.mode);
          }
        }
      }
    } else if (result.kind === 'fall') {
      if (result.end.kind === 'water') {
        danger = true;
        // 记号打在想踏进去的那一格（= 缺口本身），而不是水面上 —— 那才是玩家看着的目标。
        to = playerAnchor(level, result.end.from, mode);
      } else {
        to = playerAnchor(level, result.end.cell, stateAt(level, result.end.cell)?.mode ?? 'stand');
      }
    }

    if (to === null) return { dir, glyph: '×', danger: false };
    const delta: Vec3 = [to[0] - base[0], to[1] - base[1], to[2] - base[2]];
    const glyph = `${H(dot(delta, axes.right))}${V(dot(delta, axes.up))}` || '·';
    return { dir, glyph, danger };
  });
}

/** 一行给 HUD 的提示：方位 + 键位，末尾单列"会落水"的键。 */
export function formatDirHints(hints: readonly DirHint[]): string {
  const parts = hints.map((h) => `${KEY[h.dir]}=${h.glyph}`);
  const danger = hints.filter((h) => h.danger).map((h) => KEY[h.dir]);
  const tail = danger.length === 0 ? '' : ` ｜ ⚠ 会落水：${danger.join('/')}`;
  return `屏幕方向（按下的键实际会往哪走）：${parts.join('  ')}${tail}`;
}
