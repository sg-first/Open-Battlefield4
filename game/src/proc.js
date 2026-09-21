/* ============================================================
   程序化材质
   导出里有一部分资产既没有可用 UV 也没有材质绑定（waterfront_01、
   office_lshape、datacenter、hotel lobby 等），这里用
   「世界尺度重投影 UV + 程序化立面贴图 + 三平面着色」还原可信的建筑外观。

   设计要点（与旧实现的差异）：
   1. 贴图按「世界单位 / 次循环」设计（tile），不再依赖资产自带 UV 的密度，
      因此不会出现立面图案被压成噪点的"花屏"。
   2. 噪声全部可平铺：频率取整数且按网格周期取模，消除平铺接缝。
   3. 不再叠加逐像素白噪声颗粒，风化只用低频 fbm，幅度收敛到 ±5/255。
   4. 法线贴图由「结构化高度图」（窗框/砖缝/板缝）卷积得到，
      而不是对噪声求梯度——后者会产生高频闪烁。
   ============================================================ */
import * as THREE from 'three';
import { makeRNG, lerp, clamp, makeCanvas } from './util.js';

/* ---------------------------------------------------------- 分类 */
export function pickMatKind(name) {
  const n = name.toLowerCase();
  if (/(glass|window|skybarwindow|facadeglass)/.test(n)) return 'glass';
  if (/(skyscraper|tower|highrise|office|waterfront|hotel|datacenter|building|bd_|residential)/.test(n)) return 'glass';
  if (/(brick|backstreets|shanty)/.test(n)) return 'brick';
  if (/(metal|girder|pipe|cable|rail|antenna|vent|duct|container|crate)/.test(n)) return 'metal';
  if (/(statue|marble|stone|lantern|fountain|plaza|artwork|stair|sidewalk|kerb|curb)/.test(n)) return 'stone';
  if (/(plaster|stucco)/.test(n)) return 'plaster';
  if (/(wall|cement|concrete|foundation|pillar|archway|garage)/.test(n)) return 'concrete';
  return 'concrete';
}

/**
 * 世界尺度：一张贴图覆盖多少世界单位。
 * tile[0] = U 方向（水平），tile[1] = V 方向（竖直）。
 * 玻璃的 20.5 与 BF4 楼层模块高度（20.484）对齐，
 * 使堆叠式塔楼各层的窗格在竖向自然连续。
 */
export const PROC = {
  glass: { tile: [20.5, 20.5], roughness: 0.22, metalness: 0.42, env: 1.15, flat: '#39424c' },
  concrete: { tile: [9.0, 9.0], roughness: 0.92, metalness: 0.02, env: 0.35, flat: '#8d8b85' },
  metal: { tile: [8.0, 8.0], roughness: 0.50, metalness: 0.60, env: 0.85, flat: '#52565b' },
  brick: { tile: [4.0, 4.0], roughness: 0.95, metalness: 0.00, env: 0.30, flat: '#8a5b47' },
  stone: { tile: [6.0, 6.0], roughness: 0.88, metalness: 0.03, env: 0.42, flat: '#9a968d' },
  plaster: { tile: [10.0, 10.0], roughness: 0.93, metalness: 0.02, env: 0.33, flat: '#a8a396' },
};

/** 法线强度（越高凹凸越明显） */
const NRM_STRENGTH = { glass: 1.5, concrete: 1.1, metal: 1.0, brick: 1.7, stone: 1.3, plaster: 0.6 };

/* ---------------------------------------------------------- 可平铺噪声 */
/**
 * 周期性值噪声。采样坐标走满 `freq * grid`，而取值按 grid 取模，
 * 因此 freq 为整数时左右/上下边界天然连续（可平铺）。
 */
function periodicNoise(seed, grid) {
  const rng = makeRNG(seed);
  const g = new Float32Array(grid * grid);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const at = (x, y) => g[(((y % grid) + grid) % grid) * grid + (((x % grid) + grid) % grid)];
  const sm = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), u), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u), v);
  };
  return (u, v, freq) => sm(u * freq * grid, v * freq * grid);
}

function periodicFbm(seed, octaves, freq) {
  const grid = 32;
  const layers = [];
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const f = freq * (1 << o);
    layers.push({ n: periodicNoise(seed + o * 977, grid), f });
    norm += 1 / f;
  }
  return (u, v) => {
    let s = 0;
    for (const l of layers) s += (l.n(u, v, l.f) - 0.5) / l.f;
    return s / norm;
  };
}

