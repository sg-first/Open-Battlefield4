/* ============================================================
   BF4 导出资产加载器
   - 读取 obj/<name>.obj + obj/<name>.mtl + tex/<name>.png
     （与 export/index.html 的资源约定完全一致）
   - 顶点按 (v / vt) 焊接为索引几何体，使用作者法线
   - 贴图按类别降采样，控制显存占用
   ============================================================ */
import * as THREE from 'three';
import { pickMatKind, PROC, procMaterial, boxProjectUV, paintVertexColor } from './proc.js';
import { makeCanvas, clamp, smoothstep, valueNoise2D } from './util.js';

/** export/ 根目录（game/src/ 向上两级） */
export const ASSET_BASE = new URL('../../', import.meta.url).href;

const SPACE = (c) => c === 32 || c === 9 || c === 13;

/* ---------------------------------------------- 快速浮点扫描 */
const FP = { i: 0 };
function readFloat(s, i, end) {
  while (i < end && SPACE(s.charCodeAt(i))) i++;
  let sign = 1, started = false;
  if (i < end) {
    const c = s.charCodeAt(i);
    if (c === 45) { sign = -1; i++; } else if (c === 43) i++;
  }
  let v = 0;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c >= 48 && c <= 57) { v = v * 10 + (c - 48); i++; started = true; } else break;
  }
  if (i < end && s.charCodeAt(i) === 46) {
    i++;
    let f = 0.1;
    while (i < end) {
      const c = s.charCodeAt(i);
      if (c >= 48 && c <= 57) { v += (c - 48) * f; f *= 0.1; i++; started = true; } else break;
    }
  }
  if (started && i < end) {
    const c = s.charCodeAt(i);
    if (c === 101 || c === 69) {
      let j = i + 1, es = 1;
      if (j < end && s.charCodeAt(j) === 45) { es = -1; j++; } else if (j < end && s.charCodeAt(j) === 43) j++;
      let e = 0, got = false;
      while (j < end) { const cc = s.charCodeAt(j); if (cc >= 48 && cc <= 57) { e = e * 10 + (cc - 48); j++; got = true; } else break; }
      if (got) { v *= Math.pow(10, es * e); i = j; }
    }
  }
  FP.i = i;
  return started ? sign * v : 0;
}

function readIndex(s, i, end) {
  while (i < end && SPACE(s.charCodeAt(i))) i++;
  const c = s.charCodeAt(i);
  if (!(c >= 48 && c <= 57) && c !== 45) { FP.i = i; return -1; }
  return Math.trunc(readFloat(s, i, end));
}

/* ---------------------------------------------- OBJ 解析 */
const fvi = new Int32Array(24), fti = new Int32Array(24), fni = new Int32Array(24);

/**
 * 解析 OBJ → [{ mtl, position, uv, normal, index }]
 * 按 usemtl 分段。BF4 导出为 1:1 的 v/vt/vn，故以 (v,vt) 作为焊接键。
 */
