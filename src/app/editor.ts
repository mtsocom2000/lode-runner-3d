import { RULE_TITLES, type LevelIssue } from '../core/level/validate';
import type { Brush } from '../core/level/paint';
import type { Cell } from '../core/types';
import { cellKey } from '../core/types';
import type { LevelDef } from '../core/world/tiles';
import { PALETTE } from '../render/palette';

/**
 * **关卡编辑器面板**（T21，按 `Tab` 开关）。
 *
 * | 阶段 | 做了什么 |
 * |---|---|
 * | 1 | 存取 + 校验：JSON 摆出来、可导出/导入、校验清单列在旁边 |
 * | 2 | "应用" = **热重建**（不刷新页面） |
 * | 3 | **工具栏 + 在场景里点格子落笔**（本阶段的重点） |
 *
 * ## 落笔的判据不在这一层
 *
 * 点一下鼠标，实际发生三件事，各归各的层：
 *
 * 1. **命中点 → 格子**：`render/pick.ts`（纯几何，与摆位读同一组常量）；
 * 2. **格子 + 笔 → 新关卡**：`core/level/paint.ts`（纯函数，可单测）；
 * 3. **把新关卡画出来**：`main.ts` 的 `buildWorld`。
 *
 * 这个文件只负责**中间那件"用户选的是哪支笔"** —— 工具栏是 UI 状态，不是规则。
 * 所以它导出 `brush()` 让 main 在点击时来问，而不是自己去做落笔。
 *
 * ## 面板上必须显示"当前是哪一格"
 *
 * 折痕那一对（`A:fold-1` 与 `B:fold`）在世界里**重合**，拾取只能确定性地给一个。
 * 于是"我到底改到了哪一格"必须**看得见** —— 否则用户会遇到"我画的是这面墙、改的是那面墙"。
 */
export interface EditorCallbacks {
  /** 应用这段文本。返回 `null` = 成功；返回字符串 = 给用户看的错误。 */
  apply(text: string): string | null;
  /** 新建一张空白关卡（两面板墙 + 水面，别的都空）。 */
  createBlank(): void;
  /**
   * **试玩**：把这段文本应用掉，并**关掉编辑器** —— 于是"我画完了，想玩玩看"是一下点击。
   *
   * 返回 `null` = 成功；返回字符串 = 给用户看的错误。**出错时编辑器不关** ——
   * 否则刚写坏的 JSON 连改的地方都没了。
   */
  play(text: string): string | null;
  /**
   * **体检**：把这段文本当一张关卡查一遍，返回给人看的结论（一行一条）。
   *
   * 为什么查的是**文本框里的**而不是"已经生效的"：文本才是编辑面 —— 你可能刚手改完还没应用，
   * 也可能拖笔时刚画完。查它才能回答"我**现在写的**这张合不合法"，而不是"上一次应用的那张"。
   */
  check(text: string): readonly string[];
}

export interface Editor {
  readonly el: HTMLElement;
  /** 开关面板；返回打开与否。 */
  toggle(): boolean;
  isOpen(): boolean;
  /** 打开 / 落笔之后把当前关卡与校验结果灌进去。 */
  show(def: LevelDef, spawn: Cell | undefined, issues: readonly LevelIssue[]): void;
  /** 当前选中的笔（工具栏状态）。**落笔由调用方执行** —— 见文件头。 */
  brush(): Brush;
  /** 报告"刚刚点到哪一格 / 悬停在哪一格"（`null` = 没点到）。`diagnosis` = 关于这一格的一句话诊断。 */
  noteCell(cell: Cell | null, diagnosis?: string): void;
  dispose(): void;
}