/** 低频 fbm 场：先在 res 分辨率求值再双线性放大，避免逐像素跑多个八度 */
function fbmField(size, seed, octaves, freq, res = 192) {
  const f = periodicFbm(seed, octaves, freq);
  const small = new Float32Array(res * res);
  for (let y = 0; y < res; y++) {
    for (let x = 0; x < res; x++) small[y * res + x] = f(x / res, y / res) * 2;
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const fy = (y / size) * res, y0 = Math.floor(fy), ty = fy - y0, y1 = (y0 + 1) % res;
    for (let x = 0; x < size; x++) {
      const fx = (x / size) * res, x0 = Math.floor(fx), tx = fx - x0, x1 = (x0 + 1) % res;
      const a = lerp(small[y0 * res + x0], small[y0 * res + x1], tx);
      const b = lerp(small[y1 * res + x0], small[y1 * res + x1], tx);
      out[y * size + x] = lerp(a, b, ty);
    }
  }
  return out;
}

/** 叠加低频风化：只改变大块明暗，不产生颗粒噪点 */
function applyFbm(ctx, size, seed, amp, mono = false) {
  const f1 = fbmField(size, seed, 3, 4);
  const f2 = fbmField(size, seed + 7717, 2, 12);
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0, n = size * size; i < n; i++) {
    const w = f1[i] * amp + f2[i] * amp * 0.4;
    const p = i * 4;
    if (mono) {
      const t = clamp(d[p] + w, 0, 255);
      d[p] = d[p + 1] = d[p + 2] = t;
      d[p + 3] = 255;
    } else {
      d[p] = clamp(d[p] + w, 0, 255);
      d[p + 1] = clamp(d[p + 1] + w, 0, 255);
      d[p + 2] = clamp(d[p + 2] + w * 0.92, 0, 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}

/* ---------------------------------------------------------- 绘制辅助 */
// 生成过程中会反复 getImageData / putImageData，显式声明可避免走 GPU 回读路径
const CTX_OPT = { willReadFrequently: true };
const gray = (v) => `rgb(${v | 0},${v | 0},${v | 0})`;

function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) * k, 0, 255) | 0;
  const g = clamp(((n >> 8) & 255) * k, 0, 255) | 0;
  const b = clamp((n & 255) * k, 0, 255) | 0;
  return `rgb(${r},${g},${b})`;
}

function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const r = Math.round(lerp((pa >> 16) & 255, (pb >> 16) & 255, t));
  const g = Math.round(lerp((pa >> 8) & 255, (pb >> 8) & 255, t));
  const c = Math.round(lerp(pa & 255, pb & 255, t));
  return `rgb(${r},${g},${c})`;
}

/** 跨边界补齐绘制，保证平铺时接缝处图案完整 */
function tileRect(ctx, x, y, w, h, size, fill) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  if (x < 0) ctx.fillRect(x + size, y, w, h);
  if (x + w > size) ctx.fillRect(x - size, y, w, h);
  if (y < 0) ctx.fillRect(x, y + size, w, h);
  if (y + h > size) ctx.fillRect(x, y - size, w, h);
}

