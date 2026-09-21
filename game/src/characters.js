/* ============================================================
   角色绑定
   BF4 导出的角色网格都是 A/T-pose 且无骨骼，这里用「程序化重新摆姿」：
     1) 自动测量肩 / 肘 / 手锚点（依据手臂伸展的极值点）
     2) 双骨 IK 求肘位，把手臂摆成握枪姿态
     3) 躯干绕脊柱扭转，让枪口朝向正前方
     4) 结果烘焙成 morph target（idle / aim），运行时只调权重
   ============================================================ */
import * as THREE from 'three';
import { clamp, smoothstep, makeRNG } from './util.js';

/* ---------------------------------------------------------- 角色配方 */
export const CHAR_SPECS = {
  assault: {
    label: '突击兵', enemy: true, hp: 100,
    upper: 'characters_mp_ch_assault_ch_assault_upperbody_mesh',
    lower: 'characters_mp_ch_assault_ch_assault_lowerbody_mesh',
    head: 'characters_sp_friendly_chang_chang_head_sp_chang_head_mesh',
    headgear: 'characters_mp_ch_engineer_ch_engineer_headgear_mesh',
  },
  recon: {
    label: '侦察兵', enemy: true, hp: 85,
    upper: 'characters_mp_ch_recon_ch_recon_upperbody_mesh',
    lower: 'characters_mp_ch_recon_ch_recon_lowerbody_mesh',
    head: 'characters_sp_civilian_head_jayson_li_sp_jayson_li_head_mesh',
    headgear: 'characters_mp_ch_engineer_ch_engineer_headgear_mesh',
  },
  support: {
    label: '支援兵', enemy: true, hp: 130,
    upper: 'characters_mp_ch_support_ch_support_upperbody_mesh',
    lower: 'characters_mp_ch_support_ch_support_lowerbody_mesh',
    head: 'characters_sp_friendly_chang_chang_head_sp_chang_head_mesh',
    headgear: 'characters_mp_ru_support_ru_support_headgear02_mesh',
  },
  guard: {
    label: '狱警', enemy: true, hp: 110,
    full: 'characters_sp_enemy_prisonguard_sp_prisonguard_fullbody_mesh',
    headgear: 'characters_sp_enemy_prisonguard_sp_prisonguard_cap_mesh',
  },
  riot: {
    label: '防暴警察', enemy: true, hp: 160,
    full: 'characters_sp_enemy_riotpolice_sp_riot_police_mesh',
  },
  civ_a: {
    label: '市民', full: 'characters_sp_civilian_fullbody_warsaw_civilian_01_civilian_body_01_mesh',
    head: 'characters_sp_civilian_head_alvin_tran_sp_alvin_tran_head_mesh',
  },
  civ_b: {
    label: '市民', full: 'characters_sp_civilian_fullbody_warsaw_civilian_02_civilian_body_02_mesh',
    head: 'characters_sp_civilian_head_beulah_wong_sp_beulah_wong_head_mesh',
  },
  civ_c: {
    label: '市民', full: 'characters_sp_civilian_fullbody_warsaw_civilian_03_civilian_body_03_mesh',
    head: 'characters_sp_civilian_head_jayson_li_sp_jayson_li_head_mesh',
  },
  child: { label: '儿童', full: 'characters_sp_friendly_child_sp_child_fullbody_mesh' },
  hanna: {
    label: '汉娜',
    upper: 'characters_sp_friendly_hanna_hanna_civilian_upperbody_mesh',
    lower: 'characters_sp_friendly_hanna_hanna_civilian_lowerbody_mesh',
    head: 'characters_sp_friendly_hanna_hanna_head_sp_hanna_head_mesh',
    headgear: 'characters_sp_friendly_hanna_hanna_head_sp_hanna_hair_mesh',
  },
  pac: {
    label: '帕克',
    upper: 'characters_sp_friendly_pac_sp_pac_civilian_upperbody_mesh',
    lower: 'characters_sp_friendly_pac_sp_pac_civilian_lowerbody_mesh',
    head: 'characters_sp_friendly_pac_pac_head_sp_pac_head_mesh',
    headgear: 'characters_sp_friendly_pac_pac_beanie_mesh',
  },
  irish: {
    label: '爱尔兰人',
    upper: 'characters_sp_friendly_irish_sp_irish_civilian_upperbody_mesh',
    lower: 'characters_sp_friendly_irish_sp_irish_civilian_lowerbody_mesh',
    head: 'characters_sp_friendly_irish_irish_head_sp_irish_head_mesh',
  },
};

