import * as THREE from 'three';
import { faceOf, halfExtent } from '../core/world/fold';
import type { Level, TileKind } from '../core/world/tiles';
import { BRICK_FACE, CUBE, DECK_SHIFT, DECK_TOP_Y, HEADROOM, INK, WATER_Y, cellAnchor, type Anchor } from './metrics';
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
 */
function brickSlot(
  level: Level,
  col: number,
  row: number,
  kind: TileKind | undefined,
): Piece & { readonly color: number } {
  const { p } = place(level, col, row);
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

/** 把一关里**除砖以外**的瓦片摊成立体件。砖走 `createBrickLayer` —— 它要能被差分更新。 */
function collectProps(level: Level): {
  readonly ladders: readonly Piece[];
  readonly bars: readonly Piece[];
  readonly chips: readonly Piece[];
  readonly exits: readonly Piece[];
} {
  const ladders: Piece[] = [];
  const bars: Piece[] = [];
  const chips: Piece[] = [];
  const exits: Piece[] = [];

  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      const kind = level.at(col, row);
      if (!isProp(kind)) continue;

      const { p, alongZ } = place(level, col, row);
      switch (kind) {
        case 'ladder':
          ladders.push(...ladderParts(p, alongZ));
          break;
        case 'bar':
          bars.push({ p, s: alongZ ? [0.1, 0.1, CUBE] : [CUBE, 0.1, 0.1] });
          break;
        case 'treasure':
          chips.push({ p, s: [0.38, 0.38, 0.38] }); // 八面体半径 0.19 → 直径 0.38
          break;
        case 'exit':
          exits.push({ p, s: [CUBE, CUBE, CUBE] });
          break;
      }
    }
  }

  return { ladders, bars, chips, exits };
}

/**
 * 水面中央的岛台 + 两条通向墙面的小道。
 *
 * ## 这一段的数全是**算出来的**，不是抄来的
 *
 * 上一版这里写着 `mocks/cube-fold-mock-v10.html` 的一组手抄数字（岛台中心 (0,0)、层心 1.71…），
 * 留着它只为"截图与 v10 mock 构图一致"那条验收。现在关卡换了尺寸（`fold = 9`），
 * 手抄数字会当场失效 —— 而"两套数字各说各话"正是本仓库历次 bug 的病因。
 * 所以整段改成从 `halfExtent(fold)` / `BRICK_N` / `ISLAND_HALF` 推出来。
 *
 * ## 高度必须正好对齐（这是"能不能走过去"的全部）
 *
 * 墙面上"行 1"的行走面 = 行 0 那层砖的**顶面** = y = 1.0（砖心 0.5 + 半个立方体 0.5）。
 * 岛台与小道只有一层砖厚，于是砖心落在 y = 0.5、顶面正好 1.0，与墙上最底那层砖齐平。
 * 差半格就会变成"上不去"，或者"要先下沉一格才能攀" —— 用户之前抓到过同类的坑。
 *
 * ## 岛台 / 小道 / 宝物：**逐格照关卡数据画**（本轮的结构性改动）
 *
 * 这里原先是从 `halfExtent(fold)` 加几个写死的常量（`JETTY_U = 5`、`ISLAND_HALF = 2`）
 * **算**出岛台与小道的：那套推导在概念场景里是对的（它让"两道各 2 块砖"读得出来），
 * 代价是岛台永远 4×4、位置永远偏在某一侧。关卡一放大（每面 10 列 × 12 行）问题就来了：
 * 房间大了，岛台与水面**纹丝不动** —— 用户的原话是"场景利用率变低了……地台和水面的面积也小了"。
 *
 * 现在渲染层**照 `level.deck` 逐格画**、宝物照 `level.treasures` 摆。关卡数据是唯一出处，
 * 于是"看得见"与"走得到"**结构上不可能不一致**（那类事故本仓库栽过两次：甲板锚点、接头方向）。
 * 想摆多大的岛、岛在哪，改关卡的 `deck` 就是。
 */
function islandAndJetties(level: Level): {
  readonly bricks: readonly (Piece & { readonly color: number })[];
  readonly prize: Vec3;
  /** 甲板横向中心（x 与 z 同值 —— 折面本身关于对角线对称）。水面也读这个数，两处各算一次必然漂。 */
  readonly centre: number;
} {
  /** 一层砖厚：砖心落在**甲板顶面**下方半个立方体 —— 于是顶面正好与墙面最底那层砖齐平。 */
  const layerY = DECK_TOP_Y - CUBE / 2;

  const bricks: (Piece & { color: number })[] = level.deck.map((cell) => ({
    // `DECK_SHIFT`：往折痕方向挪半格，小道才正对墙砖中心（两套晶格相差 0.5，见 metrics.ts）。
    p: [cell.x + DECK_SHIFT, layerY, cell.z + DECK_SHIFT],
    s: [CUBE, CUBE, CUBE],
    color: PALETTE.brick,
  }));

  // 水面要读的"甲板中心"：按甲板格的实际范围算，不再由 `fold` 推。
  const xs = level.deck.map((cell) => cell.x + DECK_SHIFT);
  const centre = xs.length === 0 ? 0 : (Math.min(...xs) + Math.max(...xs)) / 2;

  // 宝物照 `level.treasures` 摆。**必须落在格心** —— core 的采集判定是"玩家所在格 == 宝物格"，
  // 而玩家只能站在格心；画在别处（比如岛台的几何中心，那是砖缝）就是"看得见捡不到"。
  const treasure = level.treasures[0];
  const prize: Vec3 = [
    (treasure?.x ?? centre) + DECK_SHIFT,
    DECK_TOP_Y + 0.3,
    (treasure?.z ?? centre) + DECK_SHIFT,
  ];

  return { bricks, prize, centre };
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
  scene: THREE.Scene,
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
  scene.add(mesh);
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
  /** 每帧调用。逐实体的补间归 `meshSync.ts`（它有自己的 mesh，不在这里）。 */
  update(elapsed: number): void;
  dispose(): void;
}

