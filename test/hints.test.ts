import { describe, expect, it } from 'vitest';
import { CONCEPT_MINIMAL } from '../src/core/level/levels/conceptMinimal';
import { parseLevel } from '../src/core/world/tiles';
import { createCamera } from '../src/render/camera';
import { dirHints, formatDirHints, type DirHint, type ScreenAxes } from '../src/render/hints';

/**
 * 方向提示：把"每个键实际会往**屏幕**哪边走"变成可断言的数字。
 *
 * 相机取**真**的那个（与 `input.test.ts` 里钉"折痕对输入透明"同源）——
 * 于是谁转了相机、改了折角，这里的数字会跟着变，提示也就跟着重新校准，
 * 而不是留下一句写死在注释里的印象。
 */
const parsed = parseLevel(CONCEPT_MINIMAL);
if (!parsed.ok) throw new Error(`概念关卡必须合法：${JSON.stringify(parsed.errors)}`);
const level = parsed.level;

const cam = createCamera();
cam.updateMatrixWorld(true);
const el = cam.matrixWorld.elements;
const axes: ScreenAxes = {
  right: [el[0] ?? 0, el[1] ?? 0, el[2] ?? 0],
  up: [el[4] ?? 0, el[5] ?? 0, el[6] ?? 0],
};

function get(hints: readonly DirHint[], dir: DirHint['dir']): DirHint {
  const found = hints.find((h) => h.dir === dir);
  if (found === undefined) throw new Error(`提示里应当有 ${dir}`);
  return found;
}

const hintsAt = (face: 'A' | 'B' | 'I', col: number, row: number): readonly DirHint[] =>
  dirHints(level, { face, col, row }, 'stand', axes);

describe('hints：屏幕方向（用户反馈"WASD 在拐角与岛台上完全不准"）', () => {
  it('岛台：两个轴都很"横"，d 与 w 的差别**只在上下分量**上（所以必须两个分量都报）', () => {
    // 这是 45° 方位角 + 水平面的几何后果，不是映射写错了：
    // 换映射只是换个方向错 —— 唯一能做的就是把真相报出来。
    const hints = hintsAt('I', -3, -3);
    expect(get(hints, 'right').glyph).toBe('→↓');
    expect(get(hints, 'left').glyph).toBe('←↑');
    // 2026-09-19：`up`/`down` 对调过（`DECK_DIR`）—— 现在每个键落在**自己的屏幕象限**里：
    // `d`↘ / `w`↗ / `a`↖ / `s`↙。以前 `w` 报的是 `←↓`（左下方），用户的原话是"更加反直觉"。
    expect(get(hints, 'up').glyph).toBe('→↑');
    expect(get(hints, 'down').glyph).toBe('←↓');
  });

  it('墙面上：col±1 就是屏幕水平（以 → / ← 开头）', () => {
    // 只断言**水平分量**：垂直那一丁点会随"脚下是砖还是梯子"变（梯格锚点在格心、
    // 比砖顶面高 0.25），那不是这条测试的主题 —— 主题是"墙面上横移在屏幕上确实是横的"。
    // 取 `col 5`：左右邻都是普通砖格，且不在接头列（概念关卡的接头是 `A:4`）上。
    expect(get(hintsAt('A', 5, 1), 'right').glyph.startsWith('→')).toBe(true);
    expect(get(hintsAt('A', 5, 1), 'left').glyph.startsWith('←')).toBe(true);
  });

  it('折痕最内列**不再反向**：A:8 按 d 在屏幕上往**右**（拐角手感已修）', () => {
    // 以前这里是反的（`←`）—— 因为折痕一步会把人从墙角"送进对面墙的背板里"，
    // 位移里带上了那半格的错位。修好之后折痕一步是**原地转 90°**，提示于是报的是
    // "接着走下去会往屏幕哪边"（拿到的是那个方向的真实投影）。
    expect(get(hintsAt('A', 8, 1), 'right').glyph.startsWith('→')).toBe(true);
    // 另一侧同理：B:9 按 a 往左。
    expect(get(hintsAt('B', 9, 1), 'left').glyph.startsWith('←')).toBe(true);
  });

  it('落水必须**提前**标出来：从 A:3,1 按 a 会掉进 col2 的缺口', () => {
    const hints = hintsAt('A', 3, 1);
    expect(get(hints, 'left').danger).toBe(true);
    // 右边是接头（上小道），不是水 —— 别把好东西也标成危险。
    expect(get(hints, 'right').danger).toBe(false);
    expect(formatDirHints(hints)).toContain('⚠ 会落水：a');
  });

  it('走不了的方向记 ×（出界 / 撞墙 / 没梯），且不会误报落水', () => {
    const hints = hintsAt('A', 0, 1); // 出生点：左边就是网格外
    expect(get(hints, 'left').glyph).toBe('×');
    expect(formatDirHints(hints)).not.toContain('⚠');
  });

  it('墙面那行**不列** `w`/`s`（那里它们不是移动键，按了不走）', () => {
    // 用户 2026-09-19 的裁定：墙上的上下是爬梯，而爬梯归 `Z`/`X` —— 见 `moveAllowed`。
    const line = formatDirHints(hintsAt('A', 5, 1), 'wall');
    expect(line).not.toContain('w=');
    expect(line).not.toContain('s=');
    expect(line).toContain('a=');
    expect(line).toContain('d=');
    expect(line).toContain('Z/X');
  });
});
