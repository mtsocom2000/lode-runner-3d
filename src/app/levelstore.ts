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