export function createStage(level: Level): Stage {
  const half = halfExtent(level.fold);
  const wallTop = level.rows + HEADROOM;
  /**
   * **一面墙**（折起来之后）在世界里占多宽。
   *
   * 曾经这里是 `level.cols + 2` —— 那是**摊平后两面的总列数**（20+2），而折起来之后
   * 两片墙是**互相垂直**的，各自只摊到一个面（`fold` 格）。于是墙板比地形宽了**一倍多**：
   * 地形缩在中间一块、四周全是空墙板。用户的原话："左右侧面扩大了，但是侧面上的场景没有铺满。"
   *
   * 概念场景里这个错被**写死的相机取景裁掉了**（`ORTHO = 6.5` 把空墙板切出画外），
   * 所以一直没露出来；把取景改成"跟着内容走"之后它当场显形。这就是那句
   * "判据只能有一个出处"的又一面：`cols` 与 `fold` 是两套坐标，混用必错。
   */
  const faceSpan = level.fold + 1; // 含两侧各 0.5 的余量
  /** 一面墙在它那条轴上的中心（从折痕 `-half` 到最外一列 `-half + fold - 1`）。 */
  const faceCentre = -half + (level.fold - 1) / 2;

  // 内容包围盒（取景用，见 `Stage.bounds` 的说明）在函数末尾算 —— 它要用到水面外沿。

  const scene = new THREE.Scene();
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
  const chipGeo = new THREE.OctahedronGeometry(0.19);
  const mat = {
    // 砖块材质给**白色**：真正的颜色由逐实例色乘上去（见 createBrickLayer）。
    white: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    shell: new THREE.MeshLambertMaterial({ color: PALETTE.shell }),
    edge: new THREE.MeshBasicMaterial({ color: PALETTE.edge }),
    seam: new THREE.MeshBasicMaterial({ color: PALETTE.seam }),
    lad: new THREE.MeshLambertMaterial({ color: PALETTE.lad }),
    bar: new THREE.MeshBasicMaterial({ color: PALETTE.bar }),
    chip: new THREE.MeshBasicMaterial({ color: PALETTE.chip }),
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
  const islandCentre = island.centre;
  const waterFar = -half + 0.2;
  /** 墙口：最外一片砖（col 0）的格心在 -0.5，再加半个立方体就是它的外表面。 */
  const wallOuter = -0.5 + CUBE / 2;
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
  // 高光条：沿海面铺 5 条，长度与位置都跟着水面尺寸走（不再是写死的 2.4 / 1.9）。
  // 位置相对**岛心**取（那是画面中心），而不是相对水面中心 —— 水面偏向开口那侧之后，
  // 两者不再重合，用水面中心会把高光推到画面外。
  for (let i = 0; i < 5; i++) {
    const t = (i - 2) / 2; // -1 .. +1
    put(
      mat.glint,
      [islandCentre + t * waterH * 0.6, WATER_Y + 0.02, islandCentre],
      [waterH * 0.5, 0.02, 0.16],
      false,
    );
  }

  // ── 折面关卡本体 + 岛台/小道 ──
  // 砖走 `createBrickLayer`（每格一个槽位，供 T11 的挖/回填差分）；其余道具建一次就不动。
  // `island` 在上面画水面时就已经取好了（水要用岛心）。
  const props = collectProps(level);
  // 岛台与小道这一版全是砖，没有连杆 —— 所以杆只来自关卡数据本身。
  const bars = props.bars;
  const brickLayer = createBrickLayer(scene, level, box, mat.white, island.bricks);
  brickLayer.apply(level.grid);

  const meshes = [
    instanced(scene, box, mat.lad, props.ladders, true),
    instanced(scene, box, mat.bar, bars, true),
    instanced(scene, chipGeo, mat.chip, props.chips, false),
    instanced(scene, box, mat.exit, props.exits, false),
  ].filter((m): m is THREE.InstancedMesh => m !== null);

  put(mat.prize, island.prize, [0.6, 0.6, 0.6], false);

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
      ladder: props.ladders.length,
      bar: bars.length,
      chip: props.chips.length,
      exit: props.exits.length,
      prize: 1,
    },
    setGrid(grid: readonly TileKind[]): number {
      return brickLayer.apply(grid);
    },
    update(_elapsed: number): void {
      // 逐实体的补间归 meshSync（它有自己的 mesh，不在这里）。
    },
    dispose(): void {
      // InstancedMesh 与墙板共用 box / chipGeo 两个几何体 —— 下面统一释放，
      // 这里只释放每个实例网格自己的实例缓冲（dispose 不动几何体）。
      brickLayer.mesh.dispose();
      for (const mesh of meshes) mesh.dispose();
      for (const o of singles) scene.remove(o);
      chipGeo.dispose();
      box.dispose();
      for (const m of Object.values(mat)) m.dispose();
      scene.clear();
    },
  };
}
