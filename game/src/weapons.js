/* ============================================================
   武器系统：SCAR-H / UMP45
   - 手持模型（后坐、抬枪、冲刺收枪、开镜、换弹关键帧动画）
   - 命中判定（世界几何 + 敌人部位）、伤害衰减、弹道扩散
   - 抛壳、枪口火焰、曳光弹、弹着特效与音效联动
   - 手持模型走独立渲染层（vmScene），不会被场景几何穿插
   ============================================================ */
import * as THREE from 'three';
import { clamp, lerp, damp, DEG, makeFlashTexture } from './util.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _q2 = new THREE.Quaternion();

export const WEAPON_DEFS = {
  scar: {
    id: 'scar',
    name: 'SCAR-H',
    kind: '突击步枪',
    asset: 'gameplay_weapons_scar-h_scar_h_static_mesh',
    auto: true,
    rpm: 600,
    mag: 20,
    reserve: 120,
    maxReserve: 200,
    dmg: [30, 21],
    range: [30, 110],
    headMul: 2.0,
    legMul: 0.85,
    spread: { hip: 2.1, ads: 0.22, move: 1.9, air: 4.2, crouch: 0.72, perShot: 0.42, max: 4.6, decay: 5.2 },
    recoil: { v: -0.86, h: 0.40, back: 0.044, rise: 0.070, roll: 0.8 },
    adsZoom: 1.62, adsTime: 0.20, adsSens: 0.62,
    reloadTac: 2.20, reloadEmpty: 2.85,
    switchTime: 0.62,
    pose: {
      idle: { pos: [0.146, -0.134, -0.372], rot: [0.030, -0.052, 0.055] },
    },
    // 机械瞄具顶点（模型局部坐标：资产按包围盒居中，+Z 指向枪口）。
    // 实测自模型顶部轮廓：导轨面在 y=+0.084，上面两个等高突起即照门与准星。
    //   rear  z=-0.178  y=+0.1295（照门）   front z=+0.239  y=+0.1303（准星）
    // 开镜姿势由这两个点反推，见 adsPose()。
    sight: { rear: [-0.0057, 0.1295, -0.1775], front: [-0.0053, 0.1303, 0.2386], eyeRelief: 0.22 },
    muzzle: [0.0, 0.014, 0.0],
    eject: [-0.032, 0.026, 0.085],
    sfx: 'scar',
    fxScale: 1.15,
    tracer: 0xffd08a,
    flashSize: 0.46,
  },
  ump: {
    id: 'ump',
    name: 'UMP-45',
    kind: '冲锋枪',
    asset: 'gameplay_weapons_ump45_ump_mesh3p_animationprop_mesh',
    auto: true,
    rpm: 660,
    mag: 25,
    reserve: 150,
    maxReserve: 250,
    dmg: [26, 16],
    range: [18, 70],
    headMul: 1.9,
    legMul: 0.9,
    spread: { hip: 1.9, ads: 0.30, move: 1.6, air: 3.6, crouch: 0.75, perShot: 0.30, max: 3.9, decay: 6.0 },
    recoil: { v: -0.58, h: 0.28, back: 0.032, rise: 0.050, roll: 0.5 },
    adsZoom: 1.42, adsTime: 0.17, adsSens: 0.68,
    reloadTac: 2.05, reloadEmpty: 2.65,
    switchTime: 0.55,
    pose: {
      // 腰射与开镜共用同一条基准（SCAR 也是这样）：
      //   y = -瞄准线高度(0.153)  → 瞄具正好在视线高度，抬枪时不会上下跳
      //   z 比开镜再往回收 0.025  → 枪托(局部 z<-0.17)整体退到相机后面
      idle: { pos: [0.138, -0.153, -0.215], rot: [0.032, -0.044, 0.050] },
    },
    // 该 3P 道具网格没有可用的准星（机匣顶部 y=+0.143 之后一路下降到 +0.132，
    // 前方只有护木细节），因此只对齐照门：机匣尾部最高的那个 y=+0.153 突起。
    // front 传 null 表示枪身与视轴平行、不做俯仰补偿。
    sight: { rear: [-0.0005, 0.1530, -0.0400], front: null, eyeRelief: 0.20 },
    muzzle: [0.0, 0.010, 0.0],
    eject: [-0.028, 0.022, 0.055],
    sfx: 'ump',
    fxScale: 0.95,
    tracer: 0xffc57a,
    flashSize: 0.38,
  },
};