export const ENEMY_KEYS = ['assault', 'recon', 'support', 'guard', 'riot'];

/* ---------------------------------------------------------- 测量 */
export function measureHumanoid(geometry) {
  const pos = geometry.attributes.position;
  let minY = 1e9, maxY = -1e9, maxAbsX = 0;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i), ax = Math.abs(pos.getX(i));
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (ax > maxAbsX) maxAbsX = ax;
  }
  // 手部：|x| 最大的那批顶点
  let sy = 0, sz = 0, n = 0;
  const thr = maxAbsX * 0.86;
  for (let i = 0; i < pos.count; i++) {
    if (Math.abs(pos.getX(i)) >= thr) { sy += pos.getY(i); sz += pos.getZ(i); n++; }
  }
  const handY = n ? sy / n : maxY - 0.55;
  const handZ = n ? sz / n : 0.24;
  const k = maxAbsX / 0.612;
  return { minY, maxY, maxAbsX, handY, handZ, k, H: maxY - minY };
}

/* ---------------------------------------------------------- 双骨 IK */
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
function twoBoneIK(shoulder, target, l1, l2, pole) {
  _a.subVectors(target, shoulder);
  let dist = _a.length();
  const maxD = (l1 + l2) * 0.998;
  if (dist > maxD) { _a.multiplyScalar(maxD / dist); dist = maxD; }
  if (dist < 1e-4) dist = 1e-4;
  const dir = _a.clone().normalize();
  const cosA = clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1);
  const ang = Math.acos(cosA);
  _b.copy(pole).sub(_c.copy(dir).multiplyScalar(pole.dot(dir)));
  if (_b.lengthSq() < 1e-7) _b.set(dir.z, 0, -dir.x);
  _b.normalize();
  const elbowDir = _c.copy(dir).multiplyScalar(Math.cos(ang)).addScaledVector(_b, Math.sin(ang));
  return { elbow: shoulder.clone().addScaledVector(elbowDir, l1), dir };
}

/* ---------------------------------------------------------- 摆姿 */
/** 姿态定义：twist 躯干扭转角，targets 为「扭转后坐标系」中的手部目标 */
export const POSE_AIM = {
  twist: -0.45,
  targets: {
    R: [-0.115, 1.200, 0.240],
    L: [-0.020, 1.210, 0.545],
  },
  pole: { R: [-0.85, -0.45, -0.35], L: [0.75, -0.55, -0.45] },
};
export const POSE_IDLE = {
  twist: 0,
  targets: {
    R: [-0.315, 0.885, 0.145],
    L: [0.315, 0.885, 0.145],
  },
  pole: { R: [-0.9, -0.35, -0.5], L: [0.9, -0.35, -0.5] },
};

function rotAboutAxis(p, ox, oy, oz, axis, angle, w) {
  if (w <= 1e-4 || Math.abs(angle) < 1e-6) return null;
  const ang = angle * w;
  const c = Math.cos(ang), s = Math.sin(ang);
  const x = p[0] - ox, y = p[1] - oy, z = p[2] - oz;
  if (axis === 'y') {
    return [ox + c * x + s * z, p[1], oz - s * x + c * z];
  }
  return null;
}

/**
 * 计算某个几何体的姿态增量（相对 base）
 * kind: 'arm' | 'head' | 'lower'
 */
