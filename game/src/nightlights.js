/* ============================================================
   夜间街道照明 —— 烘焙光照贴图 + 玩家附近真实阴影

   街道光来自一张**启动时烘焙**的世界空间光贴图：

   1) bake(boxes)：CPU 一次性烘焙
      灯位是规则格点（world.js 的 LAMP：纵向街道两侧 z 每 46m、
      横向街道两侧 x 每 58m，铺满整个路网）。逐灯把光斑"盖章"到一张
      覆盖全城的 Float 缓冲上：衰减按平方衰减 × cos 项，遮挡体取自
      碰撞世界（楼房/店招墙/道具/弃车），对每个像素做一次
      灯头→地面 的 OBB 遮挡测试 —— 所以影子是烘死的：
      楼后、车底、道具背光面全是暗的，而且**每条街都有**，
      不依赖玩家位置，也没有动态光源数量的限制。
      结果转 HalfFloat DataTexture，mipmap + 各向异性，远处也干净。

   2) 着色器采样：路面/人行道/大地材质在片元里按世界 XZ 采样这张贴图，
      乘上夜间系数加进 indirectDiffuse。不需要 UV2，instancing 下
      所有实例自动对齐同一张贴图。

   3) 真实投影灯（3 盏 SpotLight）：吸附到离玩家最近的 3 个灯位，
      给**动态物体**（角色）补接触阴影 —— 静态阴影已经在贴图里了，
      所以强度压得比较低，只做点缀。

   4) 环境窗光（6 盏 PointLight，无阴影）：挂在最近塔楼的朝街窗墙，
      暖色洗墙，让楼体不至于纯黑。

   注意单位：three r160 默认物理光照，intensity 是坎德拉。
   ============================================================ */
import * as THREE from 'three';
import { LAMP } from './world.js';

/* ---- 烘焙参数 ---- */
const LMAP_SIZE = 1536;        // 光贴图边长（像素），0.495 m/px
const LMAP_WORLD = 760;        // 贴图覆盖的世界尺度（米），路网 ±348 + 光斑外溢
const BAKE_RADIUS = 22.0;      // 单盏灯的烘焙半径
const BAKE_FADE = 15.0;        // 从这里向外平滑淡出（避免圆盘出现硬边）
const POOL_INTENSITY = 2.35;   // 光斑强度（峰值辐照度 ≈ 1.5）
const POOL_BASE = 0.12;        // 全图底光：保证最远的街也不是死黑
const OCCLUDERS_MAX = 14;      // 每盏灯最多考虑的遮挡体数量
const OCCLUDE_MIN_ATT = 0.012; // 衰减低于此值就不再测遮挡（省时间）

/* ---- 真实光源参数 ---- */
const SHADOW_COUNT = 3;        // 投影路灯数
const GLOW_COUNT = 6;          // 环境窗光数
const GLOW_RANGE = 64.0;
const GLOW_INTENSITY = 150;
const SPOT_DIST = 34.0;
const SPOT_ANGLE = 1.02;       // 灯锥半角：地面半径 ≈ H·tan(1.02) ≈ 10m
const SPOT_INTENSITY = 32;     // 静态阴影已烘死，真实灯只给角色补接触阴影
const REASSIGN_INTERVAL = 0.35;

const LAMP_WARM = 0xffc98a;
const LAMP_COL = new THREE.Color(LAMP_WARM);

/* ---------------------------------------------------------- 遮挡测试 */
/**
 * 线段（灯头 → 地面点，t∈[0,1] 未归一化方向）是否穿过 OBB。
 * 约定与 BoxWorld 一致：绕 Y 旋转 (c=cos, s=sin)，局部 = [c -s; s c]·(p-center)。
 */