/* 换弹关键帧（offset 叠加在基础姿势上） */
function reloadKeys(def) {
  const s = def.reloadTac / 2.2;
  const k = (t, pos, rot, ev) => ({ t: t * s, pos, rot, ev });
  return [
    k(0.00, [0, 0, 0], [0, 0, 0], 'grab'),
    k(0.16, [0.010, -0.080, 0.015], [0.16, -0.40, 0.10], 'magout'),
    k(0.30, [0.014, -0.135, 0.020], [0.30, -0.62, 0.20], 'magdrop'),
    k(0.50, [-0.020, -0.118, 0.008], [0.20, -0.50, 0.26], null),
    k(0.76, [0.004, -0.080, 0.0], [0.07, -0.30, 0.12], 'magin'),
    k(0.88, [0.0, -0.062, 0.0], [0.03, -0.16, 0.06], 'seat'),
    k(1.06, [0.0, -0.020, -0.010], [-0.07, -0.10, 0.02], null),
    k(1.34, [0.0, -0.034, 0.030], [0.05, -0.20, 0.05], 'bolt'),
    k(1.62, [0.0, -0.010, 0.0], [-0.01, -0.04, 0.0], null),
    k(2.20, [0, 0, 0], [0, 0, 0], 'done'),
  ];
}

const SPRINT_POSE = { pos: [0.085, -0.165, 0.030], rot: [-0.58, -0.44, 0.22] };

/** 手持模型相机相对主相机 FOV 的缩放：略窄一点，让枪看起来更「端在手里」 */
const VM_FOV_SCALE = 0.92;

/**
 * 由机械瞄具反推开镜姿势（不再用手调的魔法数字）。
 *
 * 手持模型在 pivot 下绕 Y 轴转了 180°（资产 +Z 朝前 → 相机 -Z 朝前），
 * 所以模型局部点 (x, y, z) 在 pivot 空间里是 (-x, y, -z)。
 *
 * 开镜的定义是「眼睛落在照门→准星这条瞄准线上」，于是：
 *   ① 平移：把瞄准线上「照门后方 eyeRelief 米」的那一点挪到相机原点；
 *   ② 俯仰：绕 X 轴旋转，使瞄准线指向相机正前方 -Z。
 * 平移量要带上这个旋转（pivot 的 position 是父空间量，不受自身 rotation 影响，
 * 而照门是被 rotation 带着转的），即 pos = -Rx(θ) · eye。
 *
 * 这样准星、照门、枪口三点一线，弹道（从相机原点沿 -Z 射出）与瞄准线完全重合。
 *
 * @param {number[]} rear      照门顶点（模型局部坐标）
 * @param {number[]|null} front 准星顶点；模型没有可用准星时传 null，退化为只对齐照门
 * @param {number} eyeRelief   眼睛到照门的距离（米）
 */
function adsPose(rear, front, eyeRelief) {
  const R = new THREE.Vector3(-rear[0], rear[1], -rear[2]);
  const dir = front
    ? new THREE.Vector3(-front[0], front[1], -front[2]).sub(R).normalize()
    : new THREE.Vector3(0, 0, -1);

  // 眼睛在照门后方，即沿瞄准线的反方向退 eyeRelief 米
  const eye = R.clone().addScaledVector(dir, -eyeRelief);

  // θ = atan2(-dy, -dz) 使 Rx(θ) · dir = (0, 0, -1)
  const rx = Math.atan2(-dir.y, -dir.z);
  const cs = Math.cos(rx), sn = Math.sin(rx);
  return {
    pos: [-eye.x, -(eye.y * cs - eye.z * sn), -(eye.y * sn + eye.z * cs)],
    rot: [rx, 0, 0],
  };
}

