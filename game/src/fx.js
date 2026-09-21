/* ============================================================
   特效系统：曳光弹 / 枪口火焰 / 弹着火花 / 尘烟 / 弹孔贴花 /
             抛壳 / 血雾 / 爆炸
   全部使用对象池，避免运行时 GC 抖动
   ============================================================ */
import * as THREE from 'three';
import {
  makeGlowTexture, makeFlashTexture, makeSmokeTexture,
  makeBulletHoleTexture, makeBloodTexture, clamp, smoothstep,
} from './util.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4(), _quat = new THREE.Quaternion(), _eul = new THREE.Euler();
const _pScale = new THREE.Vector3(1, 1, 1);
const _pCol = new THREE.Color(1, 1, 1);

export class FX {
  constructor(scene, camera, boxes) {
    this.scene = scene;
    this.camera = camera;
    this.boxes = boxes;

    this.texGlow = makeGlowTexture(128, [255, 224, 168], 2.4);
    this.texFlash = makeFlashTexture(256, 5);
    this.texSmoke = makeSmokeTexture(128, 9);
    this.texHole = makeBulletHoleTexture(128, 3);
    this.texBlood = makeBloodTexture(128, 21);

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);

    // ---- 曳光弹池
    const tracerGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 6, 1, true);
    tracerGeo.rotateX(Math.PI / 2);
    this.tracerGeo = tracerGeo;
    this.tracers = [];
    for (let i = 0; i < 28; i++) {
      const m = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({
        color: 0xffd48a, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      m.visible = false; m.frustumCulled = false; m.renderOrder = 8;
      this.group.add(m);
      this.tracers.push({ mesh: m, life: 0, max: 0.1, a: new THREE.Vector3(), b: new THREE.Vector3(), len: 0.5 });
    }

    // ---- 枪口火焰
    this.flashes = [];
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: this.texFlash, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false, fog: false, opacity: 0,
      }));
      m.visible = false; m.frustumCulled = false; m.renderOrder = 20;
      this.group.add(m);
      this.flashes.push({ mesh: m, life: 0 });
    }
    // 枪口照明（复用少量点光源）
    this.flashLights = [];
    for (let i = 0; i < 3; i++) {
      const l = new THREE.PointLight(0xffbb66, 0, 12, 2);
      l.visible = false;
      this.group.add(l);
      this.flashLights.push({ light: l, life: 0 });
    }

    // ---- 火花粒子
    this.sparkTex = makeGlowTexture(64, [255, 210, 140], 2.0);
    this.sparkPools = [];
    for (let i = 0; i < 16; i++) {
      const N = 18;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      const p = new THREE.Points(g, new THREE.PointsMaterial({
        map: this.sparkTex, size: 0.06, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, sizeAttenuation: true, color: 0xffc070, fog: false, opacity: 0,
      }));
      p.visible = false; p.frustumCulled = false; p.renderOrder = 9;
      this.group.add(p);
      this.sparkPools.push({
        pts: p, vel: new Float32Array(N * 3), life: 0, max: 0.4, n: N,
        origin: new THREE.Vector3(),
      });
    }

    // ---- 尘烟
    this.smokes = [];
    for (let i = 0; i < 22; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: this.texSmoke, transparent: true, depthWrite: false, opacity: 0,
        color: 0xbfb6a6, fog: true,
      }));
      m.visible = false; m.frustumCulled = false; m.renderOrder = 6;
      this.group.add(m);
      this.smokes.push({ mesh: m, life: 0, max: 1, vel: new THREE.Vector3(), grow: 1, spin: 0 });
    }

    // ---- 弹孔贴花
    this.decals = [];
    const decalMat = new THREE.MeshBasicMaterial({
      map: this.texHole, transparent: true, depthWrite: false, opacity: 0.95,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, fog: true,
    });
    for (let i = 0; i < 90; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), decalMat);
      m.visible = false; m.frustumCulled = false; m.renderOrder = 4;
      this.group.add(m);
      this.decals.push({ mesh: m, life: 0, max: 30 });
    }
    this.decalIdx = 0;

    // ---- 弹壳
    this.casings = [];
    const caseGeo = new THREE.CylinderGeometry(0.005, 0.005, 0.022, 5);
    caseGeo.rotateZ(Math.PI / 2);
    for (let i = 0; i < 40; i++) {
      const m = new THREE.Mesh(caseGeo, new THREE.MeshStandardMaterial({
        color: 0xc9a24a, metalness: 0.85, roughness: 0.32,
      }));
      m.visible = false; m.frustumCulled = false;
      this.group.add(m);
      this.casings.push({ mesh: m, life: 0, vel: new THREE.Vector3(), spin: new THREE.Vector3() });
    }
    this.caseIdx = 0;

    // ---- 血雾
    this.bloods = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: this.texBlood, transparent: true, depthWrite: false, opacity: 0, fog: false,
      }));
      m.visible = false; m.frustumCulled = false; m.renderOrder = 7;
      this.group.add(m);
      this.bloods.push({ mesh: m, life: 0, max: 0.45, scale: 1 });
    }

    // ---- 爆炸
    this.booms = [];
    for (let i = 0; i < 5; i++) {
      const light = new THREE.PointLight(0xffa040, 0, 26, 2);
      light.visible = false;
      this.group.add(light);
      const flash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
        map: this.texFlash, transparent: true, blending: THREE.AdditiveBlending,
        depthWrite: false, depthTest: false, fog: false, opacity: 0, color: 0xffd9a0,
      }));
      flash.visible = false; flash.frustumCulled = false; flash.renderOrder = 21;
      this.group.add(flash);
      this.booms.push({ light, flash, life: 0, max: 0.7 });
    }

    // ---- 飞舞的纸屑（战场氛围）
    // 一小撮围绕相机循环的纸片：随风飘、边落边翻滚，出界就从另一侧绕回来，
    // 因此不需要重新生成，也不会跑出视野范围。
    this.paperN = 340;
    this.paperR = { x: 36, z: 36, y0: -2.5, y1: 24 };
    this.paper = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.20, 0.28),
      new THREE.MeshLambertMaterial({
        side: THREE.DoubleSide, fog: true,
        emissive: 0x1b1915,          // 夜里也能看见一点点轮廓
      }),
      this.paperN,
    );
    this.paper.frustumCulled = false;
    this.paper.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.paper.renderOrder = 5;
    this.group.add(this.paper);
    this.paperD = {
      pos: new Float32Array(this.paperN * 3),
      fall: new Float32Array(this.paperN),
      rot: new Float32Array(this.paperN * 3),
      spin: new Float32Array(this.paperN * 3),
      phase: new Float32Array(this.paperN),
      sway: new Float32Array(this.paperN),
      scale: new Float32Array(this.paperN),
    };
    {
      const d = this.paperD, c = new THREE.Color();
      const inks = [
        [0.88, 0.86, 0.79],   // 复印纸
        [0.78, 0.74, 0.66],   // 旧报纸
        [0.72, 0.62, 0.47],   // 牛皮纸
        [0.60, 0.60, 0.58],   // 灰纸
        [0.40, 0.36, 0.33],   // 烧焦的边角
      ];
      for (let i = 0; i < this.paperN; i++) {
        const i3 = i * 3;
        d.pos[i3] = (Math.random() - 0.5) * this.paperR.x * 2;
        d.pos[i3 + 1] = this.paperR.y0 + Math.random() * (this.paperR.y1 - this.paperR.y0);
        d.pos[i3 + 2] = (Math.random() - 0.5) * this.paperR.z * 2;
        // 大部分被风裹着走，约两成被上升气流托着往上翻（整体比"安静飘落"快得多）
        d.fall[i] = Math.random() < 0.22
          ? 0.9 + Math.random() * 1.7
          : -(1.4 + Math.random() * 1.9);
        d.rot[i3] = Math.random() * 6.28;
        d.rot[i3 + 1] = Math.random() * 6.28;
        d.rot[i3 + 2] = Math.random() * 6.28;
        d.spin[i3] = (Math.random() - 0.5) * 11.0;
        d.spin[i3 + 1] = (Math.random() - 0.5) * 13.0;
        d.spin[i3 + 2] = (Math.random() - 0.5) * 9.0;
        d.phase[i] = Math.random() * 6.28;
        d.sway[i] = 1.4 + Math.random() * 2.2;
        d.scale[i] = 0.7 + Math.random() * 0.9;
        const u = Math.random();
        const ink = u < 0.45 ? inks[0] : u < 0.62 ? inks[1] : u < 0.75 ? inks[2] : u < 0.9 ? inks[3] : inks[4];
        c.setRGB(ink[0], ink[1], ink[2]);
        this.paper.setColorAt(i, c);
      }
      if (this.paper.instanceColor) this.paper.instanceColor.needsUpdate = true;
    }

    // ---- 燃烧点：浓烟柱 + 火光
    // 烟团全部塞进一个 InstancedMesh（一趟画完），逐实例用 instanceColor 做"火源黑烟 → 高空灰白"的渐变；
    // 因为没有逐实例透明度，消散靠"先膨胀后收缩"，配合较低的整体 opacity 与多层叠加效果。
    this.fires = [];
    this.fireMax = 16;
    this.firePuffN = 60;         // 每个火点 60 个烟团：层距小于烟团直径，柱体才不会出现断层
    const fireGeo = new THREE.PlaneGeometry(1, 1);
    const puffCount = this.fireMax * this.firePuffN;
    this.fireSmoke = new THREE.InstancedMesh(fireGeo, new THREE.MeshBasicMaterial({
      map: this.texSmoke, transparent: true, depthWrite: false, opacity: 0.75, fog: true,
    }), puffCount);
    this.fireSmoke.frustumCulled = false;
    this.fireSmoke.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fireSmoke.renderOrder = 6;
    this.fireSmoke.visible = false;
    this.group.add(this.fireSmoke);

    this.flameCount = 6;      // 每个火点的火舌精灵数
    this.fireFlames = new THREE.InstancedMesh(fireGeo, new THREE.MeshBasicMaterial({
      map: this.texGlow, transparent: true, blending: THREE.AdditiveBlending,
      depthWrite: false, fog: false,
    }), this.fireMax * this.flameCount);
    this.fireFlames.frustumCulled = false;
    this.fireFlames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.fireFlames.renderOrder = 9;
    this.fireFlames.visible = false;
    this.group.add(this.fireFlames);

    this.firePuffs = [];
    for (let i = 0; i < puffCount; i++) {
      this.firePuffs.push({
        site: -1, age: 0, life: 1, size: 1, sway: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      });
      this.fireSmoke.setColorAt(i, _pCol.setScalar(0.2));
    }
    for (let i = 0; i < this.fireMax * this.flameCount; i++) this.fireFlames.setColorAt(i, _pCol.setScalar(0));
    if (this.fireSmoke.instanceColor) this.fireSmoke.instanceColor.needsUpdate = true;
    if (this.fireFlames.instanceColor) this.fireFlames.instanceColor.needsUpdate = true;
    // 未启用的实例不参与绘制（否则会留在世界原点）
    this.fireSmoke.count = 0;
    this.fireFlames.count = 0;

    this._windV = { x: 0, z: 0 };
    this.time = 0;
  }

  /* ---------------------------------------- 燃烧点 */
  /** 在某处点一把火：又黑又浓的烟柱从 (x,y,z) 往上冒，底部有闪烁的火光精灵 */
  addFire(x, y, z, scale = 1) {
    if (this.fires.length >= this.fireMax) return null;
    const idx = this.fires.length;
    const site = { x, y, z, s: scale, seed: Math.random() * 100, flames: [] };
    // 不给火点挂 PointLight：多一盏灯等于所有受光材质的片元着色器多跑一轮，
    // "火光"改用叠加混合的火舌精灵来表现，零光照开销。
    for (let k = 0; k < this.flameCount; k++) {
      const a = (k / this.flameCount) * 6.28 + Math.random();
      site.flames.push({
        ox: Math.cos(a) * (1.2 + Math.random() * 2.2) * scale,
        oz: Math.sin(a) * (1.2 + Math.random() * 2.2) * scale,
        oy: (0.5 + Math.random() * 2.2) * scale,
        ph: Math.random() * 6.28,
        sp: 5 + Math.random() * 6,
      });
    }
    this.fires.push(site);
    const base = idx * this.firePuffN;
    for (let k = 0; k < this.firePuffN; k++) {
      const p = this.firePuffs[base + k];
      p.site = idx;
      this._respawnPuff(p, true);      // 预置成成熟状态，开场就是一根完整的烟柱
    }
    // 只绘制已启用的实例
    this.fireSmoke.count = (idx + 1) * this.firePuffN;
    this.fireFlames.count = (idx + 1) * this.flameCount;
    return site;
  }

  _respawnPuff(p, mature = false) {
    const site = this.fires[p.site];
    const s = site.s;
    // 寿命、上升速度、尺寸都收窄随机范围：烟团沿柱体分布均匀，
    // 层距（上升速度 × 重生间隔）远小于烟团直径，黑色部分才连成一片。
    p.life = (15 + Math.random() * 2.5) * (0.75 + 0.25 * s);
    p.age = mature ? Math.random() * p.life * 0.9 : 0;
    p.size = (12 + Math.random() * 6) * s;
    p.sway = 0.4 + Math.random() * 0.6;
    const r = 1.7 * s;                  // 火源处的横向散布收窄
    p.pos.set(
      site.x + (Math.random() - 0.5) * r,
      site.y + Math.random() * 1.8 * s,
      site.z + (Math.random() - 0.5) * r,
    );
    p.vel.set((Math.random() - 0.5) * 0.5 * s, (8.4 + Math.random() * 1.4) * s, (Math.random() - 0.5) * 0.5 * s);
    if (mature) {                       // 按已有年龄把位置推到对应高度
      p.pos.x += p.vel.x * p.age;
      p.pos.y += p.vel.y * p.age;
      p.pos.z += p.vel.z * p.age;
    }
  }

  /** 与纸屑共用同一股风，烟柱和纸屑被同方向吹走 */
  _wind() {
    const t = this.time;
    const gust = 1 + 0.45 * Math.sin(t * 1.9) + 0.25 * Math.sin(t * 3.7 + 0.6);
    this._windV.x = (4.6 + 1.7 * Math.sin(t * 0.31) + 0.9 * Math.sin(t * 0.83)) * gust;
    this._windV.z = (2.9 + 1.5 * Math.sin(t * 0.27 + 1.7) + 0.8 * Math.sin(t * 0.91 + 0.8)) * gust;
    return this._windV;
  }

  _updateFires(dt) {
    const n = this.fires.length;
    if (!n) { if (this.fireSmoke.visible) { this.fireSmoke.visible = false; this.fireFlames.visible = false; } return; }
    this.fireSmoke.visible = true;
    this.fireFlames.visible = true;
    const camQ = this.camera.quaternion;
    const wind = this._wind();
    const t = this.time;
    const count = n * this.firePuffN;

    for (let i = 0; i < count; i++) {
      const p = this.firePuffs[i];
      if (p.site < 0 || p.site >= n) { _pScale.setScalar(0.0001); _m4.compose(_v1.set(0, -9999, 0), camQ, _pScale); this.fireSmoke.setMatrixAt(i, _m4); continue; }
      p.age += dt;
      if (p.age >= p.life) this._respawnPuff(p);
      const k = clamp(p.age / p.life, 0, 1);

      // 柱体保持笔直：浮力衰减很慢，湍流幅度很小，风只在高处才把柱顶缓缓吹弯
      p.vel.y -= 0.28 * dt;
      const turb = Math.sin(t * 1.7 + p.sway * 9.1);
      p.pos.x += (p.vel.x + wind.x * (0.05 + k * 0.35) + turb * p.sway * 0.22) * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += (p.vel.z + wind.z * (0.05 + k * 0.35) + Math.cos(t * 1.3 + p.sway * 7.7) * p.sway * 0.22) * dt;

      // 尺寸：前 1/5 迅速膨胀到最大，最后 15% 才收缩散去（柱体全程保持饱满）
      const grow = 0.62 + 0.38 * Math.min(1, k / 0.2);
      const fade = 1 - smoothstep(0.85, 1, k);
      _pScale.setScalar(Math.max(0.05, p.size * grow * fade));
      _m4.compose(_v1.copy(p.pos), camQ, _pScale);
      this.fireSmoke.setMatrixAt(i, _m4);
      // 颜色：整根柱子都是浓黑烟，只有柱顶将散时略微转灰
      this.fireSmoke.setColorAt(i, _pCol.setScalar(0.025 + 0.16 * smoothstep(0.5, 1, k)));
    }
    this.fireSmoke.instanceMatrix.needsUpdate = true;
    if (this.fireSmoke.instanceColor) this.fireSmoke.instanceColor.needsUpdate = true;

    // 火舌：多组不同频率的正弦叠加出无规律闪烁（叠加混合，不产生任何光照开销）
    let fi = 0;
    for (const site of this.fires) {
      for (let k = 0; k < this.flameCount; k++) {
        const f = site.flames[k];
        const w = Math.sin(t * f.sp + f.ph) * 0.5 + Math.sin(t * f.sp * 2.7 + f.ph * 1.7) * 0.3 + 0.5;
        const flick = clamp(0.25 + w, 0, 1.3);
        _v1.set(site.x + f.ox, site.y + f.oy + flick * 2.4 * site.s, site.z + f.oz);
        _pScale.setScalar((2.4 + 4.6 * flick) * site.s);
        _m4.compose(_v1, camQ, _pScale);
        this.fireFlames.setMatrixAt(fi, _m4);
        _pCol.setRGB(flick, 0.32 * flick + 0.05, 0.05 * flick * flick);
        this.fireFlames.setColorAt(fi, _pCol);
        fi++;
      }
    }
    this.fireFlames.instanceMatrix.needsUpdate = true;
    if (this.fireFlames.instanceColor) this.fireFlames.instanceColor.needsUpdate = true;
  }

  /* ---------------------------------------- 内部取值 */
  _flash() {
    for (const f of this.flashes) if (f.life <= 0) return f;
    return this.flashes[0];
  }
  _flashLight() {
    for (const f of this.flashLights) if (f.life <= 0) return f;
    return this.flashLights[0];
  }
  _tracer() {
    for (const t of this.tracers) if (t.life <= 0) return t;
    return this.tracers[0];
  }
  _spark() {
    for (const s of this.sparkPools) if (s.life <= 0) return s;
    return this.sparkPools[0];
  }
  _smoke() {
    for (const s of this.smokes) if (s.life <= 0) return s;
    return this.smokes[0];
  }
  _blood() {
    for (const b of this.bloods) if (b.life <= 0) return b;
    return this.bloods[0];
  }
  _boom() {
    for (const b of this.booms) if (b.life <= 0) return b;
    return this.booms[0];
  }

  /* ---------------------------------------- 枪口火焰 */
  muzzleFlash(pos, dir, scale = 1, strong = 1) {
    const f = this._flash();
    f.mesh.position.copy(pos);
    f.mesh.quaternion.copy(this.camera.quaternion);
    f.mesh.rotateZ(Math.random() * Math.PI * 2);
    const s = scale * (0.5 + Math.random() * 0.45);
    f.mesh.scale.set(s, s * (0.85 + Math.random() * 0.3), s);
    f.life = 0.045 + Math.random() * 0.02;
    f.base = 0.85 * strong;
    f.mesh.material.opacity = f.base;
    f.mesh.visible = true;

    const fl = this._flashLight();
    fl.light.position.copy(pos).addScaledVector(dir, 0.15);
    fl.light.intensity = 24 * strong;
    fl.light.visible = true;
    fl.life = 0.06;
  }

  /** 只点亮环境（手持模型自带枪口火焰时使用） */
  muzzleLight(pos, scale = 1) {
    const fl = this._flashLight();
    fl.light.position.copy(pos);
    fl.light.intensity = 26 * scale;
    fl.light.distance = 14 * scale;
    fl.light.visible = true;
    fl.life = 0.055;
  }

  /* ---------------------------------------- 曳光弹 */
  tracer(from, to, speed = 320, width = 0.018, color = 0xffcf8a) {
    const t = this._tracer();
    const dist = from.distanceTo(to);
    t.a.copy(from); t.b.copy(to);
    t.travel = 0;
    t.dist = dist;
    t.speed = speed;
    t.tracerLen = Math.max(1.4, Math.min(9, dist * 0.14));
    t.life = t.max = Math.max(0.05, dist / speed + 0.05);
    t.width = width;
    t.mesh.material.color.setHex(color);
    t.mesh.visible = true;
    this._updateTracer(t, 0);
  }

  _updateTracer(t, dt) {
    _v1.subVectors(t.b, t.a).normalize();
    const head = clamp(t.travel, 0, t.dist);
    const tail = Math.max(0, head - t.tracerLen);
    const s = _v2.copy(t.a).addScaledVector(_v1, tail);
    const e = _v3.copy(t.a).addScaledVector(_v1, head);
    t.mesh.position.copy(s).add(e).multiplyScalar(0.5);
    t.mesh.lookAt(e.x, e.y, e.z);
    const len = Math.max(0.01, e.distanceTo(s));
    t.mesh.scale.set(t.width * 2, t.width * 2, len);
    const k = clamp(t.life / t.max, 0, 1);
    t.mesh.material.opacity = Math.min(1, k * 2.4) * 0.95;
  }

  /* ---------------------------------------- 弹着 */
  impact(point, normal, kind = 'concrete', power = 1) {
    // 火花
    const sp = this._spark();
    const pos = sp.pts.geometry.attributes.position;
    const n = _v1.copy(normal).normalize();
    for (let i = 0; i < sp.n; i++) {
      pos.setXYZ(i, point.x, point.y, point.z);
      const rx = (Math.random() - 0.5) * 2, ry = (Math.random() - 0.5) * 2, rz = (Math.random() - 0.5) * 2;
      const isMetal = kind === 'metal';
      const spd = (isMetal ? 5.5 : 2.6) * (0.4 + Math.random()) * power;
      sp.vel[i * 3] = (n.x * 1.7 + rx) * spd * 0.5;
      sp.vel[i * 3 + 1] = (n.y * 1.7 + ry + 0.6) * spd * 0.5;
      sp.vel[i * 3 + 2] = (n.z * 1.7 + rz) * spd * 0.5;
    }
    pos.needsUpdate = true;
    sp.life = sp.max = kind === 'metal' ? 0.42 : 0.22;
    sp.pts.visible = true;
    sp.pts.material.opacity = kind === 'metal' ? 1 : 0.55;
    sp.pts.material.size = kind === 'metal' ? 0.055 : 0.035;
    sp.pts.material.color.setHex(kind === 'metal' ? 0xffcf80 : kind === 'wood' ? 0xc79a5e : 0xa9a49b);

    // 尘烟
    const sm = this._smoke();
    sm.mesh.position.copy(point).addScaledVector(n, 0.06);
    sm.mesh.quaternion.copy(this.camera.quaternion);
    sm.mesh.rotateZ(Math.random() * 6.28);
    const sc = (kind === 'glass' ? 0.30 : 0.42) * (0.7 + Math.random() * 0.6) * power;
    sm.mesh.scale.set(sc, sc, sc);
    sm.mesh.material.color.setHex(kind === 'wood' ? 0x9d8358 : kind === 'concrete' ? 0xbfb8ac : 0xa8a49c);
    sm.mesh.material.opacity = 0.42;
    sm.vel.set(n.x * 0.5 + (Math.random() - 0.5) * 0.7, 0.5 + Math.random() * 0.5, n.z * 0.5 + (Math.random() - 0.5) * 0.7);
    sm.grow = 1.9 + Math.random() * 0.9;
    sm.spin = (Math.random() - 0.5) * 2;
    sm.life = sm.max = 0.6 + Math.random() * 0.35;
    sm.base = 0.42;
    sm.mesh.visible = true;

    // 贴花（玻璃不打）
    if (kind !== 'glass' && kind !== 'flesh') this.decal(point, normal, kind);
  }

  decal(point, normal, kind) {
    const d = this.decals[this.decalIdx++ % this.decals.length];
    d.mesh.position.copy(point).addScaledVector(normal, 0.012);
    _v1.copy(point).add(normal);
    d.mesh.lookAt(_v1);
    d.mesh.rotateZ(Math.random() * 6.28);
    const s = 0.10 + Math.random() * 0.07;
    d.mesh.scale.set(s, s, s);
    d.baseScale = s;
    d.life = d.max = 45;
    d.mesh.visible = true;
  }

  /* ---------------------------------------- 抛壳 */
  casing(pos, dir, right) {
    const c = this.casings[this.caseIdx++ % this.casings.length];
    c.mesh.position.copy(pos);
    c.mesh.visible = true;
    c.vel.set(
      right.x * (1.9 + Math.random() * 0.9) + dir.x * 0.4 + (Math.random() - 0.5) * 0.3,
      right.y * 0.6 + 1.5 + Math.random() * 0.8,
      right.z * (1.9 + Math.random() * 0.9) + dir.z * 0.4 + (Math.random() - 0.5) * 0.3
    );
    c.spin.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    c.life = 2.6;
    c.grounded = false;
  }

  /* ---------------------------------------- 血雾 */
  blood(point, normal) {
    const b = this._blood();
    b.mesh.position.copy(point);
    b.mesh.quaternion.copy(this.camera.quaternion);
    b.mesh.rotateZ(Math.random() * 6.28);
    const s = 0.34 + Math.random() * 0.22;
    b.mesh.scale.set(s, s, s);
    b.life = b.max = 0.34;
    b.base = 0.85;
    b.mesh.material.opacity = 0.85;
    b.mesh.visible = true;
    // 附带火花状血点
    this.impact(point, normal, 'flesh', 0.8);
  }

  /* ---------------------------------------- 爆炸 */
  explosion(point, radius = 4) {
    const b = this._boom();
    b.light.position.copy(point);
    b.light.intensity = 300;
    b.light.distance = radius * 9;
    b.light.visible = true;
    b.flash.position.copy(point);
    b.flash.quaternion.copy(this.camera.quaternion);
    b.flash.rotateZ(Math.random() * 6.28);
    const s = radius * 1.4;
    b.flash.scale.set(s, s, s);
    b.baseS = s;
    b.flash.material.opacity = 1;
    b.flash.visible = true;
    b.life = b.max = 0.75;
    for (let i = 0; i < 4; i++) {
      const sm = this._smoke();
      sm.mesh.position.copy(point).add(new THREE.Vector3((Math.random() - 0.5) * radius, Math.random() * radius * 0.7, (Math.random() - 0.5) * radius));
      sm.mesh.quaternion.copy(this.camera.quaternion);
      sm.mesh.rotateZ(Math.random() * 6.28);
      const sc = radius * (0.7 + Math.random() * 0.6);
      sm.mesh.scale.set(sc, sc, sc);
      sm.mesh.material.color.setHex(0x3a3630);
      sm.mesh.material.opacity = 0.55;
      sm.vel.set((Math.random() - 0.5) * 1.4, 0.9 + Math.random(), (Math.random() - 0.5) * 1.4);
      sm.grow = 2.6;
      sm.spin = (Math.random() - 0.5) * 1.4;
      sm.life = sm.max = 1.5 + Math.random();
      sm.base = 0.55;
      sm.mesh.visible = true;
    }
    const sp = this._spark();
    const pos = sp.pts.geometry.attributes.position;
    for (let i = 0; i < sp.n; i++) {
      pos.setXYZ(i, point.x, point.y, point.z);
      const a = Math.random() * 6.28, e = Math.random() * 1.4;
      const spd = 9 * (0.5 + Math.random());
      sp.vel[i * 3] = Math.cos(a) * Math.cos(e) * spd;
      sp.vel[i * 3 + 1] = Math.sin(e) * spd;
      sp.vel[i * 3 + 2] = Math.sin(a) * Math.cos(e) * spd;
    }
    pos.needsUpdate = true;
    sp.life = sp.max = 0.8;
    sp.pts.visible = true;
    sp.pts.material.opacity = 1;
    sp.pts.material.size = 0.09;
    sp.pts.material.color.setHex(0xffb060);
  }

  smokePuff(point, scale = 1, color = 0x9c9488) {
    const sm = this._smoke();
    sm.mesh.position.copy(point);
    sm.mesh.quaternion.copy(this.camera.quaternion);
    sm.mesh.rotateZ(Math.random() * 6.28);
    sm.mesh.scale.set(scale, scale, scale);
    sm.mesh.material.color.setHex(color);
    sm.mesh.material.opacity = 0.35;
    sm.vel.set((Math.random() - 0.5) * 0.5, 0.6 + Math.random() * 0.4, (Math.random() - 0.5) * 0.5);
    sm.grow = 2.2;
    sm.spin = (Math.random() - 0.5) * 1.2;
    sm.life = sm.max = 1.1;
    sm.base = 0.35;
    sm.mesh.visible = true;
  }

  /* ---------------------------------------- 更新 */
  update(dt) {
    this.time += dt;
    const camQ = this.camera.quaternion;

    for (const t of this.tracers) {
      if (t.life <= 0) { if (t.mesh.visible) t.mesh.visible = false; continue; }
      t.life -= dt;
      t.travel += (t.speed || 320) * dt;
      this._updateTracer(t, dt);
      if (t.life <= 0) t.mesh.visible = false;
    }

    for (const f of this.flashes) {
      if (f.life <= 0) { if (f.mesh.visible) f.mesh.visible = false; continue; }
      f.life -= dt;
      f.mesh.material.opacity = Math.max(0, f.life / 0.06) * (f.base || 1);
      if (f.life <= 0) f.mesh.visible = false;
    }
    for (const f of this.flashLights) {
      if (f.life <= 0) { if (f.light.visible) { f.light.visible = false; f.light.intensity = 0; } continue; }
      f.life -= dt;
      f.light.intensity *= Math.max(0, 1 - dt * 26);
      if (f.life <= 0) { f.light.visible = false; f.light.intensity = 0; }
    }

    for (const s of this.sparkPools) {
      if (s.life <= 0) { if (s.pts.visible) s.pts.visible = false; continue; }
      s.life -= dt;
      const pos = s.pts.geometry.attributes.position;
      for (let i = 0; i < s.n; i++) {
        s.vel[i * 3 + 1] -= 16 * dt;
        pos.setXYZ(i,
          pos.getX(i) + s.vel[i * 3] * dt,
          pos.getY(i) + s.vel[i * 3 + 1] * dt,
          pos.getZ(i) + s.vel[i * 3 + 2] * dt);
      }
      pos.needsUpdate = true;
      s.pts.material.opacity = Math.max(0, s.life / s.max) * 0.95;
      if (s.life <= 0) s.pts.visible = false;
    }

    for (const s of this.smokes) {
      if (s.life <= 0) { if (s.mesh.visible) s.mesh.visible = false; continue; }
      s.life -= dt;
      const k = 1 - s.life / s.max;
      s.mesh.position.addScaledVector(s.vel, dt);
      s.vel.multiplyScalar(1 - 1.8 * dt);
      s.vel.y += 0.35 * dt;
      s.mesh.scale.multiplyScalar(1 + (s.grow - 1) * dt * 0.9);
      s.mesh.rotateZ(s.spin * dt);
      s.mesh.material.opacity = Math.max(0, (1 - k) * (s.base || 0.4));
      if (s.life <= 0) s.mesh.visible = false;
    }

    for (const d of this.decals) {
      if (d.life <= 0) { if (d.mesh.visible) d.mesh.visible = false; continue; }
      d.life -= dt;
      if (d.life < 3) {
        const k = Math.max(0.02, d.life / 3);
        d.mesh.scale.setScalar(d.baseScale * k);
      }
      if (d.life <= 0) d.mesh.visible = false;
    }

    for (const c of this.casings) {
      if (c.life <= 0) { if (c.mesh.visible) c.mesh.visible = false; continue; }
      c.life -= dt;
      if (!c.grounded) {
        c.vel.y -= 16 * dt;
        c.mesh.position.addScaledVector(c.vel, dt);
        c.mesh.rotation.x += c.spin.x * dt;
        c.mesh.rotation.y += c.spin.y * dt;
        c.mesh.rotation.z += c.spin.z * dt;
        const floor = this.boxes.floorAt(c.mesh.position.x, c.mesh.position.z, c.mesh.position.y + 0.05);
        if (c.mesh.position.y <= floor + 0.008) {
          c.mesh.position.y = floor + 0.008;
          if (Math.abs(c.vel.y) > 0.6) {
            c.vel.y = -c.vel.y * 0.32;
            c.vel.x *= 0.55; c.vel.z *= 0.55;
            c.spin.multiplyScalar(0.5);
            if (this.onCasingBounce) this.onCasingBounce(c.mesh.position);
          } else {
            c.grounded = true;
            c.vel.set(0, 0, 0);
            c.mesh.rotation.set(0, Math.random() * 6.28, Math.PI / 2);
            c.mesh.position.y = floor + 0.006;
          }
        }
      }
      if (c.life < 0.6) {
        // 淡出用小缩放代替材质透明度（共享材质）
        const k = Math.max(0.01, c.life / 0.6);
        c.mesh.scale.setScalar(k);
      }
      if (c.life <= 0) { c.mesh.visible = false; c.mesh.scale.setScalar(1); }
    }

    for (const b of this.bloods) {
      if (b.life <= 0) { if (b.mesh.visible) b.mesh.visible = false; continue; }
      b.life -= dt;
      const k = 1 - b.life / b.max;
      b.mesh.scale.multiplyScalar(1 + 2.4 * dt);
      b.mesh.material.opacity = Math.max(0, (1 - k) * (b.base || 0.85));
      if (b.life <= 0) b.mesh.visible = false;
    }

    for (const b of this.booms) {
      if (b.life <= 0) { if (b.flash.visible) { b.flash.visible = false; b.light.visible = false; b.light.intensity = 0; } continue; }
      b.life -= dt;
      const k = 1 - b.life / b.max;
      b.light.intensity = 300 * Math.max(0, 1 - k * 2.2);
      const s = b.baseS * (1 + k * 2.0);
      b.flash.scale.set(s, s, s);
      b.flash.material.opacity = Math.max(0, 1 - k * 2.6);
      if (b.life <= 0) { b.flash.visible = false; b.light.visible = false; b.light.intensity = 0; }
    }

    this._updatePaper(dt);
    this._updateFires(dt);
  }

  /* ---------------------------------------- 飞舞的纸屑 */
  _updatePaper(dt) {
    const N = this.paperN, d = this.paperD, R = this.paperR, t = this.time;
    const cam = this.camera.position;
    // 疾风：主风 4~6m/s 并持续转向，叠加更猛的阵风，纸屑是"被卷着跑"而不是飘落
    const wind = this._wind();
    const windX = wind.x, windZ = wind.z;

    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const ph = d.phase[i] + t * (2.6 + (i % 7) * 0.38);
      // 纸片特有的飘摆：横向来回摆 + 上下抖，叠加在主风上
      d.pos[i3] += (windX + Math.sin(ph) * d.sway[i]) * dt;
      d.pos[i3 + 1] += (d.fall[i] + Math.sin(ph * 1.7) * 0.9) * dt;
      d.pos[i3 + 2] += (windZ + Math.cos(ph * 0.83 + 1.3) * d.sway[i]) * dt;

      // 以相机为中心的环形循环：出了包围盒就从另一侧绕回来
      if (d.pos[i3] > R.x) d.pos[i3] -= R.x * 2;
      else if (d.pos[i3] < -R.x) d.pos[i3] += R.x * 2;
      if (d.pos[i3 + 2] > R.z) d.pos[i3 + 2] -= R.z * 2;
      else if (d.pos[i3 + 2] < -R.z) d.pos[i3 + 2] += R.z * 2;
      if (d.pos[i3 + 1] > R.y1) d.pos[i3 + 1] = R.y0 + (d.pos[i3 + 1] - R.y1);
      else if (d.pos[i3 + 1] < R.y0) d.pos[i3 + 1] = R.y1 - (R.y0 - d.pos[i3 + 1]);

      // 三轴翻滚，纸片才会"翻面"
      d.rot[i3] += d.spin[i3] * dt;
      d.rot[i3 + 1] += d.spin[i3 + 1] * dt;
      d.rot[i3 + 2] += d.spin[i3 + 2] * dt;

      _v1.set(cam.x + d.pos[i3], cam.y + d.pos[i3 + 1], cam.z + d.pos[i3 + 2]);
      _eul.set(d.rot[i3], d.rot[i3 + 1], d.rot[i3 + 2]);
      _quat.setFromEuler(_eul);
      _pScale.setScalar(d.scale[i]);
      _m4.compose(_v1, _quat, _pScale);
      this.paper.setMatrixAt(i, _m4);
    }
    this.paper.instanceMatrix.needsUpdate = true;
  }
}
