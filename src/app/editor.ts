import type { LevelIssue } from '../core/level/validate';
import type { Cell } from '../core/types';
import type { LevelDef } from '../core/world/tiles';
import { PALETTE } from '../render/palette';

/**
 * **关卡编辑器面板**（T21，按 `Tab` 开关）。
 *
 * ## 这一版只做"存取 + 校验"，不做落笔
 *
 * 阶段 1 的目标是让关卡**能从外面进来**：把 `LevelDef` 的 JSON 摆在一个能改的地方，
 * 改完按"应用"就重载成那一关；同时把 `validateLevel` 的结果**列在旁边**。
 * 有了这个，用户今天就能手写/粘贴关卡并立刻看到它 —— 而"在 3D 场景里点格子落笔"
 * 是阶段 3 的事（射线拾取 + 工具栏）。
 *
 * ## 为什么"应用"是**重载页面**而不是热替换
 *
 * 场景是模块加载时**一次性**建起来的（`createStage(level)`），要热替换就得先做"关卡一换、
 * 场景重建"那件事 —— 那是阶段 2。在那之前，重载是最诚实的做法：**它不会假装已经生效**，
 * 也不会把半旧的场景留在屏幕上。
 *
 * ## 校验是**提示**，不是闸门
 *
 * 编辑过程中关卡必然长期处于"还不合法"的状态（没出口、出生点悬空……）。所以这里只**列出来**，
 * 绝不阻止应用 —— 阻止的话就没法边改边看了。
 */
export interface EditorCallbacks {
  /** 应用这段文本。返回 `null` = 成功（调用方负责重载）；返回字符串 = 给用户看的错误。 */
  apply(text: string): string | null;
  /** 新建一张空白关卡（两面板墙 + 水面，别的都空）。 */
  createBlank(): void;
}

export interface Editor {
  readonly el: HTMLElement;
  /** 开关面板；返回打开与否。 */
  toggle(): boolean;
  isOpen(): boolean;
  /** 打开时把当前关卡与校验结果灌进去。 */
  show(def: LevelDef, spawn: Cell | undefined, issues: readonly LevelIssue[]): void;
  dispose(): void;
}

/** 数字色值 → `#rrggbb`（与 `hud.ts` 同一个口径，理由见那边）。 */
function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function createEditor(host: HTMLElement, cb: EditorCallbacks): Editor {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'inset:0 0 0 auto', // 贴右边一整条
    'width:min(560px, 46vw)',
    'z-index:10',
    'display:none',
    'flex-direction:column',
    'gap:8px',
    'padding:10px 12px',
    'font-size:12px',
    'line-height:1.5',
    `color:${hex(PALETTE.hard)}`,
    `background:${hex(PALETTE.bg)}f2`,
    `border-left:1px solid ${hex(PALETTE.edge)}`,
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

  /** 校验清单 / 错误行。两者共用一块，谁有话说谁显示。 */
  const notes = document.createElement('div');
  notes.style.cssText = `max-height:22vh;overflow:auto;padding:6px 8px;border:1px solid ${hex(PALETTE.edge)};white-space:pre-wrap`;

  const area = document.createElement('textarea');
  area.spellcheck = false;
  area.style.cssText = [
    'flex:1',
    'min-height:40vh',
    'resize:none',
    'padding:8px',
    'font:inherit',
    `color:${hex(PALETTE.hard)}`,
    `background:${hex(PALETTE.bg)}`,
    `border:1px solid ${hex(PALETTE.edge)}`,
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
      `border:1px solid ${hex(PALETTE.edge)}`,
    ].join(';');
    b.addEventListener('click', onClick);
    return b;
  };

  const applyBtn = button('应用并重载', () => {
    const error = cb.apply(area.value);
    if (error !== null) setNotes([`✗ ${error}`]);
  });
  const blankBtn = button('新建空白关卡', () => cb.createBlank());
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

  bar.append(applyBtn, blankBtn, exportBtn, importBtn, importInput);
  el.append(head, notes, area, bar);

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
      const lines: string[] = [
        `关卡 ${def.id}「${def.name}」 · ${def.tiles[0]?.length ?? 0}×${def.tiles.length} · fold=${def.fold}`,
        `出生点 ${spawn === undefined ? '（没声明）' : `${spawn.face}:${spawn.col},${spawn.row}`}`,
        issues.length === 0 ? '校验：通过' : `校验：${issues.length} 条问题（不阻止你继续编辑）`,
        ...issues.map((i) => `  · [${i.rule}] ${i.detail}`),
      ];
      setNotes(lines);
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
