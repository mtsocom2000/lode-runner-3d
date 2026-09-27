import * as THREE from 'three';
import { faceOf, halfExtent } from '../core/world/fold';
import { deckKey, type DeckCell } from '../core/world/deck';
import type { Level, TileKind } from '../core/world/tiles';
import { BRICK_FACE, CUBE, DECK_SHIFT, DECK_TOP_Y, HEADROOM, INK, PIT_DEPTH, PIT_RECESS, WATER_Y, cellAnchor, type Anchor } from './metrics';
import type { Bounds } from './camera';
import { PALETTE } from './palette';
import type { Vec3 } from './tween';

/**
 * 折面关卡的渲染（T5）。
 *
 * 一句话：**两面竖直墙承载同一张摊平关卡** —— 这是概念本身（架构文档 §1.1）。
 *
 * ## 坐标只认 core
 *
 * 每个格子的世界坐标都由 `core/world/fold.ts` 的 `toWorld(toFold(cell))` 给出，
 * 渲染层只负责再加"砖块自身的厚度"（沿墙面法线推出 `INK + CUBE/2`）。
 * 这样"格子在哪"只有一处定义 —— 一旦这里手写一套坐标，core 与像素就会各说各话，
 * 而本仓库历次 bug 全是"两套数据不一致"（架构文档 §5.1 的反面清单）。
 *
 * 顺带验证：这份映射与 `mocks/cube-fold-mock-v10.html` 的 `place()` 逐项等价 ——
 * A 面 `z = u - 6.5`、B 面 `x = u - 6.5`，砖心同样再外移 0.49。所以"
 * 截图与 v10 构图一致"这条验收是可对照的，不是凭感觉。
 *
 * ## 为什么用 InstancedMesh
 *
 * 墙砖 / 岛砖 / 小道砖是**同一个规格的立方体**（只是颜色不同）。逐块 `Mesh` 会得到
 * 数百次 draw call；`InstancedMesh` + `setColorAt` 用一个几何体、一次 draw call 就够，
 * 颜色靠逐实例色。这也是它能保持"统一规格"这件事在代码里**看得见**的原因 ——
 * 想要给某块砖换个尺寸，就得先改这里的结构，而不可能偷偷塞一个特例进去。
 *
 * ## 归属划分
 *
 * 这里只画"state 说有什么"，并给出**差分入口** `setGrid` —— 挖开一格、回填一格，
 * 代价都只有那一格本身。逐实体的补间（角色怎么从 A 滑到 B）归 `meshSync.ts`；
 * 岛台/小道的**数据**归 T10 —— 这里现在只有"画出来的"几何（见 `islandAndJetties`），
 * 它们现在**已经**进了 `core` 的通行图（见 `CONCEPT_MINIMAL.deck` / `joints`，T10）——
 * 所以这里画的几何必须与那份**声明**对齐：改这儿的 x / z 就要改那边，否则图里通、画面上不重合。
 */

/**
 * 几何常量（`CUBE` / `WATER_Y` / `HEADROOM` / …）与"格子 → 世界坐标"的换算都搬去了
 * `render/metrics.ts` —— 因为 `meshSync`（角色）与测试也要用同一套数字，
 * 三处各写一遍必然会漂。
 */

interface Piece {
  readonly p: Vec3;
  readonly s: Vec3;
}

/** 砖块 / 硬砖的颜色；不是砖一律 null。 */
function brickColor(kind: TileKind | undefined): number | null {
  if (kind === 'dig') return PALETTE.brick;
  if (kind === 'hard') return PALETTE.hard;
  return null;
}

/** 这一格是不是"非砖道具"。写成显式判断是为了让后面的 switch 能被 TS 收窄。 */
function isProp(kind: TileKind | undefined): kind is 'ladder' | 'bar' | 'treasure' | 'exit' {
  return kind === 'ladder' || kind === 'bar' || kind === 'treasure' || kind === 'exit';
}

/**
 * 摊平坐标 (col,row) → 该格在墙上的锚点。换算在 `metrics.cellAnchor`（唯一出口），
 * 这里只负责把"列"补成完整的 `Cell`。
 */
function place(level: Level, col: number, row: number): Anchor {
  return cellAnchor(level, { face: faceOf(col, level.fold), col, row });
}

/**
 * 某格的砖块实例。`kind` 由**调用方给出**（而不是从 level 读）—— 这样差分时写的是
 * "改过之后"的瓦片，而不是关卡文件里的原始值。非砖格给零缩放：槽位仍在，只是看不见。
 *
 * `'pit'`（挖出来的坑）走一条自己的路：不是"砖没了"，而是一口**往墙里缩进去的深色凹槽** ——
 * 理由与那两个数见 `metrics.ts` 的 `PIT_DEPTH`。
 */
function brickSlot(
  level: Level,
  col: number,
  row: number,
  kind: TileKind | undefined,
): Piece & { readonly color: number } {
  const { p, alongZ } = place(level, col, row);

  if (kind === 'pit') {
    const [x, y, z] = p;
    // 凹槽沿该面的法线方向（A 面是 x，B 面是 z）后缩、并只在那一个轴上变浅。
    return alongZ
      ? { p: [x - PIT_RECESS, y, z], s: [PIT_DEPTH, CUBE, CUBE], color: PALETTE.pit }
      : { p: [x, y, z - PIT_RECESS], s: [CUBE, CUBE, PIT_DEPTH], color: PALETTE.pit };
  }

  const color = brickColor(kind);
  return { p, s: color === null ? [0, 0, 0] : [CUBE, CUBE, CUBE], color: color ?? PALETTE.brick };
}

