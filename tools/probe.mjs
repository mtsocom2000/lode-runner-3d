#!/usr/bin/env node
// 像素探针：让页面**自己** readPixels，再用 `--dump-dom` 把结论抠回来。
//
// 为什么不直接分析 PNG：Node 没有内置 PNG 解码，为一次探针引依赖不值；
// 而且页面侧的 `gl.readPixels` 拿到的是**渲染真值**，比截图再解回来更直接。
//
// 页面侧只在 `?probe=1` 时才做这件（正常玩不付开销），结果写进 `<pre id="probe">`，
// 内容是 `PROBE:{...}` 一行 JSON。
//
// 同 shot.mjs 的血泪教训：**必须带 `--headless=new`**（老 `--headless` 会静默什么都不产出）。
//
// 用法：
//   node tools/probe.mjs                     探针 dist-single/index.html（默认）
//   node tools/probe.mjs <url>               探针任意页面（如 http://localhost:5173/）
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const single = resolve(ROOT, 'dist-single', 'index.html');
const base =
  process.argv[2] ?? (existsSync(single) ? `file:///${single.replace(/\\/g, '/')}` : null);

if (base === null) {
  console.error('[probe] 找不到 dist-single/index.html —— 先跑 `npm run pack`（或 `npm run probe`）。');
  process.exit(2);
}
if (!existsSync(CHROME)) {
  console.error(`[probe] 找不到 Chrome：${CHROME}`);
  console.error('[probe] 用环境变量 CHROME_PATH=<路径> 指定。');
  process.exit(2);
}

const target = `${base}${base.includes('?') ? '&' : '?'}probe=1`;
const profile = resolve(ROOT, 'tools', 'out', `.chrome-probe-${process.pid}`);

const r = spawnSync(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--enable-unsafe-swiftshader',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    '--window-size=1600,1000',
    '--virtual-time-budget=4000',
    '--dump-dom',
    target,
  ],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
// 清理 profile 是**尽力而为**，绝不能遮蔽结果。
//
// 实测（2026-09-17）：Windows 上 Chrome 的子进程有时会晚一步释放这些文件，而
// `rmSync` 的 `force` **只**抑制 ENOENT、**不**抑制 EPERM。它就排在解析/打印之前，
// 于是一次清理失败会把整份探针结果吞掉 —— 表现为"probe 一个字都没输出"。
// 结果比垃圾重要，所以只吞这一个已知的瞬时错误；其它错误照抛（别把真问题一起藏了）。
// 残留目录无害：名字带 pid，下一次运行不会复用。
try {
  rmSync(profile, { recursive: true, force: true });
} catch (err) {
  if (err?.code !== 'EPERM') throw err;
}

const dom = r.stdout ?? '';
const m = /PROBE:(\{[\s\S]*?\})<\/pre>/.exec(dom);
if (!m) {
  console.error('[probe] FAILED：页面里没有探针结果（`?probe=1` 没生效？页面报错了？）');
  const hint = (r.stderr ?? '').trim().split('\n').slice(-5).join('\n');
  if (hint) console.error(hint);
  process.exit(1);
}

let summary;
try {
  summary = JSON.parse(m[1]);
} catch {
  console.error('[probe] FAILED：探针结果不是合法 JSON。');
  console.error(m[1].slice(0, 400));
  process.exit(1);
}

const failures = [];

if (summary.counts?.brick > 0) {
  // ok
} else {
  failures.push(`场景里一块砖都没有（counts=${JSON.stringify(summary.counts)}）`);
}

// 色相特征：每类"只有一种东西会满足它的色相"，所以为 false 就说明那类物件没画出来。
//
// **只在关卡真的声明了那类物件时才断言。** 一开始这里把五个特征全写死成必须为 true ——
// 那在旧关卡上碰巧成立（它什么都有），但概念最简关卡里根本没有横杆与数据芯片，
// 于是会报"横杆没画出来"这种**误报**。判据用 `counts`（真的建了几个 mesh），
// 不用关卡字符串：计数是渲染层自己的账，与色相判定同源。
//
// `player` 永远断言 —— 角色不在"关卡可选内容"里。
const EXPECTED_FEATURES = [
  { feature: 'bar', count: 'bar', meaning: '横杆 / 连杆' },
  { feature: 'exit', count: 'exit', meaning: '出口' },
  // 注：`cyan` 这一档现在只对应**数据芯片**。梯与折痕线在新配色里改成了钢灰/中性 slate，
  // 不再是青色 —— 调色板一改，这条规则与它就必须一起改（见 palette.ts 的契约说明）。
  { feature: 'cyan', count: 'chip', meaning: '数据芯片' },
  { feature: 'prize', count: 'prize', meaning: '岛台宝物' },
  // 实体（T12）：`counts` 里这一项来自 `syncer.counts()`（渲染层真正建了几个实体），
  // 所以"关卡声明了无人机 ⇒ 画面上必须有无人机"这条是**两端各自记账**的核对。
  { feature: 'drone', count: 'drone', meaning: '巡逻无人机' },
  { feature: 'stalker', count: 'stalker', meaning: '潜伏攀爬者' },
];
for (const { feature, count, meaning } of EXPECTED_FEATURES) {
  const declared = (summary.counts?.[count] ?? 0) > 0;
  if (!declared) continue; // 关卡里没有这类物件，不断言
  if (summary.features?.[feature] !== true) {
    failures.push(`关卡里有${meaning}，但画面上没有（feature=${feature}, counts.${count}=${summary.counts?.[count]}）`);
  }
}
if (summary.features?.player !== true) failures.push('画面上没有角色（feature=player）');

