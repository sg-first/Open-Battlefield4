/* ============================================================
   工具函数：数学、随机、几何辅助
   ============================================================ */
import * as THREE from 'three';

export const clamp = THREE.MathUtils.clamp;
export const lerp = THREE.MathUtils.lerp;
export const DEG = Math.PI / 180;

export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 确定性随机（mulberry32），保证每次生成的上海布局一致 */
export function makeRNG(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => Math.floor(rng.range(lo, hi + 1 - 1e-9));
  rng.pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
  rng.chance = (p) => rng() < p;
  return rng;
}

export function yieldFrame() {
  return new Promise((r) => setTimeout(r, 0));
}

/** 角度归一化到 [-PI, PI) */
export function wrapAngle(a) {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
}

/** 数值平滑阻尼 */
export function damp(cur, target, lambda, dt) {
  return lerp(cur, target, 1 - Math.exp(-lambda * dt));
}

/** 弹簧（临界阻尼），用于后坐力/视角回弹 */
export function spring(cur, vel, target, stiffness, damping, dt) {
  const a = (target - cur) * stiffness - vel * damping;
  vel += a * dt;
  cur += vel * dt;
  return [cur, vel];
}

export function fmt(n, d = 0) {
  return n.toFixed(d);
}

/** 在 canvas 上画一张噪点/纹理，用于程序化材质 */
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/** 简易值噪声（可平铺） */
export function valueNoise2D(seed, size) {
  const rng = makeRNG(seed);
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  const at = (x, y) => g[((y % size) + size) % size * size + (((x % size) + size) % size)];
  const smooth = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return lerp(lerp(at(xi, yi), at(xi + 1, yi), u), lerp(at(xi, yi + 1), at(xi + 1, yi + 1), u), v);
  };
  return (x, y) => smooth(x, y);
}

/** 用噪声生成可平铺的法线贴图（用于水面/地面细节） */
export function makeNoiseNormalTexture(size, strength, freq, seed) {
  const n = valueNoise2D(seed, 64);
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      h[y * size + x] = n(x * freq, y * freq) - 0.5;
    }
  }
  const s = size / 64;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const xl = h[y * size + ((x - 1 + size) % size)], xr = h[y * size + ((x + 1) % size)];
      const yu = h[((y - 1 + size) % size) * size + x], yd = h[((y + 1) % size) * size + x];
      let nx = (xl - xr) * strength * s, ny = (yu - yd) * strength * s;
      const l = Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      img.data[i] = ((nx / l) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((ny / l) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 生成一张程序化柏油/水泥地面颜色贴图 */
export function makeGroundTexture(size = 512, base = '#46464a', seed = 7) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const rng = makeRNG(seed);
  // 沥青骨料颗粒
  for (let i = 0; i < size * size * 0.7; i++) {
    const x = rng() * size, y = rng() * size;
    const v = 18 + rng() * 62;
    ctx.fillStyle = `rgba(${v + 34},${v + 34},${v + 38},${0.10 + rng() * 0.22})`;
    ctx.fillRect(x, y, 1 + rng() * 2, 1 + rng() * 2);
  }
  // 大块污渍（幅度收敛，避免地面脏成迷彩）
  const n = valueNoise2D(seed + 11, 32);
  const img = ctx.getImageData(0, 0, size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = (n(x / size * 32, y / size * 32) - 0.5) * 15;
      const i = (y * size + x) * 4;
      img.data[i] = clamp(img.data[i] + v, 0, 255);
      img.data[i + 1] = clamp(img.data[i + 1] + v, 0, 255);
      img.data[i + 2] = clamp(img.data[i + 2] + v, 0, 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** 弹孔/弹着点贴花贴图（带 alpha） */
export function makeBulletHoleTexture(size = 128, seed = 3) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rng = makeRNG(seed);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  // 外圈碎裂灰
  const g = ctx.createRadialGradient(cx, cy, size * 0.05, cx, cy, size * 0.48);
  g.addColorStop(0, 'rgba(10,9,8,0.98)');
  g.addColorStop(0.30, 'rgba(28,25,23,0.85)');
  g.addColorStop(0.62, 'rgba(70,66,62,0.42)');
  g.addColorStop(1, 'rgba(120,116,110,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.48, 0, 6.2832); ctx.fill();
  // 放射裂纹
  ctx.strokeStyle = 'rgba(200,196,190,0.20)';
  for (let i = 0; i < 26; i++) {
    const a = rng() * 6.2832, r0 = size * 0.10 + rng() * size * 0.06, r1 = size * (0.20 + rng() * 0.28);
    ctx.lineWidth = 0.5 + rng() * 1.6;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
    ctx.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 圆形柔光贴图（枪口火焰 / 火花 / 烟雾） */
export function makeGlowTexture(size = 128, tint = [255, 236, 190], power = 2.2) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const cx = size / 2 - 0.5, cy = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy) / (size / 2);
      const a = Math.pow(Math.max(0, 1 - d), power);
      const i = (y * size + x) * 4;
      img.data[i] = tint[0]; img.data[i + 1] = tint[1]; img.data[i + 2] = tint[2];
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 枪口火焰形状贴图（星形） */
export function makeFlashTexture(size = 256, seed = 5) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rng = makeRNG(seed);
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2, cy = size / 2;
  ctx.globalCompositeOperation = 'lighter';
  // 核心
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.30);
  g.addColorStop(0, 'rgba(255,255,240,1)');
  g.addColorStop(0.25, 'rgba(255,226,150,0.95)');
  g.addColorStop(0.6, 'rgba(255,150,50,0.45)');
  g.addColorStop(1, 'rgba(255,90,20,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(cx, cy, size * 0.30, 0, 6.2832); ctx.fill();
  // 星芒
  for (let i = 0; i < 9; i++) {
    const a = rng() * 6.2832;
    const len = size * (0.20 + rng() * 0.30);
    const wdt = size * (0.02 + rng() * 0.05);
    const gg = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    gg.addColorStop(0, 'rgba(255,240,200,0.85)');
    gg.addColorStop(1, 'rgba(255,120,30,0)');
    ctx.fillStyle = gg;
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(0, -wdt); ctx.lineTo(len, 0); ctx.lineTo(0, wdt); ctx.closePath(); ctx.fill();
    ctx.restore();
  }
  return new THREE.CanvasTexture(c);
}

/** 烟/尘贴图 */
export function makeSmokeTexture(size = 128, seed = 9) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const n = valueNoise2D(seed, 48);
  const img = ctx.createImageData(size, size);
  const cx = size / 2 - 0.5, cy = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy) / (size / 2);
      let a = Math.max(0, 1 - d);
      a *= 0.45 + n(x / size * 20, y / size * 20) * 0.9;
      a = clamp(a * (1 - d * 0.7), 0, 1);
      const i = (y * size + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 215;
      img.data[i + 3] = a * 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function makeBloodTexture(size = 128, seed = 21) {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  const rng = makeRNG(seed);
  const img = ctx.createImageData(size, size);
  const cx = size / 2 - 0.5, cy = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy) / (size / 2);
      let a = Math.max(0, 1 - d * 1.15);
      a = Math.pow(a, 0.7);
      const i = (y * size + x) * 4;
      img.data[i] = 120 + rng() * 40;
      img.data[i + 1] = 6 + rng() * 12;
      img.data[i + 2] = 8 + rng() * 12;
      img.data[i + 3] = a * 235;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
