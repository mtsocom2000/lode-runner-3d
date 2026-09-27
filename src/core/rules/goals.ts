import type { Cell } from '../types';
import { isConsistentCell } from '../world/fold';
import type { DeckCell } from '../world/deck';
import type { Level, TileKind } from '../world/tiles';

/**
 * 通关目标（T13）：宝物计数 → 出口闸门开启 → 触达出口过关。
 *
 * ## 规则来源是归档原型，不是自创
 *
 * `legacy/README-v0.5-prototype.md:39` —— 「**目标**：收集全部金子 → 出口 E 生成通天梯 → 爬顶过关」；
 * `:91` —— 「集齐金子 → `openExit()`：出口列打通（跳过杆行，逐格铺梯）→ 绿色门」。
 * `legacy/test.js:134-146` 是同一件事的无头脚本（`ladderUp after all gold` / `climb into exit wins`）。
 *
 * ## 与原型的一处几何差异（用户已裁定）
 *
 * 原型的出口在地面，所以"出口列往上铺梯"有地方可铺。**本关的出口在顶行**（`r5`），上方没有格子；
 * 而且出口要站得住就**必须**保留下方那块实心砖（`supportOf` 的第三条判据），
 * 所以出口自己那一列**铺不了梯**。
 *
 * 于是"通天梯"落在**出口两侧的闸门格**上：它们从硬砖变成梯子，`r5` 重新有了横向边
 * `c2 → c3(梯) → c4(出口)`。用户在两条实现路径里选的就是这条**物理门**
 * （而不是"出口照旧可达、集齐前站上去不算过关"的规则门）。
 *
 * 闸门格由关卡**显式声明**（`LevelDef.gates`），理由见 `world/tiles.ts`。
 */

/**
 * 打开出口闸门：把每个闸门格换成梯子。返回**新**网格，不改入参。
 *
 * ## 为什么校验层也用这个函数
 *
 * `validateLevel` 的 `exitGated` 规则必须验"闸门开了之后到底通不通"，而**唯一**可靠的验法
 * 就是拿这个真函数跑一遍。在校验层另写一份近似实现的话，两份迟早漂开 ——
 * 那时校验会变成摆设：它说"能过关"，而 sim 跑的是"过不了"。
 *
 * ## 越界/无效的闸门声明为什么静默跳过
 *
 * 这里不抛也不报。越界声明 → 那格没被打开 → 出口仍未开通 → `exitGated` 会报
 * "开了还到不了"；声明在本来就是空格的格上 → 出口一开始就通 → `exitGated` 会报
 * "一开始就走得到"。两种手误都被那条规则**传递地**抓住了，不必在这里重复一套。
 */
export function openGates(
  grid: readonly TileKind[],
  gates: readonly Cell[],
  cols: number,
): readonly TileKind[] {
  const next = grid.slice();
  for (const gate of gates) {
    // 闸门是**墙上**的格子。甲板格（面 'I'）的两个下标是 (x, z)，和墙的 (col, row) 不是
    // 一个坐标系，混进来只会静默改错格子 —— 直接跳过（见 deck.ts 的文件头）。
    if (gate.face === 'I') continue;
    const index = gate.row * cols + gate.col;
    if (index < 0 || index >= next.length) continue;
    next[index] = 'ladder';
  }
  return next;
}

/**
 * 这一格是不是正踩着一块**还没取走**的宝物。是就返回那一格，否则 `undefined`。
 *
 * ## 为什么第一句是面守卫，而不是直接比坐标
 *
 * 宝物的坐标是甲板的 `(x, z)`，而 `Cell` 的 `col / row` **在墙上时是 `(col, row)`** ——
 * 两套坐标系混着比会**静默比错**：某面墙上恰好 `col = -3, row = -3` 的格子是不存在的
 * （列号非负），但 `col = 3, row = 3` 存在，而它与甲板格 `(3, 3)` 的坐标**数值相同**。
 * 所以不守面，玩家站在墙上某一格就会被判成"踩到了宝物"。
 *
 * 这条守卫不是防御性编程，是**两套坐标系共存**这个事实的必然要求（见 `deck.ts` 文件头）。
 *
 * `level`（2026-09-19）：宝物可以在**塔顶**（甲板有层之后）。层必须一起比 —— 否则站在塔底
 * 那一格就会把塔顶那颗取走（两者的 `(x, z)` 相同）。
 */
export function treasureAt(treasures: readonly DeckCell[], cell: Cell): DeckCell | undefined {
  if (cell.face !== 'I') return undefined;
  const level = cell.level ?? 0;
  return treasures.find((t) => t.x === cell.col && t.z === cell.row && (t.level ?? 0) === level);
}

/**
 * 取走一块宝物：返回**新的**列表。
 *
 * 复制而不是原地删：`SimState` 必须是纯数据，每一帧都不能共享可变数组
 * （与 `applyDig` / `applyBackfill` 同一条理由 —— 否则回放比对会串味）。
 */
export function withoutTreasure(treasures: readonly DeckCell[], taken: DeckCell): readonly DeckCell[] {
  const level = taken.level ?? 0;
  return treasures.filter(
    (t) => t.x !== taken.x || t.z !== taken.z || (t.level ?? 0) !== level,
  );
}

/**
 * **墙上**那一格是不是还没取走的宝物（字形 `G`）。是就返回那一格，否则 `null`。
 *
 * ## 为什么宝物有两种落脚处（用户 2026-09-21 的追问）
 *
 * 用户的原话：*"宝物无法放置在砖块上，似乎只能放置在场景中央的水面附近。"* —— 而**原版
 * Lode Runner 的金子正是撒在砖面上**（`legacy/README-v0.5-prototype.md` 的"收集全部金子"）。
 * 我第一版只把"地台上的宝物"接进了通关逻辑，墙上的 `G` 只画出来、**没接** —— 于是
 * "宝物"这支笔在墙上点了毫无反应，用户只能把它放在水面上。
 *
 * 现在两类**等价**：都要取、都算进"集齐才开闸门"。
 *
 * ## 判据为什么守面（与 `treasureAt` 同一条理由）
 *
 * 甲板宝物的坐标是 `(x, z)`，墙格是 `(col, row)` —— 混着比会静默比错（`col = 3, row = 3`
 * 与甲板 `(3, 3)` 数值相同）。所以墙上的那一支**只认墙格**。
 */
export function wallTreasureAt(level: Level, cell: Cell): Cell | null {
  if (cell.face === 'I') return null;
  if (!isConsistentCell(cell, level.fold)) return null;
  return level.at(cell.col, cell.row) === 'treasure' ? { face: cell.face, col: cell.col, row: cell.row } : null;
}

/**
 * 取走墙上那片宝物：那一格**变空**（返回新网格）。
 *
 * 与 `applyDig`（`dig → pit`）并列的第二种"改一格网格"的动作 —— 同样返回**新数组**，
 * 因为 `grid` 是 `SimState` 的一部分（回放要逐字节比对）。
 */
export function takeWallTreasure(
  grid: readonly TileKind[],
  cell: Cell,
  cols: number,
): readonly TileKind[] {
  const next = grid.slice();
  next[cell.row * cols + cell.col] = 'empty';
  return next;
}