/** 单元格确定性随机（0..1），同一格在每次生成中保持一致 */
function cellHash(a, b, seed) {
  let h = Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(seed + 1, 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/* ---------------------------------------------------------- 高度图 → 法线 */
/**
 * 由结构化高度图卷积出切线空间法线（边缘环绕取样，可平铺）。
 * 分辨率变化时按 size/256 补偿斜率，保证不同尺寸下凹凸强度一致。
 */
function heightToNormal(heightCanvas, strength) {
  const size = heightCanvas.width;
  const src = heightCanvas.getContext('2d', CTX_OPT).getImageData(0, 0, size, size).data;
  const h = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) h[i] = src[i * 4] / 255;

  const out = makeCanvas(size, size);
  const g = out.getContext('2d', CTX_OPT);
  const img = g.createImageData(size, size);
  const s = strength * (size / 256);
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1) + size) % size, yp = (y + 1) % size;
    for (let x = 0; x < size; x++) {
      const xm = ((x - 1) + size) % size, xp = (x + 1) % size;
      const dx = (h[y * size + xp] - h[y * size + xm]) * 0.5;
      const dy = (h[yp * size + x] - h[ym * size + x]) * 0.5;
      const nx = -dx * s, ny = dy * s;      // 画布 y 向下 → v 向上，故 ny 取 +dy
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      img.data[i] = (nx * inv * 0.5 + 0.5) * 255;
      img.data[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      img.data[i + 2] = (inv * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return out;
}

/* ---------------------------------------------------------- 玻璃幕墙 */
const GLASS_STYLES = [
  { frame: '#8f9aa2', span: '#2a3238', hi: '#7ea6c4', mid: '#233442', lo: '#101a22', warm: '#ffd6a0' },
  { frame: '#b2b2ac', span: '#34343a', hi: '#b9c3c8', mid: '#3a4046', lo: '#16181c', warm: '#ffe2b0' },
  { frame: '#a89272', span: '#3a3228', hi: '#d6c3a4', mid: '#4a4234', lo: '#1e1a14', warm: '#ffcf8e' },
  { frame: '#7d8a8c', span: '#232c2e', hi: '#86b3ad', mid: '#1e2e2e', lo: '#0d1414', warm: '#ffd9a8' },
];

function makeGlassFacade(size, nsize, variant) {
  const c = makeCanvas(size, size), g = c.getContext('2d', CTX_OPT);
  const hc = makeCanvas(nsize, nsize), gh = hc.getContext('2d', CTX_OPT);
  const mc = makeCanvas(nsize, nsize), gm = mc.getContext('2d', CTX_OPT);
  const st = GLASS_STYLES[variant % GLASS_STYLES.length];
  const k = nsize / size;

  const cols = 5, rows = 5;                 // 20.5 世界单位 = 5 跨 × 5 层 → 每格 4.1
  const cw = size / cols, ch = size / rows;
  const mullX = Math.max(2.5, cw * 0.06);
  const mullY = Math.max(2.5, ch * 0.05);
  const spH = ch * 0.30;                    // 窗下墙（楼板实体）

  g.fillStyle = st.span; g.fillRect(0, 0, size, size);
  gh.fillStyle = gray(120); gh.fillRect(0, 0, nsize, nsize);
  gm.fillStyle = gray(0); gm.fillRect(0, 0, nsize, nsize);

  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const x = q * cw + mullX * 0.5;
      const y = r * ch + mullY * 0.5;
      const w = cw - mullX;
      const hh = ch - mullY - spH;
      const hv = cellHash(q, r, variant * 31 + 7);
      const lit = hv < 0.075;
      const bright = 0.88 + hv * 0.26;
      // 夜间点亮概率（与昼间亮度取值解耦，形成零散点亮的窗格）
      const on = cellHash(q, r, variant * 31 + 91);
      const lvl = (lit || on < 0.10) ? 250 : (on < 0.46 ? 96 : 0);

      const gd = g.createLinearGradient(x, y, x + w * 0.25, y + hh);
      if (lit) {
        gd.addColorStop(0, shade(st.warm, bright * 1.06));
        gd.addColorStop(0.45, shade(st.warm, bright * 0.90));
        gd.addColorStop(1, shade(st.warm, bright * 0.68));
      } else {
        gd.addColorStop(0, shade(st.hi, bright));
        gd.addColorStop(0.22, shade(st.mid, bright * 1.14));
        gd.addColorStop(0.62, shade(st.mid, bright * 0.84));
        gd.addColorStop(1, shade(st.lo, bright));
      }
      g.fillStyle = gd;
      g.fillRect(x, y, w, hh);
      gh.fillStyle = gray(lit ? 92 : 88);
      gh.fillRect(x * k, y * k, w * k, hh * k);
      gm.fillStyle = gray(lvl);
      gm.fillRect(x * k, y * k, w * k, hh * k);

      // 中竖挺：一跨分两块玻璃，远看形成高密度办公窗格
      const mx = x + w * 0.5 - mullX * 0.3;
      g.fillStyle = st.frame;
      g.fillRect(mx, y, mullX * 0.6, hh);
      gh.fillStyle = gray(212);
      gh.fillRect(mx * k, y * k, mullX * 0.6 * k, hh * k);
      gm.fillStyle = gray(0);
      gm.fillRect(mx * k, y * k, mullX * 0.6 * k, hh * k);

      // 低频斜向天空反射，打破平铺感（不产生颗粒）
      if (!lit) {
        g.fillStyle = `rgba(226,240,250,${0.05 + hv * 0.06})`;
        g.beginPath();
        g.moveTo(x + w * 0.04, y + hh * 0.04);
        g.lineTo(x + w * 0.60, y + hh * 0.04);
        g.lineTo(x + w * 0.30, y + hh);
        g.lineTo(x, y + hh);
        g.closePath(); g.fill();
      }
    }
  }

  // 阳极氧化竖挺 + 楼层横梁（跨边界补齐，平铺无缝）
  for (let q = 0; q <= cols; q++) {
    tileRect(g, q * cw - mullX * 0.5, 0, mullX, size, size, st.frame);
    tileRect(gh, (q * cw - mullX * 0.5) * k, 0, mullX * k, nsize, nsize, gray(216));
    tileRect(gm, (q * cw - mullX * 0.5) * k, 0, mullX * k, nsize, nsize, gray(0));
  }
  for (let r = 0; r <= rows; r++) {
    tileRect(g, 0, r * ch - mullY * 0.5, size, mullY, size, shade(st.frame, 0.90));
    tileRect(gh, 0, (r * ch - mullY * 0.5) * k, nsize, mullY * k, nsize, gray(204));
    tileRect(gm, 0, (r * ch - mullY * 0.5) * k, nsize, mullY * k, nsize, gray(0));
  }

  // 一点点低频柔光，避免遮罩是硬邦邦的纯色块
  applyFbm(g, size, 1300 + variant * 17, 4.5);
  applyFbm(gh, nsize, 1300 + variant * 17, 3, true);
  return { color: c, height: hc, mask: mc };
}

