/* ============================================================
   敌人：巡逻 / 警戒 / 交火 AI + 命中判定 + 波次刷新
   ============================================================ */
import * as THREE from 'three';
import { clamp, lerp, damp, wrapAngle, makeRNG } from './util.js';
import { ENEMY_KEYS, CHAR_SPECS } from './characters.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();

const CFG = {
  viewDist: 68,
  fovCos: Math.cos(1.15),
  engageDist: 34,
  loseTime: 6.0,
  patrolSpeed: 1.5,
  chaseSpeed: 3.1,
  strafeSpeed: 2.2,
  bodyHalf: [0.27, 0.50, 0.25],
  legHalf: [0.25, 0.35, 0.23],
  headR: 0.165,
};

/* 敌人武器（沿用玩家武器网格，挂在手上） */
function gunAxis() {
  const R = new THREE.Vector3(-0.115, 1.200, 0.240);
  const L = new THREE.Vector3(-0.020, 1.210, 0.545);
  return { R, L, axis: L.clone().sub(R).normalize() };
}

export class Enemy {
  constructor(mgr, key, pos, opts = {}) {
    this.mgr = mgr;
    this.key = key;
    this.spec = CHAR_SPECS[key];
    this.inst = mgr.factory.create(key);
    mgr.scene.add(this.inst.group);

    this.pos = new THREE.Vector3(pos.x, pos.y, pos.z);
    this.vel = new THREE.Vector3();
    this.yaw = opts.yaw || 0;
    this.hp = this.spec.hp * (opts.hpScale || 1);
    this.maxHp = this.hp;
    this.state = 'patrol';
    this.dead = false;
    this.deadT = 0;
    this.onGround = true;
    this.aimVal = 0.85;
    this.stride = 0;
    this.fireCd = 1 + Math.random() * 2;
    this.burst = 0;
    this.burstCd = 0;
    this.loseT = 0;
    this.reactionT = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = 0;
    this.lastSeen = new THREE.Vector3();
    this.skill = opts.skill ?? 1;
    this.hitFlash = 0;
    this.speed = 0;

    // 巡逻点
    this.waypoints = opts.waypoints || [];
    this.wp = 0;

    // 武器
    this.gun = null;
    this.muzzle = null;
    this.attachWeapon();
    this.inst.setAim(1, true);
  }

  attachWeapon() {
    const mgr = this.mgr;
    const rec = mgr.pickGun();
    if (!rec) return;
    const { asset, def } = rec;
    const { R, axis } = gunAxis();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(asset.parts[0].geometry, asset.parts[0].material);
    g.add(mesh);
    asset.parts[0].geometry.computeBoundingBox();
    const bb = asset.parts[0].geometry.boundingBox;
    const gripLocal = new THREE.Vector3(0, bb.min.y + 0.045, bb.min.z + (bb.max.z - bb.min.z) * 0.24);
    g.quaternion.copy(q);
    g.position.copy(R).sub(gripLocal.applyQuaternion(q));
    this.inst.bodyGroup.add(g);
    this.gun = g;
    const m = new THREE.Object3D();
    m.position.set(0, bb.max.y - 0.05, bb.max.z - 0.02);
    g.add(m);
    this.muzzle = m;
    this.gunDef = def;
  }

  /* ------------------------------------------ 命中盒 */
  headCenter(out) {
    const v = out || new THREE.Vector3();
    return v.set(this.pos.x, this.pos.y + this.inst.headY - 0.115, this.pos.z);
  }