export function parseOBJ(text) {
  const vx = [], vy = [], vz = [];
  const tx = [], ty = [];
  const nx = [], ny = [], nz = [];

  const parts = [];
  let cur = null;
  const vmap = new Map();
  let pos = [], uvs = [], nrm = [], idx = [];

  const flush = () => {
    if (cur !== null && idx.length) {
      parts.push({
        mtl: cur,
        position: new Float32Array(pos),
        uv: new Float32Array(uvs),
        normal: nrm.length ? new Float32Array(nrm) : null,
        index: new Uint32Array(idx),
      });
    }
    pos = []; uvs = []; nrm = []; idx = []; vmap.clear();
  };

  const len = text.length;
  let i = 0;
  while (i < len) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = len;
    let k = i;
    while (k < j && SPACE(text.charCodeAt(k))) k++;
    const c = text.charCodeAt(k);
    if (c === 118) {                                  // v / vt / vn
      const c1 = text.charCodeAt(k + 1);
      if (c1 === 32 || c1 === 9) {
        let p = k + 2;
        const x = readFloat(text, p, j); p = FP.i;
        const y = readFloat(text, p, j); p = FP.i;
        const z = readFloat(text, p, j);
        vx.push(x); vy.push(y); vz.push(z);
      } else if (c1 === 116) {                        // vt
        let p = k + 3;
        const u = readFloat(text, p, j); p = FP.i;
        const v = readFloat(text, p, j);
        tx.push(u); ty.push(v);
      } else if (c1 === 110) {                        // vn
        let p = k + 3;
        const x = readFloat(text, p, j); p = FP.i;
        const y = readFloat(text, p, j); p = FP.i;
        const z = readFloat(text, p, j);
        nx.push(x); ny.push(y); nz.push(z);
      }
    } else if (c === 102) {                           // f
      let p = k + 2, n = 0;
      while (p < j && n < 24) {
        const vi = readIndex(text, p, j); p = FP.i;
        if (vi < 1) break;
        let ti = -1, ni = -1;
        if (p < j && text.charCodeAt(p) === 47) {
          p++;
          if (p < j && text.charCodeAt(p) !== 47) { ti = readIndex(text, p, j); p = FP.i; }
          if (p < j && text.charCodeAt(p) === 47) { p++; ni = readIndex(text, p, j); p = FP.i; }
        }
        fvi[n] = vi; fti[n] = ti; fni[n] = ni; n++;
        while (p < j && SPACE(text.charCodeAt(p))) p++;
      }
      if (n >= 3) {
        if (cur === null) cur = '';
        for (let t = 0; t < n - 2; t++) {
          for (const s of [0, t + 1, t + 2]) {
            const a = fvi[s];
            const b = fti[s] > 0 ? fti[s] : 0;
            const cc = fni[s] > 0 ? fni[s] : 0;
            const key = a * 1048576 + b;              // vt 上限 1e6，安全
            let id = vmap.get(key);
            if (id === undefined) {
              id = pos.length / 3;
              vmap.set(key, id);
              pos.push(vx[a - 1] || 0, vy[a - 1] || 0, vz[a - 1] || 0);
              if (b > 0 && tx.length) uvs.push(tx[b - 1] || 0, ty[b - 1] || 0);
              else uvs.push(0, 0);
              if (cc > 0 && nx.length) nrm.push(nx[cc - 1] || 0, ny[cc - 1] || 0, nz[cc - 1] || 0);
              else if (nrm.length) nrm.push(0, 1, 0);
            }
            idx.push(id);
          }
        }
      }
    } else if (c === 117 && text.startsWith('usemtl', k)) {
      const name = text.slice(k + 6, j).trim();
      if (cur !== null) flush();
      cur = name;
    }
    i = j + 1;
  }
  flush();
  return parts;
}

/** 解析 MTL → { matName: { Kd, Bump, Ks } } */
export function parseMTL(text) {
  const out = {};
  let cur = null;
  const len = text.length;
  let i = 0;
  while (i < len) {
    let j = text.indexOf('\n', i);
    if (j < 0) j = len;
    let k = i;
    while (k < j && SPACE(text.charCodeAt(k))) k++;
    if (text.startsWith('newmtl', k)) {
      cur = text.slice(k + 6, j).trim();
      out[cur] = {};
    } else if (cur !== null && text.startsWith('map_', k)) {
      const sp = text.indexOf(' ', k);
      if (sp > 0 && sp < j) {
        const kind = text.slice(k, sp);
        let rest = text.slice(sp + 1, j).trim();
        if (rest.startsWith('-norm')) rest = rest.slice(5).trim();
        const file = rest.replace(/\\/g, '/').split('/').pop();
        if (kind === 'map_Kd') out[cur].Kd = file;
        else if (kind === 'map_Ks') out[cur].Ks = file;
        else if (kind === 'map_Bump') out[cur].Bump = file;
      }
    }
    i = j + 1;
  }
  return out;
}

