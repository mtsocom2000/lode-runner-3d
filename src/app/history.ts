/**
 * **撤销 / 重做**（编辑器阶段 4）—— 一个**通用**的不可变快照栈。
 *
 * ## 为什么这么小、而且不认识"关卡"
 *
 * `paint.ts` 的文件头早就写了落笔为什么必须是纯函数，第二条就是"撤销/重做免费"：
 * 一栈**不可变快照**就够了。这里刻意不 import 关卡、不 import three —— 它只管
 * "压栈 / 回退 / 前进"三件事，于是它自己的测试不需要任何夹具，而调用方（`main.ts`）
 * 也不必为了撤销去理解关卡数据。
 *
 * ## 一条关键约定：**引用相等 = 没有变化**
 *
 * `paint` 对"画不到的地方 / 认不出的笔"**原样返回同一个对象**（`paint.ts` 的纪律）。
 * `push` 拿这条当判据：同一个引用就**不压栈** —— 否则每次点空白处都会多一步空撤销，
 * 用户按 `Ctrl+Z` 会觉得"按了半天没反应"。这条不是优化，是**语义**：
 * 栈里每一步都必须是真的改动。
 *
 * ## 为什么 `past` 不设上限
 *
 * 快照之间**共享绝大部分结构**（`tiles` 只换一行字符串、`deck` 只换一个数组），
 * 一次落笔多出来的内存就是"一行字符串"。加上限反而要写淘汰策略和它的测试。
 */
export interface History<T> {
  /** 从旧到新；栈顶在末尾。**不含** `present`。 */
  readonly past: readonly T[];
  readonly present: T;
  /** 从近到远；下一次重做取末尾。 */
  readonly future: readonly T[];
}

export function createHistory<T>(present: T): History<T> {
  return { past: [], present, future: [] };
}

export const canUndo = <T>(h: History<T>): boolean => h.past.length > 0;
export const canRedo = <T>(h: History<T>): boolean => h.future.length > 0;

/**
 * 记一步。**`next` 与 `present` 引用相同 → 原样返回**（不算一次改动）。
 *
 * 压栈后**清空 `future`**：这是所有编辑器的老规矩 —— 撤销几步之后又画了一笔，
 * 原来那条"未来"就再也回不去了（留着它会让重做跳到一条已经不存在的分支上）。
 */
export function push<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { past: [...h.past, h.present], present: next, future: [] };
}

/** 退一步。没有可退的 → 原样返回（UI 靠 `canUndo` 禁用按钮，这里只是兜底）。 */
export function undo<T>(h: History<T>): History<T> {
  const prev = h.past[h.past.length - 1];
  if (prev === undefined) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

/** 进一步。 */
export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (next === undefined) return h;
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
}