export class WeaponSystem {
  constructor(o) {
    this.camera = o.camera;
    this.fx = o.fx;
    this.audio = o.audio;
    this.boxes = o.boxes;
    this.hud = o.hud;
    this.assets = o.assets;

    // 独立的手持模型渲染层
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(o.fov || 78, 1, 0.01, 6);
    this.root = new THREE.Object3D();
    this.vmCamera.add(this.root);
    this.vmScene.add(this.vmCamera);

    const vmLight = new THREE.DirectionalLight(0xfff2e0, 1.5);
    vmLight.position.set(-0.6, 1, 0.8);
    this.vmScene.add(vmLight);
    const vmFill = new THREE.HemisphereLight(0xa8c4e8, 0x30323a, 1.2);
    this.vmScene.add(vmFill);
    this.flashTex = makeFlashTexture(256, 5);

    this.slots = ['scar', 'ump'];
    this.weapons = {};
    this.build();

    this.index = 0;
    this.current = null;
    this.adsT = 0;
    this.trigger = false;
    this.triggerPressed = false;
    this.nextFire = 0;
    this.switching = null;
    this.switchK = 0;
    this.reload = null;
    this.bloom = 0;
    this.shotsFired = 0;
    this.heatSmoke = 0;
    this.recoilPos = new THREE.Vector3();
    this.recoilVel = new THREE.Vector3();
    this.recoilRot = new THREE.Vector3();
    this.recoilRotVel = new THREE.Vector3();
    this.sway = new THREE.Vector2();
    this.swayTarget = new THREE.Vector2();
    this.bobPhase = 0;
    this.bobOffset = new THREE.Vector2();
    this.sprintBlend = 0;
    this.landDip = 0;
    this.lastTuneKey = '';

    this.equip(0, true);
  }