/* ---------------------------------------------- 占位贴图识别
   BF4 导出里有一部分贴图是「调试贴图」，它们会让整栋楼变成卡通色。
   两种形态：
     1) 少数几块高饱和纯色块（纯绿/纯紫/纯红）→ flatColors
     2) 满屏高饱和噪声/彩色色斑（洋红-青-蓝）→ vivid
   真实建筑立面几乎完全无彩（实测均值饱和度 0.03~0.08），
   而这两种调试贴图是 0.64~1.00，分离度极大。 */
const AN = { c: null, g: null };
export function analyzeImage(img) {
  try {
    if (!AN.c) {
      AN.c = document.createElement('canvas');
      AN.c.width = 32; AN.c.height = 32;
      AN.g = AN.c.getContext('2d', { willReadFrequently: true });
    }
    const c = AN.c, g = AN.g;
    g.clearRect(0, 0, 32, 32);
    g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    const buckets = new Map();
    let sat = 0, noise = 0, lumaSum = 0, lumaN = 0, satSum = 0, vividPx = 0;
    const lum = new Float32Array(1024);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x);
        const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
        const key = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4);
        buckets.set(key, (buckets.get(key) || 0) + 1);
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        if (mx > 150 && (mx - mn) > 105) sat++;
        const s = mx > 0 ? (mx - mn) / mx : 0;
        satSum += s;
        if (mx > 60 && s > 0.40) vividPx++;
        const L = (r * 0.299 + gg * 0.587 + b * 0.114);
        lum[i] = L;
        lumaSum += L; lumaN++;
        if (x > 0) noise += Math.abs(L - lum[i - 1]);
        if (y > 0) noise += Math.abs(L - lum[i - 32]);
      }
    }
    const noiseMetric = noise / (2 * 31 * 32) / 255;
    const mean = lumaSum / Math.max(1, lumaN);
    let variance = 0;
    for (let i = 0; i < 1024; i++) variance += (lum[i] - mean) ** 2;
    variance /= 1024;
    let major = 0;
    for (const v of buckets.values()) if (v >= 32 * 32 * 0.05) major++;
    // 少数几块高饱和纯色
    const flatColors = major >= 2 && major <= 4 && sat >= 1024 * 0.30;
    // 整图高饱和（噪声/彩色斑块调试贴图）
    const meanSat = satSum / 1024;
    const vividFrac = vividPx / 1024;
    const vivid = meanSat > 0.45 && vividFrac > 0.60;
    return {
      placeholder: flatColors, vivid, major, sat, noiseMetric, variance,
      flatColors, meanSat, vividFrac,
    };
  } catch (e) {
    return { placeholder: false, vivid: false, major: 0, sat: 0, noiseMetric: 0, variance: 0, meanSat: 0, vividFrac: 0 };
  }
}

/* ---------------------------------------------- 双通道法线修复
   导出里有一批 *_n.png 是「两通道法线」（BC5/DXT5nm 解压后只留下 X/Y，
   Z 被填成常数 128）。按 three.js 的 2×c−1 解码会得到 z≈0，法线全部躺在
   切平面内：背光面纯黑、迎光面爆白，完全不是贴图本身的颜色。
   判据：合法切线空间法线的 B 通道整体偏高（实测角色贴图 B avg≈245~253），
   丢 Z 的则恒为 128。检测到后按 z = √(1 − x² − y²) 重建。 */
const NB = { c: null, g: null };
function normalZMissing(img) {
  try {
    if (!NB.c) {
      NB.c = document.createElement('canvas');
      NB.c.width = NB.c.height = 32;
      NB.g = NB.c.getContext('2d', { willReadFrequently: true });
    }
    const g = NB.g;
    g.clearRect(0, 0, 32, 32);
    g.drawImage(img, 0, 0, 32, 32);
    const d = g.getImageData(0, 0, 32, 32).data;
    let sum = 0, hi = 0;
    for (let i = 0; i < 1024; i++) {
      const b = d[i * 4 + 2];
      sum += b;
      if (b > 170) hi++;
    }
    const mean = sum / 1024;
    return hi < 102 && mean > 100 && mean < 175;   // B 既不高也不低 ⇒ 常数
  } catch (e) { return false; }
}