  /* ------------------------------------------ 更新 */
  update(dt, player) {
    if (this.dead) {
      this.deadT += dt;
      const t = clamp(this.deadT / 0.6, 0, 1);
      const k = t * t * (3 - 2 * t);
      this.inst.group.rotation.x = -k * Math.PI * 0.5;
      this.inst.group.position.y = this.pos.y + Math.sin(k * Math.PI) * 0.03;
      this.inst.setAim(clamp(this.aimVal - dt * 3, 0, 1));
      this.inst.update(dt, 0);
      return;
    }

    const dist = this.pos.distanceTo(player.pos);
    const see = this.canSee(player, dist);

    // --- 状态机
    if (this.state === 'patrol') {
      if (see && dist < CFG.viewDist) { this.state = 'alert'; this.reactionT = 0.28 + (1 - this.skill) * 0.3; }
    } else if (this.state === 'alert') {
      this.reactionT -= dt;
      if (this.reactionT <= 0) this.state = 'engage';
      if (!see) this.loseT += dt; else this.loseT = 0;
      if (this.loseT > CFG.loseTime) { this.state = 'patrol'; this.loseT = 0; }
    } else if (this.state === 'engage') {
      if (see) { this.loseT = 0; this.lastSeen.copy(player.pos); }
      else this.loseT += dt;
      if (this.loseT > CFG.loseTime) { this.state = 'patrol'; this.loseT = 0; }
      else if (!see && this.loseT > 0.8) this.state = 'search';
    } else if (this.state === 'search') {
      this.loseT += dt;
      if (see) { this.state = 'engage'; this.loseT = 0; }
      else if (this.loseT > CFG.loseTime) { this.state = 'patrol'; this.loseT = 0; }
    }

    // --- 期望朝向与移动
    let moveTarget = null;
    let faceYaw = this.yaw;
    const engaging = this.state === 'engage' || this.state === 'alert';

    if (this.state === 'patrol') {
      if (this.waypoints.length) {
        const wp = this.waypoints[this.wp % this.waypoints.length];
        moveTarget = _v.set(wp.x, this.pos.y, wp.z);
        if (Math.hypot(moveTarget.x - this.pos.x, moveTarget.z - this.pos.z) < 2.4) this.wp++;
        faceYaw = Math.atan2(moveTarget.x - this.pos.x, moveTarget.z - this.pos.z);
      } else {
        faceYaw = this.yaw + Math.sin(performance.now() * 0.0004 + this.pos.x) * dt * 0.6;
      }
      this.aimVal = damp(this.aimVal, 0.8, 3, dt);
    } else if (engaging) {
      faceYaw = Math.atan2(player.pos.x - this.pos.x, player.pos.z - this.pos.z);
      this.aimVal = damp(this.aimVal, 1, 8, dt);
      const desire = this.state === 'engage' ? CFG.strafeSpeed : CFG.chaseSpeed * 0.6;
      this.strafeT -= dt;
      if (this.strafeT <= 0) { this.strafeT = 0.8 + Math.random() * 1.6; this.strafeDir *= -1; }
      let want = 0;
      if (dist > CFG.engageDist) want = CFG.chaseSpeed;
      else if (dist < 9) want = -CFG.chaseSpeed * 0.6;
      const side = new THREE.Vector3(Math.cos(faceYaw), 0, -Math.sin(faceYaw));
      moveTarget = _v2.copy(this.pos)
        .addScaledVector(side, this.strafeDir * this.strafeSpeed * 0.6)
        .addScaledVector(_v3.set(Math.sin(faceYaw), 0, Math.cos(faceYaw)), want);
      this.speed = Math.abs(want) + CFG.strafeSpeed * 0.6;
    } else if (this.state === 'search') {
      faceYaw = Math.atan2(this.lastSeen.x - this.pos.x, this.lastSeen.z - this.pos.z);
      this.aimVal = damp(this.aimVal, 1, 4, dt);
      moveTarget = _v2.copy(this.lastSeen);
      this.speed = CFG.chaseSpeed * 0.85;
    }

    // 平滑转身
    this.yaw += wrapAngle(faceYaw - this.yaw) * clamp(dt * 6, 0, 1);

    // --- 移动
    if (moveTarget) {
      const dx = moveTarget.x - this.pos.x, dz = moveTarget.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      const maxSpd = this.state === 'patrol' ? CFG.patrolSpeed
        : (this.state === 'engage' || this.state === 'alert') ? (dist > CFG.engageDist ? CFG.chaseSpeed : CFG.strafeSpeed) : CFG.chaseSpeed * 0.85;
      if (d > 0.4) {
        const s = Math.min(maxSpd, d * 2.4);
        this.vel.x = damp(this.vel.x, dx / d * s, 8, dt);
        this.vel.z = damp(this.vel.z, dz / d * s, 8, dt);
      } else {
        this.vel.x = damp(this.vel.x, 0, 10, dt);
        this.vel.z = damp(this.vel.z, 0, 10, dt);
      }
    } else {
      this.vel.x = damp(this.vel.x, 0, 10, dt);
      this.vel.z = damp(this.vel.z, 0, 10, dt);
    }

    // 重力
    this.vel.y -= 19 * dt;
    this.pos.x += this.vel.x * dt;
    this.mgr.boxes.resolveCylinder(this.pos, 0.36, 1.8, 0.46);
    this.pos.z += this.vel.z * dt;
    this.mgr.boxes.resolveCylinder(this.pos, 0.36, 1.8, 0.46);
    this.pos.y += this.vel.y * dt;
    const floor = this.mgr.boxes.floorAt(this.pos.x, this.pos.z, this.pos.y + 0.46);
    if (this.vel.y <= 0 && this.pos.y <= floor + 0.05) { this.pos.y = floor; this.vel.y = 0; this.onGround = true; }
    else this.onGround = false;
    if (this.pos.y < -25) { this.pos.copy(this.mgr.randomSpawn()); this.vel.set(0, 0, 0); }

    // 与同伴分离
    this.mgr.separate(this, dt);

    // --- 动画
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > 0.3) this.stride += dt * (4.2 + hs * 1.5);
    this.inst.setStride(this.stride, clamp(hs / CFG.chaseSpeed, 0, 1));
    this.inst.setAim(this.aimVal);
    this.inst.group.position.copy(this.pos);
    this.inst.group.rotation.y = this.yaw;
    this.inst.update(dt, hs);