function boxBlocks(b, ox, oy, oz, dx, dy, dz) {
  const rx = ox - b.cx, rz = oz - b.cz;
  const lox = b.c * rx - b.s * rz;
  const loz = b.s * rx + b.c * rz;
  const ldx = b.c * dx - b.s * dz;
  const ldz = b.s * dx + b.c * dz;

  let tmin = 0, tmax = 1, t1, t2, t;
  if (ldx > -1e-9 && ldx < 1e-9) {
    if (lox < -b.hx || lox > b.hx) return false;
  } else {
    t1 = (-b.hx - lox) / ldx; t2 = (b.hx - lox) / ldx;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmax < tmin) return false;
  }
  if (ldz > -1e-9 && ldz < 1e-9) {
    if (loz < -b.hz || loz > b.hz) return false;
  } else {
    t1 = (-b.hz - loz) / ldz; t2 = (b.hz - loz) / ldz;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmax < tmin) return false;
  }
  if (dy > -1e-9 && dy < 1e-9) {
    if (oy < b.minY || oy > b.maxY) return false;
  } else {
    t1 = (b.minY - oy) / dy; t2 = (b.maxY - oy) / dy;
    if (t1 > t2) { t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
  }
  return tmax >= tmin;
}

/* ---------------------------------------------------------- 光照贴图着色器 */
const LMAP_PARS_GROUND = /* glsl */`
varying vec3 vLampWorld;
uniform float uLampNight;
uniform sampler2D uLampMap;
uniform vec4 uLampMapXf;   // xy=贴图左下角世界坐标 zw=1/世界尺寸

vec3 lampLight( vec3 wp ) {
  vec2 uv = ( wp.xz - uLampMapXf.xy ) * uLampMapXf.zw;
  return texture2D( uLampMap, uv ).rgb * uLampNight;
}
`;

/* 立面（道具/招牌/车辆）：光贴图存的是地面辐照度，直接糊上去会把
   11m 高的招牌照得和灯下地面一样亮，所以按离地高度衰减。 */
const LMAP_PARS_PROP = /* glsl */`
varying vec3 vLampWorld;
uniform float uLampNight;
uniform sampler2D uLampMap;
uniform vec4 uLampMapXf;

vec3 lampLight( vec3 wp ) {
  vec2 uv = ( wp.xz - uLampMapXf.xy ) * uLampMapXf.zw;
  float hfall = 1.0 / ( 1.0 + max( wp.y - 1.0, 0.0 ) * 0.35 );
  return texture2D( uLampMap, uv ).rgb * ( uLampNight * hfall );
}
`;

/**
 * 把街道光贴图接到一个材质上。
 * @param {boolean} vertical 立面物体（道具/招牌/车辆）：带离地高度衰减
 * 若材质已有 onBeforeCompile（缺贴图时退化成的程序化三平面材质），
 * 必须链式调用，否则会把三平面着色器顶掉。
 */
export function applyStreetLightmap(mat, uniforms, vertical = false) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(mat, shader, renderer);
    shader.uniforms.uLampNight = uniforms.night;
    shader.uniforms.uLampMap = uniforms.map;
    shader.uniforms.uLampMapXf = uniforms.xf;

    // 世界坐标：灯位在世界上固定不动，不能用视空间（相机一动光斑就跟着跑）
    shader.vertexShader = shader.vertexShader
      .replace('#include <begin_vertex>', /* glsl */`
#include <begin_vertex>
{
  vec4 lampWp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    lampWp = instanceMatrix * lampWp;
  #endif
  vLampWorld = ( modelMatrix * lampWp ).xyz;
}`)
      .replace('#include <common>', '#include <common>\nvarying vec3 vLampWorld;');

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${vertical ? LMAP_PARS_PROP : LMAP_PARS_GROUND}`)
      .replace('#include <lights_fragment_end>', /* glsl */`