/** 由 X/Y 重建 Z，还原成标准切线空间法线贴图；返回 canvas（无法修复时返回 null） */
function rebuildNormalZ(img) {
  try {
    const w = img.width || 0, h = img.height || 0;
    if (!w || !h) return null;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const id = g.getImageData(0, 0, w, h);
    const d = id.data;
    for (let i = 0, n = w * h; i < n; i++) {
      const o = i * 4;
      const x = d[o] / 255 * 2 - 1;
      const y = d[o + 1] / 255 * 2 - 1;
      const z = Math.sqrt(Math.max(0, 1 - x * x - y * y));
      d[o] = (x * 0.5 + 0.5) * 255;
      d[o + 1] = (y * 0.5 + 0.5) * 255;
      d[o + 2] = (z * 0.5 + 0.5) * 255;
    }
    g.putImageData(id, 0, 0);
    return cv;
  } catch (e) { return null; }
}

/* ---------------------------------------------- 贴图缓存 */
export async function decodeImage(url, maxSize) {
  let blob;
  try {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) return null;
    blob = await r.blob();
  } catch (e) { return null; }

  if (typeof createImageBitmap === 'function') {
    try {
      const bm = await createImageBitmap(blob);
      const m = Math.max(bm.width, bm.height);
      if (m > maxSize) {
        const s = maxSize / m;
        const w = Math.max(1, Math.round(bm.width * s)), h = Math.max(1, Math.round(bm.height * s));
        const small = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
        if (bm.close) bm.close();
        return small;
      }
      return bm;
    } catch (e) { /* 回退到 Image */ }
  }
  const url2 = URL.createObjectURL(blob);
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej; im.src = url2;
    });
    const m = Math.max(img.width, img.height);
    if (m <= maxSize) return img;
    const s = maxSize / m;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.width * s));
    c.height = Math.max(1, Math.round(img.height * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } catch (e) { return null; }
  finally { URL.revokeObjectURL(url2); }
}

export class TexCache {
  constructor(maxAniso = 8) {
    this.texts = new Map();
    this.maps = new Map();
    this.pending = new Map();
    this.maxAniso = maxAniso;
    this.bytes = 0;
    this.count = 0;
  }
  async text(url) {
    if (this.texts.has(url)) return this.texts.get(url);
    const p = (async () => {
      try { const r = await fetch(url); return r.ok ? await r.text() : null; }
      catch (e) { return null; }
    })();
    this.texts.set(url, p);
    return p;
  }
  get(file, { srgb = true, maxSize = 512 } = {}) {
    if (!file) return Promise.resolve(null);
    const key = file + '|' + maxSize;
    const hit = this.maps.get(key);
    if (hit) return Promise.resolve(hit);
    const pend = this.pending.get(key);
    if (pend) return pend;
    const p = (async () => {
      let img = await decodeImage(ASSET_BASE + 'tex/' + file, maxSize);
      if (!img) return null;
      // 法线贴图（非 sRGB）：丢 Z 的两通道图会让表面非黑即白，先修再上传
      if (!srgb && normalZMissing(img)) {
        const fixed = rebuildNormalZ(img);
        if (fixed) img = fixed;
      }
      const t = new THREE.Texture(img);
      t.name = file;
      t.flipY = false;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = this.maxAniso;
      t.needsUpdate = true;
      if (srgb && maxSize >= 128) {
        const a = analyzeImage(img);
        t.userData.placeholder = a.placeholder;
        t.userData.analysis = a;          // vivid（高饱和调试图案）等指标留给 loadAsset 判断
        if (a.placeholder) {
          t.userData.placeholderInfo = `${file}`;
          this.placeholderCount = (this.placeholderCount || 0) + 1;
        }
      }
      this.maps.set(key, t);
      this.count++;
      this.bytes += (img.width || 0) * (img.height || 0) * 4 * 1.34;
      return t;
    })();
    this.pending.set(key, p);
    return p;
  }
}