/** 梯：两根立柱 + 三根横档（朝向随所在面而转 —— A 面的列沿 z 排）。 */
function ladderParts(p: Vec3, alongZ: boolean): readonly Piece[] {
  const [x, y, z] = p;
  const rail: Vec3 = [0.07, CUBE, 0.07];
  const rung: Vec3 = alongZ ? [0.07, 0.06, 0.6] : [0.6, 0.06, 0.07];
  const out: Piece[] = [];
  for (const q of [-0.24, 0.24]) {
    out.push({ p: alongZ ? [x, y, z + q] : [x + q, y, z], s: rail });
  }
  for (let k = 0; k < 3; k++) {
    out.push({ p: [x, y - 0.3 + k * 0.3, z], s: rung });
  }
  return out;
}

/**
 * 把一关里**除砖以外**的瓦片摊成立体件。砖走 `createBrickLayer` —— 它要能被差分更新。
 *
 * `grid` 由调用方给（而不是读 `level.grid`）：闸门开启会把 `硬砖 → 梯子`（T13 的"通天梯"），
 * 收走芯片会把 `宝物 → 空` —— 这两件事都发生在**游戏进行中**，所以道具层必须能按新网格重建
 * （见 `createStage` 的 `setGrid`）。只读初始网格的话，闸门开了玩家会看到一条**看不见的梯子**。
 *
 * **导出**是为了让 `test/props.test.ts` 直接钉住这两件事（"折痕那一对只画一根"、
 * "闸门开了真的会多出梯子"）—— 它们是纯数据，不需要 WebGL。
 */
export function collectProps(
  level: Level,
  grid: readonly TileKind[],
): {
  readonly ladders: readonly Piece[];
  readonly bars: readonly Piece[];
  readonly treasures: readonly Piece[];
  readonly exits: readonly Piece[];
} {
  const ladders: Piece[] = [];
  const bars: Piece[] = [];
  const treasures: Piece[] = [];
  const exits: Piece[] = [];

  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      const kind = grid[row * level.cols + col];
      if (!isProp(kind)) continue;

      // 折痕两侧最内列落在**世界同一个位置**（见 `world/fold.ts` 的 `halfExtent`）。
      // 横杆/梯子这类**有方向**的件在那儿会画成一对交叉 —— 两根各自沿自己那面墙的轴、
      // 又都穿过同一个点（用户的原话："看到交接处有个粉红色的交叉，不知道有什么意思？"）。
      // 所以同一对里只画**靠 A 面**的那一根：位置一模一样，少画一根就不再有十字。
      //
      // **只对"有方向"的道具去重**（梯 / 杆）。宝物与出口是对称体（方块 / 立方体），
      // 两个重叠也看不出来；而它们**各自都算数**（宝物是可捡的、出口是终点）——
      // 把其中一个藏起来是比"重叠"严重得多的错。
      if (
        (kind === 'ladder' || kind === 'bar') &&
        col === level.fold &&
        level.at(level.fold - 1, row) === kind
      ) {
        continue;
      }

      const { p, alongZ } = place(level, col, row);
      switch (kind) {
        case 'ladder':
          ladders.push(...ladderParts(p, alongZ));
          break;
        case 'bar':
          bars.push({ p, s: alongZ ? [0.1, 0.1, CUBE] : [CUBE, 0.1, 0.1] });
          break;
        case 'treasure':
          treasures.push({ p, s: [TREASURE_SIZE, TREASURE_SIZE, TREASURE_SIZE] });
          break;
        case 'exit':
          exits.push({ p, s: [CUBE, CUBE, CUBE] });
          break;
      }
    }
  }

  // **甲板上的横杆**（T17 的"断岛之间用连杆"）：它们不在摊平网格里，所以不在上面那个循环里 ——
  // 但它们与墙上的横杆是**同一种东西**（`PALETTE.bar`、同一根细杆），所以归同一个数组。
  // 分成两处画必然有一天会出现"墙上的杆是陶土红、甲板上的杆是别的色"。
  const deckKeys = new Set(level.deck.map((c) => deckKey(c)));
  for (const cell of level.deck) {
    if (cell.hang !== true) continue;
    // 杆的**朝向** = 它连出去的那条轴：沿 x 有甲板邻居就横着画，否则竖着。
    //
    // ⚠ **邻居要按"甲板格"找，不是按"杆格"找**（第一版就是按杆格找的，当场画错）：
    // 杆桥的**两端接的是板**，只在中间才接杆 —— 只认同类的话，两头那两根会被画成横的、
    // 中间那根竖的，整条桥看起来像一道栅栏。这个 bug 是 `test/props.test.ts` 抓出来的。
    const level_ = cell.level ?? 0;
    const has = (dx: number): boolean => deckKeys.has(deckKey({ x: cell.x + dx, z: cell.z, level: level_ }));
    const alongX = has(-1) || has(1);
    // **高度取"格心"**（= `cellAnchor` 的 y），不是板心。
    //
    // 甲板格与墙面格同口径：`level` 说的是**板**在第几层，而角色站在**板的上面那一格** ——
    // 所以一格甲板的"格心"是 `DECK_TOP_Y + CUBE/2 + level`（墙面格同理：砖在 `row`、人占 `row + 1`）。
    // 第一版按**板心**（`layerY`）画，于是杆躺在板厚里、脚下就是水面 ——
    // 用户的原话："这个地板是最低一层了，下面就是水面了，所以这个连杆位置不对"。
    const p: Vec3 = [
      cell.x + DECK_SHIFT,
      DECK_TOP_Y + CUBE / 2 + level_ * CUBE,
      cell.z + DECK_SHIFT,
    ];
    bars.push({ p, s: alongX ? [CUBE, 0.1, 0.1] : [0.1, 0.1, CUBE] });
  }

  return { ladders, bars, treasures, exits };
}

