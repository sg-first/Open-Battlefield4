/* ============================================================
   面前资产识别
   - 从准星（屏幕正中）发射线，命中世界物体后沿父链回溯它的资产名
   - InstancedMesh 用 userData.batch，独立摆放的 Group 用 userData.asset
   - 角色用 userData.asset = 'character:<key>' 标记，便于区分
   ============================================================ */
import * as THREE from 'three';

const CENTER = new THREE.Vector2(0, 0);
const CHAR_PREFIX = 'character:';
const _m4 = new THREE.Matrix4();

/** 沿父链向上找到携带资产名的那个节点 */
export function ownerOf(obj) {
  let o = obj;
  while (o) {
    const u = o.userData;
    if (u && (u.asset || u.batch)) return o;
    o = o.parent;
  }
  return null;
}

export class Inspector {
  constructor(o = {}) {
    this.camera = o.camera;
    this.targets = o.targets || [];
    this.maxDist = o.maxDist || 700;
    this.ray = new THREE.Raycaster();
    this.ray.far = this.maxDist;
  }

  setTargets(list) { this.targets = list || []; return this; }

  /** 发射线并返回命中信息；未命中返回 null */
  pick(maxDist) {
    const cam = this.camera;
    if (!cam || !this.targets.length) return null;
    this.ray.far = maxDist || this.maxDist;
    this.ray.setFromCamera(CENTER, cam);

    const hits = this.ray.intersectObjects(this.targets, true);
    if (!hits.length) return null;

    const h = hits[0];
    const node = ownerOf(h.object) || h.object;
    const u = node.userData || {};
    const raw = u.asset || u.batch || h.object.name || '';
    const isChar = typeof raw === 'string' && raw.startsWith(CHAR_PREFIX);

    const info = {
      name: raw,
      kind: isChar ? 'character' : 'asset',
      label: isChar ? (u.label || raw.slice(CHAR_PREFIX.length)) : raw,
      dist: h.distance,
      point: h.point.clone(),
      object: h.object,
      node,
      instanceId: h.instanceId,
      instances: node.isInstancedMesh ? node.count : 1,
      file: isChar ? '' : `obj/${raw}.obj`,
    };

    // 摆放原点：实例化物体取该实例的平移，独立物体取世界坐标
    if (info.instanceId !== undefined && node.isInstancedMesh) {
      node.getMatrixAt(info.instanceId, _m4);
      info.origin = new THREE.Vector3().setFromMatrixPosition(_m4);
    } else {
      info.origin = node.getWorldPosition(new THREE.Vector3());
    }
    return info;
  }
}
