import { describe, expect, it } from 'vitest';
import { PALETTE, type PaletteKey } from '../src/render/palette';
import { FEATURE_RULES } from '../src/render/probe';

/**
 * **调色板 × 探针**的契约测试。
 *
 * `palette.ts` 的文件头写着"改这 5 个色相规则里的任何一个，都必须同步改 `probe.ts` 对应的那条，
 * 否则探针会开始误判" —— 但那条契约**一直只有注释在维护**。它已经漂过三次，而且都是
 * **只有探针到不了的关卡才掩盖住**的：
 *
 * - `bar` 的规则还停在深色版的**品红**上，而横杆早已改成陶土红 —— L1 没有横杆，这条坏了整整一版，
 *   直到 L2（第一关带横杆）接上探针才现形；
 * - `cyan`（墙上宝物芯片）的旧门槛能把**水面**也算进去；
 * - 新加的攀爬者第一版按"暗青"卡绝对明度，泛光一加就再也匹配不到。
 *
 * 所以这里把契约变成**可执行的**：把 `PALETTE` 里**每一项**都过一遍规则，断言
 *
 * 1. 该命中某条规则的（`prize`/`exit`/`bar`/`player`/`drone`/`stalker`）**只命中那一条**；
 * 2. 其余每一项（砖、水、背板……）**一条都不命中** —— 否则探针会把它们数成别的东西，
 *    于是"画面上有出口"这种断言会被一片水面喂饱。
 *
 * 判据只看**通道差**（对加法泛光不变），所以这条测试与"画面上真实渲出来什么"同口径。
 */
const CONTRACT: Readonly<Record<PaletteKey, string | null>> = {
  // 场景本体：不该被认成任何特征
  bg: null,
  shell: null,
  edge: null,
  seam: null,
  brick: null,
  hard: null,
  lad: null,
  water: null,
  bed: null,
  rim: null,
  glint: null,
  ink: null,
  pit: null,
  // 道具与实体：各自那条
  bar: 'bar',
  prize: 'prize',
  exit: 'exit',
  player: 'player',
  drone: 'drone',
  stalker: 'stalker',
  // 反馈记号：自己那条（只在"挖了空处"那 0.15 秒里出现，无头探针看不到它 ——
  // 这条登记是为了让"调色板每一项都有人管"这条契约继续成立）
  blocked: 'blocked',
};

function rgb(hex: number): readonly [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

function hitsOf(hex: number): readonly string[] {
  const [r, g, b] = rgb(hex);
  return Object.entries(FEATURE_RULES)
    .filter(([, rule]) => rule(r, g, b))
    .map(([name]) => name);
}

describe('palette × probe：颜色与色相规则是同一份契约', () => {
  for (const [key, expected] of Object.entries(CONTRACT) as readonly [PaletteKey, string | null][]) {
    it(`${key} → ${expected ?? '（不该命中任何规则）'}`, () => {
      expect(hitsOf(PALETTE[key])).toEqual(expected === null ? [] : [expected]);
    });
  }

  it('契约表覆盖了调色板的每一项（新加颜色时别漏登记）', () => {
    expect(Object.keys(CONTRACT).sort()).toEqual(Object.keys(PALETTE).sort());
  });
});
