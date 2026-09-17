import type { Cell } from '../core/types';
import type { MoveMode } from '../core/rules/movement';
import { toFold, toWorld } from '../core/world/fold';
import { supportOf } from '../core/world/graph';
import type { Level } from '../core/world/tiles';
import type { Vec3 } from './tween';

/**
 * 渲染层的**几何常量与锚点换算** —— 刻意做成 three-free 的纯模块（T6）。
 *
 * ## 为什么单独一个文件
 *
 * 三个消费者需要同一套数字：`scene.ts` 把砖块摆出来、`meshSync.ts` 把角色摆在墙上、
 * 测试要断言"摆的位置到底对不对"。三处各写一遍的世界坐标换算必然会漂 ——
 * 而"两套数据不一致"正是本仓库历次 bug 的共同病因（架构文档 §5.1）。
 *
 * 所以：**几何常量只在这里定义，格子→世界的换算只有 `cellAnchor` 一个出口**。
 * 本文件不导入 three，于是测试可以直接 import 它做纯数学断言，不用起 WebGL。
 *
 * ## 角色站在哪（三个数，各有各的道理）
 *
 * 法线方向：角色与砖心同一条线（`BRICK_N`）—— 人站在砖的**正上方**，不是浮在砖的前方。
 * 曾经想过用 `BRICK_DEPTH + PLAYER_SIZE/2` 把人推到砖的外表面，那是错的：那样角色会悬在
 * 砖前，读起来不像站稳了。
 *
 * 竖直方向**没有单一答案**，因为三种停驻方式踩／抓的东西不一样：
 *
 * | 停驻     | 支撑面在哪                  | 身体中心 y             |
 * |----------|-----------------------------|------------------------|
 * | 砖面     | 下方那格砖的**顶面**         | 顶面 + PLAYER_SIZE/2   |
 * | 梯       | 身体与梯档并排（就占本格）   | 格心                   |
 * | 吊在杆下 | 手搭在杆上（杆在格心）       | 格心 − PLAYER_SIZE/2   |
 *
 * 砖的顶面**不是** `row`：砖比一格小一圈（`CUBE = 0.86`），砖心在格心，于是顶面落在
 * `row − (0.5 − CUBE/2)`。角色要踩在**看得见的那张面**上，而不是踩在格子的抽象边界上 ——
 * 差那 0.07 无伤大雅，但"身体中心 = 格心"会让人悬空约 0.32，一眼就看出来。
 *
 * 这里的 `supportOf` 是**复用** core 的判定，不是在渲染层重写一遍：
 * "人能停在哪"与"人看起来停在哪"必须是同一个答案。
 *
 * > T-SP1（人工手感 gate）要看的正是这几个数。它们是**外观**参数，改这里不影响任何规则。
 */

/**
 * 每块砖都是同一个立方体，**紧贴**相邻砖块 —— 墙砖 / 岛砖 / 小道砖同规格。
 *
 * `CUBE = 1.0` 不是随手取的：格子间距就是 1.0，所以边长 1.0 的立方体会**严格铺满**，
 * 相邻砖块之间没有任何缝。用户明确指出过这一点（"每个单位砖块和其他相邻的砖块有缝隙…
 * 原版 loderunner 的砖块有缝隙吗？没有吧？"）—— 原版砖块是紧挨着的，缝是错的。
 */
export const CUBE = 1.0;

/**
 * 砖块**本体**相对格子的缩放 —— 留出来的那一圈由描边层填上（见 `scene.ts` 的 `createBrickLayer`）。
 *
 * 为什么需要它（用户两次要求合起来才成立）：① "砖块之间不许有缝"→ `CUBE = 1.0` 严格铺满；
 * ② 但那样同色的相邻砖会**糊成一整块板**，数不出单块 → 用户要求"每个单元砖块加灰黑外边框"。
 * 两者一起才是"无缝 + 可数"：砖体缩到 `BRICK_FACE`，背后垫一层**全尺寸的色块**，
 * 露出来的那一圈就是轮廓线 —— 而不是真的留缝（那会让背景透出来）。
 *
 * **第一次取 0.92 是错的**：两块之间于是有 0.08 格的暗带（约 2.8px），用户的原话是
 * "看上去像是砖块间的缝隙" —— 太粗太黑的均匀暗带会被读成"缝/阴影"，而不是"画上去的线"。
 * 0.965 让两块之间只剩 0.035 格（约 1.2px）：一条细线，邻砖仍然分得开。
 */
export const BRICK_FACE = 0.965;

/** 砖块从墙面"浮起"的起点。留一点是为了砖与墙背板之间有一道可读的分界。 */
const INK = 0.06;

/** 砖心沿墙面法线的偏移：浮起起点 + 半个立方体。 */
export const BRICK_N = INK + CUBE / 2;

/** 砖块从墙面伸出的总厚度（法线方向的进深）。 */
export const BRICK_DEPTH = INK + CUBE;

/** 角色立方体的边长。 */
export const PLAYER_SIZE = 0.5;

/** 吊在杆上时整个人下移这么多 —— 手正好搭在杆上，而不是骑在杆上。 */
export const HANG_DROP = PLAYER_SIZE / 2;

/**
 * 水面高度（世界 y）。落水规则在 T9；这里只是"看得见的水"。
 *
 * 为什么是 0.35：岛台与小道的**顶面必须落在 `DECK_TOP_Y`（= 1.0）** —— 那是墙面上"行 1"的行走面
 * （行 0 那层砖的顶面）。它们只有一层砖厚，所以底面在 y = 0。水面压到 0.35，
 * 岛台才露出 0.65 的高差；水再高一点，岛台就会读成"沉在水里的一块板"。
 */