/* ---------------------------------------------------------- 混凝土 */
const CONCRETE_BASE = ['#8e8c86', '#7f8079', '#98948b', '#87857e'];

function makeConcrete(size, nsize, variant) {
  const c = makeCanvas(size, size), g = c.getContext('2d', CTX_OPT);
  const hc = makeCanvas(nsize, nsize), gh = hc.getContext('2d', CTX_OPT);
  const k = nsize / size;

  g.fillStyle = CONCRETE_BASE[variant % CONCRETE_BASE.length];
  g.fillRect(0, 0, size, size);
  gh.fillStyle = gray(128); gh.fillRect(0, 0, nsize, nsize);

  const cols = 3, rows = 3, cw = size / cols, ch = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      const hv = cellHash(q, r, variant * 13 + 3) - 0.5;
      g.fillStyle = hv >= 0 ? `rgba(255,255,255,${hv * 0.20})` : `rgba(0,0,0,${-hv * 0.20})`;
      g.fillRect(q * cw, r * ch, cw, ch);
    }
  }

  // 板缝（凹）+ 缝下高光
  const jw = Math.max(2, size / 190);
  for (let q = 0; q <= cols; q++) {
    tileRect(g, q * cw - jw * 0.5, 0, jw, size, size, 'rgba(56,54,50,0.80)');
    tileRect(g, q * cw + jw * 0.5, 0, jw * 0.6, size, size, 'rgba(255,255,255,0.07)');
    tileRect(gh, (q * cw - jw * 0.5) * k, 0, jw * k, nsize, nsize, gray(84));
  }
  for (let r = 0; r <= rows; r++) {
    tileRect(g, 0, r * ch - jw * 0.5, size, jw, size, 'rgba(56,54,50,0.80)');
    tileRect(g, 0, r * ch + jw * 0.5, size, jw * 0.6, size, 'rgba(255,255,255,0.07)');
    tileRect(gh, 0, (r * ch - jw * 0.5) * k, nsize, jw * k, nsize, gray(84));
  }

  // 少量柔和污渍（低频、低对比）
  const rng = makeRNG(2400 + variant * 29);
  for (let i = 0; i < 18; i++) {
    const x = rng() * size, y = rng() * size, rr = size * (0.04 + rng() * 0.12);
    const gd = g.createRadialGradient(x, y, 0, x, y, rr);
    gd.addColorStop(0, `rgba(72,70,66,${0.06 + rng() * 0.07})`);
    gd.addColorStop(1, 'rgba(72,70,66,0)');
    g.fillStyle = gd;
    g.beginPath(); g.arc(x, y, rr, 0, 6.2832); g.fill();
  }

  applyFbm(g, size, 2400 + variant * 29, 5);
  applyFbm(gh, nsize, 2400 + variant * 29, 4, true);
  return { color: c, height: hc };
}

