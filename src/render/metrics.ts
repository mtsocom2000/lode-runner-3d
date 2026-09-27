import type { Cell } from '../core/types';
import { stateAt, step, type Dir, type MoveMode } from '../core/rules/movement';
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

/**
 * 坑（`'pit'`，挖出来的口袋）画成什么：**往墙里缩进去的一口深色凹槽**。
 *
 * 为什么必须专门画它：挖之前这一格是砖，挖之后它变成 `'pit'` —— 如果只是"砖块零缩放消失"，
 * 露出来的是背板，而背板（`shell 0xc7c2b6`）与砖（`brick 0xe4dccb`）**是同一个色系**，
 * 于是坑几乎看不见。用户的原话是"没看到你说的坑的特效" —— 他要的首先是"**看得见有个坑**"。
 *
 * 深度取 0.66、后缩 0.12（`CUBE = 1.0`）：前脸落在砖面之后约 0.3 格，于是相邻砖的侧面
 * 会露出来一点 —— 那正是"深度"的读法；后脸落在背板之前 0.05 格，免得与背板**同面 z-fighting**。
 *
 * 这两个数是**外观**参数（改它们不动任何规则）。真正的"土落下来"动画属于 T20 的表现层。
 */
export const PIT_DEPTH = 0.66;
export const PIT_RECESS = 0.12;

/**
 * 砖块从墙面"浮起"多少 —— **现在是 0：砖背就贴在墙面上**。
 *
 * ## 这个数曾经是 0.5，而且曾经是"小道能不能与墙对齐"的关键（历史）
 *
 * 当时的墙砖内表面 = `-half + INK + CUBE`，要让两块砖严丝合缝就必须
 * `-half + INK + 1 ∈ ℤ` ⟺ `INK ∈ 半整数`。取 0.5 之后墙砖内表面落在 `-12.0`。
 *
 * ## 现在为什么不需要它了（2026-09-19 的墙角重整）
 *
 * `fold.ts` 的 `halfExtent` 从 `fold - 0.5` 改成了 `fold - 1`：折痕线落在**整数**格上，
 * 格子从折痕线往外排（`toWorld` 里的 `+0.5`）。于是格心 = 折痕线 + 半格 + 整数格 → **半整数**，
 * 砖面自然落在**整数**上 —— 对齐由**折痕线在整数格**这件事本身保证，不再需要 `INK` 凑。
 *
 * 而 `INK` 参与对齐的代价是它同时把背板推到了折痕线前方 0.5 格 —— 折痕两侧最内列的格子
 * 因此有半个身子落在对面那面墙的背板后面（用户报的"走到两个侧面交界处就进墙里了"）。
 * 现在 `INK = 0`：背板就在折痕线上，两片墙在那儿干净地会合；砖背贴着背板，观感不变
 * （砖的**世界坐标一个都没动** —— 折痕线挪了 0.5，砖的偏移同时从 1.0 减到 0.5）。
 *
 * > 于是 `BRICK_N = 0.5`：角色/砖心在墙面之前半格 —— 正是"一格厚的墙"的中心。
 * >
 * > **它也让折痕一步变成"原地转 90°"**：A 面最内列的格心是 `(x = 墙 + BRICK_N, z = 折痕 + CUBE/2)`，
 * > B 面最内列是 `(x = 折痕 + CUBE/2, z = 墙 + BRICK_N)`。两者要落在同一点，只需要
 * > `BRICK_N = CUBE/2` —— 也就是 `INK = 0`。这正是"折"该有的样子（折痕两侧贴着的两格
 * > 是同一个位置），`test/metrics.test.ts` 有一条断言钉着它。
 */
export const INK = 0;

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
 * **水面高光条**的位置与尺寸（T21 修）。
 *
 * 本意是"沿海面铺 5 条淡淡的横纹"（把一整片平水面打散），但第一版把它们**沿着自己的长度方向
 * 排** —— 于是首尾相叠、合成**一根长白线**，在空白关卡上尤其像画错了（用户："在场景中下部有根白线"）。
 *
 * 判据落在这里而不是留在 `scene.ts` 里，是为了让它**可测**：那一版能出问题，正是因为
 * "5 条"与"叠成一条"都能画得出来，而没有任何东西盯着它。现在
 * `test/metrics.test.ts` 断言：条数对、**彼此不重叠**、而且沿**垂直于长度的那条轴**排开。
 *
 * `centre` / `half` 是水面的中心与半宽（跟着关卡尺寸走，见 `scene.ts` 的 `waterFar` / `waterNear`）。
 */
