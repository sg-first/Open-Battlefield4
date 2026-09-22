/* ============================================================
   夜光池（BF4 式夜间光照）—— 只做「建筑窗光」，含投影

   夜晚街道完全由建筑亮窗照亮，分两层：

   1) 投影窗光 ×2 —— SpotLight 挂在离玩家最近的塔楼「朝街窗墙」上，
      向下略偏向玩家打，1024² 阴影图 + PCFSoft：
      街边道具 / 灯杆 / 角色在楼前街道上投出真实的软阴影。
   2) 环境窗光 ×6 —— PointLight 挂同样的窗墙位，无阴影，
      提供更大范围的暖色洗墙，避免只有两块光斑。

   设计要点：
   - 光源常驻场景、白天强度为 0。绝不用 visible 开关 —— three 会因
     光源数量变化重编译全部材质，昼夜切换时造成明显卡顿。
   - 每 0.4s（或玩家移动 >4m）重新吸附到最近的塔楼。
   - 吸附位从塔心向玩家外移（min(14, dist*0.55)）：挂在朝街一面，
     挂在塔心会让强半径全闷在楼体内部，到街面时已衰减殆尽。
   - 环境窗光带轻微呼吸（随机相位），投影窗光保持稳定（建筑照明
     不会闪烁，闪烁的是路灯/霓虹）。
   - 注意单位：three r160 默认物理光照，intensity 是坎德拉。
   ============================================================ */
import * as THREE from 'three';

const SHADOW_COUNT = 3;             // 投影窗光数
const GLOW_COUNT = 10;              // 环境窗光数
const GLOW_RANGE = 64.0;           // 环境窗光作用半径
const SPOT_RANGE = 48.0;           // 投影窗光作用半径
const REASSIGN_INTERVAL = 0.4;     // 重新吸附间隔（秒）

export class NightLightPool {
  constructor(scene, info) {
    this.scene = scene;
    this.glowPoints = (info && info.glowPoints) || [];
    this.timer = 0;
    this.lastX = 1e9;
    this.lastZ = 1e9;

    /* ---- 投影窗光：SpotLight 向下（阴影） ---- */
    this.spots = [];
    for (let i = 0; i < SHADOW_COUNT; i++) {
      const s = new THREE.SpotLight(0xffb377, 0, SPOT_RANGE, 1.25, 0.45, 1.6);
      s.position.set(0, 11, 0);
      s.target.position.set(0, 0, 0);
      s.castShadow = true;
      s.shadow.mapSize.set(1024, 1024);
      s.shadow.camera.near = 0.5;
      s.shadow.camera.far = SPOT_RANGE;
      s.shadow.bias = -0.00035;
      s.shadow.normalBias = 0.028;
      scene.add(s, s.target);
      this.spots.push({ light: s, phase: Math.random() * 6.28 });
    }

    /* ---- 环境窗光：PointLight 无阴影 ---- */
    this.glows = [];
    for (let i = 0; i < GLOW_COUNT; i++) {
      const p = new THREE.PointLight(0xffb377, 0, GLOW_RANGE, 1.6);
      p.position.set(0, 12, 0);
      scene.add(p);
      // 色温微差：让街道上不同方向的“窗光”有冷暖变化
      const warm = 0.92 + 0.16 * Math.random();
      p.color.setRGB(1.0 * warm, 0.72 * warm, 0.48 * warm);
      this.glows.push({ light: p, phase: Math.random() * 6.28 });
    }
  }

  /**
   * 每帧调用。
   * @param {number} px 玩家 x
   * @param {number} pz 玩家 z
   * @param {number} night 夜间系数 [0,1]
   * @param {number} dt 帧间隔
   */
  update(px, pz, night, dt = 0.016) {
    if (night < 0.02) {
      for (const s of this.spots) s.light.intensity = 0;
      for (const g of this.glows) g.light.intensity = 0;
      this.timer = REASSIGN_INTERVAL;   // 入夜时立刻重新吸附
      return;
    }

    this.timer -= dt;
    const moved = (px - this.lastX) ** 2 + (pz - this.lastZ) ** 2;
    if (this.timer <= 0 || moved > 16) {
      this.timer = REASSIGN_INTERVAL;
      this.lastX = px; this.lastZ = pz;
      this._reassign(px, pz);
    }

    const t = performance.now() * 0.001;
    // 投影窗光：稳定（建筑照明不闪烁），楼前地面 ~11m 处约 480/11^1.7 ≈ 8
    for (const s of this.spots) {
      s.light.intensity = 700 * night;
    }
    // 环境窗光：呼吸（不同楼不同相位），20m 街面处约 300/20^1.6 ≈ 2.3
    for (const g of this.glows) {
      const breathe = 0.85 + 0.15 * Math.sin(t * 0.7 + g.phase);
      g.light.intensity = 420 * night * breathe;
    }
  }

  /** 把窗光吸附到离玩家最近的塔楼（朝街一面） */
  _reassign(px, pz) {
    if (!this.glowPoints.length) return;
    const sorted = this.glowPoints
      .map((p, i) => ({ i, d: (p.x - px) ** 2 + (p.z - pz) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, (SHADOW_COUNT + GLOW_COUNT) * 2);
    const used = new Set();

    // 投影窗光优先挑最近的两栋（光锥覆盖玩家与楼之间的街道）
    for (const s of this.spots) {
      const c = this._take(sorted, used);
      if (!c) continue;
      const p = this.glowPoints[c.i];
      const dist = Math.sqrt(c.d);
      if (dist < 1) { s.light.position.set(p.x, 11, p.z); continue; }
      const k = Math.min(14, dist * 0.55) / dist;
      const gx = p.x + (px - p.x) * k, gz = p.z + (pz - p.z) * k;
      s.light.position.set(gx, 11, gz);
      // 目标再往玩家方向偏 8m：锥体覆盖楼前街道而不是楼基
      const ux = (px - gx) / Math.max(dist, 1), uz = (pz - gz) / Math.max(dist, 1);
      s.light.target.position.set(gx + ux * 8, 0, gz + uz * 8);
      s.light.target.updateMatrixWorld();
    }

    // 环境窗光铺剩下最近的几栋
    for (const g of this.glows) {
      const c = this._take(sorted, used);
      if (!c) continue;
      const p = this.glowPoints[c.i];
      const dist = Math.sqrt(c.d);
      if (dist < 1) { g.light.position.set(p.x, 12, p.z); continue; }
      const k = Math.min(14, dist * 0.55) / dist;
      g.light.position.set(p.x + (px - p.x) * k, 12, p.z + (pz - p.z) * k);
    }
  }

  _take(sorted, used) {
    for (const c of sorted) {
      if (!used.has(c.i)) { used.add(c.i); return c; }
    }
    return null;
  }

  dispose() {
    for (const s of this.spots) { this.scene.remove(s.light, s.light.target); s.light.dispose(); }
    for (const g of this.glows) { this.scene.remove(g.light); g.light.dispose(); }
  }
}