/* ---------------------------------------------------------- 砖墙 */
function makeBrick(size, nsize, variant) {
  const c = makeCanvas(size, size), g = c.getContext('2d', CTX_OPT);
  const hc = makeCanvas(nsize, nsize), gh = hc.getContext('2d', CTX_OPT);
  const k = nsize / size;

  const mortar = ['#a9a094', '#9c9387', '#b0a89b', '#938b80'][variant % 4];
  g.fillStyle = mortar; g.fillRect(0, 0, size, size);
  gh.fillStyle = gray(96); gh.fillRect(0, 0, nsize, nsize);

  const cols = 5, rows = 16;                 // 4.0 世界单位 → 砖 0.8 × 0.25
  const bw = size / cols, bh = size / rows;
  const gap = Math.max(1.5, size / 300);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let q = -1; q < cols + 1; q++) {
      const hv = cellHash(q, r, variant * 7 + 11);
      const v = 0.84 + hv * 0.32;
      const x = q * bw + off, y = r * bh;
      g.fillStyle = `rgb(${Math.round(146 * v)},${Math.round(84 * v)},${Math.round(68 * v)})`;
      tileRect(g, x + gap * 0.5, y + gap * 0.5, bw - gap, bh - gap, size, g.fillStyle);
      gh.fillStyle = gray(150);
      tileRect(gh, (x + gap * 0.5) * k, (y + gap * 0.5) * k, (bw - gap) * k, (bh - gap) * k, nsize, gh.fillStyle);
    }
  }

  applyFbm(g, size, 5300 + variant * 23, 4);
  applyFbm(gh, nsize, 5300 + variant * 23, 3, true);
  return { color: c, height: hc };
}

/* ---------------------------------------------------------- 金属波纹板 */
function makeMetal(size, nsize, variant) {
  const c = makeCanvas(size, size), g = c.getContext('2d', CTX_OPT);
  const hc = makeCanvas(nsize, nsize), gh = hc.getContext('2d', CTX_OPT);
  const k = nsize / size;

  const base = ['#565b60', '#4d5257', '#5f6368', '#4a5055'][variant % 4];
  g.fillStyle = base; g.fillRect(0, 0, size, size);
  gh.fillStyle = gray(128); gh.fillRect(0, 0, nsize, nsize);

  // 竖向波纹：8.0 世界单位内 16 道
  const ribs = 16, rw = size / ribs;
  for (let i = 0; i < ribs; i++) {
    const x = i * rw;
    const gd = g.createLinearGradient(x, 0, x + rw, 0);
    gd.addColorStop(0.00, 'rgba(255,255,255,0.13)');
    gd.addColorStop(0.18, 'rgba(255,255,255,0.05)');
    gd.addColorStop(0.52, 'rgba(0,0,0,0.14)');
    gd.addColorStop(0.82, 'rgba(0,0,0,0.04)');
    gd.addColorStop(1.00, 'rgba(255,255,255,0.07)');
    g.fillStyle = gd;
    g.fillRect(x, 0, rw, size);
    // 高度：正弦轮廓
    for (let x2 = 0; x2 < rw; x2++) {
      const t = x2 / rw;
      const hv = 128 + Math.sin(t * 6.2832) * 22;
      gh.fillStyle = gray(hv);
      gh.fillRect((x + x2) * k, 0, Math.max(1, k), nsize);
    }
  }

  // 横向板缝：每 4.0 世界单位一道
  const sw = Math.max(2, size / 220);
  for (let i = 0; i <= 2; i++) {
    const y = i * size / 2;
    tileRect(g, 0, y - sw * 0.5, size, sw, size, 'rgba(26,28,31,0.70)');
    tileRect(g, 0, y + sw * 0.5, size, sw * 0.5, size, 'rgba(255,255,255,0.10)');
    tileRect(gh, 0, (y - sw * 0.5) * k, nsize, sw * k, nsize, gray(74));
  }

  // 轻微锈迹
  const rng = makeRNG(3700 + variant * 19);
  for (let i = 0; i < 8; i++) {
    const x = rng() * size, y = rng() * size, rr = size * (0.02 + rng() * 0.07);
    const gd = g.createRadialGradient(x, y, 0, x, y, rr);
    gd.addColorStop(0, `rgba(122,74,40,${0.07 + rng() * 0.10})`);
    gd.addColorStop(1, 'rgba(122,74,40,0)');
    g.fillStyle = gd;
    g.beginPath(); g.arc(x, y, rr, 0, 6.2832); g.fill();
  }

  applyFbm(g, size, 3700 + variant * 19, 4);
  return { color: c, height: hc };
}

