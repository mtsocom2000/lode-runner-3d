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
    expect(get(hints, 'up').glyph).toBe('←↓'); // 按 w 在屏幕上往**左下**，不是正上
    expect(get(hints, 'down').glyph).toBe('→↑');
  });

  it('墙面上正常：A 面中段按 d 就是屏幕向右（那一丁点向上不影响读法）', () => {
    const hints = hintsAt('A', 4, 1);
    expect(get(hints, 'right').glyph).toBe('→↑');
    expect(get(hints, 'left').glyph).toBe('←↓');
  });

  it('折痕最内列反向：A:8 按 d 在屏幕上往**左**（"拐角手感不对"的数字证据）', () => {
    expect(get(hintsAt('A', 8, 1), 'right').glyph).toBe('←');
    // 另一侧同理：B:9 按 a 反而往右。
    expect(get(hintsAt('B', 9, 1), 'left').glyph).toBe('→');
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
});
