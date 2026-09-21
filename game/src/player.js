/* ============================================================
   FPS 角色控制器
   - 走 / 跑 / 蹲 / 跳、加速与摩擦、台阶自动跨越
   - 头部摆动、落地下沉、冲刺 FOV
   - 武器后坐引起的视角抬升与回落
   ============================================================ */
import * as THREE from 'three';
import { clamp, lerp, damp, DEG } from './util.js';

const _v = new THREE.Vector3();

export const PLAYER_CFG = {
  radius: 0.36,
  height: 1.80,
  eyeStand: 1.66,
  eyeCrouch: 1.08,
  stepUp: 0.46,
  speedWalk: 4.5,
  speedSprint: 7.6,
  speedCrouch: 2.3,
  accel: 58,
  airAccel: 9,
  friction: 9.5,
  jumpVel: 5.5,
  gravity: 19,
  maxHp: 100,
};

export class Player {
  constructor(o) {
    this.camera = o.camera;
    this.boxes = o.boxes;
    this.audio = o.audio;
    this.hud = o.hud;
    this.cfg = PLAYER_CFG;

    this.pos = new THREE.Vector3(o.spawn ? o.spawn.x : 0, 0, o.spawn ? o.spawn.z : 0);
    this.vel = new THREE.Vector3();
    this.yaw = o.spawn ? (o.spawn.yaw || 0) : 0;
    this.pitch = 0;

    this.onGround = true;
    this.crouch = 0;
    this.crouchWant = false;
    this.sprint = false;
    this.eyeH = this.cfg.eyeStand;
    this.bobPhase = 0;
    this.stepDist = 0;
    this.landDip = 0;
    this.strafeLean = 0;
    this.stepSurface = 0;

    this.hp = this.cfg.maxHp;
    this.dead = false;
    this.lastHurt = -99;
    this.hurtDir = 0;
    this.damageFlash = 0;

    this.recoilPitch = 0; this.recoilYaw = 0;
    this.recoilVP = 0; this.recoilVY = 0;
    this.shakeP = 0; this.shakeV = 0;

    this.sensBase = 0.0022;
    this.fovBase = o.fov || 78;
    this.fov = this.fovBase;
    this.speed = 0;

    this.spawnPoint = this.pos.clone();
    this.spawnYaw = this.yaw;
  }

  /* -------------------------------------------- 视角 */
  look(dx, dy, sensScale = 1) {
    if (this.dead) return;
    const s = this.sensBase * sensScale;
    this.yaw -= dx * s;
    this.pitch -= dy * s;
    this.pitch = clamp(this.pitch, -1.45, 1.45);
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }

  /** 参数单位为「度」，相机使用弧度 */
  addRecoil(dPitchDeg, dYawDeg) {
    const p = dPitchDeg * DEG;
    const y = dYawDeg * DEG;
    this.recoilPitch += p;
    this.recoilYaw += y;
    this.recoilVP += p * 3.2;
    this.recoilVY += y * 3.2;
  }

  shake(amount) {
    this.shakeV += amount;
  }