/** 工具栏。顺序按"墙面 → 甲板 → 标记 → 橡皮"分组，与新用户的上手顺序一致。 */
const BRUSHES: readonly { readonly label: string; readonly hint: string; readonly brush: Brush }[] = [
  { label: '砖 X', hint: '可挖砖', brush: { kind: 'tile', glyph: 'X' } },
  { label: '硬砖 =', hint: '挖不动、挡路', brush: { kind: 'tile', glyph: '=' } },
  { label: '空 .', hint: '抹掉', brush: { kind: 'tile', glyph: '.' } },
  { label: '梯 H', hint: '梯子（上下爬）', brush: { kind: 'tile', glyph: 'H' } },
  { label: '杆 -', hint: '横杆（吊着走）', brush: { kind: 'tile', glyph: '-' } },
  { label: '芯片 G', hint: '墙上的宝物', brush: { kind: 'tile', glyph: 'G' } },
  { label: '出口 E', hint: '过关的门', brush: { kind: 'tile', glyph: 'E' } },
  { label: '板', hint: '甲板：实心方块（点方块顶面 = 往上叠一层）', brush: { kind: 'deck', mode: 'board' } },
  { label: '板·杆', hint: '甲板：可吊的横杆', brush: { kind: 'deck', mode: 'hang' } },
  { label: '板·梯', hint: '甲板：梯子格（实心柱靠它爬）', brush: { kind: 'deck', mode: 'ladder' } },
  { label: '出生点', hint: '玩家从这一格开始', brush: { kind: 'spawn' } },
  {
    label: '看守·无人机',
    hint: '巡逻无人机（只在墙面内活动，不会上岛）—— 点一次放、再点一次撤',
    brush: { kind: 'enemy', enemyKind: 'drone' },
  },
  {
    label: '看守·攀爬者',
    hint: '攀爬者（比玩家慢，但会上岛、也会吊杆）—— 点一次放、再点一次撤',
    brush: { kind: 'enemy', enemyKind: 'stalker' },
  },
  { label: '宝物', hint: '甲板上的宝物（再点一次收走）', brush: { kind: 'treasure' } },
  { label: '橡皮', hint: '墙上抹成空、甲板上删格', brush: { kind: 'erase' } },
];

/** 数字色值 → `#rrggbb`（与 `hud.ts` 同一个口径）。 */
function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

const BORDER = `1px solid ${hex(PALETTE.edge)}`;