export function computePoseDelta(geometry, m, pose, kind) {
  const pos = geometry.attributes.position;
  const nrm = geometry.attributes.normal;
  const count = pos.count;
  const outP = new Float32Array(count * 3);
  const outN = new Float32Array(count * 3);

  const k = m.k;
  const shoulderY = m.handY + 0.345 * k;
  const twistLo = shoulderY - 0.52 * k;
  const twistHi = shoulderY - 0.02 * k;

  // 手臂锚点
  const anchor = {
    R: {
      sh: new THREE.Vector3(-0.250 * k, shoulderY, -0.050 * k),
      el: new THREE.Vector3(-0.435 * k, m.handY + 0.145 * k, 0.045 * k),
      hd: new THREE.Vector3(-0.565 * k, m.handY, m.handZ),
    },
    L: {
      sh: new THREE.Vector3(0.250 * k, shoulderY, -0.050 * k),
      el: new THREE.Vector3(0.435 * k, m.handY + 0.145 * k, 0.045 * k),
      hd: new THREE.Vector3(0.565 * k, m.handY, m.handZ),
    },
  };

  let armData = null;
  if (kind === 'arm') {
    armData = {};
    for (const side of ['R', 'L']) {
      const A = anchor[side];
      const sgn = side === 'R' ? -1 : 1;
      // 扭转后的肩点
      const tw = rotAboutAxis([A.sh.x, A.sh.y, A.sh.z], 0, 0, 0, 'y', pose.twist, 1) || [A.sh.x, A.sh.y, A.sh.z];
      const sh = new THREE.Vector3(tw[0], tw[1], tw[2]);
      const tgt = new THREE.Vector3(...pose.targets[side]).multiplyScalar(k);
      const l1 = A.sh.distanceTo(A.el);
      const l2 = A.el.distanceTo(A.hd);
      const pole = new THREE.Vector3(...pose.pole[side]);
      const ik = twoBoneIK(sh, tgt, l1, l2, pole);
      // 静息方向（扭转后）
      const restUp = A.el.clone().sub(A.sh).applyAxisAngle(new THREE.Vector3(0, 1, 0), pose.twist).normalize();
      const q1 = new THREE.Quaternion().setFromUnitVectors(restUp, ik.dir.clone().normalize());
      const restFore = A.hd.clone().sub(A.el).normalize();
      const curFore = restFore.clone().applyQuaternion(q1);
      const foreDir = tgt.clone().sub(ik.elbow).normalize();
      const q2 = new THREE.Quaternion().setFromUnitVectors(curFore, foreDir);
      armData[side] = {
        sh, q1, elbow: ik.elbow, q2, sgn,
        shX: 0.250 * k, elX: 0.435 * k,
      };
    }
  }

  const v = new THREE.Vector3();
  const nv = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let px = x, py = y, pz = z;
    let nx = nrm ? nrm.getX(i) : 0, ny = nrm ? nrm.getY(i) : 1, nz = nrm ? nrm.getZ(i) : 0;

    if (kind === 'arm') {
      // 1) 躯干扭转
      const tw = smoothstep(twistLo, twistHi, y) * pose.twist;
      if (Math.abs(tw) > 1e-5) {
        const c = Math.cos(tw), s = Math.sin(tw);
        const rx = c * px + s * pz, rz = -s * px + c * pz;
        px = rx; pz = rz;
        const nx2 = c * nx + s * nz, nz2 = -s * nx + c * nz;
        nx = nx2; nz = nz2;
      }
      // 2) 手臂 IK（扭转后再摆）
      for (const side of ['R', 'L']) {
        const D = armData[side];
        if (side === 'R' ? x > 0 : x < 0) continue;
        const ax = Math.abs(x);
        const w1 = smoothstep(D.shX - 0.075 * k, D.shX + 0.075 * k, ax);
        const w2 = smoothstep(D.elX - 0.065 * k, D.elX + 0.065 * k, ax);
        if (w2 > 1e-4) {
          v.set(px - D.elbow.x, py - D.elbow.y, pz - D.elbow.z);
          nv.set(nx, ny, nz);
          const q = partialQuat(D.q2, w2);
          v.applyQuaternion(q); nv.applyQuaternion(q);
          px = D.elbow.x + v.x; py = D.elbow.y + v.y; pz = D.elbow.z + v.z;
          nx = nv.x; ny = nv.y; nz = nv.z;
        }
        if (w1 > 1e-4) {
          v.set(px - D.sh.x, py - D.sh.y, pz - D.sh.z);
          nv.set(nx, ny, nz);
          const q = partialQuat(D.q1, w1);
          v.applyQuaternion(q); nv.applyQuaternion(q);
          px = D.sh.x + v.x; py = D.sh.y + v.y; pz = D.sh.z + v.z;
          nx = nv.x; ny = nv.y; nz = nv.z;
        }
      }
    } else if (kind === 'head') {
      const tw = pose.twist;
      if (Math.abs(tw) > 1e-5) {
        const c = Math.cos(tw), s = Math.sin(tw);
        const rx = c * px + s * pz, rz = -s * px + c * pz;
        px = rx; pz = rz;
        const nx2 = c * nx + s * nz, nz2 = -s * nx + c * nz;
        nx = nx2; nz = nz2;
      }
    }

    const o = i * 3;
    outP[o] = px - x; outP[o + 1] = py - y; outP[o + 2] = pz - z;
    outN[o] = nx - (nrm ? nrm.getX(i) : 0);
    outN[o + 1] = ny - (nrm ? nrm.getY(i) : 1);
    outN[o + 2] = nz - (nrm ? nrm.getZ(i) : 0);
  }
  return { pos: outP, nrm: outN };
}