    // --- 开火
    if (this.state === 'engage') this.updateCombat(dt, player, dist);
    else this.fireCd = Math.max(this.fireCd, 0.35);
    this.hitFlash = Math.max(0, this.hitFlash - dt * 6);
  }

  updateCombat(dt, player, dist) {
    const los = this.canSee(player, dist);
    this.burstCd -= dt;
    if (this.burstCd <= 0) {
      this.burst = 3 + Math.floor(Math.random() * 4);
      this.burstCd = 1.0 + Math.random() * 1.3 + dist * 0.008;
    }
    this.fireCd -= dt;
    if (!los || this.fireCd > 0 || this.burst <= 0) return;

    this.fireCd = 0.10 + Math.random() * 0.05;
    this.burst--;
    this.shoot(player, dist);
  }

  shoot(player, dist) {
    const from = this.muzzle
      ? this.muzzle.getWorldPosition(new THREE.Vector3())
      : this.headCenter(new THREE.Vector3());
    const target = player.eyePos(new THREE.Vector3());
    const dir = target.sub(from).normalize();

    // 精度：越远越散，技能越高越准
    const spreadDeg = (1.6 + dist * 0.09) / Math.max(0.5, this.skill);
    const a = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * Math.tan(spreadDeg * Math.PI / 180);
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const d2 = dir.clone().addScaledVector(right, Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r).normalize();

    this.mgr.fx.muzzleFlash(from, d2, 0.34, 0.8);
    this.mgr.fx.smokePuff(from, 0.16, 0xa9a49c);
    this.mgr.audio.enemyShot(dist, this.panFor(player));

    // 命中玩家判定
    const hitP = this.mgr.rayVsPlayer(from, d2, player);
    if (hitP) {
      const g = this.mgr.boxes.raycast(from.x, from.y, from.z, d2.x, d2.y, d2.z, hitP.dist);
      if (!g) {
        const dmg = 8 + Math.random() * 6 + (this.key === 'support' ? 3 : 0);
        player.takeDamage(dmg * (this.mgr.dmgScale || 1), this.pos);
        this.mgr.onPlayerHit && this.mgr.onPlayerHit(this);
      }
    } else {
      // 擦身而过
      const side = right.dot(new THREE.Vector3().subVectors(player.pos, from).normalize());
      if (dist < 45 && Math.abs(side) < 0.5) this.mgr.audio.whizby(clamp(1 - dist / 45, 0.2, 1), side);
    }
  }

  panFor(player) {
    const fwd = player.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const to = _v3.subVectors(this.pos, player.pos).normalize();
    return clamp(right.dot(to), -1, 1);
  }

  canSee(player, dist) {
    if (this.dead) return false;
    if (dist > CFG.viewDist) return false;
    const eye = _v.set(this.pos.x, this.pos.y + this.inst.headY - 0.10, this.pos.z);
    const to = _v2.subVectors(player.eyePos(new THREE.Vector3()), eye);
    const d = to.length();
    if (d < 1e-3) return true;
    to.multiplyScalar(1 / d);
    // 视锥
    const facing = _v3.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const flat = new THREE.Vector3(to.x, 0, to.z).normalize();
    const inFov = facing.dot(flat) > CFG.fovCos || d < 8;
    const g = this.mgr.boxes.raycast(eye.x, eye.y, eye.z, to.x, to.y, to.z, d - 0.35);
    return inFov && !g;
  }

  takeDamage(dmg, head, point, ctx) {
    if (this.dead) return false;
    this.hp -= dmg;
    this.hitFlash = 1;
    // 被击中后立刻进入战斗
    if (this.state === 'patrol' || this.state === 'search') {
      this.state = 'engage';
      this.reactionT = 0;
      this.lastSeen.copy(ctx && ctx.playerPos ? ctx.playerPos : this.pos);
    }
    this.mgr.onDamage(this, point, head);
    if (this.hp <= 0) {
      this.hp = 0;
      this.dead = true;
      this.deadT = 0;
      this.mgr.onKill(this, head);
      return true;
    }
    return false;
  }
}