/* ---------------------------------------------- 几何合并 */
export function mergeIndexed(list) {
  let vTotal = 0, iTotal = 0, hasNormal = true, hasUv = true;
  for (const g of list) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
    if (!g.attributes.normal) hasNormal = false;
    if (!g.attributes.uv) hasUv = false;
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = hasNormal ? new Float32Array(vTotal * 3) : null;
  const uv = hasUv ? new Float32Array(vTotal * 2) : null;
  const idx = vTotal > 65535 ? new Uint32Array(iTotal) : new Uint16Array(iTotal);
  let vo = 0, io = 0;
  for (const g of list) {
    const p = g.attributes.position;
    pos.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (nrm) nrm.set(g.attributes.normal.array.subarray(0, p.count * 3), vo * 3);
    if (uv) uv.set(g.attributes.uv.array.subarray(0, p.count * 2), vo * 2);
    if (g.index) {
      const a = g.index.array;
      for (let i = 0; i < a.length; i++) idx[io++] = a[i] + vo;
    } else {
      for (let i = 0; i < p.count; i++) idx[io++] = i + vo;
    }
    vo += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nrm) out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  if (!nrm) out.computeVertexNormals();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/* ---------------------------------------------- 材质 */
const PRESETS = {
  building: { roughness: 0.88, metalness: 0.04, env: 0.45 },
  prop: { roughness: 0.76, metalness: 0.14, env: 0.6 },
  vehicle: { roughness: 0.38, metalness: 0.45, env: 1.0 },
  // 枪械是阳极氧化铝 + 聚合物 + 漆面，不是裸金属：
  // 金属度必须压得很低（否则漫反射被吃掉、反照率变成金属反射色），
  // 光泽交由 clearcoat 这层清漆来表现。
  // 工程塑料/漆面不需要厚清漆：clearcoat 与 env 提供的是「不带反照率色」的
  // 中性高光，一旦压过暗色漫反射，棕色枪身就会被洗成冷灰、看起来像裸金属。
  weapon: { roughness: 0.56, metalness: 0.06, env: 0.42, coat: 0.18, coatRough: 0.45 },
  character: { roughness: 0.70, metalness: 0.05, env: 0.5 },
  ground: { roughness: 0.95, metalness: 0.02, env: 0.25 },
  backdrop: { roughness: 1.0, metalness: 0.0, env: 0.15 },
};

export const matSig = (ref) => ref ? `${ref.Kd || ''}|${ref.Bump || ''}|${ref.Ks || ''}` : '';

export async function makeMaterial(tex, ref, opt = {}) {
  const preset = PRESETS[opt.preset] || PRESETS.prop;
  const maxSize = opt.maxSize || 512;
  const src = ref || {};
  const map = await tex.get(src.Kd, { srgb: true, maxSize });
  let normalMap = null;
  if (opt.loadNormal && src.Bump) normalMap = await tex.get(src.Bump, { srgb: false, maxSize });

  const nm = (src.Kd || '') + ' ' + (src.Bump || '') + ' ' + (opt.tag || '');
  const reflectiveFacade = /glass|window|facade|skyscraper/i.test(nm) && !/broken|destr/i.test(nm);
  const transparentGlass = /glass|window/i.test(nm) && !/broken|destr/i.test(nm);
  // 需要清漆层（漆面）时也必须走 Physical，MeshStandardMaterial 没有 clearcoat
  const usePhysical = reflectiveFacade || opt.preset === 'building'
    || opt.preset === 'vehicle' || preset.coat !== undefined;
  const Material = usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  // 材质参数可由资产清单的 mat 逐项覆盖（个别资产的贴图与预设不匹配时用它兜底）
  const M = opt.mat || {};
  const params = {
    map,
    normalMap,
    roughness: M.roughness ?? (reflectiveFacade ? Math.min(preset.roughness, 0.34) : preset.roughness),
    metalness: M.metalness ?? (reflectiveFacade ? Math.max(preset.metalness, 0.16) : preset.metalness),
    envMapIntensity: M.env ?? (reflectiveFacade ? Math.max(preset.env, 1.25) : preset.env),
    side: opt.side ?? THREE.FrontSide,
    fog: opt.fog !== false,
  };
  // clearcoat 只有 Physical 材质支持，写给 Standard 会被忽略并刷警告
  if (usePhysical) {
    params.clearcoat = M.coat ?? (preset.coat !== undefined ? preset.coat : (reflectiveFacade ? 0.76 : 0.18));
    params.clearcoatRoughness = M.coatRough ?? (preset.coatRough !== undefined ? preset.coatRough : (reflectiveFacade ? 0.14 : 0.48));
  }
  const mat = new Material(params);
  if (normalMap) mat.normalScale.set(M.normalScale ?? 1, M.normalScale ?? 1);

  if (transparentGlass && opt.glass !== false) {
    mat.transparent = true;
    mat.opacity = 0.40;
    mat.roughness = 0.06;
    mat.metalness = 0.02;
    mat.side = THREE.DoubleSide;
    mat.depthWrite = false;
    mat.envMapIntensity = 1.8;
  }
  if (opt.emissive) {
    mat.emissive = new THREE.Color(opt.emissive);
    if (map) mat.emissiveMap = map;
    mat.emissiveIntensity = opt.emissiveIntensity ?? 1;
  }
  if (!map) mat.color = new THREE.Color(opt.fallbackColor ?? 0x8a8f96);
  else if (M.albedo) mat.color.setScalar(M.albedo);   // 压暗/提亮贴图（>1 会提亮反照率）
  return mat;
}

/* ---------------------------------------------- 载入一个资产 */
/**
 * opt:
 *   preset        材质预设 (building/prop/vehicle/weapon/character/ground/backdrop)
 *   maxSize       贴图最大边长
 *   loadNormal    是否加载法线贴图
 *   pivot         'base'(默认, XZ居中且贴地) | 'origin'(保留原始坐标) | 'center'(完全居中)
 *   side          THREE 面剔除
 *   emissive      自发光颜色
 */
export async function loadAsset(tex, name, opt = {}) {
  const [objText, mtlText] = await Promise.all([
    tex.text(ASSET_BASE + 'obj/' + name + '.obj'),
    tex.text(ASSET_BASE + 'obj/' + name + '.mtl'),
  ]);
  if (!objText) return null;
  const mtl = mtlText ? parseMTL(mtlText) : {};
  const raw = parseOBJ(objText);
  if (!raw.length) return null;

  // 按材质签名归并，减少部件数与 draw call
  const groups = new Map();
  for (const p of raw) {
    const ref = mtl[p.mtl] || null;
    const sig = matSig(ref) || '__none__';
    if (!groups.has(sig)) groups.set(sig, { ref, parts: [] });
    groups.get(sig).parts.push(p);
  }

  const box = new THREE.Box3();
  const parts = [];
  let tris = 0;

  for (const g of groups.values()) {
    const geos = [];
    for (const p of g.parts) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p.position, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(p.uv, 2));
      if (p.normal && opt.authoredNormals !== false) {
        geo.setAttribute('normal', new THREE.BufferAttribute(p.normal, 3));
      } else {
        geo.computeVertexNormals();
      }
      geo.setIndex(new THREE.BufferAttribute(p.index, 1));
      geos.push(geo);
      tris += p.index.length / 3;
    }
    const geometry = geos.length === 1 ? geos[0] : mergeIndexed(geos);
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox);

    let material;
    let usable = !!(g.ref && g.ref.Kd) && !opt.forceProcedural;
    if (usable) {
      // 引用的是调试占位贴图时同样走程序化材质
      const probe = await tex.get(g.ref.Kd, { srgb: true, maxSize: opt.maxSize || 512 });
      if (!probe || probe.userData.placeholder) usable = false;
      else {
        // 满屏高饱和的调试图案（洋红-青噪声等）：真实建筑立面几乎无彩，
        // 但霓虹灯、交通锥这类道具本来就鲜艳，所以只对建筑/远景生效，
        // 避免把发光招牌误判成占位块。
        const an = probe.userData.analysis;
        // 建筑、远景、地面都不可能是高饱和的；但霓虹灯、交通锥、灯笼等
        // 道具本来就鲜艳，必须排除，否则会把发光招牌误判成占位块。
        const architectural = opt.preset === 'building'
          || opt.preset === 'backdrop' || opt.preset === 'ground';
        if (an && an.vivid && architectural) usable = false;
      }
    }
    if (usable) {
      material = await makeMaterial(tex, g.ref, opt);
    } else {
      // 缺少材质 / 贴图是调试色块：套用程序化材质。
      // 关键点：程序化贴图按「世界单位 / 次循环」设计，必须用自己的重投影 UV，
      // 资产自带的 UV 密度往往比设计尺度高一个数量级（会把立面压成噪点）。
      const kind = pickMatKind(name);
      const cfg = PROC[kind] || PROC.concrete;
      const variant = hashName(name) % 4;
      if (opt.procKeepUV !== true) {
        boxProjectUV(geometry, cfg.tile[0], cfg.tile[1], variant);
      }
      paintVertexColor(geometry, hashName(name) % 9973,
        kind === 'glass' ? { tint: 0xe6eef2 } : { grime: true });
      material = procMaterial(kind, {
        low: !!opt.procLow,
        variant,
      });
    }
    parts.push({ geometry, material });
  }

  const size = new THREE.Vector3(), center = new THREE.Vector3();
  box.getSize(size); box.getCenter(center);

  const dims = [size.x, size.y, size.z].sort((a, b) => a - b);
  if (dims[2] > 1e-6 && dims[0] < dims[2] * 0.05 && opt.side === undefined) {
    for (const p of parts) if (!p.material.transparent) p.material.side = THREE.DoubleSide;
  }

  const pivot = opt.pivot || 'base';
  if (pivot !== 'origin') {
    const tx = pivot === 'center' ? -center.x : -center.x;
    const tz = pivot === 'center' ? -center.z : -center.z;
    const ty = pivot === 'center' ? -center.y : -box.min.y;
    for (const p of parts) {
      p.geometry.translate(tx, ty, tz);
      p.geometry.computeBoundingBox();
      p.geometry.computeBoundingSphere();
    }
    center.x += tx; center.y += ty; center.z += tz;
    box.min.add(new THREE.Vector3(tx, ty, tz));
    box.max.add(new THREE.Vector3(tx, ty, tz));
  }

  return { name, parts, tris, size, center, min: box.min.clone(), max: box.max.clone(), opt };
}

