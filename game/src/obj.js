/* ============================================================
   BF4 导出资产加载器
   - 读取 obj/<name>.obj + obj/<name>.mtl + tex/<name>.png
     （与 export/index.html 的资源约定完全一致）
   - 顶点按 (v / vt) 焊接为索引几何体，使用作者法线
   - 贴图按类别降采样，控制显存占用
   ============================================================ */
import * as THREE from 'three';
import { pickMatKind, PROC, procMaterial, boxProjectUV, paintVertexColor } from './proc.js';

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
   BF4 导出里有一部分贴图是「调试 UV 色块」（纯绿/纯紫/纯红），
   它们会让整栋楼变成卡通色。这里做一次极低成本的分析并剔除。 */
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
    let sat = 0, noise = 0, lumaSum = 0, lumaN = 0;
    const lum = new Float32Array(1024);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const i = (y * 32 + x);
        const r = d[i * 4], gg = d[i * 4 + 1], b = d[i * 4 + 2];
        const key = ((r >> 4) << 8) | ((gg >> 4) << 4) | (b >> 4);
        buckets.set(key, (buckets.get(key) || 0) + 1);
        const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
        if (mx > 150 && (mx - mn) > 105) sat++;
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
    // 仅识别「少数几块高饱和纯色」的调试 UV 色块贴图，
    // 不能用高频噪声作为判据：真实建筑贴图（窗格阵列）同样高频。
    const flatColors = major >= 2 && major <= 4 && sat >= 1024 * 0.30;
    return { placeholder: flatColors, major, sat, noiseMetric, variance, flatColors };
  } catch (e) {
    return { placeholder: false, major: 0, sat: 0, noiseMetric: 0, variance: 0 };
  }
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
      const img = await decodeImage(ASSET_BASE + 'tex/' + file, maxSize);
      if (!img) return null;
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
  weapon: { roughness: 0.38, metalness: 0.55, env: 1.0 },
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
  const usePhysical = reflectiveFacade || opt.preset === 'building' || opt.preset === 'vehicle';
  const Material = usePhysical ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const params = {
    map,
    normalMap,
    roughness: reflectiveFacade ? Math.min(preset.roughness, 0.34) : preset.roughness,
    metalness: reflectiveFacade ? Math.max(preset.metalness, 0.16) : preset.metalness,
    envMapIntensity: reflectiveFacade ? Math.max(preset.env, 1.25) : preset.env,
    side: opt.side ?? THREE.FrontSide,
    fog: opt.fog !== false,
  };
  // clearcoat 只有 Physical 材质支持，写给 Standard 会被忽略并刷警告
  if (usePhysical) {
    params.clearcoat = reflectiveFacade ? 0.76 : 0.18;
    params.clearcoatRoughness = reflectiveFacade ? 0.14 : 0.48;
  }
  const mat = new Material(params);
  if (normalMap) mat.normalScale.set(opt.normalScale ?? 1, opt.normalScale ?? 1);

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
