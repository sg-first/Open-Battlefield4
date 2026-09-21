/* ============================================================
   程序化材质
   导出里有一部分资产既没有 UV 也没有材质绑定（外墙、机房、塔楼等），
   这里用「盒式投影 UV + 程序化贴图 + 顶点色」还原可信的建筑外观。
   ============================================================ */
import * as THREE from 'three';
import { makeRNG, valueNoise2D, clamp, makeCanvas } from './util.js';

/* ---------------------------------------------------------- 分类 */
export function pickMatKind(name) {
  const n = name.toLowerCase();
  if (/(glass|window|skybarwindow|facadeglass)/.test(n)) return 'glass';
  if (/(skyscraper|tower|highrise|office|waterfront|hotel|datacenter|building|bd_|residential)/.test(n)) return 'glass';
  if (/(brick|backstreets|shanty)/.test(n)) return 'brick';
  if (/(metal|girder|pipe|cable|rail|antenna|vent|duct|container|crate)/.test(n)) return 'metal';
  if (/(statue|marble|stone|lantern|fountain|plaza|artwork|stair|sidewalk|kerb|curb)/.test(n)) return 'stone';
  if (/(plaster|wall|cement|concrete|foundation|pillar|archway|garage)/.test(n)) return 'concrete';
  return 'concrete';
}

export const PROC = {
  glass: { scale: 1 / 32, roughness: 0.24, metalness: 0.34, env: 1.0, flat: '#39424c' },
  concrete: { scale: 1 / 8.4, roughness: 0.90, metalness: 0.03, env: 0.4, flat: '#8d8b85' },
  metal: { scale: 1 / 5.0, roughness: 0.52, metalness: 0.55, env: 0.8, flat: '#52565b' },
  brick: { scale: 1 / 2.2, roughness: 0.94, metalness: 0.02, env: 0.3, flat: '#8a5b47' },
  stone: { scale: 1 / 3.2, roughness: 0.86, metalness: 0.04, env: 0.45, flat: '#9a968d' },
  plaster: { scale: 1 / 4.0, roughness: 0.92, metalness: 0.02, env: 0.35, flat: '#a8a396' },
};

/* ---------------------------------------------------------- 贴图生成 */
function grain(ctx, w, h, seed, amount, base) {
  const img = ctx.getImageData(0, 0, w, h);
  const rng = makeRNG(seed);
  const n = valueNoise2D(seed + 3, 32);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const v = (n(x / w * 26, y / h * 26) - 0.5) * amount + (rng() - 0.5) * amount * 0.5;
      img.data[i] = clamp(img.data[i] + v, 0, 255);
      img.data[i + 1] = clamp(img.data[i + 1] + v, 0, 255);
      img.data[i + 2] = clamp(img.data[i + 2] + v * (base || 1), 0, 255);
    }
  }
  ctx.putImageData(img, 0, 0);
}

function makeGlassFacade(size = 512, seed = 11) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#2b333c';
  g.fillRect(0, 0, size, size);
  const rng = makeRNG(seed);
  const cols = 8, rows = 8;
  const cw = size / cols, ch = size / rows;
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < cols; k++) {
      const lit = rng() < 0.06;
      const shade = 0.72 + rng() * 0.5;
      if (lit) {
        const gd = g.createLinearGradient(k * cw, r * ch, k * cw, (r + 1) * ch);
        gd.addColorStop(0, 'rgba(226,196,150,0.85)');
        gd.addColorStop(1, 'rgba(150,116,74,0.8)');
        g.fillStyle = gd;
      } else {
        const gd = g.createLinearGradient(k * cw, r * ch, (k + 1) * cw, (r + 1) * ch);
        gd.addColorStop(0, `rgba(${Math.round(74 * shade)},${Math.round(90 * shade)},${Math.round(104 * shade)},1)`);
        gd.addColorStop(0.55, `rgba(${Math.round(46 * shade)},${Math.round(58 * shade)},${Math.round(70 * shade)},1)`);
        gd.addColorStop(1, `rgba(${Math.round(30 * shade)},${Math.round(38 * shade)},${Math.round(48 * shade)},1)`);
        g.fillStyle = gd;
      }
      g.fillRect(k * cw + 2, r * ch + 2, cw - 4, ch - 4);
      // 竖向反光
      if (!lit && rng() < 0.3) {
        g.fillStyle = 'rgba(190,215,235,0.10)';
        g.fillRect(k * cw + 2, r * ch + 2, cw * 0.28, ch - 4);
      }
    }
  }
  // 幕墙竖挺 / 横梁
  g.strokeStyle = 'rgba(150,164,178,0.55)';
  g.lineWidth = Math.max(1, size / 256);
  for (let k = 0; k <= cols; k++) {
    g.beginPath(); g.moveTo(k * cw, 0); g.lineTo(k * cw, size); g.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    g.beginPath(); g.moveTo(0, r * ch); g.lineTo(size, r * ch); g.stroke();
  }
  grain(g, size, size, seed + 5, 10);
  return c;
}