/* ---------------------------------------------- 夜间窗户掩膜 */
/**
 * 由立面漫反射贴图推导「窗户掩膜」，用作 emissiveMap。
 *
 * 为什么不能直接拿漫反射贴图当 emissiveMap：BF4 导出的立面上，
 * 玻璃窗是**暗区**（深色玻璃／黑色），墙体与楼板是**亮区**。
 * 直接把 map 当 emissiveMap 会让整面墙发光、窗户反而黑的，
 * 看上去就是「一整栋全在发光」，非常假。
 *
 * 这里按亮度取暗区生成掩膜（smoothstep 反相），再叠一层低频噪声，
 * 让不同楼段/窗格的亮度有变化，而不是整齐划一。
 * 结果按源贴图缓存（同一张贴图被多栋楼共用时只算一次）。
 *
 * 阈值用**分位数**而不是固定值：各张贴图的整体明暗差异极大
 * （例如某栋楼的贴图是一张整体偏暗的内饰图，固定阈值会让它整面全亮）。
 * 取亮度的 p12 / p32 作为暗区上下界，发光面积因此被锁在 30% 左右，
 * 且能自适应不同曝光的立面。
 */
const _maskCache = new WeakMap();
export function deriveWindowMask(srcTex, size = 256) {
  if (!srcTex || !srcTex.image) return null;
  const hit = _maskCache.get(srcTex);
  if (hit) return hit;
  try {
    const c = makeCanvas(size, size);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(srcTex.image, 0, 0, size, size);
    const img = g.getImageData(0, 0, size, size);
    const d = img.data;
    const n = size * size;

    const lum = new Float32Array(n);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) {
      const L = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
      lum[i] = L;
      hist[Math.min(255, (L * 255) | 0)]++;
    }
    const pct = (p) => {
      let acc = 0;
      for (let b = 0; b < 256; b++) {
        acc += hist[b];
        if (acc >= n * p) return b / 255;
      }
      return 1;
    };
    const lo = pct(0.12), hi = pct(0.32);
    // 明暗几乎没有层次（整体均匀的贴图）：没有「窗 vs 墙」可分离，
    // 只留极淡底光，避免随机斑块发光。
    const flat = (hi - lo) < 0.05;
    const nz = valueNoise2D(1337, 8);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        let m = flat ? 0 : (1 - smoothstep(lo, hi, lum[i]));
        if (m > 0.001) {
          // 低频变化：不同楼段/窗格亮度不一，避免整齐划一
          const v = 0.55 + 0.75 * nz((x / size) * 8, (y / size) * 8);
          m *= clamp(v, 0.2, 1.15);
        }
        const out = Math.round(clamp(Math.max(m, 0.05), 0, 1) * 255);
        const p = i * 4;
        d[p] = d[p + 1] = d[p + 2] = out;
        d[p + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.name = (srcTex.name || 'tex') + '_nightmask';
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    _maskCache.set(srcTex, t);
    return t;
  } catch (e) {
    return null;
  }
}

