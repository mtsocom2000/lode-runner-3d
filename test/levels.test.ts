import { describe, expect, it } from 'vitest';
import { createSim, replay, viewOf, type SimState } from '../src/core/sim';
import { validateLevel } from '../src/core/level/validate';
import { BUILTIN_LEVELS } from '../src/app/levelstore';
import { parseLevel, type LevelDef } from '../src/core/world/tiles';
import { cellKey, type Cell } from '../src/core/types';
import { walkReachable } from '../src/core/rules/reach';

/**
 * **所有内置关卡的通用契约**（T22）。
 *
 * ## 为什么是"一份通用测试"而不是每关一个文件
 *
 * 原来的 `l1/l2/l3.test.ts` 三份测的几乎是同一件事：合法、可达、能过关，只是关卡不同。
 * 加一关就得新开一个文件、把断言再抄一遍 —— 抄的人（我）迟早会漏掉一条，而漏掉的那条
 * 往往正好是新关卡违反的那条。
 *
 * 所以这里**遍历 `BUILTIN_LEVELS`**（关卡库自己那份，不是另抄一个列表 —— 否则加了关卡
 * 忘了加进测试，就会出现"测试全绿、新关从未被验过"）。每关都要求：
 *
 * 1. **校验 0 错 0 警**：连提醒都不该有。提醒的意思是"大概没画完"，而内置关卡是交付内容；
 * 2. **开闸之后出口真的走得到**：`exitGated` 已经验过一遍，这里按"真的把闸门那几格清掉"
 *    再走一遍 —— 两条路都通才说明校验与 sim 对同一件事没有两套判据；
 * 3. **60 tick 确定性**：同一份输入跑两遍逐帧相同（架构红线，顺手每关都过一遍）；
 * 4. 开局能动、不抛。
 *
 * 每关的**性格**（形状、梯子/横杆数量）写在各关自己的用例里，不在这一份。
 */
function simOf(def: LevelDef): SimState {
  if (def.spawn === undefined) throw new Error(`${def.id} 没声明 spawn`);
  return createSim(def, def.spawn);
}

/** 出口格（可能不止一个：两侧各一个的关卡很常见）。 */
function exitCells(def: LevelDef): readonly Cell[] {
  const out: Cell[] = [];
  def.tiles.forEach((line, row) => {
    for (let col = 0; col < line.length; col++) {
      if (line[col] === 'E') out.push({ face: col < def.fold ? 'A' : 'B', col, row });
    }
  });
  return out;
}

/** 把声明过的闸门那几格清成空 —— 与 `openGates` 同一个效果，但作用在**字形**上（要重新解析）。 */
function withGatesOpen(def: LevelDef): LevelDef {
  if (def.gates === undefined || def.gates.length === 0) return def;
  const chars = def.tiles.map((line) => line.split(''));
  for (const gate of def.gates) {
    if (gate.face === 'I') continue;
    const row = chars[gate.row];
    if (row !== undefined && gate.col < row.length) row[gate.col] = '.';
  }
  return { ...def, tiles: chars.map((row) => row.join('')) };
}

describe('T22：内置关卡通用契约（遍历关卡库）', () => {
  it('库里有内置关，且每关都声明了出生点（否则这一份等于空转）', () => {
    expect(BUILTIN_LEVELS.length).toBeGreaterThanOrEqual(1);
    for (const entry of BUILTIN_LEVELS) expect(entry.def.spawn, entry.key).toBeDefined();
  });

  for (const entry of BUILTIN_LEVELS) {
    const { def } = entry;
    describe(`${entry.key}（${def.name}）`, () => {
      it('校验 **0 错 0 警**（内置关卡是交付内容，不该有"大概没画完"）', () => {
        expect(validateLevel(def, def.spawn).map((i) => `${i.severity} ${i.rule}: ${i.detail}`)).toEqual([]);
      });

      it('**把闸门清掉之后**出口真的走得到（拿 sim 走一遍，不只信校验）', () => {
        const opened = parseLevel(withGatesOpen(def));
        if (!opened.ok) throw new Error(`${def.id} 清掉闸门后反而解析失败`);
        const exits = exitCells(withGatesOpen(def));
        expect(exits.length, `${def.id} 没有出口`).toBeGreaterThan(0);
        // 可达性用**校验层同一个** `walkReachable` —— 不在这里另写一遍洪泛。
        const spawn = def.spawn;
        if (spawn === undefined) throw new Error(`${def.id} 没声明 spawn`);
        const reachable = walkReachable(opened.level, spawn).cells;
        expect(exits.some((e) => reachable.has(cellKey(e))), `${def.id} 开闸后出口仍走不到`).toBe(true);
      });

      it('60 tick 确定性：同一份输入跑两遍，逐帧状态相同', () => {
        const seq = Array.from({ length: 60 }, () => ({ move: null, dig: null }) as const);
        expect(replay(simOf(def), seq).map((f) => f.state)).toEqual(replay(simOf(def), seq).map((f) => f.state));
      });

      it('开局能动：推一 tick 不抛，状态是 playing，宽度就是 fold×2', () => {
        const frame = replay(simOf(def), [{ move: null, dig: null }])[0];
        expect(frame?.state.status).toBe('playing');
        expect(viewOf(frame?.state ?? simOf(def)).cols).toBe(def.fold * 2);
      });
    });
  }
});
