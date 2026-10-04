import { PALETTE } from '../render/palette';

/**
 * **选关浮层**（玩家面向）。
 *
 * ## 为什么单独一个模块，而不是塞进 `editor.ts`
 *
 * 这两块面向**不同的人**：编辑器是给造关卡的人的（工具、JSON、校验），选关是给玩的人的
 * （一个列表、点一下）。混在一个文件里迟早会出现"玩家在选关面板上看到 JSON 文本框"这种事。
 * 它们共用的是**数据与动作**（库里的条目、`openLevel`），那两样都在 `main.ts` 里。
 *
 * ## 为什么还是 DOM，而不是画在 canvas 里
 *
 * 与编辑器同一个理由：文字按钮用 DOM 一行一个，`↑↓`/`Enter`/`Tab` 的键盘可达性是**白送**的
 * （真 `<button>`），画在 canvas 里这些都要自己写一遍。
 */

export interface SelectorEntry {
  /** 库里的槽键。 */
  readonly key: string;
  /** 列表上显示的名字。 */
  readonly label: string;
  /** 序号（从 1 起）—— 也对应数字键，让熟手不必用鼠标。 */
  readonly index: number;
  /** 这一关的"下一关"叫什么（没有就空）—— 显示在名字后面，让链一眼看得出来。 */
  readonly next: string;
}

export interface SelectorCallbacks {
  /** 选中某一关。**由调用方负责切关与关掉这个浮层**（见 `main.ts` 的 `pick`）。 */
  pick(key: string): void;
}

export interface Selector {
  readonly el: HTMLElement;
  open(entries: readonly SelectorEntry[], active: string): void;
  close(): void;
  isOpen(): boolean;
  dispose(): void;
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

const BORDER = `1px solid ${hex(PALETTE.edge)}`;

export function createSelector(host: HTMLElement, cb: SelectorCallbacks): Selector {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:none',
    'align-items:center',
    'justify-content:center',
    `background:${hex(PALETTE.bg)}d8`, // 半透明：看得见后面那一关，但读得清列表
    'z-index:20',
    'font:inherit',
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'min-width:320px',
    'max-height:80vh',
    'overflow:auto',
    'padding:14px 16px',
    `background:${hex(PALETTE.bg)}`,
    `border:${BORDER}`,
    `color:${hex(PALETTE.hard)}`,
    'display:flex',
    'flex-direction:column',
    'gap:6px',
  ].join(';');

  const title = document.createElement('div');
  title.textContent = '选关';
  title.style.cssText = 'font-weight:700;margin-bottom:2px';

  const note = document.createElement('div');
  note.textContent = '点一下，或按数字键；↑↓ + Enter 也行。（L 关闭）';
  note.style.cssText = 'opacity:.7;margin-bottom:6px';

  const list = document.createElement('div');
  list.style.cssText = 'display:flex;flex-direction:column;gap:4px';

  panel.append(title, note, list);
  el.appendChild(panel);
  host.appendChild(el);

  /** 让数字键与 `Esc` 都能用：`main.ts` 读它判断"浮层开着"。 */
  let open = false;

  return {
    el,
    open(entries, active): void {
      list.textContent = '';
      for (const entry of entries) {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.cssText = [
          'text-align:left',
          'padding:6px 10px',
          'font:inherit',
          'cursor:pointer',
          `color:${hex(PALETTE.hard)}`,
          `background:${entry.key === active ? hex(PALETTE.shell) : hex(PALETTE.bg)}`,
          `border:${BORDER}`,
          entry.key === active ? 'font-weight:700' : 'font-weight:400',
        ].join(';');
        const tail = entry.next === '' ? '' : `　→ ${entry.next}`;
        b.textContent = `${entry.index}. ${entry.label}${tail}`;
        b.addEventListener('click', () => cb.pick(entry.key));
        list.appendChild(b);
      }
      el.style.display = 'flex';
      open = true;
      // 聚焦第一个按钮：这样 `↑↓`/`Enter` 是**浏览器原生**的焦点移动，不必自己写一遍。
      const first = list.querySelector('button');
      if (first instanceof HTMLElement) first.focus();
    },
    close(): void {
      el.style.display = 'none';
      open = false;
    },
    isOpen: () => open,
    dispose(): void {
      el.remove();
    },
  };
}
