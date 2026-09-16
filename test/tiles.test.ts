import { TILE_CHARS, TILE_GLYPHS, parseLevel, type LevelDef } from '../src/core/world/tiles';

/** 用 v10 mock 里那份已验证过的关卡当夹具 —— 外观基准也不该是脏数据。 */
const L1: LevelDef = {
  id: 'L1',
  name: '折角',
  fold: 7,
  tiles: [
    'XX.X.XX.XXX.XX', // r0 地板：col4 是竖井口，直通水面
    '..............', // r1 走廊
    'XXXX.XX..XX.XX', // r2 主平台
    '.....H....XX..', // r3 梯 col5
    'XX.XX..XX.XX.X',
    '.XX.HXXX..H.XX', // r5 梯 col4 / col10
    'XXX....XX..X.X',
    '..XX.X--X.XX..', // r7 横杆 col6 / col7 穿过折痕
    'XX.XX.X.XX.XX.',
    '..X.G.X.EE.X.G', // r9 宝物 G / 出口 E
  ],
};

describe('tiles：字形 ↔ 语义', () => {
  it('恰好 7 种字形，与架构文档 §四 一致', () => {
    expect([...TILE_GLYPHS]).toEqual(['X', '=', '.', 'H', '-', 'G', 'E']);
    expect(Object.keys(TILE_CHARS)).toHaveLength(7);
  });

  it('逐个字形映射正确', () => {
    expect(TILE_CHARS['X']).toBe('dig');
    expect(TILE_CHARS['=']).toBe('hard');
    expect(TILE_CHARS['.']).toBe('empty');
    expect(TILE_CHARS['H']).toBe('ladder');
    expect(TILE_CHARS['-']).toBe('bar');
    expect(TILE_CHARS['G']).toBe('treasure');
    expect(TILE_CHARS['E']).toBe('exit');
  });

  it('未定义字形返回 undefined —— 不能被静默当成"空"', () => {
    expect(TILE_CHARS['o']).toBeUndefined();
    expect(TILE_CHARS[' ']).toBeUndefined();
    expect(TILE_CHARS['#']).toBeUndefined();
  });
});

describe('tiles：关卡装载', () => {
  it('合法关卡装载成功，尺寸取自数据本身', () => {
    const r = parseLevel(L1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.level.id).toBe('L1');
    expect(r.level.cols).toBe(14);
    expect(r.level.rows).toBe(10);
    expect(r.level.fold).toBe(7);
  });

  it('按 (col,row) 取值正确，行索引 0 = 最底行', () => {
    const r = parseLevel(L1);
    if (!r.ok) throw new Error('夹具应当是合法关卡');
    expect(r.level.at(0, 0)).toBe('dig'); // r0 开头 "XX"
    expect(r.level.at(1, 0)).toBe('dig');
    expect(r.level.at(4, 0)).toBe('empty'); // r0 的竖井口
    expect(r.level.at(0, 1)).toBe('empty'); // r1 整行空
    expect(r.level.at(5, 3)).toBe('ladder'); // r3 的梯
    expect(r.level.at(6, 7)).toBe('bar'); // r7 横杆（折痕左）
    expect(r.level.at(7, 7)).toBe('bar'); // r7 横杆（折痕右）
    expect(r.level.at(4, 9)).toBe('treasure'); // r9 宝物
    expect(r.level.at(13, 9)).toBe('treasure');
    expect(r.level.at(8, 9)).toBe('exit');
    expect(r.level.at(9, 9)).toBe('exit');
  });

  it('越界返回 undefined：不抛异常、也不返回一个像"空砖"的默认值', () => {
    const r = parseLevel(L1);
    if (!r.ok) throw new Error('夹具应当是合法关卡');
    expect(r.level.at(-1, 0)).toBeUndefined();
    expect(r.level.at(14, 0)).toBeUndefined();
    expect(r.level.at(0, -1)).toBeUndefined();
    expect(r.level.at(0, 10)).toBeUndefined();
    expect(r.level.at(99, 99)).toBeUndefined();
  });

  it('非法字形被指名道姓报出来（行、列、字符）', () => {
    const r = parseLevel({ id: 'bad', name: 'bad', fold: 1, tiles: ['Xo', 'XX'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toEqual({ kind: 'badChar', row: 0, col: 1, ch: 'o' });
  });

  it('长短不齐被报出来（带期望/实际长度）', () => {
    const r = parseLevel({ id: 'bad', name: 'bad', fold: 1, tiles: ['XX', 'XXX'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ kind: 'ragged', row: 1, expected: 2, got: 3 }]);
  });

  it('总列数必须 = 2 × fold', () => {
    const r = parseLevel({ id: 'bad', name: 'bad', fold: 3, tiles: ['XXXX', 'XXXX'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ kind: 'foldMismatch', fold: 3, cols: 4 }]);
  });

  it('空关卡被拒', () => {
    const r = parseLevel({ id: 'bad', name: 'bad', fold: 1, tiles: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toEqual([{ kind: 'noRows' }]);
  });

  it('多个问题一次列全（validator 需要一次看全，而不是遇到第一个就停）', () => {
    const r = parseLevel({ id: 'bad', name: 'bad', fold: 1, tiles: ['Xo', 'XXX'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(2);
    expect(r.errors.map((e) => e.kind).sort()).toEqual(['badChar', 'ragged']);
  });

  it('全部字形都合法时不会误报', () => {
    const r = parseLevel({ id: 'ok', name: 'ok', fold: 2, tiles: ['X=H-', '.GEX'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.level.cols).toBe(4);
    expect(r.level.rows).toBe(2);
    expect(r.level.at(0, 0)).toBe('dig');
    expect(r.level.at(1, 0)).toBe('hard');
    expect(r.level.at(2, 0)).toBe('ladder');
    expect(r.level.at(3, 0)).toBe('bar');
    expect(r.level.at(1, 1)).toBe('treasure');
    expect(r.level.at(2, 1)).toBe('exit');
  });
});
