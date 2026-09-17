#!/usr/bin/env node
// 无头截图探针。
//
// 血泪要点：**必须带 `--headless=new`**。本机这版 Chrome 用老的 `--headless` 会
// 静默不产出文件，而 exit code 仍然是 0 —— 极易被误判成"改坏了"或"没问题"。
// 所以本脚本不信任 exit code，只认"文件真的存在、且体积合理"。
//
// 用法：
//   node tools/shot.mjs                        截图 dist-single/index.html（默认）
//   node tools/shot.mjs <url> [名称] [虚拟时间ms]   截图任意页面（如 dev server）
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'tools', 'out');
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const single = resolve(ROOT, 'dist-single', 'index.html');
const target = process.argv[2] ?? `file:///${single.replace(/\\/g, '/')}`;
const name = process.argv[3] ?? 'page';
const budget = process.argv[4] ?? '1200';
const out = resolve(OUT_DIR, `${name}.png`);

if (!existsSync(CHROME)) {
  console.error(`[shot] 找不到 Chrome：${CHROME}`);
  console.error('[shot] 用环境变量 CHROME_PATH=<路径> 指定。');
  process.exit(2);
}

mkdirSync(OUT_DIR, { recursive: true });
rmSync(out, { force: true });

const profile = resolve(OUT_DIR, `.chrome-${process.pid}`);
const args = [
  '--headless=new',
  '--disable-gpu',
  '--enable-unsafe-swiftshader',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  `--user-data-dir=${profile}`,
  '--window-size=1600,1000',
  `--virtual-time-budget=${budget}`,
  `--screenshot=${out}`,
  target,
];

const r = spawnSync(CHROME, args, { encoding: 'utf8' });
// 同 probe.mjs：清理是尽力而为。`force` 不抑制 EPERM，而这里紧跟 Chrome 退出，
// 子进程可能还没放开文件；吞掉这个瞬时错误，否则会盖掉截图本身的成败判断。
try {
  rmSync(profile, { recursive: true, force: true });
} catch (err) {
  if (err?.code !== 'EPERM') throw err;
}

// Chrome 会把 "N bytes written to file ..." 也写进 stderr，那是**成功**的信息。
// 所以只在真的失败时才回显 stderr —— 否则每次截图都会在 PowerShell 里冒一条刺眼的红字。
function stderrTail() {
  const tail = (r.stderr ?? '').trim().split('\n').slice(-4).join('\n');
  return tail;
}

if (!existsSync(out)) {
  console.error(`[shot] FAILED：Chrome 已退出但没产出文件（exit=${r.status ?? '?'}）`);
  console.error(`[shot] 目标：${target}`);
  const hint = stderrTail();
  if (hint) console.error(hint);
  process.exit(1);
}

const bytes = statSync(out).size;
if (bytes < 2000) {
  console.error(`[shot] FAILED：产物只有 ${bytes} 字节，基本是空白页。`);
  const hint = stderrTail();
  if (hint) console.error(hint);
  process.exit(1);
}

console.log(`[shot] OK → ${out}  (${bytes} bytes)   <- ${target}`);