export function glintStrips(centre: number, half: number): readonly { readonly p: Vec3; readonly s: Vec3 }[] {
  const out: { p: Vec3; s: Vec3 }[] = [];
  for (let i = 0; i < 5; i++) {
    const t = (i - 2) / 2; // -1 .. +1
    out.push({
      // 沿 **z** 排开，而每条自身沿着 **x** —— 长度方向与排列方向**垂直**，这才是"5 条"。
      p: [centre, WATER_Y + 0.02, centre + t * half * 0.6],
      s: [half * 0.5, 0.02, 0.16],
    });
  }
  return out;
}


/**
 * 甲板**第二层及以上**的板厚（T17）。第一层是整块立方（它就是岛面本身），上面几层是**薄板**。
 *
 * 为什么上面几层必须薄：一层只有 `CUBE` 高，而角色有 `PLAYER_SIZE` 高 —— 每层都画成整块立方的话，
 * "站在第 L 层"的身体正好被第 L+1 层那块立方**包住**（人会消失在里面），塔也就爬不上去。
 * 薄板贴在**这一层的最上面**（顶面 = `DECK_TOP_Y + level`），它下面那一格就空得下一个人 ——
 * 与 `cellAnchor` 的口径（脚踩板顶）正好对上。
 */


/**
 * 墙板比最高一行再高出这么多，免得顶行砖贴着板边。
 */
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
/**
 * 甲板（岛台 / 小道）相对**格心**的渲染偏移：半格（`+0.5`）。
 *
 * ## 为什么必须是半格
 *
 * 两个独立的理由，都由**墙**那边的晶格决定：
 *
 * 1. **对齐墙砖列**：墙面砖心在 `-half + u + 0.5`（半整数），甲板的**行/列**必须是半整数
 *    才能正对它们（否则小道顶在两块墙砖的缝上 —— 用户的原话）。
 * 2. **与墙贴合**：墙砖内表面 = `-half + CUBE` = `-12.0`（`INK = 0`、`CUBE = 1` 时是个**整数**）；
 *    甲板砖的**面**要落在整数上，砖心就得是**半整数**。第 1 条已保证了这一点。
 *
 * 取 `+0.5`（而不是 `-0.5`）是为了让**岛台偏向开口侧**：折痕那条墙角在 `-13.0`、
 * 墙面外沿在 `-half + fold` = `1.0`，中点是 `-6.0`；甲板砖心只能落在半整数上，
 * 取 `+0.5` 让岛台落在 `-6.5`（离中点 0.5）。**这半格是晶格决定的，不是笔误** ——
 * 想让它绝对居中就得挪关卡里 `deck` 的格子（整数格挪一格，还是差 0.5）。
 *
 * > 改这个值必须同时改 `scene.ts` 里甲板砖的摆放（它们**共用**这个常量），以及两处接头的
 * > 墙面列（L1 是 `A:7` / `B:20` —— 那是"小道正对的那块墙砖"）。
 */
export const DECK_SHIFT = 0.5;

export function cellAnchor(level: Level, cell: Cell): Anchor {
  // 甲板格单独一条路。**必须在 `toFold`/`toWorld` 之前** —— 那两个函数只懂
  // "沿墙 u × 高度 y"（`fold.ts` 的文件头），把甲板格送进去会得到房间外的坐标：
  // `toFold({face:'I', col:-7, row:-4})` 把 x 当成全局列算成 `u = -7 - 9 = -16`，
  // 于是锚点成了 `(-24.5, -3.5, -8.5)`。用户看到的就是"角色从某处飞到另一处"
  // 与"走不进岛台"（模拟层一直是好的：`step` 的可达性 BFS 显示甲板 20/20 格可达）。
  if (cell.face === 'I') {
    // 两个下标**就是**世界 x/z（再加半格对齐偏移，见 `DECK_SHIFT`）；高度取甲板顶面 + 半砖，
    // 与墙面格的"格心"同口径（`playerAnchor` 的"站砖面"会给回 顶面 + PLAYER_SIZE/2，脚踩顶面）。
    //
    // `level`（2026-09-19）：每高一整格。`level = 0` 就是水面上的那一层 —— 于是既有关卡的
    // 锚点一个字节都没变。
    const level = cell.level ?? 0;
    return {
      p: [
        cell.col + DECK_SHIFT,
        DECK_TOP_Y + CUBE / 2 + level * CUBE,
        cell.row + DECK_SHIFT,
      ],
      alongZ: false,
    };
  }

  const w = toWorld(toFold(cell, level.fold), level.fold);
  const alongZ = cell.face === 'A';
  const p: Vec3 = alongZ ? [w.x + BRICK_N, w.y, w.z] : [w.x, w.y, w.z + BRICK_N];
  return { p, alongZ };
}