export const WATER_Y = 0.35;

/**
 * 甲板（岛台 / 小道）**顶面**的世界 y。这是"甲板只有一层砖厚"这句话的全部算术：
 *
 * 墙面格心的高度是 `row + 0.5`（`core/world/fold.ts` 的 `toWorld`），所以行 0 那层砖的
 * **顶面** = `0.5 + CUBE/2` —— 那正是墙面"行 1"的行走面。甲板铺在 y = 0 上、只有一层砖厚，
 * 于是顶面必须落在同一个高度（`scene.ts` 摆岛砖时读的就是它：砖心 = `DECK_TOP_Y - CUBE/2`）。
 *
 * 为什么值得单独一个常量：**它是"小道接得上最底层砖块"的全部依据**。以前这个数只在
 * `scene.ts` 里叫 `layerY`、`metrics.ts` 里没有名字 —— 于是 `cellAnchor` 的甲板分支
 * 干脆漏了（甲板格被送进墙面换算 `toFold`/`toWorld`），角色一进岛台就被画到房间外。
 * 见 `cellAnchor` 的注释。**两处各写一遍，就是那个 bug 的成因。**
 */
export const DECK_TOP_Y = 0.5 + CUBE / 2;

/**
 * 岛台边长的一半（4×4 岛台 → 2.0）。**这是用户指定的数，别动。**
 *
 * ## 岛心是怎么定的（这段注释原先写错了，订正于 2026-09）
 *
 * 原文写的是"岛心由 `scene.ts` 按墙面包围出来的区域算，不是写死的"。**这句不成立**：
 * `islandAndJetties` 用的是手挑的 `JETTY_U = 5`，岛心 = `-halfExtent(fold) + JETTY_U`。
 * 它只是**恰好落在水面中心附近**，不是从水面推出来的 —— 两者差 0.22。
 *
 * `fold = 9` 时的真实数字（`halfExtent(9) = 8.5`）：
 *
 * | 量 | 值 |
 * |---|---|
 * | 岛心 | `-8.5 + 5 = -3.5` |
 * | 岛台跨度 | `-5.5 .. -1.5`（宽 4） |
 * | 水面跨度 | `-7.94 .. 0.5`（宽 8.44） |
 * | 水面中心 | `-3.72` |
 *
 * 所以要判断"岛相对水面是不是太大"，正确的比法是 **4 / 8.44 ≈ 47%** —— 岛占跨度的将近
 * 一半，而水面本身已经是几何允许的最大范围（从折痕砖线铺到墙口外 0.5，见 `scene.ts`）。
 * 也就是说这一项**没有"把水改大"这个选项**，只有缩岛或放大房间（改 `fold`）。
 */
export const ISLAND_HALF = 2.0;

/** 墙板比最高一行再高出这么多，免得顶行砖贴着板边。 */
export const HEADROOM = 1.4;

/** 一个格子在墙上的锚点，外加"该面的列是否沿 z 排"（A 面沿 z，B 面沿 x）。 */
export interface Anchor {
  readonly p: Vec3;
  /** 该面的列沿 z 排列（A 面），而不是沿 x（B 面）。梯子的横档、杆的粗细都要按它转 90°。 */
  readonly alongZ: boolean;
}

/**
 * 格子的锚点 = 格心 + 沿该面法线推出 `BRICK_N`。
 * 这是**砖心**的位置，也是**站在该格的角色的身体中心**（见文件头）。
 */
export function cellAnchor(level: Level, cell: Cell): Anchor {
  // 甲板格单独一条路。**必须在 `toFold`/`toWorld` 之前** —— 那两个函数只懂
  // "沿墙 u × 高度 y"（`fold.ts` 的文件头），把甲板格送进去会得到房间外的坐标：
  // `toFold({face:'I', col:-7, row:-4})` 把 x 当成全局列算成 `u = -7 - 9 = -16`，
  // 于是锚点成了 `(-24.5, -3.5, -8.5)`。用户看到的就是"角色从某处飞到另一处"
  // 与"走不进岛台"（模拟层一直是好的：`step` 的可达性 BFS 显示甲板 20/20 格可达）。
  if (cell.face === 'I') {
    // 两个下标**就是**世界 x/z；高度取甲板顶面 + 半砖，与墙面格的"格心"同口径
    // （`playerAnchor` 的"站砖面"会给回 `顶面 + PLAYER_SIZE/2`，即脚踩顶面、不悬空）。
    return { p: [cell.col, DECK_TOP_Y + CUBE / 2, cell.row], alongZ: false };
  }

  const w = toWorld(toFold(cell, level.fold), level.fold);
  const alongZ = cell.face === 'A';
  const p: Vec3 = alongZ ? [w.x + BRICK_N, w.y, w.z] : [w.x, w.y, w.z + BRICK_N];
  return { p, alongZ };
}

/** 站在砖面上时，身体中心比格心低这么多（推导见文件头的表）。 */
const STAND_ON_BRICK_DROP = 1 - CUBE / 2 - PLAYER_SIZE / 2;

/** 角色在世界里的位置。三种停驻方式不一样 —— 见文件头的表。 */
export function playerAnchor(level: Level, cell: Cell, mode: MoveMode): Vec3 {
  const { p } = cellAnchor(level, cell);
  const [x, y, z] = p;

  // 吊在杆下：手搭在杆上，而杆心就是格心。
  if (mode === 'hang') return [x, y - HANG_DROP, z];

  const support = supportOf(level, cell);
  // 站在砖面上：脚踩在下方那格砖的**顶面**。
  if (support === 'brick') return [x, y - STAND_ON_BRICK_DROP, z];
  // 梯（以及万一说不清支撑方式时的兜底）：身体就占本格。
  return p;
}