function makeConcrete(size = 512, seed = 23) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#8e8c86';
  g.fillRect(0, 0, size, size);
  const rng = makeRNG(seed);
  // 板材分缝
  g.strokeStyle = 'rgba(96,94,90,0.55)';
  g.lineWidth = 2;
  for (let k = 0; k <= 4; k++) {
    g.beginPath(); g.moveTo(0, k * size / 4); g.lineTo(size, k * size / 4); g.stroke();
    g.beginPath(); g.moveTo(k * size / 4, 0); g.lineTo(k * size / 4, size); g.stroke();
  }
  // 污渍
  for (let k = 0; k < 40; k++) {
    const x = rng() * size, y = rng() * size, r = 6 + rng() * 42;
    const gd = g.createRadialGradient(x, y, 0, x, y, r);
    gd.addColorStop(0, `rgba(96,92,86,${0.10 + rng() * 0.16})`);
    gd.addColorStop(1, 'rgba(96,92,86,0)');
    g.fillStyle = gd;
    g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
  grain(g, size, size, seed + 7, 26);
  return c;
}

function makeMetal(size = 512, seed = 37) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#53585d';
  g.fillRect(0, 0, size, size);
  const rng = makeRNG(seed);
  // 竖向波纹板
  for (let k = 0; k < size; k += 16) {
    const gd = g.createLinearGradient(k, 0, k + 16, 0);
    gd.addColorStop(0, 'rgba(255,255,255,0.10)');
    gd.addColorStop(0.5, 'rgba(0,0,0,0.10)');
    gd.addColorStop(1, 'rgba(255,255,255,0.06)');
    g.fillStyle = gd;
    g.fillRect(k, 0, 16, size);
  }
  g.strokeStyle = 'rgba(30,32,35,0.65)';
  g.lineWidth = 2;
  for (let k = 0; k <= 2; k++) { g.beginPath(); g.moveTo(0, k * size / 2); g.lineTo(size, k * size / 2); g.stroke(); }
  g.fillStyle = 'rgba(28,30,33,0.55)';
  for (let k = 0; k < 120; k++) g.fillRect(4 + rng() * (size - 8), rng() * size, 2, 2);
  // 锈迹
  for (let k = 0; k < 14; k++) {
    const x = rng() * size, y = rng() * size, r = 4 + rng() * 22;
    const gd = g.createRadialGradient(x, y, 0, x, y, r);
    gd.addColorStop(0, `rgba(122,74,40,${0.10 + rng() * 0.20})`);
    gd.addColorStop(1, 'rgba(122,74,40,0)');
    g.fillStyle = gd; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
  grain(g, size, size, seed + 9, 18);
  return c;
}

function makeBrick(size = 512, seed = 53) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#9c9084';
  g.fillRect(0, 0, size, size);
  const rng = makeRNG(seed);
  const bh = size / 16, bw = size / 8;
  for (let r = 0; r < 16; r++) {
    const off = (r % 2) * bw * 0.5;
    for (let k = -1; k < 9; k++) {
      const v = 0.7 + rng() * 0.6;
      g.fillStyle = `rgb(${Math.round(126 * v)},${Math.round(78 * v)},${Math.round(62 * v)})`;
      g.fillRect(k * bw + off + 1.5, r * bh + 1.5, bw - 3, bh - 3);
    }
  }
  grain(g, size, size, seed + 2, 22);
  return c;
}

function makeStone(size = 512, seed = 71) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#9d998f';
  g.fillRect(0, 0, size, size);
  const rng = makeRNG(seed);
  for (let r = 0; r < 8; r++) {
    for (let k = 0; k < 8; k++) {
      const v = 0.82 + rng() * 0.34;
      g.fillStyle = `rgb(${Math.round(158 * v)},${Math.round(153 * v)},${Math.round(143 * v)})`;
      g.fillRect(k * size / 8 + 1.5, r * size / 8 + 1.5, size / 8 - 3, size / 8 - 3);
    }
  }
  grain(g, size, size, seed + 4, 30);
  return c;
}

