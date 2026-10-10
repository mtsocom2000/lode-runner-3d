import { BLANK } from '../core/level/levels/blank';
import { BARS } from '../core/level/levels/bars';
import { CORRIDOR } from '../core/level/levels/corridor';
import { RING } from '../core/level/levels/ring';
import { ZIGZAG } from '../core/level/levels/zigzag';
import { LADDER_CITY } from '../core/level/levels/ladderCity';
import { POLE_FOREST } from '../core/level/levels/poleForest';
import { L2 } from '../core/level/levels/l2';
import { L3 } from '../core/level/levels/l3';
import { parseLevel, type LevelDef, type LoadError } from '../core/world/tiles';

/**
 * **关卡的保存与加载**（T21 编辑器）。
 *
 * 用户的原话：*"有了编辑器，你就不要考虑场景生成的问题，而需要考虑场景的保存和加载。"*
 * 所以这个模块只管一件事：**关卡数据怎么出去、怎么回来** —— 纯函数，不碰 DOM、不碰 three，
 * 于是可以直接单测（而"存了读不回来"正是这类功能最经典的 bug）。
 *
 * ## 为什么是 JSON 而不是继续用 `tiles: string[]` 那套紧凑写法
 *
 * `tiles` 的行字符串是**人写**的格式（一行 28 个字符，在编辑器里对齐很好看）；
 * 而存档要的是**完整**：甲板三态（板 / 杆 / 梯子）、层、接头、闸门、宝物、敌人、出生点。
 * 那些在字符串里没有位置，硬塞进去会造出一套只有本仓库看得懂的方言。
 * 所以存档 = `LevelDef` 的 JSON —— 字段名与代码里的一模一样，出问题时肉眼就能查。
 *
 * ## 加载**必须**先过 `parseLevel`
 *
 * 与 `main.ts` 里那句"数据不合法就没有'渲染一个关'这回事"同一条纪律：
 * 一个字符合法的 JSON 不代表一张合法的关卡。字形层不合法（行长不齐、出现不认识的字符、
 * `fold` 与列数对不上）就地拒绝，并把人话写进 `error`。
 */
export const LEVEL_STORAGE_KEY = 'loderunner.level';

/** 关卡 → 文本。带缩进，便于粘贴、diff、肉眼看。 */
export function encodeLevel(def: LevelDef): string {
  return JSON.stringify(def, null, 2);
}

export type DecodeResult = { readonly ok: true; readonly def: LevelDef } | { readonly ok: false; readonly error: string };

