/* ============================================================
   HUD：准星 / 弹药 / 血量 / 命中反馈 / 击杀提示 / 小地图
   ============================================================ */
import * as THREE from 'three';
import { clamp, lerp } from './util.js';

const _v = new THREE.Vector3();

export class HUD {
  constructor(o) {
    this.camera = o.camera;
    this.boxes = o.boxes;
    this.extent = o.extent || 720;
    this.el = {};
    const $ = (id) => document.getElementById(id);
    this.el.cross = $('hudCross');
    this.el.crossLines = [...document.querySelectorAll('#hudCross i')];
    this.el.ammo = $('hudAmmo');
    this.el.ammoRes = $('hudAmmoRes');
    this.el.wname = $('hudWeapon');
    this.el.wkind = $('hudWeaponKind');
    this.el.hpBar = $('hudHpBar');
    this.el.hpNum = $('hudHpNum');
    this.el.hitmark = $('hudHitmark');
    this.el.feed = $('hudFeed');
    this.el.wave = $('hudWave');
    this.el.alive = $('hudAlive');
    this.el.score = $('hudScore');
    this.el.fps = $('hudFps');
    this.el.time = $('hudTime');
    this.el.pos = $('hudPos');
    this.el.banner = $('hudBanner');
    this.el.bannerT = $('hudBannerT');
    this.el.bannerS = $('hudBannerS');
    this.el.reload = $('hudReload');
    this.el.reloadIn = $('hudReloadIn');
    this.el.vin = $('hudVignette');
    this.el.death = $('hudDeath');
    this.el.dmgs = $('hudDmgNums');
    this.el.indicators = $('hudIndicators');
    this.el.mini = $('miniMap');
    this.el.miniWrap = $('miniWrap');
    this.el.obj = $('hudObjective');
    this.el.toast = $('hudToast');
    this.el.toastT = $('hudToastT');
    this.el.toastS = $('hudToastS');

    this.miniCtx = this.el.mini ? this.el.mini.getContext('2d') : null;
    this.kick = 0;
    this.curGap = 12;
    this.hitT = 0;
    this.dmgPool = [];
    this.indPool = [];
    this.stepPulse = 0;
    this.shakeT = 0;
    this.reloadShown = false;
    this.staticMap = null;
    this.staticScale = 2;      // px / m
    this.mapCenter = new THREE.Vector2(0, 0);
    this.mapHalf = 95;         // 小地图半宽（米）
    this.lastFeed = [];
    this.bannerT_ = 0;
    this.toastTimer = 0;
    if (this.el.mini) {
      this.el.mini.width = 208; this.el.mini.height = 208;
    }
  }

  /* ---------------------------------------------- 静态地图 */
  buildStaticMap() {
    const S = this.staticScale;
    const size = Math.ceil(this.extent * 2 * S);
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#12161c';
    g.fillRect(0, 0, size, size);
    const toPx = (v) => (v + this.extent) * S;
    for (const b of this.boxes.boxes) {
      const w = (b.maxX - b.minX), d = (b.maxZ - b.minZ);
      if (w * d < 26) continue;
      const isRoad = (b.maxY - b.minY) < 0.6 && w * d > 60;
      g.fillStyle = isRoad ? '#232a33' : (b.maxY - b.minY > 8 ? '#2c343f' : '#1d232b');
      g.fillRect(toPx(b.minX), toPx(b.minZ), Math.max(1, w * S), Math.max(1, d * S));
    }
    this.staticMap = c;
    this.mapSize = size;
  }