function makePlaster(size = 512, seed = 89) {
  const c = makeCanvas(size, size);
  const g = c.getContext('2d');
  g.fillStyle = '#aaa598';
  g.fillRect(0, 0, size, size);
  const rng = makeRNG(seed);
  for (let k = 0; k < 30; k++) {
    const x = rng() * size, y = rng() * size, r = 10 + rng() * 60;
    const gd = g.createRadialGradient(x, y, 0, x, y, r);
    gd.addColorStop(0, `rgba(${120 + rng() * 40 | 0},${116 + rng() * 30 | 0},${104 + rng() * 30 | 0},${0.14 + rng() * 0.2})`);
    gd.addColorStop(1, 'rgba(120,116,104,0)');
    g.fillStyle = gd; g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
  }
  grain(g, size, size, seed + 6, 24);
  return c;
}

const BUILDERS = {
  glass: makeGlassFacade, concrete: makeConcrete, metal: makeMetal,
  brick: makeBrick, stone: makeStone, plaster: makePlaster,
};

const texCache = new Map();
const matCache = new Map();

export function procTexture(kind) {
  if (texCache.has(kind)) return texCache.get(kind);
  const cfg = PROC[kind] || PROC.concrete;
  const size = kind === 'glass' ? 512 : 512;
  const c = (BUILDERS[kind] || makeConcrete)(size, 1000 + kind.length * 37);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.needsUpdate = true;
  texCache.set(kind, t);
  return t;
}

export function procNormal(kind) {
  const key = kind + '_n';
  if (texCache.has(key)) return texCache.get(key);
  const cfg = PROC[kind] || PROC.concrete;
  const strength = kind === 'brick' ? 3.0 : kind === 'metal' ? 1.6 : 2.2;
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  const n = valueNoise2D(kind.length * 13 + 5, 64);
  const freq = kind === 'glass' ? 32 : 24;
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const h = (xx, yy) => n((((xx + 256) % 256) / 256) * freq, ((((yy + 256) % 256)) / 256) * freq) - 0.5;
      const dx = (h(x - 1, y) - h(x + 1, y)) * strength;
      const dy = (h(x, y - 1) - h(x, y + 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * 256 + x) * 4;
      img.data[i] = ((dx / l) * 127 + 128);
      img.data[i + 1] = ((dy / l) * 127 + 128);
      img.data[i + 2] = ((1 / l) * 127 + 128);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

export function procMaterial(kind, opts = {}) {
  const key = kind + (opts.low ? '_low' : '');
  if (matCache.has(key)) return matCache.get(key);
  const cfg = PROC[kind] || PROC.concrete;
  const m = new THREE.MeshStandardMaterial({
    map: procTexture(kind),
    normalMap: opts.low ? null : procNormal(kind),
    normalScale: new THREE.Vector2(0.6, 0.6),
    roughness: cfg.roughness,
    metalness: cfg.metalness,
    envMapIntensity: cfg.env,
    vertexColors: true,
    side: opts.side ?? THREE.FrontSide,
    fog: opts.fog !== false,
  });
  matCache.set(key, m);
  return m;
}

/* ---------------------------------------------------------- 几何处理 */
/** 盒式投影生成 UV（无 UV 资产用） */
export function boxProjectUV(geometry, scale, seed = 1) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const count = pos.count;
  const uv = new Float32Array(count * 2);
  const off = (seed % 97) * 0.137;
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let nx = 0, ny = 1, nz = 0;
    if (nrm) { nx = nrm.getX(i); ny = nrm.getY(i); nz = nrm.getZ(i); }
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let u, v;
    if (ay >= ax && ay >= az) { u = x * scale; v = z * scale; }
    else if (ax >= az) { u = z * scale; v = y * scale; }
    else { u = x * scale; v = y * scale; }
    uv[i * 2] = u + off;
    uv[i * 2 + 1] = v + off;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}

/** 顶点色：高度渐变 + 噪点，避免大面积死板 */
export function paintVertexColor(geometry, seed = 1, opts = {}) {
  const pos = geometry.attributes.position;
  const count = pos.count;
  const col = new Float32Array(count * 3);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const span = Math.max(1e-3, bb.max.y - bb.min.y);
  const rng = makeRNG(seed);
  const tint = new THREE.Color(opts.tint || 0xffffff);
  const bottomTint = new THREE.Color(opts.grime || 0xbfb9ad);
  const c = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const t = clamp((pos.getY(i) - bb.min.y) / span, 0, 1);
    c.copy(tint);
    if (opts.grime) c.lerp(bottomTint, (1 - t) * 0.35);
    const n = 0.88 + 0.24 * ((Math.sin(i * 12.9898 + seed) * 43758.5453) % 1 + 1) * 0.5;
    c.multiplyScalar(n);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geometry;
}