export class EnemyManager {
  constructor(o) {
    this.scene = o.scene;
    this.boxes = o.boxes;
    this.factory = o.factory;
    this.assets = o.assets;
    this.fx = o.fx;
    this.audio = o.audio;
    this.hud = o.hud;
    this.player = o.player;
    this.spawnPoints = o.spawnPoints || [];
    this.enemies = [];
    this.rng = makeRNG(20260921);
    this.gunList = [];
    this.weapons = o.weapons;
    this.wave = 0;
    this.kills = 0;
    this.waveTimer = 3;
    this.dmgScale = 1;
    this.maxAlive = 14;
  }

  pickGun() {
    if (!this.gunList.length) {
      for (const id of ['scar', 'ump']) {
        const def = this.weapons[id];
        if (!def) continue;
        const asset = this.assets.get(def.asset);
        if (asset) this.gunList.push({ asset, def });
      }
    }
    return this.gunList.length ? this.gunList[Math.floor(Math.random() * this.gunList.length)] : null;
  }

  randomSpawn() {
    if (!this.spawnPoints.length) return new THREE.Vector3(0, 1, 0);
    const p = this.spawnPoints[Math.floor(this.rng() * this.spawnPoints.length)];
    return new THREE.Vector3(p.x, this.boxes.floorAt(p.x, p.z, 60), p.z);
  }

  spawnWave() {
    this.wave++;
    const n = Math.min(this.maxAlive, 5 + this.wave * 2);
    this.dmgScale = 1 + Math.min(0.8, (this.wave - 1) * 0.09);
    const keys = ['assault', 'recon', 'support', 'guard', 'riot'];
    for (let i = 0; i < n; i++) {
      const key = this.rng() < 0.12 ? 'riot' : this.rng() < 0.25 ? 'guard' : keys[Math.floor(this.rng() * 3)];
      this.spawnOne(key);
    }
    this.hud && this.hud.setWave(this.wave, this.aliveCount());
    this.hud && this.hud.announce(`第 ${this.wave} 波敌人来袭`, '压制并清空街区');
  }

  spawnOne(key) {
    const p = this.randomSpawn();
    const e = new Enemy(this, key, p, {
      skill: 0.75 + Math.min(0.6, this.wave * 0.07),
      hpScale: 1 + Math.min(0.5, (this.wave - 1) * 0.06),
      waypoints: this.makeWaypoints(p),
    });
    this.enemies.push(e);
    return e;
  }

  makeWaypoints(p) {
    const pts = [];
    const n = 3;
    for (let i = 0; i < n; i++) {
      const a = this.rng() * Math.PI * 2, r = 8 + this.rng() * 26;
      pts.push({ x: p.x + Math.cos(a) * r, z: p.z + Math.sin(a) * r });
    }
    return pts;
  }