/** 站在砖面上时，身体中心比格心低这么多（推导见文件头的表）。 */
const STAND_ON_BRICK_DROP = 1 - CUBE / 2 - PLAYER_SIZE / 2;

/**
 * 角色在世界里的位置。三种停驻方式不一样 —— 见文件头的表。
 *
 * `bridges` = **有人的坑**（`sim.bridgesOf`）：坑里有人时坑口踩得住，角色就站在**那个人的头上**
 * —— 高度按"站在砖面上"算（脚在坑口那一格的下沿），否则会画成半个身子陷在坑里。
 * 与移动层问的是**同一个**集合，"人能停在哪"与"人看起来停在哪"因此不可能不一致。
 */
export function playerAnchor(
  level: Level,
  cell: Cell,
  mode: MoveMode,
  bridges?: ReadonlySet<string>,
): Vec3 {
  const { p } = cellAnchor(level, cell);
  const [x, y, z] = p;

  // 吊在杆下：手搭在杆上，而杆心就是格心。
  if (mode === 'hang') return [x, y - HANG_DROP, z];

  const support = supportOf(level, cell, bridges);
  // 站在砖面上：脚踩在下方那格砖的**顶面**。
  if (support === 'brick') return [x, y - STAND_ON_BRICK_DROP, z];
  // 梯（以及万一说不清支撑方式时的兜底）：身体就占本格。
  return p;
}

/**
 * 位移在某个轴上小于它就算"没有这个方向"。一格的世界位移约 `CUBE`(1.0)，
 * 所以 0.15 是"不足六分之一格"—— 肉眼在那个量级上分辨不出偏差。
 */
export const NEGLIGIBLE = 0.15;

/** 按某个方向走一步会落到哪、会不会落水 —— `stepDelta` 的结果。 */
export interface StepDelta {
  /** 世界位移（未归一化）。 */
  readonly delta: Vec3;
  /** 这一步会**落水**（扣命）。 */
  readonly danger: boolean;
}

function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 按 `dir` 走一步的**世界位移**（渲染口径：吃锚点）。`null` = 这一步走不了。
 *
 * 两个消费者：HUD 的方向提示（投影到屏幕轴变成 `→↑` 那种记号）与角色的**朝向箭头**
 * （把位移转成 yaw）。两件事必须同源 —— 否则"提示说往右、箭头却指着别处"。
 *
 * **跨折痕那一步位移是 0**（两格落在世界同一个位置，见 `BRICK_N` 的说明）：直接返回就得到
 * 一个零向量，所以再看一步 —— 那正是"按下去之后我会往哪边走"的答案。
 */
export function stepDelta(
  level: Level,
  cell: Cell,
  mode: MoveMode,
  dir: Dir,
  bridges?: ReadonlySet<string>,
): StepDelta | null {
  const opts = { bridges };
  const base = playerAnchor(level, cell, mode, bridges);

  const result = step(level, { cell, mode }, dir, opts);
  let to: Vec3 | null = null;
  let danger = false;

  if (result.kind === 'move') {
    to = playerAnchor(level, result.state.cell, result.state.mode, bridges);
    if (distance(to, base) < NEGLIGIBLE) {
      // 跨折痕：原地转 90°，再看一步。
      const next = step(level, result.state, dir, opts);
      if (next.kind === 'move') {
        to = playerAnchor(level, next.state.cell, next.state.mode, bridges);
      } else if (next.kind === 'fall') {
        if (next.end.kind === 'landed') {
          to = playerAnchor(level, next.end.cell, stateAt(level, next.end.cell)?.mode ?? 'stand', bridges);
        } else {
          danger = true;
          to = playerAnchor(level, next.end.from, result.state.mode, bridges);
        }
      } else {
        to = null; // 转过去也走不动 → 没有可报的方向
      }
    }
  } else if (result.kind === 'fall') {
    if (result.end.kind === 'water') {
      danger = true;
      // 记号打在想踏进去的那一格（= 缺口本身），而不是水面上 —— 那才是玩家看着的目标。
      to = playerAnchor(level, result.end.from, mode, bridges);
    } else {
      to = playerAnchor(level, result.end.cell, stateAt(level, result.end.cell)?.mode ?? 'stand', bridges);
    }
  }

  if (to === null) return null;
  return { delta: [to[0] - base[0], to[1] - base[1], to[2] - base[2]], danger };
}

