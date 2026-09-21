/* ============================================================
   程序化音频（WebAudio 合成，无外部音频文件）
   枪声采用「瞬态 + 枪体 + 尾音 + 房间混响」四层叠加
   ============================================================ */
import { clamp } from './util.js';

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.ready = false;
    this.master = null;
  }

  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const ctx = this.ctx = new AC();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.18;
    const master = this.master = ctx.createGain();
    master.gain.value = 0.85;
    master.connect(comp);
    comp.connect(ctx.destination);

    // 噪声缓冲（2 秒白噪声）
    const len = Math.floor(ctx.sampleRate * 2);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // 混响脉冲（城市街谷回声）
    const irLen = Math.floor(ctx.sampleRate * 1.5);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const dd = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) {
        const t = i / ctx.sampleRate;
        const decay = Math.exp(-t * 4.2);
        const early = (i < ctx.sampleRate * 0.09) ? 1.8 : 1;
        dd[i] = (Math.random() * 2 - 1) * decay * early * 0.5;
      }
    }
    this.conv = ctx.createConvolver();
    this.conv.buffer = ir;
    this.reverbIn = ctx.createGain();
    this.reverbIn.gain.value = 1;
    this.reverbIn.connect(this.conv);
    const rvOut = ctx.createGain();
    rvOut.gain.value = 0.42;
    this.conv.connect(rvOut);
    rvOut.connect(master);

    this.ready = true;
  }

  resume() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  setVolume(v) { if (this.master) this.master.gain.value = v; }

  /* -------------------------------------------------- 基础构件 */
  _noise(dur, { gain = 0.4, type = 'bandpass', freq = 1200, q = 1, sweepTo = null, attack = 0.001, curve = 3, dest = null, pan = 0, wet = 0 } = {}) {
    if (!this.ready || !this.enabled) return null;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 1;
    const flt = ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = freq;
    flt.Q.value = q;
    if (sweepTo) flt.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt); flt.connect(g);
    let out = g;
    if (pan) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p); out = p;
    }
    out.connect(dest || this.master);
    if (wet > 0) { const w = ctx.createGain(); w.gain.value = wet; out.connect(w); w.connect(this.reverbIn); }
    src.start(t);
    src.stop(t + dur + 0.02);
    return g;
  }

  _tone(freq, dur, { gain = 0.25, type = 'sine', sweepTo = null, attack = 0.001, dest = null, pan = 0, wet = 0 } = {}) {
    if (!this.ready || !this.enabled) return null;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (sweepTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, sweepTo), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    let out = g;
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); g.connect(p); out = p; }
    out.connect(dest || this.master);
    if (wet > 0) { const w = ctx.createGain(); w.gain.value = wet; out.connect(w); w.connect(this.reverbIn); }
    o.start(t);
    o.stop(t + dur + 0.02);
    return g;
  }

  _gainBus(vol) {
    const g = this.ctx.createGain();
    g.gain.value = vol;
    return g;
  }

  /* -------------------------------------------------- 枪声 */
  /** kind: 'scar' | 'ump'，dist 距离（自己射击为 0），pan 声道 */
  gunshot(kind = 'scar', dist = 0, pan = 0) {
    if (!this.ready || !this.enabled) return;
    const heavy = kind === 'scar';
    const att = dist > 0.5 ? 1 / (1 + dist / 14) : 1;
    const wet = dist > 0.5 ? clamp(0.25 + dist / 220, 0.2, 1.6) : 0.55;
    const bus = this._gainBus(att * (heavy ? 1.0 : 0.92));
    bus.connect(this.master);

    const bodyFreq = heavy ? 1500 : 2300;
    const thumpA = heavy ? 165 : 235;
    const thumpB = heavy ? 52 : 86;
    const bodyDur = heavy ? 0.155 : 0.105;

    // 1. 瞬态
    this._noise(0.012, { gain: 0.85, type: 'highpass', freq: 3200, q: 0.7, dest: bus, pan, wet: wet * 0.6 });
    // 2. 枪体
    this._noise(bodyDur, { gain: 0.75, type: 'lowpass', freq: bodyFreq, q: 0.9, sweepTo: bodyFreq * 0.22, dest: bus, pan, wet });
    this._noise(bodyDur * 0.7, { gain: 0.5, type: 'bandpass', freq: heavy ? 900 : 1400, q: 0.7, dest: bus, pan, wet: wet * 0.5 });
    // 3. 低频冲击
    this._tone(thumpA, heavy ? 0.14 : 0.09, { gain: 0.5, sweepTo: thumpB, type: 'sine', dest: bus, pan, wet: wet * 0.8 });
    // 4. 高频细节（机械感）
    this._noise(0.03, { gain: 0.3, type: 'bandpass', freq: heavy ? 2600 : 3600, q: 2.2, dest: bus, pan, wet: wet * 0.4 });
  }

  /** 敌人向玩家开火时的方位化枪声 */
  enemyShot(dist, pan, kind = 'scar') {
    this.gunshot(kind, dist, pan);
    if (dist < 40) this.whizby(clamp(dist / 40, 0.15, 1), pan > 0 ? 0.6 : -0.6);
  }

  /* -------------------------------------------------- 换弹 / 机构 */
  reloadStep(step, kind = 'scar') {
    if (!this.ready || !this.enabled) return;
    switch (step) {
      case 'magout':
        this._noise(0.10, { gain: 0.40, type: 'bandpass', freq: 2600, q: 1.4, sweepTo: 1200, wet: 0.2 });
        this._tone(320, 0.05, { gain: 0.10, type: 'square', sweepTo: 180 });
        break;
      case 'magdrop':
        this._noise(0.07, { gain: 0.28, type: 'bandpass', freq: 1800, q: 2, wet: 0.15 });
        break;
      case 'magin':
        this._noise(0.05, { gain: 0.42, type: 'bandpass', freq: 2200, q: 1.2, wet: 0.2 });
        this._tone(150, 0.10, { gain: 0.34, sweepTo: 70, type: 'sine' });
        break;
      case 'seat':
        this._tone(190, 0.07, { gain: 0.30, sweepTo: 95, type: 'triangle' });
        this._noise(0.04, { gain: 0.22, type: 'highpass', freq: 2400 });
        break;
      case 'bolt':
        this._noise(0.05, { gain: 0.55, type: 'bandpass', freq: 3400, q: 2.4, wet: 0.25 });
        setTimeout(() => this._noise(0.05, { gain: 0.45, type: 'bandpass', freq: 2500, q: 2.0, wet: 0.25 }), 55);
        break;
      case 'charge':
        this._noise(0.07, { gain: 0.5, type: 'bandpass', freq: 3000, q: 2.6, sweepTo: 1600, wet: 0.25 });
        break;
      case 'grab':
        this._noise(0.06, { gain: 0.22, type: 'lowpass', freq: 1400, sweepTo: 700 });
        break;
      case 'switch':
        this._noise(0.08, { gain: 0.30, type: 'bandpass', freq: 1800, q: 1.2, wet: 0.2 });
        this._tone(260, 0.06, { gain: 0.14, type: 'triangle' });
        break;
      default: break;
    }
  }

  dryFire() {
    this._noise(0.03, { gain: 0.45, type: 'bandpass', freq: 3600, q: 3 });
    this._tone(420, 0.03, { gain: 0.10, type: 'square' });
  }

  shellDrop() {
    this._tone(2400 + Math.random() * 900, 0.10, { gain: 0.09, type: 'sine', sweepTo: 1500 });
    this._noise(0.03, { gain: 0.10, type: 'highpass', freq: 4200 });
  }

  /* -------------------------------------------------- 伤害 / 命中 */
  hitmarker(head = false) {
    this._tone(head ? 1750 : 1150, head ? 0.075 : 0.05, { gain: head ? 0.22 : 0.15, type: 'triangle', sweepTo: head ? 900 : 780 });
    if (head) setTimeout(() => this._tone(2300, 0.07, { gain: 0.16, type: 'sine', sweepTo: 1400 }), 45);
  }
  kill() {
    this._tone(880, 0.10, { gain: 0.16, type: 'sine', sweepTo: 1320 });
    setTimeout(() => this._tone(1180, 0.12, { gain: 0.14, type: 'sine', sweepTo: 1580 }), 80);
  }
  hurt() {
    this._noise(0.20, { gain: 0.35, type: 'lowpass', freq: 700, sweepTo: 220 });
    this._tone(90, 0.16, { gain: 0.22, sweepTo: 55, type: 'sine' });
  }
  death() {
    this._noise(0.9, { gain: 0.4, type: 'lowpass', freq: 900, sweepTo: 120 });
    this._tone(120, 0.8, { gain: 0.25, sweepTo: 45, type: 'sine' });
  }

  /* -------------------------------------------------- 弹着 / 子弹掠过 */
  impact(kind, dist = 0) {
    const att = 1 / (1 + dist / 12);
    const bus = this._gainBus(att);
    bus.connect(this.master);
    const pan = 0;
    switch (kind) {
      case 'metal':
        this._noise(0.09, { gain: 0.5, type: 'bandpass', freq: 3000, q: 1.1, sweepTo: 900, dest: bus, pan, wet: 0.5 });
        this._tone(1800 + Math.random() * 700, 0.13, { gain: 0.16, type: 'triangle', sweepTo: 900, dest: bus, wet: 0.5 });
        break;
      case 'glass':
        this._noise(0.12, { gain: 0.25, type: 'highpass', freq: 4200, dest: bus, pan, wet: 0.4 });
        this._tone(3200, 0.10, { gain: 0.10, type: 'sine', sweepTo: 2600, dest: bus });
        break;
      case 'wood':
        this._noise(0.08, { gain: 0.45, type: 'bandpass', freq: 1100, q: 1.0, sweepTo: 420, dest: bus, pan, wet: 0.3 });
        break;
      case 'flesh':
        this._noise(0.07, { gain: 0.35, type: 'lowpass', freq: 620, sweepTo: 240, dest: bus, pan });
        break;
      default: // concrete / dirt
        this._noise(0.10, { gain: 0.45, type: 'lowpass', freq: 1600, sweepTo: 500, dest: bus, pan, wet: 0.35 });
        this._noise(0.05, { gain: 0.22, type: 'bandpass', freq: 2600, q: 1.6, dest: bus, pan });
        break;
    }
  }

  whizby(strength = 1, pan = 0) {
    this._noise(0.075, { gain: 0.30 * strength, type: 'bandpass', freq: 3400, q: 3.2, sweepTo: 620, pan, wet: 0.2 });
  }

  /* -------------------------------------------------- 脚步 / 移动 */
  footstep(surface = 'stone', strength = 1) {
    const cfg = {
      stone: { freq: 1500, q: 1.1, g: 0.16, d: 0.075 },
      concrete: { freq: 1200, q: 1.0, g: 0.17, d: 0.08 },
      metal: { freq: 2600, q: 2.0, g: 0.15, d: 0.09 },
      wood: { freq: 900, q: 1.4, g: 0.16, d: 0.075 },
      dirt: { freq: 700, q: 0.9, g: 0.14, d: 0.07 },
      water: { freq: 3200, q: 1.2, g: 0.18, d: 0.12 },
      grass: { freq: 2200, q: 0.8, g: 0.10, d: 0.09 },
    }[surface] || { freq: 1300, q: 1.0, g: 0.15, d: 0.08 };
    const jitter = 0.85 + Math.random() * 0.3;
    this._noise(cfg.d, { gain: cfg.g * strength * jitter, type: 'bandpass', freq: cfg.freq * jitter, q: cfg.q, sweepTo: cfg.freq * 0.4 });
    if (surface === 'metal' || surface === 'wood') {
      this._tone(cfg.freq * 0.5, 0.05, { gain: 0.05 * strength, type: 'triangle' });
    }
  }

  land(strength = 1) {
    this._noise(0.16, { gain: 0.30 * strength, type: 'lowpass', freq: 900, sweepTo: 200 });
    this._noise(0.06, { gain: 0.18 * strength, type: 'bandpass', freq: 1800, q: 1.2 });
  }

  jump() {
    this._noise(0.07, { gain: 0.14, type: 'bandpass', freq: 1400, q: 1.1 });
  }

  slide() {
    this._noise(0.5, { gain: 0.22, type: 'bandpass', freq: 2200, q: 0.6, sweepTo: 900 });
  }

  /* -------------------------------------------------- 爆炸 */
  explosion(dist = 0) {
    const att = 1 / (1 + dist / 22);
    const bus = this._gainBus(att);
    bus.connect(this.master);
    this._noise(1.3, { gain: 0.85, type: 'lowpass', freq: 420, q: 0.8, sweepTo: 70, dest: bus, wet: 1.6, attack: 0.004 });
    this._noise(0.12, { gain: 0.7, type: 'highpass', freq: 2000, dest: bus, wet: 0.8 });
    this._tone(70, 1.0, { gain: 0.5, sweepTo: 28, type: 'sine', dest: bus, wet: 1.2 });
  }

  /* -------------------------------------------------- 环境音 */
  ambientStart() {
    if (!this.ready || this.ambient) return;
    const ctx = this.ctx;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(this.master);
    master.gain.linearRampToValueAtTime(0.55, ctx.currentTime + 4);
    this.ambient = master;

    // 城市低频轰鸣
    const rumble = ctx.createBufferSource();
    rumble.buffer = this.noise; rumble.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320; lp.Q.value = 0.6;
    const rg = ctx.createGain(); rg.gain.value = 0.16;
    rumble.connect(lp); lp.connect(rg); rg.connect(master);
    rumble.start();

    // 风：带通噪声 + 慢速 LFO
    const wind = ctx.createBufferSource();
    wind.buffer = this.noise; wind.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 420; bp.Q.value = 0.5;
    const wg = ctx.createGain(); wg.gain.value = 0.10;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.055;
    lfo.connect(lfoG); lfoG.connect(wg.gain);
    wind.connect(bp); bp.connect(wg); wg.connect(master);
    wind.start(); lfo.start();

    // 高空电流/管线嗡鸣
    const hum = ctx.createOscillator();
    hum.type = 'sawtooth'; hum.frequency.value = 62;
    const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 180;
    const hg = ctx.createGain(); hg.gain.value = 0.012;
    hum.connect(hf); hf.connect(hg); hg.connect(master);
    hum.start();

    this._ambientTimer = 6;
  }

  ambientUpdate(dt) {
    if (!this.ambient) return;
    this._ambientTimer -= dt;
    if (this._ambientTimer > 0) return;
    this._ambientTimer = 9 + Math.random() * 22;
    const r = Math.random();
    if (r < 0.42) {
      // 远处汽车鸣笛
      const f = 300 + Math.random() * 200;
      const pan = (Math.random() - 0.5) * 1.6;
      this._tone(f, 0.42, { gain: 0.045, type: 'sawtooth', pan, wet: 0.8 });
      setTimeout(() => this._tone(f * 1.5, 0.28, { gain: 0.035, type: 'sawtooth', pan, wet: 0.8 }), 190);
    } else if (r < 0.62) {
      // 远处警笛
      const pan = (Math.random() - 0.5) * 1.6;
      for (let i = 0; i < 4; i++) {
        setTimeout(() => this._tone(700, 0.32, { gain: 0.030, type: 'sine', sweepTo: 1050, pan, wet: 0.9 }), i * 340);
      }
    } else if (r < 0.8) {
      // 金属碰撞 / 施工
      this._noise(0.25, { gain: 0.05, type: 'bandpass', freq: 1500, q: 1.4, pan: (Math.random() - 0.5) * 1.2, wet: 0.9 });
    } else {
      // 远处的枪声
      this.gunshot(Math.random() < 0.5 ? 'scar' : 'ump', 90 + Math.random() * 80, (Math.random() - 0.5) * 1.4);
    }
  }

  uiClick() {
    this._tone(900, 0.035, { gain: 0.10, type: 'square', sweepTo: 1300 });
  }
}