  /* ---------------------------------------------- 每帧 */
  update(dt, st) {
    const { player, weapon, enemies } = st;
    const now = st.time || 0;

    // 准星
    if (weapon) {
      const spread = weapon.currentSpread({
        speed: player.speed, onGround: player.onGround, crouch: player.crouch > 0.4,
      });
      const gap = clamp(6 + spread * 5.4, 6, 62) + this.kick * 8;
      this.curGap = lerp(this.curGap, gap, clamp(dt * 14, 0, 1));
      this.kick = Math.max(0, this.kick - dt * 5.5);
      const g = this.curGap;
      const L = this.el.crossLines;
      if (L.length === 4) {
        L[0].style.transform = `translate(-50%,0) translateY(${-g}px)`;
        L[1].style.transform = `translate(-50%,0) translateY(${g}px)`;
        L[2].style.transform = `translate(0,-50%) translateX(${-g}px)`;
        L[3].style.transform = `translate(0,-50%) translateX(${g}px)`;
      }
      if (this.el.cross) this.el.cross.style.opacity = st.ads ? 0.15 : 0.92;

      // 换弹进度
      if (weapon.isReloading) {
        this.el.reload.classList.add('on');
        this.el.reloadIn.style.width = (weapon.reloadProgress * 100).toFixed(0) + '%';
      } else if (this.el.reload.classList.contains('on')) {
        this.el.reload.classList.remove('on');
      }
    }

    // 血量
    const hp = clamp(player.hp / player.cfg.maxHp, 0, 1);
    if (this.el.hpBar) this.el.hpBar.style.width = (hp * 100).toFixed(0) + '%';
    if (this.el.hpNum) this.el.hpNum.textContent = Math.max(0, Math.round(player.hp));
    if (this.el.hpBar) {
      this.el.hpBar.style.background = hp < 0.3
        ? 'linear-gradient(90deg,#c0392b,#ff6b4a)'
        : hp < 0.6 ? 'linear-gradient(90deg,#c98c2b,#f0c04a)' : 'linear-gradient(90deg,#2f9e6f,#63d9a0)';
    }
    if (this.el.vin) {
      const v = clamp(player.damageFlash * 0.9 + (1 - hp) * 0.55, 0, 1);
      this.el.vin.style.opacity = v.toFixed(3);
    }

    // 命中标记
    if (this.hitT > 0) {
      this.hitT -= dt;
      if (this.el.hitmark) this.el.hitmark.style.opacity = clamp(this.hitT / 0.22, 0, 1);
    } else if (this.el.hitmark && this.el.hitmark.style.opacity !== '0') {
      this.el.hitmark.style.opacity = '0';
    }

    // 脚步/震动
    this.stepPulse = Math.max(0, this.stepPulse - dt * 3.4);
    this.shakeT = Math.max(0, this.shakeT - dt * 3);

    // 伤害数字
    this.updateDamageNumbers(dt);
    this.updateIndicators(dt);

    // 横幅
    if (this.bannerT_ > 0) {
      this.bannerT_ -= dt;
      if (this.bannerT_ <= 0) this.el.banner.classList.remove('on');
    }

    // 右上信息
    if (this.el.fps) this.el.fps.textContent = st.fps.toFixed(0);
    if (this.el.time) this.el.time.textContent = fmtClock(st.clock);
    if (this.el.pos) this.el.pos.textContent = `${player.pos.x.toFixed(0)}, ${player.pos.z.toFixed(0)}`;

    this.drawMinimap(player, enemies, st);
  }

  /* ---------------------------------------------- 小地图 */
  drawMinimap(player, enemies, st) {
    const ctx = this.miniCtx;
    if (!ctx || !this.staticMap) return;
    const W = this.el.mini.width, H = this.el.mini.height;
    const S = this.staticScale * (W / (this.mapHalf * 2));
    const cx = (player.pos.x + this.extent) * this.staticScale;
    const cz = (player.pos.z + this.extent) * this.staticScale;
    const half = this.mapHalf * this.staticScale;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2, H / 2);
    const yaw = player.yaw;
    ctx.rotate(yaw);                     // 地图随视角旋转
    ctx.drawImage(this.staticMap, cx - half, cz - half, half * 2, half * 2, -W / 2, -H / 2, W, H);
    ctx.restore();

