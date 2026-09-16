import { PALETTE } from '../render/palette';

/**
 * 极简 HUD。
 *
 * 刻意**不引入 React** —— 理由见架构文档 §5.1：v1 的 UI 复杂度就是"宝物 n/m、命数、
 * 出口状态"这几个数字，手写 DOM 足够；引入框架只会多出一套要和 sim state 同步的状态，
 * 而"两套数据不一致"恰恰是本项目历次 bug 的共同病因。
 *
 * ## 颜色从 `PALETTE` 派生，不是硬编码（这是修过一次的 bug）
 *
 * 第一版的 HUD 是**深色面板**（`#cfe3f4` 浅蓝字配 `rgba(10,16,24,.84)` 近黑底）——
 * 那是深蓝科技风时期的取值。换成浅色极简配色之后**它被落下了**：一屏浅灰几何体里，
 * 这个近黑方块成了全画面对比度最高的东西，眼睛先看 UI 而不是关卡。用户的原话是
 * "HUD 深色面板是全画面对比度最高的东西，抢主体"。
 *
 * 所以这一版不仅换成浅底，还把**根因**一起修掉：色值不再硬编码，而是从 `PALETTE`
 * 派生。硬编码才是真正的病 —— 只要它还自己留一套颜色，下次换配色就会重新掉队一次。
 *
 * ## 压进背景语汇，但不能压到不可读
 *
 * 目标是"几何体才是画面上最暗和最亮的东西"，所以：
 *
 * - 底色用 `PALETTE.bg`（和页面底、场景底同一个色）再带 80% alpha —— 面板与背景同族，
 *   只靠一层半透明把自己"贴"在画面上，而不是盖一个方块上去；
 * - 描边用 `PALETTE.edge` 的 1px 细线，不用填充；
 * - 文字用 `PALETTE.hard`（可挖/不可挖那条分界用的暗端，约 95 级亮度）。
 *   它与 `bg` 的对比度约 **5.7:1**，正文可读性达到 WCAG AA 的 4.5:1 —— 这一条是硬约束，
 *   不能为了"不抢戏"把字调到看不清。
 *
 * 唯一**不能**通用的常量是 `alpha`：`PALETTE` 里全是不透明色，透明度是 DOM 层的语义
 * （"这层面板浮在画面上"），场景里没有对应概念。
 */
export interface Hud {
  set(lines: readonly string[]): void;
}

/** 数字色值 → DOM 能用的 `#rrggbb`。`PALETTE` 存的是 0xRRGGBB，DOM 要字符串。 */
function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

/**
 * 面板底色的不透明度。
 * 太透 → 落在深色几何体上时字看不清；太实 → 又变成一块盖住画面的方块。
 * 0.8 是在"读得清"与"融得进"之间取的。
 */
const PANEL_ALPHA = 'cc'; // 16 进制 0xcc ≈ 80%

export function createHud(host: HTMLElement): Hud {
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed',
    'top:12px',
    'left:14px',
    'z-index:2',
    'pointer-events:none',
    'padding:8px 12px',
    // 2px 而不是 8px：参照图的语汇是平涂 CAD，没有大圆角。
    'border-radius:2px',
    'font-size:12px',
    'line-height:1.65',
    'letter-spacing:.02em',
    `color:${hex(PALETTE.hard)}`,
    `background:${hex(PALETTE.bg)}${PANEL_ALPHA}`,
    `border:1px solid ${hex(PALETTE.edge)}`,
    'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
  ].join(';');
  host.appendChild(el);

  return {
    set(lines: readonly string[]): void {
      el.replaceChildren();
      lines.forEach((line, i) => {
        if (i > 0) el.appendChild(document.createElement('br'));
        el.appendChild(document.createTextNode(line));
      });
    },
  };
}