#include <lights_fragment_end>
reflectedLight.indirectDiffuse += lampLight( vLampWorld ) * diffuseColor.rgb;`);
  };
  mat.customProgramCacheKey = () =>
    (prevKey ? prevKey.call(mat) : '') + (vertical ? '|street-lightmap-v' : '|street-lightmap');
  mat.needsUpdate = true;
  return mat;
}

/* ---------------------------------------------------------- 夜光池 */
export class NightLightPool {
  /**
   * @param {THREE.Scene} scene
   * @param {object} info    worldInfo（需要 lamps / glowPoints / lampMat）
   * @param {THREE.Material[]} groundMats 路面、人行道、大地材质（采样光贴图）
   * @param {THREE.Material[]} propMats 街面物体（招牌/道具/车辆，带离地衰减）
   */
  constructor(scene, info, groundMats = [], propMats = []) {
    this.scene = scene;
    this.lamps = (info && info.lamps) || [];
    this.glowPoints = (info && info.glowPoints) || [];
    this.lampMat = info && info.lampMat;
    this.lampWarm = (info && info.lampWarm) || new THREE.Color(LAMP_WARM);

    this._key = -1;
    this._t = REASSIGN_INTERVAL;
    this._baked = false;

    /* ---- 光贴图 uniform：一块改全部生效 ---- */
    const half = LMAP_WORLD / 2;
    this.uniforms = {
      night: { value: 0 },
      map: { value: null },
      xf: { value: new THREE.Vector4(-half, -half, 1 / LMAP_WORLD, 1 / LMAP_WORLD) },
    };
    // 烘焙前的占位：1×1 底光，避免头几帧街道全黑
    const br = LAMP_COL.r * POOL_BASE, bg = LAMP_COL.g * POOL_BASE, bb = LAMP_COL.b * POOL_BASE;
    this.uniforms.map.value = new THREE.DataTexture(
      new Float32Array([br, bg, bb, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.uniforms.map.value.needsUpdate = true;

    for (const m of groundMats) if (m) applyStreetLightmap(m, this.uniforms, false);
    for (const m of propMats) if (m) applyStreetLightmap(m, this.uniforms, true);

    /* ---- 投影路灯：SpotLight 垂直向下，挂在灯头上 ---- */
    this.spots = [];
    for (let i = 0; i < SHADOW_COUNT; i++) {
      const s = new THREE.SpotLight(LAMP_WARM, 0, SPOT_DIST, SPOT_ANGLE, 0.72, 1.7);
      s.position.set(0, LAMP.H, 0);
      s.target.position.set(0, 0, 0);
      s.castShadow = true;
      s.shadow.mapSize.set(1024, 1024);
      s.shadow.camera.near = 0.5;
      s.shadow.camera.far = SPOT_DIST;
      s.shadow.bias = -0.0004;
      s.shadow.normalBias = 0.03;
      // 光源常驻可见、白天强度为 0。绝不用 visible 开关 ——
      // three 会因光源数量变化重编译全部材质，昼夜切换时明显卡顿。
      scene.add(s, s.target);
      this.spots.push(s);
    }

    /* ---- 环境窗光：PointLight 无阴影 ---- */
    this.glows = [];
    for (let i = 0; i < GLOW_COUNT; i++) {
      const p = new THREE.PointLight(LAMP_WARM, 0, GLOW_RANGE, 1.6);
      p.position.set(0, 12, 0);
      scene.add(p);
      const warm = 0.92 + 0.16 * Math.random();   // 色温微差
      p.color.setRGB(warm, 0.76 * warm, 0.55 * warm);
      this.glows.push({ light: p, phase: Math.random() * 6.28 });
    }
  }

  /**
   * 烘焙街道光照贴图（启动时调用一次，约几百毫秒）。
   * @param {BoxWorld} boxes 碰撞世界：遮挡体来源（楼/店招/道具/弃车）
   */
  bake(boxes) {
    if (this._baked) return;
    this._baked = true;
    const t0 = performance.now();

    const N = LMAP_SIZE, W = LMAP_WORLD, half = W / 2;
    const mpp = W / N;                       // 米 / 像素
    const buf = new Float32Array(N * N * 3);

    // 1) 全图底光
    const br = LAMP_COL.r * POOL_BASE, bg = LAMP_COL.g * POOL_BASE, bb = LAMP_COL.b * POOL_BASE;
    for (let i = 0; i < buf.length; i += 3) { buf[i] = br; buf[i + 1] = bg; buf[i + 2] = bb; }

    // 2) 逐灯盖章：光斑 + 遮挡影子
    if (boxes && this.lamps.length) {
      const R = BAKE_RADIUS, R2 = R * R, H = LAMP.H;
      const DEN0 = R2 + H * H;
      const fadeK = 1 / Math.max(1e-3, R - BAKE_FADE);
      const ir = LAMP_COL.r * POOL_INTENSITY, ig = LAMP_COL.g * POOL_INTENSITY, ib = LAMP_COL.b * POOL_INTENSITY;
      const rpx = R / mpp;
      const cand = [], occ = [];

      for (let li = 0; li < this.lamps.length; li++) {
        const l = this.lamps[li];

        // 候选遮挡体：灯周范围内的碰撞盒（贴地薄物忽略）
        boxes.candidates(l.x, l.z, R + 6, cand);
        occ.length = 0;
        for (let n = 0; n < cand.length && occ.length < OCCLUDERS_MAX; n++) {
          const b = cand[n];
          if (b.maxY < 0.45) continue;
          const ex = Math.abs(b.c) * b.hx + Math.abs(b.s) * b.hz;
          const ez = Math.abs(b.s) * b.hx + Math.abs(b.c) * b.hz;
          const ddx = b.cx - l.x, ddz = b.cz - l.z;
          const rr = Math.sqrt(ex * ex + ez * ez);
          const reach = R + rr;
          if (ddx * ddx + ddz * ddz > reach * reach) continue;
          occ.push(b);
        }

        // 光斑圆盘（外圈平滑淡出）
        const cx = (l.x + half) * (N / W), cz = (l.z + half) * (N / W);
        const px0 = Math.max(0, Math.floor(cx - rpx)), px1 = Math.min(N - 1, Math.ceil(cx + rpx));
        const py0 = Math.max(0, Math.floor(cz - rpx)), py1 = Math.min(N - 1, Math.ceil(cz + rpx));

        for (let py = py0; py <= py1; py++) {
          const wz = (py + 0.5) * mpp - half;
          const dz = wz - l.z, dz2 = dz * dz;
          const row = py * N;
          for (let px = px0; px <= px1; px++) {
            const wx = (px + 0.5) * mpp - half;
            const dx = wx - l.x;
            const d2 = dx * dx + dz2;
            if (d2 > R2) continue;
            const d3 = Math.sqrt(d2 + H * H);
            let a = R2 / (DEN0 + d2);
            let att = a * a * (H / d3);
            const Dh = Math.sqrt(d2);
            if (Dh > BAKE_FADE) {          // 外圈淡出，避免圆盘硬边
              let f = (Dh - BAKE_FADE) * fadeK;
              att *= 1 - f * f * (3 - 2 * f);
            }
            if (att < OCCLUDE_MIN_ATT) continue;
            // 遮挡：灯头 → 地面点 的射线穿过任何碰撞盒则这盏灯照不到
            if (occ.length) {
              const dyp = -H;
              let blocked = false;
              for (let n = 0; n < occ.length; n++) {
                if (boxBlocks(occ[n], l.x, H, l.z, dx, dyp, dz)) { blocked = true; break; }
              }
              if (blocked) continue;
            }
            const k = (row + px) * 3;
            buf[k] += ir * att; buf[k + 1] += ig * att; buf[k + 2] += ib * att;
          }
        }
      }
    }

    // 3) 转 HalfFloat 数据纹理（线性光照值，允许 >1）
    const data = new Uint16Array(N * N * 4);
    const toHalf = THREE.DataUtils.toHalfFloat;
    const one = toHalf(1);
    for (let i = 0, j = 0; i < buf.length; i += 3, j += 4) {
      data[j] = toHalf(buf[i]);
      data[j + 1] = toHalf(buf[i + 1]);
      data[j + 2] = toHalf(buf[i + 2]);
      data[j + 3] = one;
    }
    const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    this.uniforms.map.value = tex;

    console.log(`[街道光照] 烘焙 ${N}² 光照贴图（${this.lamps.length} 盏灯）` +
      ` ${Math.round(performance.now() - t0)}ms`);
  }

  /**
   * 每帧调用。
   * @param {number} px 玩家 x
   * @param {number} pz 玩家 z
   * @param {number} night 夜间系数 [0,1]
   * @param {number} dt 帧间隔
   */
  update(px, pz, night, dt = 0.016) {
    this.uniforms.night.value = night;
    // 灯头可见亮度（白昼是深色玻璃罩，入夜逐渐点亮的钠灯）
    if (this.lampMat) this.lampMat.color.copy(this.lampWarm).multiplyScalar(0.10 + night * 1.85);

    if (night <= 0.02) {
      for (const s of this.spots) s.intensity = 0;
      for (const g of this.glows) g.light.intensity = 0;
      this._key = -1;          // 下次入夜重新吸附
      return;
    }

    // 只在"最近的灯位换了"时重新吸附：灯位是格点，玩家沿街走 ~23m 才换一次，
    // 不会出现每帧挪灯造成的阴影抖动。
    this._t += dt;
    if (this._key < 0 || this._t >= REASSIGN_INTERVAL) {
      this._t = 0;
      const k = this._nearestLamp(px, pz);
      if (k !== this._key) { this._key = k; this._reassign(px, pz); }
    }

    const t = performance.now() * 0.001;
    for (const s of this.spots) s.intensity = SPOT_INTENSITY * night;
    for (const g of this.glows) {
      const breathe = 0.85 + 0.15 * Math.sin(t * 0.7 + g.phase);
      g.light.intensity = GLOW_INTENSITY * night * breathe;
    }
  }

  /** 最近的灯位索引（灯位是格点，索引变化 ≈ 玩家走过两灯中点） */
  _nearestLamp(px, pz) {
    const lamps = this.lamps;
    let best = -1, bd = Infinity;
    for (let i = 0; i < lamps.length; i++) {
      const l = lamps[i];
      const d = (l.x - px) * (l.x - px) + (l.z - pz) * (l.z - pz);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** 投影灯吸附到离玩家最近的几个灯位；环境窗光吸附到最近的塔楼窗墙 */
  _reassign(px, pz) {
    const lamps = this.lamps;
    if (!lamps.length) return;

    const used = new Set();
    for (const s of this.spots) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < lamps.length; i++) {
        if (used.has(i)) continue;
        const l = lamps[i];
        const d = (l.x - px) * (l.x - px) + (l.z - pz) * (l.z - pz);
        if (d < bd) { bd = d; best = i; }
      }
      if (best < 0) break;
      used.add(best);
      const l = lamps[best];
      s.position.set(l.x, LAMP.H + 0.35, l.z);
      s.target.position.set(l.x, 0, l.z);
      s.target.updateMatrixWorld();
    }

    // 环境窗光：最近的几栋塔楼，从塔心向玩家外移挂在朝街一面
    if (!this.glowPoints.length) return;
    const sorted = this.glowPoints
      .map((p, i) => ({ i, d: (p.x - px) ** 2 + (p.z - pz) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, this.glows.length);
    for (let n = 0; n < this.glows.length; n++) {
      const c = sorted[n];
      if (!c) break;
      const g = this.glows[n];
      const p = this.glowPoints[c.i];
      const dist = Math.sqrt(c.d);
      if (dist < 1) { g.light.position.set(p.x, 12, p.z); continue; }
      const k = Math.min(14, dist * 0.55) / dist;
      g.light.position.set(p.x + (px - p.x) * k, 12, p.z + (pz - p.z) * k);
    }
  }

  dispose() {
    for (const s of this.spots) { this.scene.remove(s, s.target); s.dispose(); }
    for (const g of this.glows) { this.scene.remove(g.light); g.light.dispose(); }
    const tex = this.uniforms.map.value;
    if (tex && tex.dispose) tex.dispose();
  }
}