const _qa = new THREE.Quaternion();
function partialQuat(q, w) {
  if (w >= 0.999) return q;
  _qa.copy(q);
  // 四元数按角度插值（等价于 slerp 到单位元）
  const cosHalf = clamp(_qa.w, -1, 1);
  const half = Math.acos(cosHalf);
  const sinHalf = Math.sin(half);
  if (sinHalf < 1e-6) return _qa.set(0, 0, 0, 1);
  const t = (half * w);
  const s = Math.sin(t) / sinHalf;
  return _qa.set(_qa.x * s, _qa.y * s, _qa.z * s, Math.cos(t));
}

/* ---------------------------------------------------------- 角色类型 */
export class CharacterFactory {
  constructor(assets) {
    this.assets = assets;
    this.types = new Map();
  }

  /** 构建（并缓存）一种角色的共享几何体与材质 */
  build(key) {
    if (this.types.has(key)) return this.types.get(key);
    const spec = CHAR_SPECS[key];
    if (!spec) return null;

    const parts = [];
    const add = (assetName, kind) => {
      const asset = this.assets.get(assetName);
      if (!asset) return;
      const geo = asset.parts[0].geometry;
      const mat = asset.parts[0].material;
      const m = measureHumanoid(geo);
      const pAim = computePoseDelta(geo, m, POSE_AIM, kind);
      const pIdle = computePoseDelta(geo, m, POSE_IDLE, kind);
      const g = geo.clone();
      g.morphTargetsRelative = true;
      g.morphAttributes.position = [
        new THREE.BufferAttribute(pIdle.pos, 3),
        new THREE.BufferAttribute(pAim.pos, 3),
      ];
      if (geo.attributes.normal) {
        g.morphAttributes.normal = [
          new THREE.BufferAttribute(pIdle.nrm, 3),
          new THREE.BufferAttribute(pAim.nrm, 3),
        ];
      }
      parts.push({
        kind, geometry: g, material: mat, measure: m,
        hipY: kind === 'lower' ? m.maxY * 0.94 : 0,
      });
    };

    if (spec.full) {
      add(spec.full, 'arm');                       // 整体模型自带手臂/头部
      if (spec.headgear) add(spec.headgear, 'head');
    } else {
      if (spec.lower) add(spec.lower, 'none');
      if (spec.upper) add(spec.upper, 'arm');
      if (spec.head) add(spec.head, 'head');
      if (spec.headgear) add(spec.headgear, 'head');
    }

    const type = { key, spec, parts };
    this.types.set(key, type);
    return type;
  }

