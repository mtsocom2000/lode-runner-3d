/**
 * 音效（2026-09-19 起的第一件：**挖空处的"咔哒空响"**）。
 *
 * ## 为什么是合成而不是素材
 *
 * 全项目零素材文件（`dist-single/index.html` 是单文件产物，塞音频进去要么膨胀、要么多出
 * 一个要管的二进制品）。而这一声的全部内容就是"一个极短的、不悦耳的、没有音高的咔哒" ——
 * 一个振荡器 + 一条衰减包络就能表达，还顺手省掉了"素材路径"这种只在浏览器里才失效的东西。
 *
 * ## 浏览器的自动播放限制
 *
 * `AudioContext` 在用户操作之前是 `suspended` 的。这不是问题：**这一声只可能由按键触发**，
 * 而按键本身就是那个"用户操作"。所以这里懒创建上下文、并在每次发声前 `resume()` 一次，
 * 不去猜"什么时候用户才算交互过"。
 *
 * ## 不能因为它而炸掉游戏
 *
 * 任何一步（构造上下文、创建节点）都可能在不支持的环境里抛异常 —— 而"挖了空处没有声音"
 * 远算不上值得让整局游戏停下的错误。所以全部包在 `try` 里，失败就静默降级成"没有音效"。
 */
export interface Sfx {
  /** 挖了空处的一声短促空响。 */
  dryFire(): void;
}

/**
 * 两次空响之间的最短间隔（秒）。
 *
 * 存在的理由：`digBlocked` 是**电平**事件（按住不放每 tick 报一次），不节流的话
 * 每 16ms 叠一声，听起来是一段嗡鸣而不是"咔哒"。
 */
const DRY_FIRE_MIN_GAP = 0.12;

/** 一声空响的长度（秒）。用户要的是"清脆短促"。 */
const DRY_FIRE_SECONDS = 0.07;

export function createSfx(): Sfx {
  let ctx: AudioContext | null = null;
  /** 上一次发声的上下文时间。0 = 还没发过。 */
  let lastAt = Number.NEGATIVE_INFINITY;

  function context(): AudioContext | null {
    if (ctx !== null) return ctx;
    try {
      ctx = new AudioContext();
    } catch {
      return null; // 没有 WebAudio（或不允许）：静默降级
    }
    return ctx;
  }

  return {
    dryFire(): void {
      const audio = context();
      if (audio === null) return;
      try {
        if (audio.state === 'suspended') void audio.resume();
        const now = audio.currentTime;
        if (now - lastAt < DRY_FIRE_MIN_GAP) return;
        lastAt = now;

        // 一个方波从 190Hz 快速掉到 90Hz：没有音高感、只有"撞在硬东西上"的质感。
        const osc = audio.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(190, now);
        osc.frequency.exponentialRampToValueAtTime(90, now + DRY_FIRE_SECONDS);

        const gain = audio.createGain();
        // 起手就压得很低（0.06）：这是"哑火"，不该盖过任何东西。
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.0005, now + DRY_FIRE_SECONDS);

        osc.connect(gain).connect(audio.destination);
        osc.start(now);
        osc.stop(now + DRY_FIRE_SECONDS);
      } catch {
        // 同上：反馈的失败不该升级成游戏错误。
      }
    },
  };
}
