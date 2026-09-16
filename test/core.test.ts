import { cellKey, parseCell, type Cell } from '../src/core/types';

describe('core：折面坐标的键编码（T1 折叠映射的地基）', () => {
  it('cellKey → parseCell 往返无损', () => {
    const cells: Cell[] = [
      { face: 'A', col: 0, row: 0 },
      { face: 'A', col: 6, row: 9 },
      { face: 'B', col: 7, row: 9 },
      { face: 'B', col: 13, row: 0 },
    ];
    for (const c of cells) {
      expect(parseCell(cellKey(c))).toEqual(c);
    }
  });

  it('两面不会被混为一谈：同 col/row、不同 face 必须是不同的键', () => {
    expect(cellKey({ face: 'A', col: 6, row: 3 })).not.toBe(cellKey({ face: 'B', col: 6, row: 3 }));
  });

  it('非法键返回 null，而不是抛异常', () => {
    for (const bad of ['', 'A', 'C:0,0', 'A:0', 'A:x,0', 'A:0,0,0']) {
      expect(parseCell(bad)).toBeNull();
    }
  });

  it('core 跑在纯 Node 里：没有 DOM（架构红线，切到 jsdom 这条会红）', () => {
    expect(typeof globalThis.document).toBe('undefined');
  });
});