  separate(e, dt) {
    for (const o of this.enemies) {
      if (o === e || o.dead) continue;
      const dx = e.pos.x - o.pos.x, dz = e.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 1.44 && d2 > 1e-4) {
        const d = Math.sqrt(d2);
        const push = (1.2 - d) * 2.2 * dt;
        e.pos.x += dx / d * push;
        e.pos.z += dz / d * push;
      }
    }
  }

  aliveCount() { return this.enemies.filter((e) => !e.dead).length; }

  onDamage(e, point, head) {
    // 命中硬直：轻微打断移动，让射击有打击反馈
    e.vel.x *= 0.72;
    e.vel.z *= 0.72;
    e.fireCd += 0.05;
  }

  onKill(e, head) {
    this.kills++;
    this.hud && this.hud.killFeed(CHAR_SPECS[e.key] ? CHAR_SPECS[e.key].label : '敌人', head);
    this.hud && this.hud.setScore(this.kills);
  }

  /* 供玩家子弹使用的敌人射线检测 */
  raycastEnemies(origin, dir, maxDist) {
    let best = null;
    const hb = CFG.bodyHalf, lb = CFG.legHalf;
    for (const e of this.enemies) {
      if (e.dead) continue;
      // 头部球
      const hc = e.headCenter(_v);
      const dh = raySphere(origin, dir, hc, CFG.headR);
      if (dh !== null && dh < maxDist && (!best || dh < best.dist)) {
        best = { dist: dh, enemy: e, part: 'head', point: origin.clone().addScaledVector(dir, dh), normal: dir.clone().negate() };
      }
      // 躯干
      const cb = _v2.set(e.pos.x, e.pos.y + 0.95, e.pos.z);
      const d1 = rayAABB(origin, dir, cb, hb[0], hb[1], hb[2]);
      if (d1 !== null && d1 < maxDist && (!best || d1 < best.dist)) {
        best = { dist: d1, enemy: e, part: 'body', point: origin.clone().addScaledVector(dir, d1), normal: dir.clone().negate() };
      }
      // 腿部
      const cl = _v3.set(e.pos.x, e.pos.y + 0.38, e.pos.z);
      const d2 = rayAABB(origin, dir, cl, lb[0], lb[1], lb[2]);
      if (d2 !== null && d2 < maxDist && (!best || d2 < best.dist)) {
        best = { dist: d2, enemy: e, part: 'leg', point: origin.clone().addScaledVector(dir, d2), normal: dir.clone().negate() };
      }
    }
    return best;
  }

  /** 敌人子弹是否命中玩家 */
  rayVsPlayer(origin, dir, player) {
    const c = _v.set(player.pos.x, player.pos.y + player.eyeH * 0.62, player.pos.z);
    const d = rayAABB(origin, dir, c, 0.40, player.eyeH * 0.62, 0.34);
    if (d !== null) return { dist: d };
    const hc = _v2.set(player.pos.x, player.pos.y + player.eyeH, player.pos.z);
    const dh = raySphere(origin, dir, hc, 0.22);
    if (dh !== null) return { dist: dh };
    return null;
  }

  /** 敌人留在原地的尸体 */
  update(dt) {
    for (const e of this.enemies) e.update(dt, this.player);
    // 清理久留的尸体
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (e.dead && e.deadT > 26) {
        this.scene.remove(e.inst.group);
        this.enemies.splice(i, 1);
      }
    }
    // 波次
    if (this.aliveCount() === 0) {
      this.waveTimer -= dt;
      if (this.waveTimer <= 0) {
        this.waveTimer = 8;
        this.spawnWave();
      }
    } else {
      this.waveTimer = 8;
    }
    this.hud && this.hud.setEnemies(this.aliveCount());
  }
}

/* ---------------------------------------------- 射线工具 */
export function rayAABB(o, d, c, hx, hy, hz) {
  let tmin = 0, tmax = 1e9;
  for (let i = 0; i < 3; i++) {
    const oo = i === 0 ? o.x : i === 1 ? o.y : o.z;
    const dd = i === 0 ? d.x : i === 1 ? d.y : d.z;
    const cc = i === 0 ? c.x : i === 1 ? c.y : c.z;
    const h = i === 0 ? hx : i === 1 ? hy : hz;
    if (Math.abs(dd) < 1e-9) { if (oo < cc - h || oo > cc + h) return null; continue; }
    const inv = 1 / dd;
    let t1 = (cc - h - oo) * inv, t2 = (cc + h - oo) * inv;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmax < tmin) return null;
  }
  return tmin;
}

export function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const sq = Math.sqrt(disc);
  let t = -b - sq;
  if (t < 0) t = -b + sq;
  return t < 0 ? null : t;
}
