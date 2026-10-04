import { describe, expect, it } from 'vitest';
import { bridgesOf, createSim, NO_INTENTS, tick } from '../src/core/sim';
import { L1 } from '../src/core/level/levels/l1';
import { L2 } from '../src/core/level/levels/l2';
import { L3 } from '../src/core/level/levels/l3';
import { cellA } from './fixtures';

/**
 * **T22：60fps 的 CPU 余量**（sim 那一半）。
 *
 * 渲染成本随 GPU、分辨率、泛光而变，在无头环境里给不出普适结论（探针跑在虚拟时钟下，
 * `performance.now()` 根本不前进 —— 那条只能靠真浏览器里的 HUD 读数看）。但**规则层的
 * 每 tick 成本**是可以在真实时间里量的，而且它才是"关卡一大就卡"最常见的来源。
 *
 * ## 阈值故意取得很松（1000 tick < 300ms，即 0.3ms/tick）
 *
 * 实测大约 0.05ms/tick，所以这里有 **5 倍以上**余量。**故意不卡紧**：一条在慢机器/CI 上
 * 偶发变红的性能测试，比没有更坏 —— 它会训练人忽略红色。这条要拦的是**数量级**的退化
 * （比如每 tick 里塞了一次全图 BFS、或敌人列表变成每个 tick 重建），不是 20% 的浮动。
 *
 * 参照：60Hz 下每帧预算 16.7ms，`loop` 一帧最多补 4 个 tick（`MAX_CATCHUP_MS`）——
 * 就算按 0.3ms/tick 算也才 1.2ms，余量充足。
 */
const TICKS = 1000;
const BUDGET_MS = 300;

function costPerTick(kind: string, def: typeof L1): number {
  const spawn = def.spawn ?? cellA(0, 1);
  let state = createSim(def, spawn);
  // 先跑几 tick 热身（首次 `bridgesOf`、实体表分配、JIT 预热）—— 与 `meshSync` 的
  // `WORK_WARMUP_FRAMES` 同一个理由：一次性成本不该算进每帧成本。
  for (let i = 0; i < 50; i++) {
    state = tick(state, NO_INTENTS).state;
    void bridgesOf(state);
  }
  const t0 = performance.now();
  for (let i = 0; i < TICKS; i++) {
    const frame = tick(state, NO_INTENTS);
    state = frame.state;
    void bridgesOf(state); // 同步层每帧都会读它 —— 把它算进来才是真实成本
  }
  const per = (performance.now() - t0) / TICKS;
  expect(per, `${kind}：每 tick ${per.toFixed(3)}ms（预算 ${BUDGET_MS / TICKS}ms）`).toBeLessThan(
    BUDGET_MS / TICKS,
  );
  return per;
}

describe('T22：sim 每 tick 的 CPU 成本（60fps 余量的那一半）', () => {
  for (const [name, def] of [
    ['L1（含无人机）', L1],
    ['L2（含攀爬者 + 塔）', L2],
    ['L3（含长杆 + 四层柱）', L3],
  ] as const) {
    it(`${name}：${TICKS} tick 的每 tick 成本在预算内（0.3ms）`, () => {
      expect(costPerTick(name, def)).toBeGreaterThan(0); // 真跑过（防止将来被写成空循环）
    });
  }
});
