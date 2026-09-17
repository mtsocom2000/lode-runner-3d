import { describe, expect, it } from 'vitest';
import { createSim, type SimState } from '../src/core/sim';
import { CONCEPT_MINIMAL, PLAYER_SPAWN } from '../src/core/level/levels/conceptMinimal';
import { parseLevel } from '../src/core/world/tiles';
import type { Cell } from '../src/core/types';
import { createSyncer, type ObjectParent } from '../src/render/meshSync';
import { playerAnchor } from '../src/render/metrics';
import { isDone, sample, snapTo, type Vec3 } from '../src/render/tween';

/**
 * 同步层：**位置不连续时不许插值**（用户报的"跳过缺口，回到起点处"）。
 *
 * 现象与机制（已实测）：站在 `A:3,1` 时向左走一步会踩进 `col2` 的落水缺口 → 落水。
 * `sim` 在**同一个 tick**里完成 `fall → drowned → respawned`（`sim.ts` 的 tick 第⑤步），
 * 于是同步层看到的是"位置从 `A:3,1` 直接变成 `A:0,1`" —— 中间那条下坠**根本没有帧**。
 * 而 `meshSync` 当年对任何目标变化都走 `aim → retarget`（世界里直线插值），
 * 于是这一跳被画成**从缺口正上方横滑 3.0 格回出生点**：读起来就是"跨过了缺口"。
 *
 * 修法：瞬移由**事件流**识别（`respawned` 是模拟层明写的事实），把这批实体的补间
 * 直接落位（`snapTo`）—— 不引入任何"距离阈值"式的启发式，那是第二份
 * "什么算合法移动"的真相（`graph.ts` 文件头那条红线）。
 *
 * 刻意**不 import three**（架构红线）：同步器只要求父节点能 `add`/`remove`，
 * 所以这里给一个两行的壳就够 —— 与 `input.test.ts` 里"只借 camera 的矩阵、不碰 three"同一个理由。
 */
const parsed = parseLevel(CONCEPT_MINIMAL);
if (!parsed.ok) throw new Error(`概念关卡必须合法：${JSON.stringify(parsed.errors)}`);
const level = parsed.level;

const parent: ObjectParent = { add: (): void => {}, remove: (): void => {} };

/** 把实体挪到某格，其余 state 照旧（同步层只读 `entities` 的格与模式）。 */
function withCell(base: SimState, cell: Cell): SimState {
  return { ...base, entities: base.entities.map((e) => ({ ...e, cell })) };
}

const AT_HOLE_EDGE: Cell = { face: 'A', col: 3, row: 1 };
const base = createSim(CONCEPT_MINIMAL, PLAYER_SPAWN);
const atEdge = playerAnchor(level, AT_HOLE_EDGE, 'stand');
const spawnAt = playerAnchor(level, PLAYER_SPAWN, 'stand');

describe('meshSync：重生必须就地落位（不许横穿缺口滑回起点）', () => {
  it('对照（旧行为）：不给 snap 时，**重生那一帧角色还画在旧位** —— 接下来几帧就滑过去了', () => {
    const syncer = createSyncer(parent, level);
    syncer.update(withCell(base, AT_HOLE_EDGE), 0.016);
    // dt = 0：表示"就是发生这一跳的那一帧"。插值的话位置仍是起点，于是随后的帧把它拖过去。
    syncer.update(withCell(base, PLAYER_SPAWN), 0);
    expect(syncer.positionOf(0)).toEqual(atEdge);
  });

  it('修好之后：同一帧给了 snap → **精确落在**出生点锚点（一步都不滑）', () => {
    const syncer = createSyncer(parent, level);
    syncer.update(withCell(base, AT_HOLE_EDGE), 0.016);
    syncer.update(withCell(base, PLAYER_SPAWN), 0, { snapEntities: new Set([0]) });
    expect(syncer.positionOf(0)).toEqual(spawnAt);
  });

  it('snap 只作用于列进集合的实体（将来多实体时，别把别人的补间一起打断）', () => {
    const syncer = createSyncer(parent, level);
    syncer.update(withCell(base, AT_HOLE_EDGE), 0.016);
    // 集合里是别的 id → 本实体照旧插值（还画在旧位）
    syncer.update(withCell(base, PLAYER_SPAWN), 0, { snapEntities: new Set([99]) });
    expect(syncer.positionOf(0)).toEqual(atEdge);
  });
});

describe('meshSync：终局不把尸体留在原地装活人', () => {
  it('`dead` 时整体隐藏；重开回 `playing` 又可见（尸体与活人长得一样，必须区分开）', () => {
    const syncer = createSyncer(parent, level);
    syncer.update(base, 0.016);
    expect(syncer.group.visible).toBe(true);

    syncer.update({ ...base, status: 'dead' }, 0.016);
    expect(syncer.group.visible).toBe(false);

    syncer.update(base, 0.016); // R 重开之后
    expect(syncer.group.visible).toBe(true);
  });
});

describe('tween：snapTo —— 不插值的那一档', () => {
  it('立刻就在目标点上，且已经"走完"', () => {
    const p: Vec3 = [1, 2, 3];
    const t = snapTo(p);
    expect(sample(t)).toEqual(p);
    expect(isDone(t)).toBe(true);
  });
});
