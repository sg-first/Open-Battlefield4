/* ============================================================
   特效系统：曳光弹 / 枪口火焰 / 弹着火花 / 尘烟 / 弹孔贴花 /
             抛壳 / 血雾 / 爆炸
   全部使用对象池，避免运行时 GC 抖动
   ============================================================ */
import * as THREE from 'three';
import {
  makeGlowTexture, makeFlashTexture, makeSmokeTexture,
  makeBulletHoleTexture, makeBloodTexture, clamp,
} from './util.js';

const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

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

    this.time = 0;
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
  }
}