  /** 创建一个角色实例 */
  create(key, opts = {}) {
    const type = this.build(key);
    if (!type) return null;
    const group = new THREE.Group();
    group.userData.asset = 'character:' + key;      // 供面前资产识别使用
    group.userData.label = type.spec.label || key;
    const crouchGroup = new THREE.Group();
    const legGroup = new THREE.Group();
    const bodyGroup = new THREE.Group();
    crouchGroup.add(legGroup, bodyGroup);
    group.add(crouchGroup);

    const meshes = [];
    let headY = 1.6;
    let hipY = 1.0;
    for (const p of type.parts) {
      const mesh = new THREE.Mesh(p.geometry, p.material);
      mesh.updateMorphTargets();
      mesh.morphTargetInfluences[0] = 1;   // idle
      mesh.morphTargetInfluences[1] = 0;   // aim
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      if (p.kind === 'lower') {
        hipY = p.hipY || 1.0;
        mesh.position.y = -hipY;          // 让旋转围绕髋关节
        legGroup.add(mesh);
        legGroup.position.y = hipY;
      } else {
        bodyGroup.add(mesh);
      }
      meshes.push({ mesh, part: p });
      headY = Math.max(headY, p.measure.maxY);
    }

    const inst = {
      key, group, crouchGroup, legGroup, bodyGroup, meshes, type,
      hipY, headY,
      aim: 0, targetAim: 0,
      stride: 0, strideAmp: 0,
      crouch: 0,
    };

    inst.setAim = (v, instant) => {
      inst.targetAim = clamp(v, 0, 1);
      if (instant) inst.aim = inst.targetAim;
    };
    inst.setStride = (phase, amp) => { inst.stride = phase; inst.strideAmp = amp; };
    inst.setCrouch = (v) => { inst.crouch = clamp(v, 0, 1); };
    inst.update = (dt, speed = 0) => {
      inst.aim += (inst.targetAim - inst.aim) * clamp(dt * 9, 0, 1);
      const a = inst.aim;
      for (const { mesh } of meshes) {
        if (!mesh.morphTargetInfluences) continue;
        mesh.morphTargetInfluences[1] = a;
        mesh.morphTargetInfluences[0] = 1 - a;
      }
      // 腿部摆动
      const amp = clamp(inst.strideAmp, 0, 1) * 0.62;
      const sw = Math.sin(inst.stride) * amp;
      legGroup.rotation.x = sw;
      legGroup.rotation.z = Math.sin(inst.stride * 2) * amp * 0.06;
      bodyGroup.rotation.y = -sw * 0.10;
      bodyGroup.rotation.z = Math.sin(inst.stride) * amp * 0.045;
      const c = inst.crouch;
      crouchGroup.position.y = -c * 0.42;
      crouchGroup.rotation.x = c * 0.16;
      legGroup.rotation.x += c * 0.5;
      bodyGroup.rotation.x = c * 0.14;
    };
    return inst;
  }
}

/* ---------------------------------------------------------- 尸体（俯卧/仰卧） */
export const DEAD_POSES = [
  'characters_sp_friendly_deadposes_civilians_warsaw_civilian_01_dead_lying01_mesh',
  'characters_sp_friendly_deadposes_civilians_warsaw_civilian_03_dead_lying02_mesh',
  'characters_sp_friendly_deadposes_civilians_warsaw_civilian_05_dead_sitting01_mesh',
];