/**
 * 水面中央的岛台 + 两条通向墙面的小道。
 *
 * ## 这一段的数全来自**关卡数据**（不是抄来的，也不是从 `fold` 推的）
 *
 * 更早的版本写着 `mocks/cube-fold-mock-v10.html` 的一组手抄数字；再往后改成从
 * `halfExtent(fold)` 加写死的常量（`JETTY_U`、`ISLAND_HALF`）**算**出来。两次都不行：
 * 手抄数字一换关卡就失效，而"从 `fold` 推"让岛台永远 4×4、位置永远偏在某一侧 ——
 * 关卡一放大（每面 10 列 × 12 行），房间大了、岛台与水面纹丝不动
 * （用户的原话："场景利用率变低了……地台和水面的面积也小了"）。
 *
 * ## 高度必须正好对齐（这是"能不能走过去"的全部）
 *
 * 墙面上"行 1"的行走面 = 行 0 那层砖的**顶面** = y = 1.0（砖心 0.5 + 半个立方体 0.5）。
 * 岛台与小道只有一层砖厚，于是砖心落在 y = 0.5、顶面正好 1.0，与墙上最底那层砖齐平。
 * 差半格就会变成"上不去"，或者"要先下沉一格才能攀" —— 用户之前抓到过同类的坑。
 *
 * ## 岛台 / 小道 / 宝物：**逐格照关卡数据画**
 *
 * 渲染层照 `level.deck` 逐格画、宝物照 `level.treasures` 摆。关卡数据是唯一出处，
 * 于是"看得见"与"走得到"**结构上不可能不一致**（那类事故本仓库栽过两次：甲板锚点、接头方向）。
 * 想摆多大的岛、岛在哪，改关卡的 `deck` 就是。
 */
export function islandAndJetties(level: Level): {
  readonly bricks: readonly (Piece & { readonly color: number })[];
  /**
   * **塔的梯子标记**：某一层甲板格的正上方还是甲板 → 那里画一段梯子。
   *
   * 它是"这里能按 `Z` 上去"的**视觉说明**，不是另一份规则数据 —— 判据（上面一层是不是甲板）
   * 只有一个出处，core 的 `stepLift` 与这里读的是同一件事。梯子不给任何额外能力，
   * 所以画错/漏画不会造成"看得见走不到"，只会难看。
   */
  readonly ladders: readonly Piece[];
  /**
   * 每一颗宝物的**位置与身份**（甲板格）。`createStage` 按它建实例，并在收走时把对应实例缩到 0
   * （见 `applyTreasures`）—— 所以这里要的是**全部**宝物，不是一颗。
   */
  readonly prizes: readonly { readonly cell: DeckCell; readonly p: Vec3 }[];
  /** 甲板横向中心（x 与 z 同值 —— 折面本身关于对角线对称）。水面也读这个数，两处各算一次必然漂。 */
  readonly centre: number;
} {
  /** 一层砖厚：砖心落在**甲板顶面**下方半个立方体 —— 于是顶面正好与墙面最底那层砖齐平。 */
  const layerY = DECK_TOP_Y - CUBE / 2;

  const bricks: (Piece & { readonly color: number })[] = level.deck
    .filter((cell) => cell.hang !== true && cell.ladder !== true) // 杆与梯子都不是方块
    .map((cell) => ({
      // **整块立方**（T17 定稿）。第一版把上面几层画成薄板，是想绕开"站在第 L 层会被第 L+1 层
      // 那块包住"—— 但那是**方块堆叠的几何事实**，不该靠改厚度糊过去（用户的原话：
      // "砖块的厚度也比其他的砖块薄了一半，这是第二个不合理"）。
      // 正确的解法是**梯子格**：梯子占的是你所在的那一格，所以它上面可以继续叠方块。
      p: [cell.x + DECK_SHIFT, layerY + (cell.level ?? 0) * CUBE, cell.z + DECK_SHIFT],
      s: [CUBE, CUBE, CUBE],
      color: PALETTE.brick,
    }));

  // **梯子格**画梯子（见下面那段：判据是数据，不是推断）。
  const ladders: Piece[] = [];
  for (const cell of level.deck) {
    // **梯子格**才画梯子 —— 这是 T17 定稿的判据（用户 2026-09-19 的追问逼出来的）。
    //
    // 在这之前这里是**推断**的："上面那一层还是甲板 → 画一段梯子"。那条推断在"实心方块柱"
    // 上必然出错：柱身每一格的上面都是方块，于是梯子被画进方块内部（用户："梯子位于一个砖块的
    // 内部"）；我把它挪到外侧，它又指错了能爬的那一格（用户："走进梯子无法攀爬"）。
    //
    // 现在它**不是推断，是数据**：`ladder: true` 的格子才画梯子，而那也正是 `Z` 生效的地方 ——
    // "画在哪"与"站哪能爬"不可能再错开，因为两者读的是同一个字段。
    if (cell.ladder !== true) continue;

    // 画在 `[level, level + 1]`：于是柱侧的三个梯子格连成**一根从岛面直达柱顶**的梯子
    // （柱身方块在 `[level, level+1]` 上，最上一块顶面 = `DECK_TOP_Y + 3` = 梯子的顶端）。
    const y = layerY + (cell.level ?? 0) * CUBE;
    ladders.push(...ladderParts([cell.x + DECK_SHIFT, y, cell.z + DECK_SHIFT], false));
  }

  // 水面要读的"甲板中心"：按甲板格的实际范围算，不再由 `fold` 推。
  const xs = level.deck.map((cell) => cell.x + DECK_SHIFT);
  const centre = xs.length === 0 ? 0 : (Math.min(...xs) + Math.max(...xs)) / 2;

  // 宝物**逐颗**照 `level.treasures` 摆。**必须落在格心** —— core 的采集判定是"玩家所在格 ==
  // 宝物格"，而玩家只能站在格心；画在别处（比如岛台的几何中心，那是砖缝）就是"看得见捡不到"。
  //
  // **高度必须带层**（T17 修）：`level` 是"柱顶那颗"与"岛面那颗"的**唯一区别**，
  // 漏掉它就等于把柱顶那颗画进柱身里 —— 用户的原话是"宝物在柱顶，这个没看到"。
  //
  // **以前这里只取 `treasures[0]`**：L2 有两颗，于是第一颗根本没画出来；而画出来那颗收走之后
  // 也不会消失。两处都在用户那条"取了宝物没有任何反应、闸门没移走"的反馈里。
  const prizes = level.treasures.map((t) => ({
    cell: t,
    p: [
      t.x + DECK_SHIFT,
      DECK_TOP_Y + (t.level ?? 0) * CUBE + 0.3,
      t.z + DECK_SHIFT,
    ] as Vec3,
  }));

  return { bricks, ladders, prizes, centre };
}