    // 敌人
    ctx.save();
    ctx.translate(W / 2, H / 2);
    for (const e of enemies) {
      if (e.dead) continue;
      const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
      const r = Math.hypot(dx, dz);
      if (r > this.mapHalf) continue;
      const c = Math.cos(yaw), s = Math.sin(yaw);
      const px = (dx * c - dz * s) * S;
      const py = (dx * s + dz * c) * S;
      const seen = e.state === 'engage' || e.state === 'alert';
      ctx.fillStyle = seen ? '#ff4d4d' : 'rgba(255,150,90,.72)';
      ctx.beginPath();
      ctx.arc(px, py, 3.2, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();

    // 玩家三角
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.fillStyle = '#8fe3ff';
    ctx.beginPath();
    ctx.moveTo(0, -6); ctx.lineTo(4.4, 5); ctx.lineTo(0, 2.6); ctx.lineTo(-4.4, 5);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // 罗盘（北 = 世界 -Z）
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.fillStyle = 'rgba(190,220,245,.85)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const R = this.mapHalf * S * 0.90;
    ctx.fillText('北', Math.sin(yaw) * R, -Math.cos(yaw) * R);
    ctx.restore();
  }

  /* ---------------------------------------------- 伤害数字 */
  spawnDmgEl() {
    let d = this.dmgPool.find((x) => x.life <= 0);
    if (!d) {
      const el = document.createElement('div');
      el.className = 'dmgNum';
      this.el.dmgs.appendChild(el);
      d = { el, life: 0, max: 1, world: new THREE.Vector3() };
      this.dmgPool.push(d);
    }
    return d;
  }

  damageNumber(worldPos, amount, head) {
    const d = this.spawnDmgEl();
    d.life = d.max = head ? 1.0 : 0.8;
    d.world.copy(worldPos);
    d.el.textContent = amount > 0 ? String(amount) : '';
    d.el.className = 'dmgNum' + (head ? ' head' : '');
    if (amount <= 0) { d.life = 0; d.el.textContent = ''; return; }
    d.el.style.opacity = '1';
  }

  updateDamageNumbers(dt) {
    const cam = this.camera;
    const W = window.innerWidth, H = window.innerHeight;
    for (const d of this.dmgPool) {
      if (d.life <= 0) { if (d.el.style.display !== 'none') d.el.style.display = 'none'; continue; }
      d.life -= dt;
      d.el.style.display = 'block';
      d.world.y += dt * 0.85;
      _v.copy(d.world).project(cam);
      const x = (_v.x * 0.5 + 0.5) * W;
      const y = (-_v.y * 0.5 + 0.5) * H;
      const k = d.life / d.max;
      d.el.style.transform = `translate(-50%,-50%) translate(${x}px,${y}px) scale(${1 + (1 - k) * 0.25})`;
      d.el.style.opacity = String(clamp(k * 1.6, 0, 1));
      if (d.life <= 0) d.el.style.display = 'none';
    }
  }

  /* ---------------------------------------------- 受击方向指示 */
  damageIndicator(fromPos) {
    let ind = this.indPool.find((x) => x.life <= 0);
    if (!ind) {
      const el = document.createElement('div');
      el.className = 'dmgDir';
      this.el.indicators.appendChild(el);
      ind = { el, life: 0, max: 1.1, dir: 0 };
      this.indPool.push(ind);
    }
    const fwd = this.camera.getWorldDirection(new THREE.Vector3());
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const to = _v.copy(fromPos).sub(this.camera.position);
    to.y = 0; to.normalize();
    const dotR = right.dot(to), dotF = fwd.dot(to);
    ind.dir = Math.atan2(dotR, dotF);
    ind.life = ind.max;
    ind.el.style.display = 'block';
  }

  updateIndicators(dt) {
    for (const ind of this.indPool) {
      if (ind.life <= 0) { if (ind.el.style.display !== 'none') ind.el.style.display = 'none'; continue; }
      ind.life -= dt;
      const k = ind.life / ind.max;
      ind.el.style.opacity = String(clamp(k, 0, 1) * 0.9);
      ind.el.style.transform = `rotate(${(ind.dir * 180 / Math.PI).toFixed(1)}deg)`;
    }
  }

  /* ---------------------------------------------- 基础设置 */
  setAmmo(mag, reserve, flash) {
    if (this.el.ammo) this.el.ammo.textContent = mag;
    if (this.el.ammoRes) this.el.ammoRes.textContent = reserve;
    if (flash && this.el.ammo) {
      const p = this.el.ammo.parentElement;
      p.classList.remove('pop');
      void p.offsetWidth;
      p.classList.add('pop');
    }
  }
  flashAmmo() {
    if (!this.el.ammo) return;
    const p = this.el.ammo.parentElement;
    p.classList.remove('pop'); void p.offsetWidth; p.classList.add('pop');
  }
  setWeapon(w) {
    if (!this.el.wname || !w) return;
    this.el.wname.textContent = w.def.name;
    if (this.el.wkind) this.el.wkind.textContent = w.def.kind + ' · 全自动';
    this.setAmmo(w.mag, w.reserve);
  }
  hitmarker(head, killed) {
    this.hitT = killed ? 0.30 : 0.22;
    if (!this.el.hitmark) return;
    this.el.hitmark.classList.toggle('head', !!head);
    this.el.hitmark.classList.toggle('kill', !!killed);
    this.el.hitmark.style.opacity = '1';
  }
  crosshairKick() { this.kick = Math.min(1.6, this.kick + 0.55); }
  footstepPulse(v) { this.stepPulse = v; }
  screenShake(v) { this.shakeT = Math.max(this.shakeT, v); }
  setWave(n, alive) {
    if (this.el.wave) this.el.wave.textContent = n;
    if (this.el.alive) this.el.alive.textContent = alive;
  }
  setEnemies(n) { if (this.el.alive) this.el.alive.textContent = n; }
  setScore(n) { if (this.el.score) this.el.score.textContent = n; }
  killFeed(name, head) {
    if (!this.el.feed) return;
    const d = document.createElement('div');
    d.className = 'feedItem' + (head ? ' head' : '');
    d.innerHTML = `<span class="who">你</span><span class="ico">${head ? '◎' : '✕'}</span><span class="tgt">${name}</span>`;
    this.el.feed.appendChild(d);
    while (this.el.feed.children.length > 5) this.el.feed.removeChild(this.el.feed.firstChild);
    setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 700); }, 3600);
  }
  announce(title, sub, dur = 3.4) {
    if (!this.el.banner) return;
    this.el.bannerT.textContent = title;
    this.el.bannerS.textContent = sub || '';
    this.el.banner.classList.add('on');
    this.bannerT_ = dur;
  }
  setObjective(text) { if (this.el.obj) this.el.obj.textContent = text; }

  /* ---------------------------------------------- 提示条 */
  toast(msg, sub, dur = 3.4) {
    const el = this.el.toast;
    if (!el) return;
    if (this.el.toastT) this.el.toastT.textContent = msg || '';
    if (this.el.toastS) this.el.toastS.textContent = sub || '';
    el.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('on'), (dur || 3.4) * 1000);
  }
  onDeath() {
    if (this.el.death) this.el.death.classList.add('on');
  }
  onRespawn() {
    if (this.el.death) this.el.death.classList.remove('on');
  }
}

function fmtClock(t) {
  const h = Math.floor(t) % 24;
  const m = Math.floor((t % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