/**
 * 两个位移是不是**同一个世界方向**（只看 x/z；夹角小于约 25° 就算同一个）。
 *
 * 用途只有一个：**跨接头的转折**上判断"按住不放还有没有意义"。玩家沿小道按 `w` 走过来、
 * 出门时 `w` 在墙面上指的是爬梯（另一回事）—— 那就该掐掉按住，让他重新按，而不是替他
 * 拐进另一条走廊（用户 2026-09-19："按着 a 键会在到达墙面时自动转换方向，这是不对的"）。
 *
 * 折痕**不算**这种转折：那是同一条走廊折了一下，两边的世界方向一致（`stepDelta` 的
 * "再看一步"口径下相同），按住不放继续走正是教学里那句"沿走廊一直走就能过去"。
 */
/**
 * **悬停辅助线**在某一面墙上、某一行的那条线：位置与尺寸。
 *
 * ## 为什么它是纯函数、而且放在这里
 *
 * 第一版写在 `fx.ts` 里，两个错都犯了，而且是**用户先看出来的**：
 *
 * 1. **中心取了第一个格子的锚点**，不是两端的中点 —— 整条线偏出去半面墙、还长出场景外
 *    （用户："这辅助线不对吧？"）；
 * 2. 另一个轴推了整整一格，线**浮在墙外**。
 *
 * "两个端点 + 偏移"正是几何唯一出处该管的事（`cellAnchor` 就在这里）；放进纯函数就顺带能测，
 * 不必再靠"看着像不像"。
 *
 * ## 约定
 *
 * - **沿墙**展开：A 面的列沿 z、B 面的列沿 x —— 所以长边分别是 z / x；
 * - 两端各多出 `CUBE * 0.4`，把首尾两格**盖满**（不然两头各差半格，像没到头）；
 * - 贴着那一面墙**正面外一点**（约 0.1 格）：不埋进砖里，也不像浮在空中。
 */
export function guideLine(
  level: Level,
  face: 'A' | 'B',
  row: number,
  opts: { readonly tickAtCol?: number } = {},
): { readonly p: Vec3; readonly s: Vec3 } {
  /**
   * **乙**（用户 2026-09-23 选定）：指着的那面墙只画**指针附近一小段**（"我在这儿"），
   * 另一面墙画**整行**（"这个高度在对面落在哪一行"）。所以两条线天然分工、而且**长度不等** ——
   * 第一版两面都画整行，用户一眼就说不对（"射到右边墙上那条较长，射到左边墙上那条较短"）。
   *
   * `tickAtCol` 给了就是"短的那条"，按那面墙的列范围**夹住**（否则指针在边缘时一小段会伸到墙外）。
   */
  const lo = face === 'A' ? 0 : level.fold;
  const hi = face === 'A' ? level.fold - 1 : level.cols - 1;
  const firstCol = opts.tickAtCol === undefined ? lo : Math.max(lo, Math.min(hi, opts.tickAtCol - TICK_HALF));
  const lastCol = opts.tickAtCol === undefined ? hi : Math.max(lo, Math.min(hi, opts.tickAtCol + TICK_HALF));
  const first = cellAnchor(level, { face, col: firstCol, row }).p;
  const last = cellAnchor(level, { face, col: lastCol, row }).p;
  const along = Math.abs(last[0] - first[0]) + Math.abs(last[2] - first[2]) + CUBE * 0.8;
  const thin = CUBE * 0.08;
  // **中点**（两端平均）——第一版在这里栽过：用了端点当中心，整条线偏出去半面墙。
  const midX = (first[0] + last[0]) / 2;
  const midZ = (first[2] + last[2]) / 2;
  const out = CUBE * 0.6; // 贴墙面外一点：不埋进砖里，也不像浮在空中
  return face === 'A'
    ? { p: [midX + out, first[1], midZ], s: [thin, thin, along] }
    : { p: [midX, first[1], midZ + out], s: [along, thin, thin] };
}

/** 短线的半长（格）：指针所在那面墙上只提示指针左右各 2 格。 */
export const TICK_HALF = 2;
export function sameWorldDirection(a: Vec3, b: Vec3): boolean {
  const la = Math.hypot(a[0], a[2]);
  const lb = Math.hypot(b[0], b[2]);
  if (la < NEGLIGIBLE || lb < NEGLIGIBLE) return false;
  return (a[0] * b[0] + a[2] * b[2]) / (la * lb) > 0.9;
}