// "白块"回归：未著色的实例默认是白的，一旦出现说明实例色没写进去。
if (typeof summary.whiteRatio !== 'number' || summary.whiteRatio > 0.05) {
  failures.push(`近白像素占比 ${summary.whiteRatio} —— 超过 5%，疑似白块`);
}

// **背景色回归**（T21）：画面里**占比最大**的那一档必须够亮。
//
// 背景（`PALETTE.bg`）、砖、水面都是浅色，所以"最大的一档是近黑"只可能意味着一件事：
// **背景被擦掉了**。真实事故：泛光在**创建时**抓走了 `scene.background`，而那时它还是 `null`
// —— 于是它每帧都把背景设成空，用户看到的就是"场景背景变成黑色了"。
//
// 那条 bug 当时**没被探针拦住**（规则只查"有没有玩家 / 有没有砖 / 白块"），而它恰恰是
// **产物级**的：源码全对，是渲染管线的时序错了。所以这条补在这里，用产物验。
const top = (summary.dominant ?? [])[0];
if (top !== undefined) {
  const r = parseInt(top.hex.slice(1, 3), 16);
  const g = parseInt(top.hex.slice(3, 5), 16);
  const b = parseInt(top.hex.slice(5, 7), 16);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (!(luma > 100)) {
    failures.push(`画面占比最大的一档是 ${top.hex}（亮度 ${luma.toFixed(0)}）—— 太暗，背景多半被擦掉了`);
  }
}

// ── 位置对账：分两层，别混为一谈 ──
//
// ① 代码级（必须严）：`meshSync` 真正写进 mesh 的位置，必须**就是** `playerAnchor` 算出的那个点。
//    这一条直接回答"锚点被用上了没有" —— 单测只能证明锚点算得对，证明不了它被用上。
// ② 像素级（较松）：画面上那一坨的重心应当落在算出的点附近。它同时受采样步长、抗锯齿
//    与遮挡影响，所以容差取"半个身位"；两层分开报，出错时才能一眼看出是哪一层。
if ((summary.sim?.entities ?? 0) > 0) {
  const expect = summary.playerExpect;
  const seen = summary.centroids?.player;

  if (!expect || !expect.mesh) {
    failures.push(`没能读到 mesh 的实际位置（playerExpect=${JSON.stringify(expect)}）`);
  } else {
    const meshDist = Math.hypot(expect.mesh.x - expect.x, expect.mesh.y - expect.y);
    console.log(`[probe] ① mesh 位置 vs playerAnchor：差 ${meshDist.toFixed(2)}px（要求 < 1.5）`);
    if (!(meshDist < 1.5)) {
      failures.push(`meshSync 用的位置与 playerAnchor 差了 ${meshDist.toFixed(2)}px —— 锚点没被用上`);
    }
  }

  if (!seen) {
    failures.push('画面上量不到角色像素（centroids.player 缺失）');
  } else {
    // ② 像素级：**只打印，不断言**。
    //
    // 历史：旧的"紧色盒"规则下，重心离算出位置 ~10.4px、外接框 ~30×12（一条横带），
    // 而完整立方体投影应约 37×28 —— 当时记为"身体上半截没画出来，原因**未查明**"。
    //
    // **现在可以结案了（首选解释）。** 判据换成"通道差"（见 `probe.ts` 的 `player`：
    // 紧必须紧在**不变量**上）之后，同一帧的重心差降到 **0.85px**、框 84×51（含外发光壳），
    // 且 ① 仍为 0.00px。所以"缺了上半截"最可能是**旧规则的筛选偏差** —— 只认"正好等于 C"
    // 的像素，于是只捞到混合最少的那一条带 —— 而不是渲染真的少了半截身体。
    // 要推翻它，需要一张"角色像素明显偏向一侧"的图。
    //
    // 不设为失败：一条自己解释不清的断言当门禁，只会变成迟早被放宽到无意义的假测试。
    // 真正的硬证据是 ①（0.00px）。这里把数字留在日志里。
    const dist = Math.hypot(seen.x - expect.x, seen.y - expect.y);
    const [x0, y0, x1, y1] = seen.bbox;
    console.log(
      `[probe] ② 角色像素（诊断，不断言）：算出 (${expect.x.toFixed(1)}, ${expect.y.toFixed(1)})` +
        ` ｜ 重心 (${seen.x.toFixed(1)}, ${seen.y.toFixed(1)} / ${seen.count} 点)` +
        ` ｜ 框 ${x1 - x0 + 1}×${y1 - y0 + 1}@(${x0},${y0}) ｜ 差 ${dist.toFixed(2)}px`,
    );
  }
}

console.log(`[probe] 画布 ${summary.size?.[0]}×${summary.size?.[1]}，采样 ${summary.sampled} 点`);
console.log(`[probe] 几何：${JSON.stringify(summary.counts)}`);
console.log(`[probe] 特征：${JSON.stringify(summary.features)}  近白占比 ${summary.whiteRatio}`);
console.log('[probe] 主导色（量化 5 位/通道）：');
for (const d of (summary.dominant ?? []).slice(0, 8)) {
  console.log(`         ${d.hex}  ${d.count}`);
}

if (failures.length > 0) {
  console.error('[probe] FAILED：');
  for (const f of failures) console.error(`         - ${f}`);
  process.exit(1);
}

console.log('[probe] OK');