interface BrickLayer {
  readonly mesh: THREE.InstancedMesh;
  /** 应用新的瓦片表，**只写变了的格**，返回改动格数。 */
  apply(grid: readonly TileKind[]): number;
}

/**
 * 砖块层：逐实例着色（材质给白色，颜色全靠实例色乘上去）+ 每格一个槽位。
 *
 * **为什么要给空格也留槽位**：挖（T11）把砖变空 —— 有槽位可隐藏；回填把空变砖 ——
 * 也要有槽位才画得出来。若只按"初始有几块砖"分配，回填就无处可放。
 * 代价是几十个零缩放的不可见实例，在这个规模下等于零。
 *
 * 岛台/小道的砖接在关卡格子之后，**不参与差分**（它们不归关卡数据管）。
 */
function createBrickLayer(
  scene: THREE.Scene,
  level: Level,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  extra: readonly (Piece & { readonly color: number })[],
): BrickLayer {
  const slots = level.cols * level.rows;
  const total = slots + extra.length;

  /**
   * 描边层：**全尺寸**的深色盒，与砖块同一批变换。
   *
   * 两个关键点，缺一不可：
   * 1. **先画**（`renderOrder = -1`）且 **`depthWrite: false`** —— 它写颜色不写深度，
   *    于是随后画的砖块（缩小到 `BRICK_FACE`）照常盖在它上面，**露出来的那一圈就是轮廓线**。
   *    若让它写深度，砖块会被它挡住（它比砖大，正面更靠近相机）。
   * 2. 颜色用 `PALETTE.ink`（灰黑）而不是背景色 —— 留缝会让背景透出来，读成"砖在浮着"，
   *    而这里读成"一条线"。用户要的是后者。
   */
  const outline = new THREE.InstancedMesh(
    geo,
    new THREE.MeshBasicMaterial({ color: PALETTE.ink, depthWrite: false }),
    total,
  );
  outline.renderOrder = -1;

  const mesh = new THREE.InstancedMesh(geo, mat, total);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const col = new THREE.Color();
  const write = (index: number, piece: Piece & { readonly color: number }): void => {
    // 描边层：原样（= 铺满整格）
    pos.set(piece.p[0], piece.p[1], piece.p[2]);
    scl.set(piece.s[0], piece.s[1], piece.s[2]);
    outline.setMatrixAt(index, m.compose(pos, q, scl));

    // 砖体：同样位置，缩小到 `BRICK_FACE`（于是四周露出一圈描边）
    scl.set(piece.s[0] * BRICK_FACE, piece.s[1] * BRICK_FACE, piece.s[2] * BRICK_FACE);
    mesh.setMatrixAt(index, m.compose(pos, q, scl));
    mesh.setColorAt(index, col.setHex(piece.color));
  };

  extra.forEach((piece, i) => write(slots + i, piece));

  /** 上一次应用过的瓦片表 —— 差分的全部内容就是拿它跟新表比。初值 undefined，故首次 apply 会写满。 */
  const applied: (TileKind | undefined)[] = new Array<TileKind | undefined>(slots).fill(undefined);

  scene.add(outline);
  scene.add(mesh);

  return {
    mesh,
    apply(grid: readonly TileKind[]): number {
      let changed = 0;
      for (let row = 0; row < level.rows; row++) {
        for (let c = 0; c < level.cols; c++) {
          const index = row * level.cols + c;
          const kind = grid[index];
          if (kind === applied[index]) continue;
          applied[index] = kind;
          write(index, brickSlot(level, c, row, kind));
          changed += 1;
        }
      }
      if (changed > 0) {
        mesh.instanceMatrix.needsUpdate = true;
        outline.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      return changed;
    },
  };
}

/** 建一个单色 InstancedMesh。 */
function instanced(
  parent: THREE.Object3D,
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  pieces: readonly Piece[],
  shadows: boolean,
): THREE.InstancedMesh | null {
  if (pieces.length === 0) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, pieces.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();

  pieces.forEach((piece, i) => {
    pos.set(piece.p[0], piece.p[1], piece.p[2]);
    scl.set(piece.s[0], piece.s[1], piece.s[2]);
    mesh.setMatrixAt(i, m.compose(pos, q, scl));
  });

  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  parent.add(mesh);
  return mesh;
}

export interface Stage {
  readonly scene: THREE.Scene;
  /** 各类立体件的数量 —— 给探针与日志一份"到底摆了些什么"的凭据。 */
  readonly counts: Readonly<Record<string, number>>;
  /**
   * 关卡内容的**世界包围盒**（取景用，见 `camera.ts` 的 `fitCamera`）。
   *
   * **为什么显式算、不用 `Box3.setFromObject(scene)`**：砖层是 `InstancedMesh`，
   * 而 three 的 `Box3.expandByObject` 只拿**几何体本身**（一个原点处的单位立方体）去撑，
   * 看不到逐实例矩阵 —— 算出来会是个贴在原点的小盒子，比不设还糟。
   * 所以这里按"两面墙 + 砖块进深 + 水面外沿 + 顶部余量"直接给数。
   */
  readonly bounds: Bounds;
  /**
   * 把新的瓦片表贴上墙，返回**改动格数**。这是 state→mesh 的差分入口：
   * 挖开一格、回填一格，代价都只有那一格 —— 而不是重建整面墙。
   */
  setGrid(grid: readonly TileKind[]): number;
  /**
   * 更新"还剩哪几颗宝物"（收走一颗就少一颗）。
   *
   * 与 `setGrid` 同一类入口：渲染层不推演规则，只把 `SimState.treasures` 这个事实画出来。
   * 缺了它，收走的宝物会一直留在岛上（用户报的"取了宝物没有任何反应"）。
   */
  setTreasures(remaining: readonly DeckCell[]): void;
  /** 每帧调用。逐实体的补间归 `meshSync.ts`（它有自己的 mesh，不在这里）。 */
  update(elapsed: number): void;
  dispose(): void;
}

/**
 * 造一关的场景。
 *
 * `scene` 可注入（T21）：**场景对象本身由调用方持有**，重建关卡时只清空内容、不换容器 ——
 * 于是泛光那套（它抓着 `scene` 的引用）不必跟着重建。不传就自己造一个（旧行为不变）。
 */
/**
 * **宝物**的边长（墙上那颗 `G` 与甲台上那颗**是同一个东西**，所以共用一个尺寸）。
 *
 * 曾经墙上那颗是 0.38 的**蓝色八面体**，用户的原话是"场景右侧中部有三个芯片，但是大小很小
 * 一点点"，后来又一针见血："宝物的图案以前不是现在这个小蓝点的样子。" ——
 * 八面体+蓝色是**芯片**的行头，而宝物在原版里就是撒在砖面上的一块金子。所以现在墙上与甲台
 * 都是同一颗**金色方块**：`box` + `mat.prize`，同一个常量，一眼认得出是同一样东西。
 */
const TREASURE_SIZE = 0.6;

export function createStage(level: Level, scene: THREE.Scene = new THREE.Scene()): Stage {
  const half = halfExtent(level.fold);
  const wallTop = level.rows + HEADROOM;
/**
 * **一面墙**（折起来之后）在世界里占多宽，以及它在自己那条轴上的中心。
 *
 * 折痕线在 `-halfExtent(fold)`，格子从折痕线往外排 `fold` 格（`fold.ts` 的 `toWorld`），
 * 所以一面墙恰好占 `[−half, −half + fold]`：宽度 = `fold`、中心 = `-half + fold/2`。
 *
 * > 这里曾经是 `cols + 2`（那是**摊平后两面的总列数**）—— 于是墙板比地形宽一倍多，
 * > 地形缩在中间一块、四周全是空墙板（用户："左右侧面扩大了，但是侧面上的场景没有铺满"）。
 * > `cols` 与 `fold` 是两套坐标，混用必错；判据只能有一个出处。
 */
const faceSpan = level.fold;
const faceCentre = -half + level.fold / 2;

  // 内容包围盒（取景用，见 `Stage.bounds` 的说明）在函数末尾算 —— 它要用到水面外沿。

  scene.background = new THREE.Color(PALETTE.bg);

  // 灯光按**浅色**场景重新配过：上一版是给深蓝夜色调的（冷色天光 + 强蓝补光），
  // 打在浅底上会把整个画面洗白。这一版要的是参照图 3 那种"平涂 + 柔和阴影"：
  // 天光偏中性白、主光从斜上打、补光只压一点点。
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b4a6, 0.85));
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.5);
  sun.position.set(16, 34, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -40, right: 40, top: 40, bottom: -40, far: 220 });
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  const rim = new THREE.DirectionalLight(0xd8e6f2, 0.3);
  rim.position.set(-20, 9, -18);
  scene.add(rim);

  const box = new THREE.BoxGeometry(1, 1, 1);
  const mat = {
    // 砖块材质给**白色**：真正的颜色由逐实例色乘上去（见 createBrickLayer）。
    white: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    shell: new THREE.MeshLambertMaterial({ color: PALETTE.shell }),
    edge: new THREE.MeshBasicMaterial({ color: PALETTE.edge }),
    seam: new THREE.MeshBasicMaterial({ color: PALETTE.seam }),
    lad: new THREE.MeshLambertMaterial({ color: PALETTE.lad }),
    bar: new THREE.MeshBasicMaterial({ color: PALETTE.bar }),
    prize: new THREE.MeshLambertMaterial({ color: PALETTE.prize }),
    exit: new THREE.MeshBasicMaterial({ color: PALETTE.exit }),
    // 水面用 Lambert 而不是 Phong：不要镜面高光。这一版的风格是平涂（参照图 3），
    // 一层高光就会把画面拉回"科技夜"。"不可进入"由规则表达，不靠刺眼的水色。
    water: new THREE.MeshLambertMaterial({
      color: PALETTE.water,
      transparent: true,
      opacity: 0.85,
    }),
    bed: new THREE.MeshLambertMaterial({ color: PALETTE.bed }),
    waterRim: new THREE.MeshBasicMaterial({
      color: PALETTE.rim,
      transparent: true,
      opacity: 0.4,
    }),
    glint: new THREE.MeshBasicMaterial({
      color: PALETTE.glint,
      transparent: true,
      opacity: 0.1,
    }),
  };

  const singles: THREE.Mesh[] = [];
  function put(
    m: THREE.Material,
    p: Vec3,
    s: Vec3,
    shadows = true,
    geo: THREE.BufferGeometry = box,
  ): THREE.Mesh {
    const o = new THREE.Mesh(geo, m);
    o.position.set(p[0], p[1], p[2]);
    o.scale.set(s[0], s[1], s[2]);
    o.castShadow = shadows;
    o.receiveShadow = shadows;
    scene.add(o);
    singles.push(o);
    return o;
  }

  // ── 两片墙（背板）+ 折痕线 ──
  //
  // 背板的**内表面**必须落在 `-half + INK`（正是砖块的背面，两者相切），所以背板的**中心**
  // 在 `-half + INK - CUBE/2`。⚠ 这里最容易写错的是"面"与"中心"：
  // 曾经把中心写成 `-half + INK`，于是背板内表面跑到 `-12.5`，而砖的范围是 `-13.0 … -12.0`
  // —— **背板把每块砖靠墙的一半吃掉了**（用户看到的是"顶面只剩一半、像嵌进墙里、
  // 剖面中间一条白线"）。半个砖的错位，症状却是三条。
  const panelCentre = -half + INK - CUBE / 2;
  put(mat.shell, [panelCentre, wallTop / 2, faceCentre], [CUBE, wallTop, faceSpan]);
  put(mat.shell, [faceCentre, wallTop / 2, panelCentre], [faceSpan, wallTop, CUBE]);
  // 折痕线画在两片背板**内表面**相交的那条棱上。
  put(mat.seam, [-half + INK, wallTop / 2 - 0.5, -half + INK], [0.09, wallTop - 0.8, 0.09]);

  // ── 墙面轮廓线：没有这一圈，两片墙会整片隐进背景，"折面贴在墙角"就读不出来了 ──
  {
    const e = -half + INK + 0.06;
    const w = 0.05;
    const z0 = faceCentre - faceSpan / 2;
    const z1 = faceCentre + faceSpan / 2;
    const t = wallTop;
    put(mat.edge, [e, t / 2, z0], [w, t, w], false);
    put(mat.edge, [e, t / 2, z1], [w, t, w], false);
    put(mat.edge, [e, 0.05, faceCentre], [w, w, faceSpan], false);
    put(mat.edge, [e, t - 0.05, faceCentre], [w, w, faceSpan], false);
    put(mat.edge, [z0, t / 2, e], [w, t, w], false);
    put(mat.edge, [z1, t / 2, e], [w, t, w], false);
    put(mat.edge, [faceCentre, 0.05, e], [faceSpan, w, w], false);
    put(mat.edge, [faceCentre, t - 0.05, e], [faceSpan, w, w], false);
  }

  // ── 水面：铺满"两片墙围起来的这一块"，岛台只是水里的一座台 ──
  // 远边**收进墙面砖块里面**（`-half + BRICK_N` 正好是砖心），把水的接缝藏在砖背后；
  // 近边往开口那侧**铺出去**，让水延伸到手边甚至出画 —— 而不是在岛外一圈就断掉
  // （第一版就是断在岛外，于是"水面"读成了一块岛的边框）。
  //
  // ## `WATER_SPILL` 为什么从 0.5 放到 2.2（观感返工③）
  //
  // 用户审图后指出"岛相对水面偏大"。查下来的真实数字：`halfExtent(9) = 8.5`，
  // 水面跨度 8.44、岛台跨度 4 → **岛占跨度 47%**。而水面其实**已经铺满了几何允许的
  // 最大范围**（从折痕砖线铺到墙口），所以"把水改大"在**网格内部**没有空间了。
  //
  // 但水面是**纯装饰** —— 水是"掉出墙体"的**结果**，不是一张瓦片（见 `core/world/water.ts`），
  // 所以它可以往墙脚**外面**铺而不动任何规则。用户给的硬约束是"岛 4×4"，那么在
  // "放大水体 / 缩小岛"这两条里只有前者与之相容，于是取前者。
  //
  // 0.5 → 2.2 的调整：跨度 8.44 → 10.14，岛占跨度 47% → **39%**。
  //
  // ## 试过 4.0，**失败了**（别再重复这条路）
  //
  // 2.2 之后**看图**发现：水面虽然成片，但**收边仍落在取景框里**（底部能看到矩形边界
  // 和一圈 `waterRim`），画面读成"一个大水池"而不是"延伸出去的水"。
  // 于是试着放大到 4.0（跨度 12.44，岛占比 32%）想把它顶出框 —— **没成功，而且更糟**：
  // 四条边同时进入视野，矩形读起来反而**更完整**了。
  //
  // 根因：**水面是一个正方形平面，正方形永远有边**。放大只是把四条边往外推，
  // 边依然是边。"靠放大水面让它读成无边的水"这个思路**本身不成立**。
  //
  // 真要消掉"水池感"，可试的方向是**去掉 `waterRim` 那四根亮线**（让水在自己的边缘
  // 没有描边、直接融进背景色），而不是继续放大。这一版没做，留给下一轮定。
  // 所以这里回到 2.2：4.0 的**理由已被推翻**，没有理由留着它。
  //
  // 往**开口那侧**铺（不是往折痕那侧）是因为折痕那边的接缝要靠砖块挡住。
  // 这个值是**外观参数**，改它不牵连任何逻辑。
  const island = islandAndJetties(level);
  // `island.centre` 现在只给**注释掉的**高光条用（见下面那几行）—— 留着比删了又加便宜。
  void island.centre;
  const waterFar = -half + 0.2;
  /** 墙口：最外一列格子的中心在 `-half + fold - 0.5`，再加半个立方体就是砖的外表面。 */
  const wallOuter = -half + level.fold;
  /** 水从墙口外沿再往开口侧铺出去多少格（观感参数，不参与任何规则）。 */
  const WATER_SPILL = 2.2;
  const waterNear = wallOuter + WATER_SPILL;
  const waterC = (waterFar + waterNear) / 2;
  const waterH = (waterNear - waterFar) / 2;
  put(mat.bed, [waterC, 0.01, waterC], [waterH * 2, 0.03, waterH * 2], false);
  put(mat.water, [waterC, WATER_Y / 2, waterC], [waterH * 2, WATER_Y, waterH * 2], false);
  // ── 水面边线：**这一版故意不画**（观感实验③-b） ──
  //
  // 原先这里沿水面四条边各画一根亮线（`mat.waterRim`）。加上去是因为"水面没有边就
  // 看不出来是一层水" —— 但**看图之后**发现它同时在替水面**描出一个矩形轮廓**，
  // 那正是"读成一个大水池而不是延伸出去的水"的直接来源。
  //
  // 试过先放大水面（`WATER_SPILL` 0.5 → 2.2 → 4.0）想把边顶出画外，**失败了**：
  // 正方形平面永远有边，放大只是把四条边往外推，边依然是边。
  // 所以换个方向：**不给水描边**，让它自己的边缘直接融进背景色。
  //
  // 要还原就把下面四行放回来（水面尺寸不用动）：
  //
  //   const y = WATER_Y + 0.012;
  //   const len = waterH * 2 + 0.1;
  //   put(mat.waterRim, [waterC, y, waterC - waterH], [len, 0.035, 0.1], false);
  //   put(mat.waterRim, [waterC, y, waterC + waterH], [len, 0.035, 0.1], false);
  //   put(mat.waterRim, [waterC - waterH, y, waterC], [0.1, 0.035, len], false);
  //   put(mat.waterRim, [waterC + waterH, y, waterC], [0.1, 0.035, len], false);
  //
  // `mat.waterRim` 与 `PALETTE.rim` 都**留着不删** —— 这样还原是"粘回四行"，
  // 而不是"还要把材质和色板条目重新加回来"。多留一个未被引用的材质，比删了又加便宜。
  // 高光条：**已撤**（用户 2026-09-21："现在这根白线分成了 4 根" —— 他要的是**不要这几条**）。
  //
  // 上一版把它修成"真的是 5 条、彼此不重叠"，但那仍然是一组**凭空画在水面上的亮条**：
  // 空白关卡上水面是主角，它们看起来就像画错了。要还原就取消下面这行的注释
  //（`glintStrips` 与 `PALETTE.glint` / `mat.glint` 都留着 —— 与 `rim` 同一套处置：
  // 多留一个未被引用的东西，比删了又加便宜）。
  //
  //   for (const strip of glintStrips(island.centre, waterH)) {
  //     put(mat.glint, [strip.p[0], strip.p[1], strip.p[2]], [strip.s[0], strip.s[1], strip.s[2]], false);
  //   }

  // ── 折面关卡本体 + 岛台/小道 ──
  // 砖走 `createBrickLayer`（每格一个槽位，供 T11 的挖/回填差分）。
  // `island` 在上面画水面时就已经取好了（水要用岛心）。
  const brickLayer = createBrickLayer(scene, level, box, mat.white, island.bricks);
  brickLayer.apply(level.grid);

  /**
   * **道具层**（梯 / 杆 / 芯片 / 出口）—— 整层可重建。
   *
   * 为什么不能像以前那样"建一次就不动"：闸门开启会把 `硬砖 → 梯子`（T13 的"通天梯"），
   * 收走芯片会把 `宝物 → 空` —— 都发生在**游戏进行中**。只建一次的话，玩家会看到
   * "闸门开了、路也通了，可那一段是**看不见的梯子**"。
   *
   * 重建判据是**道具签名**（把非道具格统一记成 `.`）：挖坑/回填不会改签名（那是最频繁的改动，
   * 归砖层的差分），只有"道具的种类或位置变了"才整层重建 —— 一共几十个实例，重建很便宜。
   */
  const propGroup = new THREE.Group();
  scene.add(propGroup);
  /**
   * 当前道具层的**件数**（每种各几个 `Piece`）。`counts` 报它、探针拿它对账
   * （"关卡声明了芯片 ⇒ 画面上就该有芯片"）。
   *
   * ⚠ 这里存**件数**而不是"网格数组的下标"：`instanced()` 对空列表返回 `null` 并被过滤掉，
   * 于是数组会缩短、下标会错位（曾经 `propMeshes[2]` 指到了出口网格，探针报"有芯片但画面上没有"）。
   */
  const propCounts = { ladders: 0, bars: 0, treasures: 0, exits: 0 };
  let propMeshes: THREE.InstancedMesh[] = [];
  let propSignature = '';
  const propSig = (grid: readonly TileKind[]): string =>
    grid.map((kind) => (isProp(kind) ? kind : '.')).join('');

  function buildProps(grid: readonly TileKind[]): void {
    for (const mesh of propMeshes) {
      propGroup.remove(mesh);
      mesh.dispose();
    }
    const props = collectProps(level, grid);
    propCounts.ladders = props.ladders.length;
    propCounts.bars = props.bars.length;
    propCounts.treasures = props.treasures.length;
    propCounts.exits = props.exits.length;
    propMeshes = [
      instanced(propGroup, box, mat.lad, props.ladders, true),
      instanced(propGroup, box, mat.bar, props.bars, true),
      instanced(propGroup, box, mat.prize, props.treasures, false),
      instanced(propGroup, box, mat.exit, props.exits, false),
    ].filter((m): m is THREE.InstancedMesh => m !== null);
    propSignature = propSig(grid);
  }
  buildProps(level.grid);

  /**
   * **塔的梯子标记**（甲板层与层之间）。建一次就够 —— 甲板是关卡数据，游戏进行中不变
   * （会变的是瓦片，那是道具层的事）。用与墙梯同一个材质，读起来才是同一种东西。
   */
  const deckLadderMesh = instanced(scene, box, mat.lad, island.ladders, true);

  /**
   * 宝物实例：**每一颗**一个实例（`island.prizes`）。收走哪颗就把哪个实例缩到 0 ——
   * 与砖层同一套"零缩放 = 不可见"的约定（这里没有差分，宝物最多几颗）。
   *
   * 为什么不能"建一次就不动"：收走之后那颗必须消失（用户："走到岛台取的宝物后，没有任何反应"）。
   */
  const prizeMesh = instanced(
    scene,
    box,
    mat.prize,
    island.prizes.map((spot) => ({ p: spot.p, s: [TREASURE_SIZE, TREASURE_SIZE, TREASURE_SIZE] })),
    false,
  );
  function applyTreasures(remaining: readonly DeckCell[]): void {
    if (prizeMesh === null) return;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    island.prizes.forEach((spot, i) => {
      const alive = remaining.some((t) => t.x === spot.cell.x && t.z === spot.cell.z);
      const k = alive ? TREASURE_SIZE : 0;
      pos.set(spot.p[0], spot.p[1], spot.p[2]);
      scl.set(k, k, k);
      prizeMesh.setMatrixAt(i, m.compose(pos, q, scl));
    });
    prizeMesh.instanceMatrix.needsUpdate = true;
  }
  applyTreasures(level.treasures);

  // 取景包围盒：从墙背板外侧到**水面外沿**，从水底到墙顶。用真实的量算（`waterNear` / `wallTop`）——
  // 写死数字（曾经是 1.2）会在关卡尺寸一变就立刻说谎，而那正是"看不见出口/画面不铺满"的来源。
  const bounds: Bounds = {
    min: [-half - 0.8, -0.2, -half - 0.8],
    max: [waterNear, wallTop, waterNear],
  };

  return {
    scene,
    bounds,
    counts: {
      // `brick` 是**画出来的**砖（关卡里的 + 岛台/小道的）；`brickSlots` 是分配出的槽位数。
      // 两者不相等是正常的（空格也占槽）—— 分开报，才看得出"差分容器有没有给够"。
      brick: level.grid.filter((kind) => brickColor(kind) !== null).length + island.bricks.length,
      brickSlots: level.cols * level.rows,
      ladder: propCounts.ladders,
      bar: propCounts.bars,
      treasure: propCounts.treasures,
      exit: propCounts.exits,
      prize: island.prizes.length,
    },
    setGrid(grid: readonly TileKind[]): number {
      const changed = brickLayer.apply(grid);
      // 道具只在**签名变了**时重建（闸门开了 / 芯片被收走）。
      if (propSig(grid) !== propSignature) buildProps(grid);
      return changed;
    },
    setTreasures(remaining: readonly DeckCell[]): void {
      applyTreasures(remaining);
    },
    update(_elapsed: number): void {
      // 逐实体的补间归 meshSync（它有自己的 mesh，不在这里）。
    },
    dispose(): void {
      // InstancedMesh 与墙板共用 `box` 一个几何体 —— 下面统一释放，
      // 这里只释放每个实例网格自己的实例缓冲（dispose 不动几何体）。
      brickLayer.mesh.dispose();
      for (const mesh of propMeshes) mesh.dispose();
      deckLadderMesh?.dispose();
      prizeMesh?.dispose();
      for (const o of singles) scene.remove(o);
      box.dispose();
      for (const m of Object.values(mat)) m.dispose();
      scene.clear();
    },
  };
}