/* ---------------------------------------------------------- 石材砌块 */
function makeStone(size, nsize, variant) {
  const c = makeCanvas(size, size), g = c.getContext('2d', CTX_OPT);
  const hc = makeCanvas(nsize, nsize), gh = hc.getContext('2d', CTX_OPT);
  const k = nsize / size;

  g.fillStyle = '#7d7a72'; g.fillRect(0, 0, size, size);
  gh.fillStyle = gray(92); gh.fillRect(0, 0, nsize, nsize);

  const cols = 4, rows = 8;                  // 6.0 世界单位 → 块 1.5 × 0.75
  const bw = size / cols, bh = size / rows;
  const gap = Math.max(2, size / 200);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * bw * 0.25;
    for (let q = -1; q < cols + 1; q++) {
      const hv = cellHash(q, r, variant * 17 + 5);
      const v = 0.86 + hv * 0.28;
      const x = q * bw + off, y = r * bh;
      const fill = `rgb(${Math.round(156 * v)},${Math.round(151 * v)},${Math.round(141 * v)})`;
      tileRect(g, x + gap * 0.5, y + gap * 0.5, bw - gap, bh - gap, size, fill);
      gh.fillStyle = gray(138);
      tileRect(gh, (x + gap * 0.5) * k, (y + gap * 0.5) * k, (bw - gap) * k, (bh - gap) * k, nsize, gh.fillStyle);
    }
  }

  applyFbm(g, size, 7100 + variant * 31, 5);
  applyFbm(gh, nsize, 7100 + variant * 31, 4, true);
  return { color: c, height: hc };
}

/* ---------------------------------------------------------- 抹灰 */
function makePlaster(size, nsize, variant) {
  const c = makeCanvas(size, size), g = c.getContext('2d', CTX_OPT);
  const hc = makeCanvas(nsize, nsize), gh = hc.getContext('2d', CTX_OPT);

  g.fillStyle = ['#aaa598', '#a49f92', '#b0ab9d', '#9e9a8e'][variant % 4];
  g.fillRect(0, 0, size, size);
  gh.fillStyle = gray(128); gh.fillRect(0, 0, nsize, nsize);

  const rng = makeRNG(8900 + variant * 37);
  for (let i = 0; i < 22; i++) {
    const x = rng() * size, y = rng() * size, rr = size * (0.05 + rng() * 0.16);
    const t = rng();
    const gd = g.createRadialGradient(x, y, 0, x, y, rr);
    gd.addColorStop(0, `rgba(${118 + t * 40 | 0},${114 + t * 30 | 0},${102 + t * 30 | 0},${0.10 + rng() * 0.14})`);
    gd.addColorStop(1, 'rgba(120,116,104,0)');
    g.fillStyle = gd;
    g.beginPath(); g.arc(x, y, rr, 0, 6.2832); g.fill();
  }

  applyFbm(g, size, 8900 + variant * 37, 7);
  applyFbm(gh, nsize, 8900 + variant * 37, 5, true);
  return { color: c, height: hc };
}

const BUILDERS = {
  glass: makeGlassFacade, concrete: makeConcrete, metal: makeMetal,
  brick: makeBrick, stone: makeStone, plaster: makePlaster,
};

const builtCache = new Map();
const texCache = new Map();
const matCache = new Map();

function buildPair(kind, variant) {
  const key = `${kind}_${variant}`;
  const hit = builtCache.get(key);
  if (hit) return hit;
  const csize = kind === 'glass' ? 1024 : 512;
  const nsize = 512;
  const build = BUILDERS[kind] || makeConcrete;
  const out = build(csize, nsize, variant);
  builtCache.set(key, out);
  return out;
}

