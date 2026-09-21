/* ============================================================
   碰撞世界：一批 Y 轴旋转的 OBB + 均匀网格加速
   支持：圆柱体（角色）推出、射线求交、地面高度采样
   ============================================================ */
import * as THREE from 'three';
import { clamp } from './util.js';

const CELL = 8;

export class BoxWorld {
  constructor() {
    this.boxes = [];
    this.grid = new Map();
    this.groundY = 0;
  }

  add(cx, cy, cz, hx, hy, hz, yaw = 0, kind = 'concrete') {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // 世界 AABB（用于粗筛）
    const ex = Math.abs(c) * hx + Math.abs(s) * hz;
    const ez = Math.abs(s) * hx + Math.abs(c) * hz;
    const b = {
      cx, cy, cz, hx, hy, hz, c, s, kind,
      minX: cx - ex, maxX: cx + ex,
      minZ: cz - ez, maxZ: cz + ez,
      minY: cy - hy, maxY: cy + hy,
      dirty: false,
    };
    this.boxes.push(b);
    return b;
  }

  finalize() {
    this.grid.clear();
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const x0 = Math.floor(b.minX / CELL), x1 = Math.floor(b.maxX / CELL);
      const z0 = Math.floor(b.minZ / CELL), z1 = Math.floor(b.maxZ / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const k = x * 73856093 ^ z * 19349663;
          let arr = this.grid.get(k);
          if (!arr) { arr = []; this.grid.set(k, arr); }
          arr.push(i);
        }
      }
    }
    return this;
  }

  /** 收集 (x,z) 附近半径 r 的候选盒索引 */
  candidates(x, z, r, out) {
    out.length = 0;
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    const seen = this._seen || (this._seen = new Set());
    seen.clear();
    for (let ix = x0; ix <= x1; ix++) {
      for (let iz = z0; iz <= z1; iz++) {
        const arr = this.grid.get(ix * 73856093 ^ iz * 19349663);
        if (!arr) continue;
        for (let n = 0; n < arr.length; n++) {
          const id = arr[n];
          if (!seen.has(id)) { seen.add(id); out.push(this.boxes[id]); }
        }
      }
    }
    return out;
  }

  /**
   * 圆柱推出。pos 为脚底位置（会被修改）
   * 返回是否发生碰撞
   */
  resolveCylinder(pos, radius, height, stepUp = 0.12, outNormal) {
    const list = this.candidates(pos.x, pos.z, radius + 1.2, this._tmp || (this._tmp = []));
    let hit = false;
    const y0 = pos.y + stepUp, y1 = pos.y + height;
    for (let n = 0; n < list.length; n++) {
      const b = list[n];
      if (y1 <= b.minY + 0.02 || y0 >= b.maxY - 0.02) continue;
      const dx = pos.x - b.cx, dz = pos.z - b.cz;
      const lx = b.c * dx - b.s * dz;
      const lz = b.s * dx + b.c * dz;
      const qx = clamp(lx, -b.hx, b.hx);
      const qz = clamp(lz, -b.hz, b.hz);
      let nx, nz, push;
      const ddx = lx - qx, ddz = lz - qz;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 > radius * radius) continue;
      if (d2 > 1e-7) {
        const d = Math.sqrt(d2);
        nx = ddx / d; nz = ddz / d;
        push = radius - d;
      } else {
        const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
        if (px < pz) { nx = lx < 0 ? -1 : 1; nz = 0; push = px + radius; }
        else { nx = 0; nz = lz < 0 ? -1 : 1; push = pz + radius; }
      }
      const wx = b.c * nx + b.s * nz;
      const wz = -b.s * nx + b.c * nz;
      pos.x += wx * push;
      pos.z += wz * push;
      if (outNormal) { outNormal.x = wx; outNormal.z = wz; }
      hit = true;
    }
    return hit;
  }

  /** 采样地面：返回 x,z 处不高于 maxY 的最高表面 */
  floorAt(x, z, maxY) {
    const list = this.candidates(x, z, 1.6, this._tmp2 || (this._tmp2 = []));
    let top = this.groundY;
    for (let n = 0; n < list.length; n++) {
      const b = list[n];
      if (b.maxY > maxY) continue;
      const dx = x - b.cx, dz = z - b.cz;
      const lx = b.c * dx - b.s * dz;
      const lz = b.s * dx + b.c * dz;
      if (Math.abs(lx) > b.hx + 0.02 || Math.abs(lz) > b.hz + 0.02) continue;
      if (b.maxY > top) top = b.maxY;
    }
    return top;
  }

  /** 圆柱中心是否卡在某盒内部（用于掉出地图后的复位判断） */
  insideAny(x, y, z) {
    const list = this.candidates(x, z, 1.6, this._tmp3 || (this._tmp3 = []));
    for (let n = 0; n < list.length; n++) {
      const b = list[n];
      if (y < b.minY || y > b.maxY) continue;
      const dx = x - b.cx, dz = z - b.cz;
      const lx = b.c * dx - b.s * dz;
      const lz = b.s * dx + b.c * dz;
      if (Math.abs(lx) < b.hx && Math.abs(lz) < b.hz) return true;
    }
    return false;
  }

  /**
   * 射线求交（DDA 沿网格推进）
   * 返回 { dist, point, normal, box } 或 null
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist) {
    let best = null, bestT = maxDist;
    const invX = 1 / (dx || 1e-9), invZ = 1 / (dz || 1e-9);
    // 沿射线访问网格单元
    let cx = Math.floor(ox / CELL), cz = Math.floor(oz / CELL);
    const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tDeltaX = Math.abs(CELL * invX), tDeltaZ = Math.abs(CELL * invZ);
    let tMaxX = ((dx > 0 ? (cx + 1) * CELL - ox : ox - cx * CELL)) * Math.abs(invX);
    let tMaxZ = ((dz > 0 ? (cz + 1) * CELL - oz : oz - cz * CELL)) * Math.abs(invZ);
    if (!isFinite(tMaxX)) tMaxX = Infinity;
    if (!isFinite(tMaxZ)) tMaxZ = Infinity;

    const visited = this._visited || (this._visited = new Set());
    visited.clear();
    let guard = 0;
    let t = 0;
    while (t <= maxDist && guard++ < 4096) {
      const k = cx * 73856093 ^ cz * 19349663;
      const arr = this.grid.get(k);
      if (arr && !visited.has(k)) {
        visited.add(k);
        for (let n = 0; n < arr.length; n++) {
          const b = this.boxes[arr[n]];
          const r = this._slab(b, ox, oy, oz, dx, dy, dz, bestT);
          if (r && r.t < bestT) { bestT = r.t; best = r; best.box = b; }
        }
      }
      if (bestT <= t) break;
      if (tMaxX < tMaxZ) { t = tMaxX; cx += stepX; tMaxX += tDeltaX; }
      else { t = tMaxZ; cz += stepZ; tMaxZ += tDeltaZ; }
    }
    if (!best) return null;
    return {
      dist: best.t,
      point: new THREE.Vector3(ox + dx * best.t, oy + dy * best.t, oz + dz * best.t),
      normal: new THREE.Vector3(best.nx, best.ny, best.nz),
      box: best.box,
    };
  }

  /** OBB 的 slab 测试 */
  _slab(b, ox, oy, oz, dx, dy, dz, maxT) {
    const rx = ox - b.cx, ry = oy - b.cy, rz = oz - b.cz;
    // 转到局部空间（绕 Y 逆旋转）
    const lox = b.c * rx - b.s * rz;
    const loz = b.s * rx + b.c * rz;
    const ldx = b.c * dx - b.s * dz;
    const ldz = b.s * dx + b.c * dz;

    let tmin = 0, tmax = maxT;
    let axis = -1, sign = 1;

    const test = (o, d, h, ax) => {
      if (Math.abs(d) < 1e-9) return o >= -h && o <= h;
      const inv = 1 / d;
      let t1 = (-h - o) * inv, t2 = (h - o) * inv, s = -1;
      if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
      if (t1 > tmin) { tmin = t1; axis = ax; sign = s; }
      if (t2 < tmax) tmax = t2;
      return tmax >= tmin;
    };

    if (!test(lox, ldx, b.hx, 0)) return null;
    if (!test(oy - b.cy, dy, b.hy, 1)) return null;
    if (!test(loz, ldz, b.hz, 2)) return null;
    if (tmin < 0 || tmin > maxT) return null;

    let nx = 0, ny = 0, nz = 0;
    if (axis === 0) nx = sign; else if (axis === 1) ny = sign; else nz = sign;
    // 局部 → 世界
    const wx = b.c * nx + b.s * nz;
    const wz = -b.s * nx + b.c * nz;
    return { t: tmin, nx: wx, ny, nz: wz };
  }
}