  /* -------------------------------------------- 构建 */
  build() {
    for (const id of this.slots) {
      const def = WEAPON_DEFS[id];
      const asset = this.assets.get(def.asset);
      if (!asset) { console.warn('缺少武器资产:', def.asset); continue; }

      const pivot = new THREE.Object3D();
      const swayG = new THREE.Object3D();
      const recoilG = new THREE.Object3D();
      pivot.add(swayG); swayG.add(recoilG);
      this.root.add(pivot);

      const mesh = new THREE.Mesh(asset.parts[0].geometry, asset.parts[0].material.clone());
      mesh.material.side = THREE.FrontSide;
      mesh.rotation.y = Math.PI;          // 资产 +Z 朝前 → 相机 -Z 朝前
      mesh.frustumCulled = false;
      recoilG.add(mesh);

      asset.parts[0].geometry.computeBoundingBox();
      const bb = asset.parts[0].geometry.boundingBox;
      const boreY = bb.min.y + (bb.max.y - bb.min.y) * 0.62;

      const muzzle = new THREE.Object3D();
      muzzle.position.set(def.muzzle[0], boreY + def.muzzle[1], bb.max.z - 0.02);
      mesh.add(muzzle);

      const eject = new THREE.Object3D();
      eject.position.set(def.eject[0], def.eject[1], def.eject[2]);
      mesh.add(eject);

      // 手持模型专用的枪口火焰（永远朝向摄像机）
      const flash = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: this.flashTex, transparent: true, blending: THREE.AdditiveBlending,
          depthWrite: false, depthTest: false, opacity: 0, color: 0xffdca8,
        })
      );
      flash.position.z = 0.04;
      flash.rotation.y = Math.PI;         // 抵消枪身的 180°，正对摄像机
      flash.frustumCulled = false;
      flash.renderOrder = 30;
      flash.visible = false;
      muzzle.add(flash);
      const flashLight = new THREE.PointLight(0xffb060, 0, 2.2, 2);
      flashLight.position.z = 0.1;
      muzzle.add(flashLight);

      const ads = def.sight
        ? adsPose(def.sight.rear, def.sight.front, def.sight.eyeRelief)
        : { pos: [0, -0.090, -0.300], rot: [0, 0, 0] };

      this.weapons[id] = {
        def, asset, pivot, swayG, recoilG, mesh, muzzle, eject, flash, flashLight,
        mag: def.mag, reserve: def.reserve,
        keys: reloadKeys(def),
        flashLife: 0,
        size: asset.size,
        ads,
      };
      pivot.visible = false;
    }
  }

  /* -------------------------------------------- 装备 / 切换 */
  equip(i, instant) {
    const n = this.slots.length;
    i = ((i % n) + n) % n;
    const id = this.slots[i];
    if (!this.weapons[id]) return;
    if (instant) {
      if (this.current) this.current.pivot.visible = false;
      this.index = i;
      this.current = this.weapons[id];
      this.current.pivot.visible = true;
      this.reload = null;
      this.adsT = 0;
      this.switchK = 0;
      this.applyPose();
      this.hud && this.hud.setWeapon(this.current);
      return;
    }
    if (this.switching || i === this.index) return;
    this.switching = { to: i, t: 0, swapped: false };
    this.reload = null;
    this.audio.reloadStep('switch');
  }

  next(dir = 1) { this.equip(this.index + dir); }
  selectSlot(i) { this.equip(i); }
  get def() { return this.current ? this.current.def : WEAPON_DEFS.scar; }
  get ammo() { return this.current ? [this.current.mag, this.current.reserve] : [0, 0]; }
  get isReloading() { return !!this.reload; }
  get reloadProgress() { return this.reload ? clamp(this.reload.t / this.reload.dur, 0, 1) : 0; }
  get adsActive() { return this.adsT > 0.55; }

  /** 补满弹药（用于补给点/重生） */
  refill() {
    for (const id of this.slots) {
      const w = this.weapons[id];
      if (!w) continue;
      w.mag = w.def.mag;
      w.reserve = w.def.maxReserve;
    }
    this.hud && this.hud.setAmmo(this.current.mag, this.current.reserve);
  }

  /* -------------------------------------------- 输入 */
  setTrigger(down) {
    if (down && !this.trigger) this.triggerPressed = true;
    this.trigger = down;
  }
  startReload() {
    if (!this.current || this.reload || this.switching) return;
    const w = this.current;
    if (w.mag >= w.def.mag || w.reserve <= 0) return;
    const empty = w.mag === 0;
    this.reload = {
      t: 0,
      dur: empty ? w.def.reloadEmpty : w.def.reloadTac,
      empty, keys: w.keys, next: 0,
    };
    this.audio.reloadStep('grab');
  }

  /* -------------------------------------------- 主更新 */
  update(dt, ctx) {
    const w = this.current;
    if (!w) return;
    const def = w.def;

    // ---- 手持模型相机跟随主相机 FOV
    // 开镜时世界被放大（adsZoom），枪若仍按腰射 FOV 渲染就会和世界脱节
    // （枪显得又小又远）。瞄准线过原点，缩放 FOV 不影响开镜对齐。
    const vmFov = this.camera.fov * VM_FOV_SCALE;
    if (Math.abs(this.vmCamera.fov - vmFov) > 1e-3) {
      this.vmCamera.fov = vmFov;
      this.vmCamera.updateProjectionMatrix();
    }

    // ---- 切换动画
    if (this.switching) {
      const sw = this.switching;
      const total = this.weapons[this.slots[sw.to]].def.switchTime;
      const half = total * 0.45;
      sw.t += dt;
      if (sw.t < half) {
        this.switchK = clamp(sw.t / half, 0, 1);
      } else {
        if (!sw.swapped) {
          sw.swapped = true;
          this.current.pivot.visible = false;
          this.index = sw.to;
          this.current = this.weapons[this.slots[sw.to]];
          this.current.pivot.visible = true;
          this.hud && this.hud.setWeapon(this.current);
        }
        this.switchK = 1 - clamp((sw.t - half) / (total - half), 0, 1);
        if (sw.t >= total) { this.switching = null; this.switchK = 0; }
      }
    } else if (this.switchK > 0) {
      this.switchK = Math.max(0, this.switchK - dt * 6);
    }

    // ---- 瞄准
    const wantAds = ctx.ads && !this.reload && !ctx.sprint;
    const adsSpeed = dt / Math.max(0.05, def.adsTime);
    this.adsT = clamp(this.adsT + (wantAds ? adsSpeed : -adsSpeed * 1.3), 0, 1);

    // ---- 冲刺收枪
    const spd = ctx.speed || 0;
    const sprintWant = (ctx.sprint && spd > 3.4) ? 1 : 0;
    this.sprintBlend = damp(this.sprintBlend, sprintWant, 9, dt);

    // ---- 换弹
    if (this.reload) this.updateReload(dt);

    // ---- 开火
    if (this.trigger && !this.reload && !this.switching && ctx.time >= this.nextFire) {
      if (def.auto || this.triggerPressed) {
        this.fire(ctx);
        this.nextFire = ctx.time + 60 / def.rpm;
      }
    }
    if (!this.trigger) this.triggerPressed = false;

    // ---- 扩散衰减
    const sd = def.spread;
    this.bloom = Math.max(0, this.bloom - sd.decay * dt * (this.trigger ? 0.4 : 1));

    // ---- 后坐弹簧
    const stiff = 300, dampK = 24;
    this.recoilVel.addScaledVector(this.recoilPos, -stiff * dt).multiplyScalar(Math.max(0, 1 - dampK * dt));
    this.recoilPos.addScaledVector(this.recoilVel, dt);
    this.recoilRotVel.addScaledVector(this.recoilRot, -stiff * dt).multiplyScalar(Math.max(0, 1 - dampK * dt));
    this.recoilRot.addScaledVector(this.recoilRotVel, dt);

    // ---- 摆动
    this.sway.x = damp(this.sway.x, this.swayTarget.x, 13, dt);
    this.sway.y = damp(this.sway.y, this.swayTarget.y, 13, dt);
    this.swayTarget.multiplyScalar(Math.max(0, 1 - dt * 7));

    // ---- 走动摆动
    const speedNorm = clamp(spd / 6.2, 0, 1.35);
    if (speedNorm > 0.04) this.bobPhase += dt * (6.2 + speedNorm * 3.4);
    const adsBlend = this.adsT;
    const bobAmp = speedNorm * lerp(1, 0.22, adsBlend) * lerp(1, 0.20, this.sprintBlend);
    this.bobOffset.set(
      Math.sin(this.bobPhase) * 0.016 * bobAmp,
      -Math.abs(Math.sin(this.bobPhase * 2)) * 0.011 * bobAmp
    );
    this.landDip = Math.max(0, this.landDip - dt * 4.2);
    this.lastTuneKey = '';

    this.applyPose();
    this.updateFlash(dt);

    // ---- 枪管过热冒烟
    this.heatSmoke = Math.max(0, this.heatSmoke - dt * 5.5);
    if (this.shotsFired > 10 && this.heatSmoke <= 0 && Math.random() < dt * 3.0) {
      this.heatSmoke = 1.1;
      this.fx.smokePuff(this.getWorldPos(w.muzzle), 0.22, 0xb9b2a6);
    }
    if (this.shotsFired > 60) this.shotsFired = 30;
  }

  updateReload(dt) {
    const r = this.reload, w = this.current;
    r.t += dt;
    while (r.next < r.keys.length && r.t >= r.keys[r.next].t) {
      const k = r.keys[r.next];
      if (k.ev && k.ev !== 'done') this.audio.reloadStep(k.ev, w.def.sfx);
      r.next++;
    }
    if (r.t >= r.dur) {
      const need = w.def.mag - w.mag;
      const take = Math.min(need, w.reserve);
      w.mag += take;
      w.reserve -= take;
      this.reload = null;
      this.hud && this.hud.setAmmo(w.mag, w.reserve, true);
    }
  }

  reloadOffset() {
    const r = this.reload;
    if (!r) return null;
    const keys = r.keys;
    let a = keys[0], b = keys[keys.length - 1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (r.t >= keys[i].t && r.t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
    }
    let k = clamp((r.t - a.t) / Math.max(1e-4, b.t - a.t), 0, 1);
    k = k * k * (3 - 2 * k);
    return {
      pos: [lerp(a.pos[0], b.pos[0], k), lerp(a.pos[1], b.pos[1], k), lerp(a.pos[2], b.pos[2], k)],
      rot: [lerp(a.rot[0], b.rot[0], k), lerp(a.rot[1], b.rot[1], k), lerp(a.rot[2], b.rot[2], k)],
    };
  }

  applyPose() {
    const w = this.current;
    const def = w.def;
    const a = this.adsT;
    const p0 = def.pose.idle, p1 = w.ads;

    let px = lerp(p0.pos[0], p1.pos[0], a);
    let py = lerp(p0.pos[1], p1.pos[1], a);
    let pz = lerp(p0.pos[2], p1.pos[2], a);
    let rx = lerp(p0.rot[0], p1.rot[0], a);
    let ry = lerp(p0.rot[1], p1.rot[1], a);
    let rz = lerp(p0.rot[2], p1.rot[2], a);

    if (this.tuning) {
      const t = this.tuning[def.id];
      if (t) { px += t.px; py += t.py; pz += t.pz; rx += t.rx; ry += t.ry; rz += t.rz; }
      const ta = this.tuning[def.id + '_ads'];
      if (ta) {
        px += ta.px * a; py += ta.py * a; pz += ta.pz * a;
        rx += ta.rx * a; ry += ta.ry * a; rz += ta.rz * a;
      }
    }

    const sb = this.sprintBlend;
    px = lerp(px, SPRINT_POSE.pos[0], sb);
    py = lerp(py, SPRINT_POSE.pos[1], sb);
    pz = lerp(pz, SPRINT_POSE.pos[2], sb);
    rx = lerp(rx, SPRINT_POSE.rot[0], sb);
    ry = lerp(ry, SPRINT_POSE.rot[1], sb);
    rz = lerp(rz, SPRINT_POSE.rot[2], sb);

    const ro = this.reloadOffset();
    if (ro) {
      px += ro.pos[0]; py += ro.pos[1]; pz += ro.pos[2];
      rx += ro.rot[0]; ry += ro.rot[1]; rz += ro.rot[2];
    }

    const sk = this.switchK;
    py += -0.24 * sk;
    rx += -0.85 * sk;

    px += this.bobOffset.x;
    py += this.bobOffset.y + this.landDip * 0.055;

    w.pivot.position.set(px, py, pz);
    w.pivot.rotation.set(rx, ry, rz);

    const sw = this.sway, swayScale = lerp(1, 0.26, a) * lerp(1, 0.3, sb);
    w.swayG.position.set(sw.x * 0.011 * swayScale, sw.y * 0.009 * swayScale, 0);
    w.swayG.rotation.set(sw.y * 0.055 * swayScale, -sw.x * 0.085 * swayScale, sw.x * 0.05 * swayScale);

    w.recoilG.position.copy(this.recoilPos);
    w.recoilG.rotation.set(this.recoilRot.x, this.recoilRot.y, this.recoilRot.z);
  }

  updateFlash(dt) {
    for (const id of this.slots) {
      const w = this.weapons[id];
      if (!w) continue;
      if (w.flashLife > 0) {
        w.flashLife -= dt;
        const k = Math.max(0, w.flashLife / 0.05);
        w.flash.material.opacity = k;
        w.flash.visible = k > 0;
        w.flashLight.intensity = 12 * k;
      } else if (w.flash.visible) {
        w.flash.visible = false;
        w.flashLight.intensity = 0;
      }
    }
  }

  /* -------------------------------------------- 开火 */
  fire(ctx) {
    const w = this.current;
    const def = w.def;
    if (w.mag <= 0) {
      this.audio.dryFire();
      this.nextFire = ctx.time + 0.30;
      this.startReload();
      return;
    }
    w.mag--;
    this.shotsFired++;
    this.hud && this.hud.setAmmo(w.mag, w.reserve);

    // 弹道方向（含扩散）
    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const baseDir = this.camera.getWorldDirection(new THREE.Vector3()).clone();
    const spreadDeg = this.currentSpread(ctx);
    const dir = baseDir.clone();
    if (spreadDeg > 0.001) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * Math.tan(spreadDeg * DEG);
      let up = _v3.set(0, 1, 0).cross(baseDir);
      if (up.lengthSq() < 1e-6) up.set(1, 0, 0);
      up.normalize();
      const right = new THREE.Vector3().crossVectors(baseDir, up).normalize();
      const up2 = new THREE.Vector3().crossVectors(right, baseDir).normalize();
      dir.addScaledVector(right, Math.cos(a) * r).addScaledVector(up2, Math.sin(a) * r).normalize();
    }

    // ---- 后坐：一份参数拆成两条通道
    //   ① 视觉通道 → 手持模型的弹簧（recoilPos 位移 / recoilRot 旋转），只晃枪、不改弹道
    //   ② 弹道通道 → ctx.addRecoil 交给相机，真的改变 camera.rotation，必须压枪
    const rec = def.recoil;                      // 当前武器的后坐参数（角度/米，见 WEAPON_DEFS）

    // ①-a 位移：枪身沿枪轴向后顶 + 极轻微上移
    this.recoilPos.z += rec.back;                // 后退量（米）
    this.recoilPos.y += 0.005;                   // 抬升量（米）
    this.recoilVel.z += 0.60;                    // 给弹簧初速度 → 第一帧"顶"出去，而非线性渐变

    // ①-b 旋转：枪口上抬、随机侧滚、随机横摆
    this.recoilRot.x += rec.rise;                // 枪口上抬（弧度）
    this.recoilRot.z += (Math.random() - 0.5) * rec.roll * 0.05;   // 侧滚抖动
    this.recoilRotVel.x += 2.8;                  // 旋转弹簧初速度
    this.recoilRot.y += (Math.random() - 0.5) * rec.h * 0.03;      // 横摆抖动
    this.bloom = Math.min(def.spread.max, this.bloom + def.spread.perShot);  // 连发累积扩散

    // ② 弹道通道：抬枪量 + 左右随机偏摆（单位「度」，player.addRecoil 内部转弧度）
    //    rec.v 在 WEAPON_DEFS 里写成负数表示"kick"，这里取负转成"向上"；
    //    rec.h 的 ±h 由 random-0.5 生成，即每次水平抖动落在 [-h, +h] 度内。
    ctx.addRecoil && ctx.addRecoil(-rec.v, (Math.random() - 0.5) * rec.h * 2);

    // 枪口火焰
    const mp = this.getWorldPos(w.muzzle);
    const md = this.getWorldDir(w.muzzle);
    this.fx.muzzleLight(mp, def.fxScale);
    w.flash.visible = true;
    w.flash.material.opacity = 1;
    const fs = def.flashSize * (0.82 + Math.random() * 0.4);
    w.flash.scale.set(fs, fs * (0.85 + Math.random() * 0.35), fs);
    w.flash.rotation.z = Math.random() * Math.PI * 2;
    w.flashLife = 0.05;

    // 抛壳
    this.fx.casing(this.getWorldPos(w.eject), dir, this.getWorldRight(w.eject));

    // 命中判定
    const maxDist = 420;
    const hit = this.traceShot(origin, dir, maxDist, ctx);
    const end = hit ? hit.point : origin.clone().addScaledVector(dir, maxDist);
    this.fx.tracer(mp, end, 360, 0.016, def.tracer);

    if (hit) {
      if (hit.enemy) this.onEnemyHit(hit, def, ctx);
      else {
        this.fx.impact(hit.point, hit.normal, hit.kind, 1);
        this.audio.impact(hit.kind, 0);
      }
    }

    this.audio.gunshot(def.sfx, 0, 0);
    if (this.hud) { this.hud.crosshairKick(); this.hud.setAmmo(w.mag, w.reserve); }
    ctx.onShot && ctx.onShot(def);
  }

  currentSpread(ctx) {
    const def = this.current.def, s = def.spread;
    const a = this.adsT;
    let base = lerp(s.hip, s.ads, a);
    const spd = clamp((ctx.speed || 0) / 6.2, 0, 1.6);
    base += s.move * spd * lerp(1, 0.25, a);
    if (ctx.onGround === false) base += s.air;
    if (ctx.crouch) base *= s.crouch;
    if (this.sprintBlend > 0.1) base += 2.4 * this.sprintBlend;
    return base + this.bloom;
  }

  traceShot(origin, dir, maxDist, ctx) {
    let best = null;
    if (ctx.raycastEnemies) {
      const e = ctx.raycastEnemies(origin, dir, maxDist);
      if (e) best = { dist: e.dist, point: e.point, normal: e.normal, enemy: e.enemy, part: e.part };
    }
    const g = this.boxes.raycast(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist);
    if (g && (!best || g.dist < best.dist)) {
      best = { dist: g.dist, point: g.point, normal: g.normal, kind: (g.box && g.box.kind) || 'concrete' };
    }
    return best;
  }

  onEnemyHit(hit, def, ctx) {
    const dist = hit.dist;
    const t = clamp((dist - def.range[0]) / Math.max(1, def.range[1] - def.range[0]), 0, 1);
    let dmg = lerp(def.dmg[0], def.dmg[1], t);
    const head = hit.part === 'head';
    const leg = hit.part === 'leg';
    if (head) dmg *= def.headMul;
    else if (leg) dmg *= def.legMul;
    const killed = hit.enemy.takeDamage(dmg, head, hit.point, ctx);
    this.fx.blood(hit.point, hit.normal);
    this.audio.impact('flesh', dist);
    this.audio.hitmarker(head);
    if (killed) this.audio.kill();
    if (this.hud) {
      this.hud.hitmarker(head, killed);
      this.hud.damageNumber(hit.point, Math.round(dmg), head);
    }
  }

  /* -------------------------------------------- 辅助 */
  /* 手持模型位于相机局部空间，需再乘以相机的世界矩阵 */
  getWorldPos(obj, out) {
    const v = out || new THREE.Vector3();
    obj.updateWorldMatrix(true, false);
    v.setFromMatrixPosition(obj.matrixWorld);
    return v.applyMatrix4(this.camera.matrixWorld);
  }
  getWorldDir(obj, out) {
    const v = out || new THREE.Vector3();
    obj.updateWorldMatrix(true, false);
    _m4.extractRotation(obj.matrixWorld);
    v.set(0, 0, 1).applyMatrix4(_m4);
    v.applyQuaternion(this.camera.getWorldQuaternion(_q2));
    return v.normalize();
  }
  getWorldRight(obj, out) {
    const v = out || new THREE.Vector3();
    obj.updateWorldMatrix(true, false);
    _m4.extractRotation(obj.matrixWorld);
    v.set(-1, 0, 0).applyMatrix4(_m4);
    v.applyQuaternion(this.camera.getWorldQuaternion(_q2));
    return v.normalize();
  }

  /** 视口变化时同步手持模型相机 */
  setViewport(aspect, fov) {
    this.vmCamera.aspect = aspect;
    this.vmCamera.fov = fov * VM_FOV_SCALE;
    this.vmCamera.updateProjectionMatrix();
  }
}