  /* -------------------------------------------- 主更新 */
  update(dt, input) {
    const cfg = this.cfg;

    // ---- 下蹲
    this.crouchWant = !!input.crouch;
    this.sprint = !!input.sprint && !this.crouchWant && input.forward > 0.1 && !input.ads;

    // ---- 期望速度
    let target = cfg.speedWalk;
    if (this.crouchWant) target = cfg.speedCrouch;
    else if (this.sprint) target = cfg.speedSprint;
    if (input.ads) target *= 0.62;
    if (this.dead) target = 0;

    // 蹲下时若头顶有障碍则不能起身
    const wantCrouch = this.crouchWant ? 1 : 0;
    this.crouch = damp(this.crouch, wantCrouch, 11, dt);

    // ---- 方向
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = (-sin * input.forward) + (cos * input.right);
    let wz = (-cos * input.forward) + (-sin * input.right);
    const wl = Math.hypot(wx, wz);
    if (wl > 1e-4) { wx /= wl; wz /= wl; }

    // ---- 水平加速
    const accel = this.onGround ? cfg.accel : cfg.airAccel;
    const tx = wx * target, tz = wz * target;
    let dvx = tx - this.vel.x, dvz = tz - this.vel.z;
    const dvl = Math.hypot(dvx, dvz);
    const maxDv = accel * dt;
    if (dvl > maxDv && dvl > 1e-6) { dvx *= maxDv / dvl; dvz *= maxDv / dvl; }
    this.vel.x += dvx; this.vel.z += dvz;

    // 摩擦
    if (this.onGround && wl < 1e-4) {
      const f = Math.exp(-cfg.friction * dt);
      this.vel.x *= f; this.vel.z *= f;
    }
    if (this.onGround && this.crouchWant && Math.hypot(this.vel.x, this.vel.z) > cfg.speedCrouch) {
      const f = Math.exp(-6 * dt);
      this.vel.x *= f; this.vel.z *= f;
    }

    // ---- 跳跃 / 重力
    if (input.jump && this.onGround && !this.dead) {
      this.vel.y = cfg.jumpVel;
      this.onGround = false;
      this.audio.jump();
    }
    this.vel.y -= cfg.gravity * dt;
    if (this.vel.y < -60) this.vel.y = -60;

    // ---- 水平移动 + 碰撞（分轴推进，避免卡角）
    const wasGround = this.onGround;
    const step = this.onGround ? cfg.stepUp : 0.12;
    this.pos.x += this.vel.x * dt;
    this.boxes.resolveCylinder(this.pos, cfg.radius, cfg.height, step);
    this.pos.z += this.vel.z * dt;
    this.boxes.resolveCylinder(this.pos, cfg.radius, cfg.height, step);

    // ---- 垂直
    this.pos.y += this.vel.y * dt;

    // ---- 地面吸附
    const floor = this.boxes.floorAt(this.pos.x, this.pos.z, this.pos.y + cfg.stepUp);
    if (this.vel.y <= 0 && this.pos.y <= floor + 0.06) {
      const impactV = -this.vel.y;
      this.pos.y = floor;
      this.vel.y = 0;
      if (!wasGround) {
        const s = clamp(impactV / 9, 0, 1.4);
        this.landDip = 0.5 + s * 0.9;
        this.audio.land(0.5 + s * 0.7);
        this.shake(s * 0.02);
        if (s > 0.9 && this.hud) this.hud.screenShake(s * 0.5);
      }
      this.onGround = true;
    } else {
      this.onGround = false;
    }

    // 掉出地图
    if (this.pos.y < -30) this.respawn();

    // 站到建筑内部时向外推
    if (this.boxes.insideAny(this.pos.x, this.pos.y + 1.0, this.pos.z)) {
      this.boxes.resolveCylinder(this.pos, cfg.radius, cfg.height, 0.2);
    }

    // ---- 速度
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.speed = hs;

    // ---- 脚步
    if (this.onGround && hs > 0.6) {
      const stride = this.crouchWant ? 0.78 : (this.sprint ? 0.92 : 0.80);
      this.stepDist += hs * dt;
      if (this.stepDist >= stride) {
        this.stepDist = 0;
        this.stepSurface = (this.stepSurface + 1) % 6;
        const surf = this.stepSurface < 2 ? 'concrete' : 'stone';
        this.audio.footstep(surf, this.crouchWant ? 0.5 : this.sprint ? 1.15 : 0.9);
        if (this.hud) this.hud.footstepPulse(this.sprint ? 1 : 0.6);
      }
    }

    // ---- 头部摆动
    const sn = clamp(hs / cfg.speedSprint, 0, 1.2);
    const bobActive = this.onGround ? sn : 0;
    this.bobPhase += dt * (7.4 + sn * 3.6) * (bobActive > 0.02 ? 1 : 0);
    const strafe = input.right || 0;
    this.strafeLean = damp(this.strafeLean, -strafe * 0.035, 7, dt);

    // ---- 视角回弹
    this.recoilVP += (-this.recoilPitch * 120 - this.recoilVP * 15) * dt;
    this.recoilPitch += this.recoilVP * dt;
    this.recoilVY += (-this.recoilYaw * 120 - this.recoilVY * 15) * dt;
    this.recoilYaw += this.recoilVY * dt;
    this.shakeP *= Math.max(0, 1 - dt * 7);
    this.shakeV *= Math.max(0, 1 - dt * 7);
    this.landDip = Math.max(0, this.landDip - dt * 3.6);

    // ---- 眼睛高度
    const eyeTarget = lerp(cfg.eyeStand, cfg.eyeCrouch, this.crouch);
    this.eyeH = damp(this.eyeH, eyeTarget, 12, dt);

    // ---- 相机
    const bobY = Math.abs(Math.sin(this.bobPhase)) * 0.035 * bobActive;
    const bobX = Math.sin(this.bobPhase) * 0.025 * bobActive;
    const shakeX = (Math.random() - 0.5) * this.shakeP;
    const shakeY = (Math.random() - 0.5) * this.shakeP;
    const cam = this.camera;
    cam.position.set(
      this.pos.x + bobX + shakeX,
      this.pos.y + this.eyeH - bobY - this.landDip * 0.075 + shakeY,
      this.pos.z
    );
    const roll = this.strafeLean + Math.sin(this.bobPhase) * 0.010 * bobActive;
    cam.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, roll, 'YXZ');

    // ---- FOV
    // adsZoom 是「放大倍数」：开镜要缩小 FOV（除以倍数）
    const fovTarget = this.fovBase
      * (this.sprint ? 1.06 : 1)
      / (input.ads ? input.adsZoom || 1 : 1);
    this.fov = damp(this.fov, fovTarget, 12, dt);
    cam.fov = this.fov;
    cam.updateProjectionMatrix();

    // ---- 受伤恢复
    if (!this.dead && this.hp < cfg.maxHp && this.lastHurt > 0 && performance.now() / 1000 - this.lastHurt > 5) {
      this.hp = Math.min(cfg.maxHp, this.hp + 12 * dt);
    }
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);
  }

  /* -------------------------------------------- 伤害 */
  takeDamage(dmg, fromPos) {
    if (this.dead) return false;
    this.hp -= dmg;
    this.lastHurt = performance.now() / 1000;
    this.damageFlash = clamp(this.damageFlash + dmg / 45, 0, 1.4);
    this.audio.hurt();
    this.shake(0.05);
    if (this.hud) this.hud.damageIndicator(fromPos);
    if (this.hp <= 0) { this.hp = 0; this.die(); return true; }
    return false;
  }

  die() {
    this.dead = true;
    this.audio.death();
    if (this.hud) this.hud.onDeath();
  }

  respawn() {
    this.pos.copy(this.spawnPoint);
    this.pos.y = this.boxes.floorAt(this.pos.x, this.pos.z, 50);
    this.vel.set(0, 0, 0);
    this.yaw = this.spawnYaw;
    this.pitch = 0;
    this.recoilPitch = this.recoilYaw = this.recoilVP = this.recoilVY = 0;
    this.hp = this.cfg.maxHp;
    this.dead = false;
    this.landDip = 0;
    if (this.hud) this.hud.onRespawn();
  }

  /** 视线世界坐标（子弹起点参考） */
  eyePos(out) {
    const v = out || _v;
    return v.set(this.pos.x, this.pos.y + this.eyeH, this.pos.z);
  }
}
