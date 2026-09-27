import { describe, expect, it } from 'vitest';
import { BLANK } from '../src/core/level/levels/blank';
import { L3 } from '../src/core/level/levels/l3';
import {
  LIBRARY_STORAGE_KEY,
  LEVEL_STORAGE_KEY,
  clearStoredLevel,
  decodeLevel,
  encodeLevel,
  loadLibrary,
  loadStoredLevel,
  newLevelKey,
  removeLevel,
  saveLibrary,
  storeLevel,
  upsertLevel,
} from '../src/app/levelstore';

/**
 * T21 · **关卡的保存与加载**。
 *
 * 用户的原话：*"有了编辑器，你就不要考虑场景生成的问题，而需要考虑场景的保存和加载。"*
 * 这类功能最经典的 bug 是"**存了读不回来**"（字段漏了、`fold` 没带上、甲板的 `ladder`
 * 丢了……），而它只有在编辑器里手改半天之后才会被发现。所以这里逐条钉住：
 *
 * 1. **往返无损**：`encode → decode` 之后与原关卡**逐字段相同**；
 * 2. **不合法的输入被拒绝**，而且**不抛异常**（调用方是 UI，抛出去就是白屏）；
 * 3. **存储里的坏草稿不会让游戏起不来** —— 读不到就退回内置关卡。
 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length(): number {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  } as Storage;
}

describe('T21 · 关卡存档：往返无损', () => {
  it('L3 编成文本再读回来，**逐字段相同**（含甲板三态、层、接头、闸门、宝物、敌人、出生点）', () => {
    const decoded = decodeLevel(encodeLevel(L3));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.def).toEqual(L3);
    // 特别是这几处 —— 它们都是"漏了就悄悄坏掉"的字段：
    expect(decoded.def.deck?.some((c) => c.ladder === true)).toBe(true);
    expect(decoded.def.deck?.some((c) => c.hang === true)).toBe(true);
    expect(decoded.def.spawn).toEqual(L3.spawn);
    expect(decoded.def.treasures?.some((t) => (t.level ?? 0) > 0)).toBe(true);
  });

  it('空白关卡也能往返（它就是编辑器新建时的那张）', () => {
    const decoded = decodeLevel(encodeLevel(BLANK));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.def).toEqual(BLANK);
    expect(decoded.def.tiles).toHaveLength(12);
    expect(decoded.def.tiles.every((row) => row.length === 28)).toBe(true);
  });
});

describe('T21 · 关卡存档：不合法的输入被拒绝（且不抛）', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['不是 JSON', '{ 这不是 json'],
    ['顶层是数组', '[]'],
    ['顶层是字符串', '"L3"'],
    ['缺 id', '{"name":"x","fold":2,"tiles":[".."]}'],
    ['缺 fold', '{"id":"X","name":"x","tiles":[".."]}'],
    ['缺 tiles', '{"id":"X","name":"x","fold":2}'],
    ['字形行不齐', '{"id":"X","name":"x","fold":2,"tiles":["..","..."]}'],
    ['出现不认识的字符', '{"id":"X","name":"x","fold":2,"tiles":["?.",".."]}'],
    ['fold 与列数对不上', '{"id":"X","name":"x","fold":3,"tiles":["..",".."]}'],
  ];

  for (const [name, text] of cases) {
    it(`${name} → ok:false，且带一句人话`, () => {
      const r = decodeLevel(text);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.length).toBeGreaterThan(0);
    });
  }

  it('报错信息里带**行号**（编辑器面板上直接显示它，好定位）', () => {
    const r = decodeLevel('{"id":"X","name":"x","fold":2,"tiles":["..","?..."]}');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('第 1 行');
  });
});

describe('T21 · 关卡存档：浏览器存储', () => {
  it('存了能读回来', () => {
    const s = fakeStorage();
    expect(storeLevel(L3, s)).toBe(true);
    expect(loadStoredLevel(s)).toEqual(L3);
  });

  it('没存过 → null（调用方退回内置关卡）', () => {
    expect(loadStoredLevel(fakeStorage())).toBeNull();
  });

  it('**草稿坏了也返回 null**，不抛 —— 否则编辑器手改坏一次就再也打不开', () => {
    const s = fakeStorage({ [LEVEL_STORAGE_KEY]: '{坏掉的草稿' });
    expect(loadStoredLevel(s)).toBeNull();
  });

  it('清掉之后读不到', () => {
    const s = fakeStorage();
    storeLevel(BLANK, s);
    clearStoredLevel(s);
    expect(loadStoredLevel(s)).toBeNull();
  });

  it('没有存储（隐私模式 / 无 DOM）时静默降级，不抛', () => {
    expect(storeLevel(L3, null)).toBe(false);
    expect(loadStoredLevel(null)).toBeNull();
  });
});

describe('关卡库（T21 #3）：命名槽 + 迁移 + 删不得空', () => {
  it('空存储 → 内置三关，active 落在 L3（与旧行为一致：打开就能玩）', () => {
    const lib = loadLibrary(fakeStorage());
    expect(lib.levels.map((e) => e.key)).toEqual(['builtin:l1', 'builtin:l2', 'builtin:l3']);
    expect(lib.active).toBe('builtin:l3');
  });

  it('**老单槽要迁移**（用户手上那张图不能丢），并且直接成为 active', () => {
    // 用户正在画的那一关就在老键里 —— 升级成库不该让人丢图。
    const s = fakeStorage({ [LEVEL_STORAGE_KEY]: encodeLevel(BLANK) });
    const lib = loadLibrary(s);
    expect(lib.active).toBe('migrated');
    expect(lib.levels.some((e) => e.key === 'migrated')).toBe(true);
    expect(lib.levels).toHaveLength(4);
  });

  it('存进去的库读得回来（含 active）', () => {
    const s = fakeStorage();
    const lib = loadLibrary(s);
    const one = upsertLevel(lib, 'mine', BLANK);
    expect(saveLibrary(one, s)).toBe(true);
    const back = loadLibrary(s);
    expect(back.active).toBe('mine');
    expect(back.levels.filter((e) => e.key === 'mine')).toHaveLength(1);
  });

  it('active 指着一个不存在的槽 → 落到第一个；坏 JSON → 退回种子（**不抛**）', () => {
    const s = fakeStorage({ [LIBRARY_STORAGE_KEY]: JSON.stringify({ active: 'gone', levels: [{ key: 'a', def: BLANK }] }) });
    expect(loadLibrary(s).active).toBe('a');
    expect(loadLibrary(fakeStorage({ [LIBRARY_STORAGE_KEY]: '{坏的' })).levels).toHaveLength(3);
  });

  it('upsert：新槽进库、active 跟着走；同键是**替换**不是新增', () => {
    const base = { active: 'a', levels: [{ key: 'a', def: BLANK }] };
    const added = upsertLevel(base, 'b', BLANK);
    expect(added.levels.map((e) => e.key)).toEqual(['a', 'b']);
    expect(added.active).toBe('b');
    const replaced = upsertLevel(added, 'b', BLANK);
    expect(replaced.levels).toHaveLength(2);
  });

  it('删除：删掉 active → active 落到剩下的第一个；**最后一关删不掉**', () => {
    const lib = { active: 'a', levels: [{ key: 'a', def: BLANK }, { key: 'b', def: BLANK }] } as const;
    const afterA = removeLevel(lib, 'a');
    expect(afterA.active).toBe('b');
    expect(afterA.levels.map((e) => e.key)).toEqual(['b']);
    const empty = removeLevel(afterA, 'b');
    expect(empty.levels).toHaveLength(1); // 留一个空白的：库里一个都没有的状态要处处特判，不如让它不可能
  });

  it('新槽键不重复（连开两次"新建"不会撞车）', () => {
    expect(newLevelKey()).not.toBe(newLevelKey());
  });
});