import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, createHistory, push, redo, undo } from '../src/app/history';

/**
 * 撤销/重做栈。它自己**不认识关卡**，所以这一份测试用最短的夹具（字符串）——
 * 真正要钉的是**栈的语义**，而语义与元素类型无关。关卡那一侧的性质（"落笔不改原对象"）
 * 由 `test/paint.test.ts` 钉住，两者合起来才是"撤销是可靠的"。
 */
describe('history —— 不可变快照栈', () => {
  it('新栈：一个当前值、两个方向都空', () => {
    const h = createHistory('a');
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);
    expect(canRedo(h)).toBe(false);
  });

  it('压栈 → 回退 → 前进，走一个来回回到原处', () => {
    let h = createHistory('a');
    h = push(h, 'b');
    h = push(h, 'c');
    expect(h.present).toBe('c');
    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);
    h = redo(h);
    h = redo(h);
    expect(h.present).toBe('c');
    expect(canRedo(h)).toBe(false);
  });

  it('**同一个引用不算一步** —— 点空白处不该多出一次"没反应"的撤销', () => {
    const a = { tiles: ['..'] };
    const h = push(createHistory(a), a);
    expect(h.past).toEqual([]);
    expect(canUndo(h)).toBe(false);
  });

  it('退到底 / 进到头都**原样返回**（不抛、也不造出空数组边界）', () => {
    const empty = createHistory('a');
    expect(undo(empty)).toBe(empty);
    expect(redo(empty)).toBe(empty);
  });

  it('撤销几步后又画一笔 → **未来被清空**（重做不能跳回已经不存在的分支）', () => {
    let h = createHistory('a');
    h = push(h, 'b');
    h = push(h, 'c');
    h = undo(h);
    expect(canRedo(h)).toBe(true);
    h = push(h, 'd');
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe('d');
    expect(undo(h).present).toBe('b');
  });

  it('每一步都**不改**旧栈对象（同 `paint` 的不变式：旧值随时还能拿去比对）', () => {
    const h0 = createHistory('a');
    const h1 = push(h0, 'b');
    expect(h0.present).toBe('a');
    expect(h0.past).toEqual([]);
    const h2 = undo(h1);
    expect(h1.present).toBe('b');
    expect(h2.present).toBe('a');
  });

  it('长链：压 50 步再退 50 步，回到起点；再进 50 步回到终点', () => {
    let h = createHistory(0);
    for (let i = 1; i <= 50; i++) h = push(h, i);
    for (let i = 0; i < 50; i++) h = undo(h);
    expect(h.present).toBe(0);
    for (let i = 0; i < 50; i++) h = redo(h);
    expect(h.present).toBe(50);
  });
});
