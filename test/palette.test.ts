import { describe, expect, it } from 'vitest';
import { PALETTE } from '../src/render/palette';
import { FEATURE_RULES } from '../src/render/probe';

/**
 * **调色板 × 探针**的契约测试。
 *
 * `palette.ts` 的文件头写着"改这 5 个色相规则里的任何一个，都必须同步改 `probe.ts` 对应的那条，
 * 否则探针会开始误判" —— 但那条契约**一直只有注释在维护**：改色的人忘了改规则，
 * 探针不会报错，它只会**认错东西**（历史上有两次：换浅色版时 player 改色、
 * 加泛光之后身体像素不再等于材质色）。
 *
 * 这条测试把契约变成可执行的：
 *
 * 1. 每个**实体**的颜色必须命中它自己那条规则（否则探针报"画面上没有它"）；
 * 2. 每个实体的颜色**不得**命中别人的规则（否则探针把 A 数成 B）；
 * 3. 规则的键与实体的键同名 —— 名字对不上时上面两条都是空转。
 */
const ENTITIES = ['player', 'drone', 'stalker'] as const;

function rgb(hex: number): readonly [number, number, number] {
  return [(hex >> 16) & 0xff, (hex >> 8) & 0xff, hex & 0xff];
}

describe('palette × probe：实体的颜色与色相规则是同一份契约', () => {
  for (const kind of ENTITIES) {
    it(`${kind}：命中自己的规则，且只命中自己那一条`, () => {
      const [r, g, b] = rgb(PALETTE[kind]);
      const hits = Object.entries(FEATURE_RULES)
        .filter(([, rule]) => rule(r, g, b))
        .map(([name]) => name);

      expect(hits).toContain(kind); // 探针得认得出它
      expect(hits).toEqual([kind]); // 也不能把它认成别的（或反过来）
    });
  }

  it('规则的键覆盖了三种实体（名字对不上时上面几条都是空转）', () => {
    for (const kind of ENTITIES) expect(Object.keys(FEATURE_RULES)).toContain(kind);
  });
});