export function createEditor(host: HTMLElement, cb: EditorCallbacks): Editor {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'inset:0 0 0 auto',
    'width:min(520px, 42vw)',
    'z-index:10',
    'display:none',
    'flex-direction:column',
    'gap:6px',
    'padding:10px 12px',
    'font-size:12px',
    'line-height:1.5',
    `color:${hex(PALETTE.hard)}`,
    `background:${hex(PALETTE.bg)}f2`,
    `border-left:${BORDER}`,
    'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
  ].join(';');
  host.appendChild(el);

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px';
  const title = document.createElement('strong');
  title.textContent = '关卡编辑器';
  const spacer = document.createElement('span');
  spacer.style.cssText = 'flex:1';
  const hint = document.createElement('span');
  hint.textContent = '（Tab 关闭）';
  head.append(title, spacer, hint);

  /** "当前是哪一格" —— 折痕那一对重合，这条必须看得见。 */
  const cellLine = document.createElement('div');
  cellLine.style.cssText = 'opacity:.85';

  const toolbar = document.createElement('div');
  toolbar.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap';

  const notes = document.createElement('div');
  notes.style.cssText = `max-height:20vh;overflow:auto;padding:6px 8px;border:${BORDER};white-space:pre-wrap`;

  const area = document.createElement('textarea');
  area.spellcheck = false;
  area.style.cssText = [
    'flex:1',
    'min-height:30vh',
    'resize:none',
    'padding:8px',
    'font:inherit',
    `color:${hex(PALETTE.hard)}`,
    `background:${hex(PALETTE.bg)}`,
    `border:${BORDER}`,
  ].join(';');

  const bar = document.createElement('div');
  bar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';

  const button = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = [
      'padding:4px 10px',
      'font:inherit',
      'cursor:pointer',
      `color:${hex(PALETTE.hard)}`,
      `background:${hex(PALETTE.bg)}`,
      `border:${BORDER}`,
    ].join(';');
    b.addEventListener('click', onClick);
    return b;
  };

  // ── 工具栏：选中态靠背景色，不引入新色（`shell` 是现成的一档灰） ──
  let index = 0;
  const brushButtons = BRUSHES.map((entry, i) => {
    const b = button(entry.label, () => select(i));
    b.title = entry.hint;
    b.style.minWidth = '52px';
    toolbar.appendChild(b);
    return b;
  });
  const select = (i: number): void => {
    index = i;
    brushButtons.forEach((b, k) => {
      b.style.background = k === i ? hex(PALETTE.shell) : hex(PALETTE.bg);
      b.style.fontWeight = k === i ? '700' : '400';
    });
    cellLine.textContent = `笔：${BRUSHES[i]?.label ?? '?'} —— ${BRUSHES[i]?.hint ?? ''}`;
  };
  select(0);

  const applyBtn = button('应用并重载', () => {
    const error = cb.apply(area.value);
    if (error !== null) setNotes([`✗ ${error}`]);
  });
  const blankBtn = button('新建空白关卡', () => cb.createBlank());
  const playBtn = button('试玩（关掉编辑器）', () => {
    const error = cb.play(area.value);
    if (error !== null) setNotes([`✗ ${error}`]);
  });
  /**
   * 体检：**只报告、不改动**（与「应用」分开）。
   *
   * 编辑过程中关卡长期不合法，所以"合法"这件事必须能**随时问一次** —— 而不是等到应用之后
   * 从 HUD 角落里看出来。结论直接铺在下面的清单区里（通过时也写一句，免得空着看不出跑没跑）。
   */
  const checkBtn = button('校验是否合法', () => {
    setNotes(cb.check(area.value));
  });
  const exportBtn = button('导出 JSON', () => {
    const blob = new Blob([area.value], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${defId(area.value)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = '.json,application/json';
  importInput.style.display = 'none';
  importInput.addEventListener('change', () => {
    const file = importInput.files?.[0];
    if (file === undefined) return;
    void file.text().then((text) => {
      area.value = text;
      setNotes(['已读入文件 —— 按「应用并重载」生效']);
    });
    importInput.value = '';
  });
  const importBtn = button('导入 JSON…', () => importInput.click());

  bar.append(applyBtn, playBtn, checkBtn, blankBtn, exportBtn, importBtn, importInput);
  el.append(head, cellLine, toolbar, notes, area, bar);

  const setNotes = (lines: readonly string[]): void => {
    notes.replaceChildren();
    lines.forEach((line, i) => {
      if (i > 0) notes.appendChild(document.createElement('br'));
      notes.appendChild(document.createTextNode(line));
    });
  };

  let open = false;
  return {
    el,
    isOpen: () => open,
    toggle(): boolean {
      open = !open;
      el.style.display = open ? 'flex' : 'none';
      return open;
    },
    show(def, spawn, issues): void {
      area.value = JSON.stringify(def, null, 2);
      const errors = issues.filter((i) => i.severity === 'error');
      const warns = issues.filter((i) => i.severity === 'warn');
      // **错误与提醒分开数**（用户的追问："这些红框我都不认为是非法的"）：
      // "玩不了"和"大概没画完"混在一句"N 条问题"里，就没有轻重了。
      const summary =
        issues.length === 0
          ? '校验：通过'
          : `校验：${errors.length} 个错误${warns.length > 0 ? `、${warns.length} 条提醒` : ''}（都不阻止你继续编辑）`;
      const lines: string[] = [
        `关卡 ${def.id}「${def.name}」 · ${def.tiles[0]?.length ?? 0}×${def.tiles.length} · fold=${def.fold}`,
        `出生点 ${spawn === undefined ? '（没声明）' : `${spawn.face}:${spawn.col},${spawn.row}`}`,
        summary,
        // 场景里**红框 = 错误、灰框 = 提醒**（见 `render/fx.ts`），与这里的记号一一对应。
        ...issues.map((i) => `  ${i.severity === 'error' ? '✗' : '⚠'} ${RULE_TITLES[i.rule]}：${i.detail}`),
      ];
      setNotes(lines);
    },
    brush: () => BRUSHES[index]?.brush ?? { kind: 'erase' },
    noteCell(cell, diagnosis): void {
      const which = BRUSHES[index]?.label ?? '?';
      if (cell === null) {
        cellLine.textContent = `笔：${which} —— 未指到格子`;
        return;
      }
      const where = `格子 ${cellKey(cell)}${cell.level === undefined ? '' : `（第 ${cell.level} 层）`}`;
      // 诊断一句话（站得住吗 / 为什么）—— 用户的追问"我实在不明白哪里全空"要的就是它：
      // `A:13,1` 这种记号对人不直观，但"**脚下 A:13,0 是空的**"是可直接行动的。
      cellLine.textContent =
        diagnosis === undefined ? `笔：${which} ｜ ${where}` : `笔：${which} ｜ ${where} —— ${diagnosis}`;
    },
    dispose(): void {
      el.remove();
    },
  };
}

/** 导出文件名：尽量用关卡 id，读不出来就叫 `level`。 */
function defId(text: string): string {
  try {
    const raw = JSON.parse(text) as { id?: unknown };
    return typeof raw.id === 'string' && raw.id !== '' ? raw.id : 'level';
  } catch {
    return 'level';
  }
}