function canvasTexture(canvas, { srgb, name }) {
  const t = new THREE.CanvasTexture(canvas);
  t.name = name;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export function procTexture(kind, variant = 0) {
  const key = `${kind}_${variant}_d`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const t = canvasTexture(buildPair(kind, variant).color, { srgb: true, name: key });
  texCache.set(key, t);
  return t;
}

export function procNormal(kind, variant = 0) {
  const key = `${kind}_${variant}_n`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const h = buildPair(kind, variant).height;
  const t = canvasTexture(heightToNormal(h, NRM_STRENGTH[kind] || 1.2), { srgb: false, name: key });
  texCache.set(key, t);
  return t;
}

/**
 * 夜间窗光遮罩：只有玻璃部分发光，窗框与楼板保持黑色。
 * 用它代替整张立面贴图做 emissiveMap，夜景才是"零散点亮的窗格"
 * 而不是整面墙均匀发亮。
 */
export function procWindowMask(kind, variant = 0) {
  const key = `${kind}_${variant}_w`;
  const hit = texCache.get(key);
  if (hit) return hit;
  const m = buildPair(kind, variant).mask;
  if (!m) return null;
  const t = canvasTexture(m, { srgb: true, name: key });
  texCache.set(key, t);
  return t;
}

/* ---------------------------------------------------------- 三平面着色 */
/**
 * 资产自带的 UV 密度不可控（部分达到设计尺度的 20~40 倍），且斜面/曲面上
 * UV 会被拉伸。这里在着色器内按物体局部坐标做三平面投影：
 * 颜色与法线都取自世界尺度，任意朝向的表面都保持一致的纹素密度且不拉伸。
 * UV 仍然保留（用于 emissive 与切线基），只是不再决定立面图案。
 */
const TRI_GLSL_PARS = `
varying vec3 vTriPos;
varying vec3 vTriNrm;
uniform vec2 uTriScale;
uniform vec2 uTriOffset;
uniform float uTriSharp;
vec3 triWeights( vec3 n ) {
  vec3 w = pow( abs( n ), vec3( uTriSharp ) );
  return w / max( w.x + w.y + w.z, 1e-4 );
}
vec2 triUvX( vec3 p ) { return vec2( p.z, p.y ) * uTriScale + uTriOffset; }
vec2 triUvY( vec3 p ) { return vec2( p.x, p.z ) * uTriScale + uTriOffset; }
vec2 triUvZ( vec3 p ) { return vec2( p.x, p.y ) * uTriScale + uTriOffset; }
`;

const TRI_MAP = `
#ifdef USE_MAP
  vec3 triN0 = normalize( vTriNrm );
  vec3 triW = triWeights( triN0 );
  vec4 triC = texture2D( map, triUvX( vTriPos ) ) * triW.x
            + texture2D( map, triUvY( vTriPos ) ) * triW.y
            + texture2D( map, triUvZ( vTriPos ) ) * triW.z;
  diffuseColor *= triC;
#endif
`;

const TRI_NORMAL = `
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 triN0n = normalize( vTriNrm );
  vec3 triWn = triWeights( triN0n );
  vec3 tnX = texture2D( normalMap, triUvX( vTriPos ) ).xyz * 2.0 - 1.0;
  vec3 tnY = texture2D( normalMap, triUvY( vTriPos ) ).xyz * 2.0 - 1.0;
  vec3 tnZ = texture2D( normalMap, triUvZ( vTriPos ) ).xyz * 2.0 - 1.0;
  vec3 triTn = tnX * triWn.x + tnY * triWn.y + tnZ * triWn.z;
  triTn.xy *= normalScale;
  normal = normalize( tbn * triTn );
#endif
`;

function applyTriplanar(mat, scaleU, scaleV, variant) {
  // 记录参数：Material.copy() 不会复制 onBeforeCompile，clone 后需要重新挂载
  mat.userData.procTri = { scaleU, scaleV, variant };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTriScale = { value: new THREE.Vector2(scaleU, scaleV) };
    shader.uniforms.uTriOffset = { value: new THREE.Vector2(variant * 0.37, variant * 0.61) };
    shader.uniforms.uTriSharp = { value: 14.0 };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTriPos;\nvarying vec3 vTriNrm;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvTriPos = position;\n\tvTriNrm = normal;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${TRI_GLSL_PARS}`)
      .replace('#include <map_fragment>', TRI_MAP)
      .replace('#include <normal_fragment_maps>', TRI_NORMAL);
  };
  // 必须给出稳定的自定义 key，否则会与其它 Physical 材质共用已缓存的 program
  mat.customProgramCacheKey = () => 'proc-triplanar';
  return mat;
}

/** 取得该程序化材质的夜间窗光遮罩（非程序化材质返回 null） */
export function windowMaskFor(mat) {
  const p = mat && mat.userData && mat.userData.proc;
  if (!p) return null;
  return procWindowMask(p.kind, p.variant);
}

/** 材质被 clone() 后重新挂载三平面着色器（Material.copy 不会复制 onBeforeCompile） */
export function reattachProcShader(mat) {
  const t = mat && mat.userData && mat.userData.procTri;
  if (!t || mat.onBeforeCompile.toString().indexOf('vTriPos') >= 0) return mat;
  applyTriplanar(mat, t.scaleU, t.scaleV, t.variant);
  return mat;
}

/* ---------------------------------------------------------- 材质 */
export function procMaterial(kind, opts = {}) {
  const variant = opts.variant ?? 0;
  const key = `${kind}_${variant}${opts.low ? '_low' : ''}`;
  const hit = matCache.get(key);
  if (hit) return hit;

  const cfg = PROC[kind] || PROC.concrete;
  const isGlass = kind === 'glass';
  const m = new THREE.MeshPhysicalMaterial({
    map: procTexture(kind, variant),
    normalMap: opts.low ? null : procNormal(kind, variant),
    normalScale: new THREE.Vector2(isGlass ? 0.55 : 0.75, isGlass ? 0.55 : 0.75),
    roughness: cfg.roughness,
    metalness: cfg.metalness,
    envMapIntensity: cfg.env,
    clearcoat: isGlass ? 0.82 : 0.06,
    clearcoatRoughness: isGlass ? 0.10 : 0.55,
    reflectivity: isGlass ? 0.68 : 0.5,
    vertexColors: true,
    side: opts.side ?? THREE.FrontSide,
    fog: opts.fog !== false,
  });

  // 供外部把夜间自发光挂到窗光遮罩上（而不是整张立面）。
  // 只存 kind/variant 这类纯数据：Material.copy 会对 userData 做 JSON 深拷贝，
  // 直接放 Texture 会丢失甚至出错。
  m.userData.proc = { kind, variant };

  applyTriplanar(m, 1 / cfg.tile[0], 1 / cfg.tile[1], variant);
  matCache.set(key, m);
  return m;
}

/* ---------------------------------------------------------- 几何处理 */
/**
 * 盒式投影生成 UV（世界尺度）。
 * 程序化贴图按「世界单位/次循环」设计，因此必须用局部坐标换算，
 * 不能使用资产自带 UV——后者的密度与设计尺度不匹配会让立面糊成噪点。
 */
export function boxProjectUV(geometry, tileW = 8, tileH = 8, seed = 1) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const su = 1 / tileW, sv = 1 / tileH;
  const ou = (seed % 251) * 0.0417, ov = (seed % 197) * 0.0533;
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let nx = 0, ny = 1, nz = 0;
    if (nrm) { nx = nrm.getX(i); ny = nrm.getY(i); nz = nrm.getZ(i); }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let u, v;
    if (ay >= ax && ay >= az) { u = x; v = z; }        // 顶面
    else if (ax >= az) { u = z; v = y; }                // 平行于 YZ 的墙面
    else { u = x; v = y; }                              // 平行于 XY 的墙面
    uv[i * 2] = u * su + ou;
    uv[i * 2 + 1] = v * sv + ov;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/**
 * 顶点色：只做低频竖向渐变（底部积灰 / 顶部提亮）。
 * 旧实现在这里叠加了逐顶点哈希随机，会在密网格上产生明显麻点，已移除。
 */
export function paintVertexColor(geometry, seed = 1, opts = {}) {
  const pos = geometry.attributes.position;
  const count = pos.count;
  const col = new Float32Array(count * 3);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const span = Math.max(1e-3, bb.max.y - bb.min.y);
  const tint = new THREE.Color(opts.tint || 0xffffff);
  const grimeCol = new THREE.Color(typeof opts.grime === 'number' ? opts.grime : 0xb3ada2);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const t = clamp((pos.getY(i) - bb.min.y) / span, 0, 1);
    c.copy(tint);
    if (opts.grime) c.lerp(grimeCol, (1 - t) * (1 - t) * 0.30);
    c.multiplyScalar(0.95 + 0.05 * t);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geometry;
}
