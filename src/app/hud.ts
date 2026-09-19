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
  /**
   * 短暂的大字提示（死亡 / 终局）。传 `null` 收掉。
   *
   * 为什么需要它：`drowned` / `buried` / `gameover` 在**同一个 tick 内**就把状态改完了
   * （扣命、重生回起点、或终局），画面上除了"命数少 1"没有任何可见事件 —— 用户的原话是
   * "死了以后至少应该有个短暂的 UI 提示或者过渡，好知道死了"。
   * 事件流里早就有这些钩子（`sim.ts` 的 `SimEvent`），这里只是把它们显示出来。
   */
  flash(text: string | null): void;
  /**
   * 运行时日志（用户 2026-09-19 要的）：一行一行往下加，只留最近 `LOG_LINES` 行。
   *
   * 存在的理由：**非预期的错误必须看得见**。只往 `console` 里报，等于没报 —— 而用户看到的是
   * 一个"行为有点怪但还在跑"的画面，没有任何线索。所以它和 HUD 面板一样是屏幕上的一块。
   *
   * 记什么由调用方决定（`main.ts`）：JS 异常、未处理的 Promise、关卡校验问题、
   * 以及 sim 事件里值得注意的那几种。
   */
  log(text: string): void;
}

/** 日志面板保留的行数。多了会盖住画面；少了不够查。 */
const LOG_LINES = 7;

/**
 * 主面板的最大宽度（px）。用户 2026-09-19 报"太宽了、挡场景" —— 那几行教学提示很长，
 * 不限宽时面板会横着铺出去。320 是"最长那行换行后仍读得顺"与"别侵占画面"之间取的。
 */
const PANEL_WIDTH = 320;

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
    'padding:7px 10px',
    // 2px 而不是 8px：参照图的语汇是平涂 CAD，没有大圆角。
    'border-radius:2px',
    'font-size:11.5px',
    'line-height:1.6',
    'letter-spacing:.02em',
    // **限宽**（用户 2026-09-19："面板太宽了，挡了一点场景"）。
    // 那几行教学提示很长，没有宽度约束时面板会横着铺到屏幕中间去。
    // 限宽 + 自动换行 = 面板站在左边一条，挡住的东西少得多。
    `max-width:${PANEL_WIDTH}px`,
    'white-space:normal',
    'overflow-wrap:anywhere',
    `color:${hex(PALETTE.hard)}`,
    `background:${hex(PALETTE.bg)}${PANEL_ALPHA}`,
    `border:1px solid ${hex(PALETTE.edge)}`,
    'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
  ].join(';');
  host.appendChild(el);

  // 大字提示：居中、单行、与面板同族的配色（色值一律从 `PALETTE` 派生，理由见文件头）。
  // 默认 `display:none` —— 平时它对画面零影响。
  const banner = document.createElement('div');
  banner.style.cssText = [
    'position:fixed',
    'top:36%',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:3',
    'pointer-events:none',
    'padding:10px 22px',
    'border-radius:2px',
    'font-size:26px',
    'letter-spacing:.14em',
    'font-weight:600',
    `color:${hex(PALETTE.hard)}`,
    `background:${hex(PALETTE.bg)}${PANEL_ALPHA}`,
    `border:1px solid ${hex(PALETTE.edge)}`,
    'font-family:"PingFang SC","Microsoft YaHei",system-ui,sans-serif',
    'display:none',
  ].join(';');
  host.appendChild(banner);

  // 运行时日志面板：贴在左下角（主面板在左上）。等宽字体 —— 里面会出现键名、坐标、事件名，
  // 对齐了才好扫。默认**空的也占位**吗？不：没有日志时它整块 `display:none`，对画面零影响。
  const logEl = document.createElement('div');
  logEl.style.cssText = [
    'position:fixed',
    'bottom:12px',
    'left:14px',
    'z-index:2',
    'pointer-events:none',
    'padding:6px 9px',
    'border-radius:2px',
    'font-size:11px',
    'line-height:1.5',
    'letter-spacing:.01em',
    `max-width:${PANEL_WIDTH}px`,
    'white-space:pre-wrap',
    'overflow-wrap:anywhere',
    `color:${hex(PALETTE.hard)}`,
    `background:${hex(PALETTE.bg)}${PANEL_ALPHA}`,
    `border:1px solid ${hex(PALETTE.edge)}`,
    'font-family:ui-monospace,SFMono-Regular,Consolas,monospace',
    'display:none',
  ].join(';');
  host.appendChild(logEl);

  /** 最近 `LOG_LINES` 行。留着的理由：面板只画这么高，旧的滚掉才看得见新的。 */
  let logLines: readonly string[] = [];

  return {
    set(lines: readonly string[]): void {
      el.replaceChildren();
      lines.forEach((line, i) => {
        if (i > 0) el.appendChild(document.createElement('br'));
        el.appendChild(document.createTextNode(line));
      });
    },
    flash(text: string | null): void {
      if (text === null) {
        banner.style.display = 'none';
        banner.replaceChildren();
        return;
      }
      banner.textContent = text;
      banner.style.display = 'block';
    },
    log(text: string): void {
      logLines = [...logLines, text].slice(-LOG_LINES);
      logEl.replaceChildren();
      logLines.forEach((line, i) => {
        if (i > 0) logEl.appendChild(document.createElement('br'));
        logEl.appendChild(document.createTextNode(line));
      });
      logEl.style.display = 'block';
    },
  };
}