/* ---------------------------------------------- 辅助 */
export function hashName(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

export function hasValidUV(geometry) {
  const uv = geometry.attributes.uv;
  if (!uv) return false;
  const a = uv.array;
  for (let i = 0; i < a.length; i++) if (a[i] !== 0) return true;
  return false;
}

/** 从已有资产裁剪几何（按世界/本地 Y 区间），用于 1P 手臂等 */
export function clipGeometryY(geometry, yMin, yMax) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const idx = geometry.index;
  const keep = [];
  const n = idx ? idx.count : pos.count;
  const get = (i) => idx ? idx.getX(i) : i;
  let vCount = 0;
  const np = [], nn = [], nu = [], ni = [];
  const remap = new Map();
  for (let t = 0; t < n; t += 3) {
    const a = get(t), b = get(t + 1), c = get(t + 2);
    const ya = pos.getY(a), yb = pos.getY(b), yc = pos.getY(c);
    const inA = ya >= yMin && ya <= yMax, inB = yb >= yMin && yb <= yMax, inC = yc >= yMin && yc <= yMax;
    if (!inA && !inB && !inC) continue;
    for (const v of [a, b, c]) {
      let id = remap.get(v);
      if (id === undefined) {
        id = vCount++;
        remap.set(v, id);
        np.push(pos.getX(v), pos.getY(v), pos.getZ(v));
        if (nrm) nn.push(nrm.getX(v), nrm.getY(v), nrm.getZ(v));
        if (uv) nu.push(uv.getX(v), uv.getY(v));
      }
      ni.push(id);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(np), 3));
  if (nn.length) out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nn), 3));
  if (nu.length) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(nu), 2));
  out.setIndex(new THREE.BufferAttribute(vCount > 65535 ? new Uint32Array(ni) : new Uint16Array(ni), 1));
  if (!nn.length) out.computeVertexNormals();
  out.computeBoundingBox(); out.computeBoundingSphere();
  return out;
}