/** 文本 → 关卡。任何一步不合法都返回 `{ ok: false }`，**不抛异常**（调用方是 UI）。 */
export function decodeLevel(text: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `不是合法 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '顶层必须是一个对象（一张关卡）' };
  }

  const def = raw as Partial<LevelDef>;
  if (typeof def.id !== 'string' || def.id === '') return { ok: false, error: '缺少 id' };
  if (typeof def.name !== 'string') return { ok: false, error: '缺少 name' };
  if (typeof def.fold !== 'number') return { ok: false, error: '缺少 fold（每面列数）' };
  if (!Array.isArray(def.tiles)) return { ok: false, error: '缺少 tiles（字形行数组）' };

  const parsed = parseLevel(def as LevelDef);
  if (!parsed.ok) return { ok: false, error: `字形层不合法：${describe(parsed.errors)}` };
  return { ok: true, def: def as LevelDef };
}

/** `LoadError` → 人话（编辑器面板上直接显示这一串）。 */
function describe(errors: readonly LoadError[]): string {
  return errors
    .map((e) => {
      switch (e.kind) {
        case 'noRows':
          return '一行字形都没有';
        case 'ragged':
          return `第 ${e.row} 行有 ${e.got} 个字符，应为 ${e.expected} 个`;
        case 'badChar':
          return `第 ${e.row} 行第 ${e.col} 列的字符「${e.ch}」不认识`;
        case 'foldMismatch':
          return `fold=${e.fold} 要求 ${e.fold * 2} 列，实际 ${e.cols} 列`;
      }
    })
    .join('；');
}

/**
 * 从浏览器存储读草稿。**读不到、读坏了都返回 `null`** —— 编辑器要能在一个坏草稿之后照常打开，
 * 而不是白屏。
 */
export function loadStoredLevel(storage: Storage | null = safeStorage()): LevelDef | null {
  if (storage === null) return null;
  let text: string | null;
  try {
    text = storage.getItem(LEVEL_STORAGE_KEY);
  } catch {
    return null;
  }
  if (text === null) return null;
  const decoded = decodeLevel(text);
  return decoded.ok ? decoded.def : null;
}

/** 存草稿。存不进去（隐私模式、配额满）就静默放弃 —— 那是"没存上"，不该让编辑器崩。 */
export function storeLevel(def: LevelDef, storage: Storage | null = safeStorage()): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(LEVEL_STORAGE_KEY, encodeLevel(def));
    return true;
  } catch {
    return false;
  }
}

export function clearStoredLevel(storage: Storage | null = safeStorage()): void {
  try {
    storage?.removeItem(LEVEL_STORAGE_KEY);
  } catch {
    // 同上：清不掉不是错误。
  }
}

/** `localStorage` 在某些环境（无 DOM、隐私模式）取不到 —— 取不到就当没有存储。 */
function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * **关卡库**（T21 #3）：命名槽。
 *
 * ## 为什么要它
 *
 * 在这之前只有一个存档位（`LEVEL_STORAGE_KEY`）—— 用户"新建一关"就等于**扔掉上一关**。
 * 他的原话是"这关不救了，我新建了一关"。库把这件事分开：每张图有自己的**槽键**，
 * 切关卡只换 `active`，谁都不会被谁顶掉。
 *
 * ## 内置三关也是库里的条目
 *
 * `L1/L2/L3` 初始化时**写进库里**，之后一视同仁（可改、可删、可以被 `next` 指向）——
 * 于是"内置"与"我画的"不再需要两套代码路径。用户想留住原版就把 L3 复制一份再改。
 *
 * ## 迁移：老的单槽**不能丢**
 *
 * 用户正在画的那一关就在老键里。首次加载时把它**作为一个条目并进库**，并设为 active ——
 * 升级不该让任何人丢掉手上那一张图。
 */
export const LIBRARY_STORAGE_KEY = 'loderunner.library';

/**
 * **内置关名册的版本号**（T22）。每往 `BUILTIN_LEVELS` 里加/改关卡就 +1。
 *
 * 为什么：关卡库一旦存进浏览器，**老用户的那份库里没有新关卡** —— 名册更新了，他却永远
 * 看不到（除非清缓存）。所以在库里记一个 `seedVersion`：加载时若它落后于当前版本，
 * 就把**新版内置关合并进去**（保留用户自建的那些），再把版本号升上来。迁移只发生一次。
 *
 * - **1**：库刚诞生时的六关（corridor/bars/ring/zigzag/l2/l3）；
 * - **2**：加入「梯城」「杆林」（T22 名册补齐）。
 */
export const SEED_VERSION = 2;

export interface StoredLevel {
  /** 槽键。**与关卡 `id` 无关**：两张图可以同名，槽不能。 */
  readonly key: string;
  readonly def: LevelDef;
}

export interface LevelLibrary {
  readonly active: string;
  readonly levels: readonly StoredLevel[];
  /**
   * 这份库写盘时对应的内置关名册版本（见 `SEED_VERSION`）。缺省 = 老库（当作 `0`/`1`），
   * 加载时会被迁移。`loadLibrary` 返回的这份**一定**是当前版本。
   */
  readonly seedVersion?: number;
}

/** 新槽的键。用时间戳 + 随机尾巴：可读、又不至于撞车。 */
export function newLevelKey(): string {
  return `level:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 内置关卡当作初始条目（见文件头）。
 *
 * **`next` 在这里补上**（而不是写进 `l1.ts` / `l2.ts` 本身）：链指向的是**槽键**
 * （`builtin:l2`），而槽键是库的概念 —— 关卡文件不该知道"我在库里的第几个槽"。
 * 于是内置三关天然串成 L1 → L2 → L3。
 */
export const BUILTIN_LEVELS: readonly StoredLevel[] = [
  // 新名册（T22）：先六张"没有中央台子"的关卡，从教学关「走廊」开始；
  // 最后两张是甲板篇（用户 2026-10-04 定：放在做好的关后面）。
  // 链（`next`）按名册顺序接。
  { key: 'builtin:corridor', def: { ...CORRIDOR, next: 'builtin:bars' } },
  { key: 'builtin:bars', def: { ...BARS, next: 'builtin:ring' } },
  { key: 'builtin:ring', def: { ...RING, next: 'builtin:zigzag' } },
  { key: 'builtin:zigzag', def: { ...ZIGZAG, next: 'builtin:laddercity' } },
  { key: 'builtin:laddercity', def: { ...LADDER_CITY, next: 'builtin:poleforest' } },
  { key: 'builtin:poleforest', def: { ...POLE_FOREST, next: 'builtin:l2' } },
  { key: 'builtin:l2', def: { ...L2, next: 'builtin:l3' } },
  { key: 'builtin:l3', def: L3 },
];

function isEntry(v: unknown): v is StoredLevel {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as { key?: unknown; def?: unknown };
  return typeof e.key === 'string' && typeof e.def === 'object' && e.def !== null;
}

/**
 * 读库。**任何异常都退回"内置 + 老单槽"的种子**，绝不抛（与 `loadStoredLevel` 同一条纪律：
 * 编辑器打不开比"读不到上次那一关"严重得多）。
 */
export function loadLibrary(storage: Storage | null = safeStorage()): LevelLibrary {
  const legacy = loadStoredLevel(storage);
  const seed = (): LevelLibrary => {
    const levels = [...BUILTIN_LEVELS];
    if (legacy !== null) levels.push({ key: 'migrated', def: legacy });
    // **老单槽用户上来先看到他那一关**（与旧行为一致：打开就是上次那张）。
    // **新用户从第一关开始**（它是教学关）—— 旧行为是"最新那一关"，那是开发顺序，不是上手顺序。
    return { active: legacy !== null ? 'migrated' : 'builtin:corridor', levels, seedVersion: SEED_VERSION };
  };
  if (storage === null) return seed();
  const raw = storage.getItem(LIBRARY_STORAGE_KEY);
  if (raw === null) return seed();
  try {
    const parsed = JSON.parse(raw) as { active?: unknown; levels?: unknown; seedVersion?: unknown };
    if (!Array.isArray(parsed.levels)) return seed();
    const stored = parsed.levels.filter(isEntry);
    if (stored.length === 0) return seed();

    // **名册迁移**（`SEED_VERSION`）：落后就把新版内置关并进库，用户自建的那几张原样留着。
    const version = typeof parsed.seedVersion === 'number' ? parsed.seedVersion : 0;
    const levels = version < SEED_VERSION ? mergeSeed(stored) : stored;
    const active =
      typeof parsed.active === 'string' && levels.some((e) => e.key === parsed.active)
        ? parsed.active
        : (levels[0]?.key ?? 'builtin:corridor');
    const lib: LevelLibrary = { active, levels, seedVersion: SEED_VERSION };
    // 迁移**写回**，否则每次加载都重来一遍（版本号也就失去意义了）。
    if (version < SEED_VERSION) saveLibrary(lib, storage);
    return lib;
  } catch {
    return seed();
  }
}

/**
 * 把新版内置关**合并**进一份老库（见 `SEED_VERSION`）。
 *
 * 规则：**内置关整块按当前名册重排在前**（这样 `next` 链、选关序号都是新的），
 * **非内置的条目**（用户自建、以及老单槽迁移来的 `migrated`）保持原来的相对顺序接在后面。
 *
 * 代价说清楚：**内置关本身会被刷新** —— 用户若直接改过某张内置关，那次改动会在这里被当前版本覆盖。
 * 这是刻意的（内置关是随版本走的交付内容）；想留住自己那版，就在编辑器里**复制一份**再改。
 */
function mergeSeed(stored: readonly StoredLevel[]): readonly StoredLevel[] {
  const builtinKeys = new Set(BUILTIN_LEVELS.map((e) => e.key));
  const mine = stored.filter((e) => !builtinKeys.has(e.key));
  return [...BUILTIN_LEVELS, ...mine];
}

export function saveLibrary(lib: LevelLibrary, storage: Storage | null = safeStorage()): boolean {
  if (storage === null) return false;
  try {
    // 落盘就代表"这份库是当前版本的" —— 统一补上 `seedVersion`，免得某个构造点漏了它、
    // 下次加载又被当成老库迁移一遍。
    storage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify({ ...lib, seedVersion: SEED_VERSION }));
    return true;
  } catch {
    return false;
  }
}

/** 写一个槽（没有就加）。返回**新**库，不改入参。 */
export function upsertLevel(lib: LevelLibrary, key: string, def: LevelDef): LevelLibrary {
  const rest = lib.levels.filter((e) => e.key !== key);
  return { active: key, levels: [...rest, { key, def }] };
}

/**
 * 删一个槽。**最后一关删不掉**（留一个空白的）—— 库里一个条目都没有的状态，
 * 面板、`active`、开局全都要各写一遍"那怎么办"，不如让它不可能发生。
 */
export function removeLevel(lib: LevelLibrary, key: string): LevelLibrary {
  const levels = lib.levels.filter((e) => e.key !== key);
  if (levels.length === 0) return { active: lib.active, levels: [{ key: 'blank', def: BLANK }] };
  const active = levels.some((e) => e.key === lib.active) ? lib.active : (levels[0]?.key ?? 'blank');
  return { active: active === key ? (levels[0]?.key ?? 'blank') : active, levels };
}

export function levelByKey(lib: LevelLibrary, key: string): StoredLevel | null {
  return lib.levels.find((e) => e.key === key) ?? null;
}