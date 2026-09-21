/* ============================================================
   上海开放世界生成
   - 街区块 + 道路 + 人行道 + 高楼群 + 街面店招 + 街景道具
   - 中央喷泉广场、外滩滨水码头、天际线背景
   - 程序化天空 / 日夜循环 / 雾 / 水面
   ============================================================ */
import * as THREE from 'three';
import {
  clamp, lerp, smoothstep, makeRNG, DEG,
  makeGroundTexture, makeNoiseNormalTexture,
} from './util.js';

export const CITY = {
  BLOCK: 116,          // 街区间距
  ROAD: 26,            // 道路宽度
  HALF: 45,            // 街区半径（可建筑范围）
  SIDEWALK: 3.2,
  GRID: 2,             // 街区索引 -2..2
  QUAY_X: -300,        // 滨江岸线
};

/* ---------------------------------------------------------- 天空 */
const SKY_KEYS = [
  { e: -0.45, top: '#080f24', mid: '#16203c', bot: '#242f4a', sun: '#7f9ac6', dir: 0.22, amb: 0.30, hemi: 0.34, fog: 0x131b30, exp: 1.35 },
  { e: -0.12, top: '#122043', mid: '#33365f', bot: '#6b4f5e', sun: '#c08ea6', dir: 0.50, amb: 0.30, hemi: 0.40, fog: 0x2d3350, exp: 1.26 },
  { e: 0.03, top: '#183064', mid: '#8a5c78', bot: '#e2926a', sun: '#ffb478', dir: 1.35, amb: 0.34, hemi: 0.52, fog: 0x9a7466, exp: 1.06 },
  { e: 0.22, top: '#255fa8', mid: '#9dc0e6', bot: '#e8dcc4', sun: '#fff0cf', dir: 2.35, amb: 0.40, hemi: 0.68, fog: 0xc4d4e2, exp: 0.98 },
  { e: 1.0, top: '#1f5ab8', mid: '#8fc0ee', bot: '#dbe7f4', sun: '#fffaf0', dir: 3.0, amb: 0.44, hemi: 0.74, fog: 0xd2e0ee, exp: 0.96 },
];
const _cA = new THREE.Color(), _cB = new THREE.Color();
const mixHex = (a, b, t) => '#' + _cA.set(a).lerp(_cB.set(b), t).getHexString();

export function skyStateAt(e) {
  let a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    if (e >= SKY_KEYS[i].e && e <= SKY_KEYS[i + 1].e) { a = SKY_KEYS[i]; b = SKY_KEYS[i + 1]; break; }
  }
  const t = smoothstep(a.e, b.e, e);
  return {
    top: mixHex(a.top, b.top, t), mid: mixHex(a.mid, b.mid, t), bot: mixHex(a.bot, b.bot, t),
    sun: mixHex(a.sun, b.sun, t),
    dir: lerp(a.dir, b.dir, t), amb: lerp(a.amb, b.amb, t), hemi: lerp(a.hemi, b.hemi, t),
    fog: _cA.set(a.fog).lerp(_cB.set(b.fog), t).getHex(), exp: lerp(a.exp, b.exp, t),
  };
}

export function sunDirAt(hour) {
  const ang = (hour - 6) / 12 * Math.PI;
  return new THREE.Vector3(-Math.cos(ang) * 0.86, Math.sin(ang), 0.42).normalize();
}

/* ---------------------------------------------------------- 环境反射 */
function envFace(top, horizon, bottom, side) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, top); grad.addColorStop(0.48, horizon); grad.addColorStop(1, bottom);
  g.fillStyle = grad; g.fillRect(0, 0, 256, 256);
  // 模糊城市轮廓进入反射，避免玻璃只映出纯色天空
  if (side) {
    g.fillStyle = 'rgba(24,32,42,.55)';
    let x = 0;
    while (x < 256) {
      const w = 9 + ((x * 17) % 26), h = 30 + ((x * 31) % 96);
      g.fillRect(x, 165 - h, w, h);
      x += w + 2;
    }
    g.fillStyle = 'rgba(255,230,186,.14)';
    for (let i = 0; i < 26; i++) g.fillRect((i * 47) % 250, 92 + (i * 29) % 70, 2, 2);
  }
  return c;
}

function makeCityEnvironment() {
  const tex = new THREE.CubeTexture([
    envFace('#80b7df', '#d8e4e8', '#364656', true),
    envFace('#80b7df', '#d8e4e8', '#364656', true),
    envFace('#a6cbed', '#dcebf5', '#7e97a8', false),
    envFace('#43586d', '#657789', '#27323e', false),
    envFace('#79afd6', '#d8e4e8', '#364656', true),
    envFace('#79afd6', '#d8e4e8', '#364656', true),
  ]);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ---------------------------------------------------------- 主入口 */
export function buildWorld(o) {
  const scene = o.scene;
  const assets = o.assets;
  const W = o.builder;
  const rng = makeRNG(0x5A17C0);

  const S = {};

  // 为玻璃、抛光金属与车辆提供预过滤的城市/天空反射；
  // PMREM 让粗糙度能正确影响反射模糊度，立面不会像镜子贴纸。
  const envSource = makeCityEnvironment();
  const pmrem = new THREE.PMREMGenerator(o.renderer);
  pmrem.compileCubemapShader();
  const envRT = pmrem.fromCubemap(envSource);
  envSource.dispose();
  pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 1.0;
  S.environment = envRT;

  /* ---------------- 光照与天空 ---------------- */
  const sun = new THREE.DirectionalLight(0xffffff, 2.6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 420;
  sun.shadow.camera.left = -84; sun.shadow.camera.right = 84;
  sun.shadow.camera.top = 84; sun.shadow.camera.bottom = -84;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.55;
  scene.add(sun, sun.target);

  const hemi = new THREE.HemisphereLight(0xbcd8f5, 0x4a4438, 0.55);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0x6d84a6, 0.30);
  scene.add(amb);

  const skyU = {
    top: { value: new THREE.Color('#255fa8') }, mid: { value: new THREE.Color('#9dc0e6') },
    bot: { value: new THREE.Color('#e8dcc4') }, sunCol: { value: new THREE.Color('#fff0cf') },
    sunDir: { value: new THREE.Vector3(0, 1, 0) }, sunI: { value: 1 }, haze: { value: 0.5 },
    cloudTime: { value: new THREE.Vector2(0, 0) },
  };
  const skyMat = new THREE.ShaderMaterial({
    uniforms: skyU, side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main(){ vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 top, mid, bot, sunCol, sunDir; uniform float sunI, haze;
      uniform vec2 cloudTime;
      varying vec3 vDir;
      float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
      float noise2(vec2 p) {
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(hash21(i), hash21(i+vec2(1,0)), f.x),
                   mix(hash21(i+vec2(0,1)), hash21(i+vec2(1,1)), f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0, a = 0.55;
        for (int i=0; i<4; i++) { v += noise2(p)*a; p = p*2.02+7.3; a *= 0.5; }
        return v;
      }
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y*0.5+0.5, 0.0, 1.0);
        vec3 c = mix(bot, mid, smoothstep(0.40,0.545,h));
        c = mix(c, top, smoothstep(0.52,0.95,h));
        // 多尺度云层：只出现在地平线以上，亮度随日照变化。
        vec2 cuv = d.xz / max(0.18, d.y + 0.33) * 1.35 + cloudTime;
        float cl = fbm(cuv * 0.85) * 0.72 + fbm(cuv * 2.3 + 18.0) * 0.28;
        float cloud = smoothstep(0.48, 0.68, cl) * smoothstep(-0.02, 0.20, d.y) * (1.0-smoothstep(0.20, 0.98, d.y));
        vec3 cloudCol = mix(vec3(0.55,0.62,0.70), vec3(1.0,0.98,0.92), clamp(sunDir.y*1.4,0.0,1.0));
        c = mix(c, cloudCol, cloud * (0.30 + sunI * 0.18));
        float sd = max(dot(d, normalize(sunDir)), 0.0);
        c += sunCol * pow(sd, 900.0) * 6.0 * sunI;
        c += sunCol * pow(sd, 12.0) * 0.30 * sunI;
        c += sunCol * pow(sd, 3.0) * 0.10 * sunI;
        // 地平线雾带
        float hz = smoothstep(0.5, 0.42, h) * smoothstep(0.30, 0.44, h);
        c = mix(c, bot * (0.85 + haze*0.4), hz * 0.55);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(3000, 40, 26), skyMat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -1000;
  scene.add(skyMesh);

  scene.fog = new THREE.FogExp2(0xc4d4e2, 0.00135);

  /* ---------------- 地面 ---------------- */
  const groundTex = makeGroundTexture(512, '#46464a', 7);
  groundTex.repeat.set(58, 58);
  const groundNormal = makeNoiseNormalTexture(256, 1.2, 8, 31);
  groundNormal.repeat.set(46, 46);
  const mainLand = new THREE.Mesh(
    new THREE.PlaneGeometry(1700, 2200, 1, 1),
    new THREE.MeshStandardMaterial({
      map: groundTex, normalMap: groundNormal, roughness: 0.94, metalness: 0.02,
      normalScale: new THREE.Vector2(0.26, 0.26), color: 0xa8a8ac,
    })
  );
  mainLand.rotation.x = -Math.PI / 2;
  mainLand.position.set(CITY.QUAY_X + 850, 0, 0);
  mainLand.receiveShadow = true;
  scene.add(mainLand);

  // 水面（黄浦江）
  const waterNormal = makeNoiseNormalTexture(256, 1.6, 6, 77);
  waterNormal.repeat.set(60, 60);
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(2600, 3000, 1, 1),
    new THREE.MeshStandardMaterial({
      color: 0x21485f, roughness: 0.08, metalness: 0.62,
      normalMap: waterNormal, normalScale: new THREE.Vector2(0.55, 0.55),
      transparent: true, opacity: 0.94,
    })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(CITY.QUAY_X - 1300, -1.05, 0);
  scene.add(water);

  // 岸线挡墙
  const quayMat = new THREE.MeshStandardMaterial({ color: 0x6d6a63, roughness: 0.9, metalness: 0.03 });
  const quay = new THREE.Mesh(new THREE.BoxGeometry(4, 3.4, 2200), quayMat);
  quay.position.set(CITY.QUAY_X + 1, -0.9, 0);
  quay.receiveShadow = true; quay.castShadow = true;
  scene.add(quay);
  W.addBoxOnly(CITY.QUAY_X + 1, -0.9, 0, 2, 1.7, 1100, 0);

  /* ---------------- 道路网格 ---------------- */
  const B = CITY.BLOCK, RH = CITY.ROAD / 2;
  const roadAsset = 'objects_architecture_roads_set_01_roadstraight_s1024x4096_mesh';
  const roadLen = 41.1;
  const grid = CITY.GRID;
  const cityMin = -(grid + 1) * B, cityMax = (grid + 1) * B;
  const roadCenters = [];
  for (let i = -grid; i <= grid - 1; i++) roadCenters.push((i + 0.5) * B);

  // 纵向街道（沿 Z），每条路铺两车道
  for (const x of roadCenters) {
    const n = Math.ceil((cityMax - cityMin) / roadLen);
    for (let k = 0; k < n; k++) {
      const z = cityMin + k * roadLen + roadLen / 2;
      for (const off of [-5.9, 5.9]) {
        W.place(roadAsset, x + off, 0.02, z, Math.PI / 2, { collide: false });
      }
    }
  }
  // 横向街道（沿 X）
  for (const z of roadCenters) {
    const n = Math.ceil((cityMax - cityMin) / roadLen);
    for (let k = 0; k < n; k++) {
      const x = cityMin + k * roadLen + roadLen / 2;
      for (const off of [-5.9, 5.9]) {
        W.place(roadAsset, x, 0.02, z + off, 0, { collide: false });
      }
    }
  }

  /* ---------------- 交通标线：额外近景微细节，避免道路成为大块纯贴图 ---------------- */
  const markMat = new THREE.MeshStandardMaterial({
    color: 0xe8e5d8, roughness: 0.68, metalness: 0.02, depthWrite: false,
  });
  const dashV = new THREE.PlaneGeometry(0.18, 4.2).rotateX(-Math.PI / 2);
  const dashH = new THREE.PlaneGeometry(4.2, 0.18).rotateX(-Math.PI / 2);
  const vMarks = [], hMarks = [];
  for (const x of roadCenters) {
    for (let z = cityMin + 8; z < cityMax; z += 11) vMarks.push([x, z]);
  }
  for (const z of roadCenters) {
    for (let x = cityMin + 8; x < cityMax; x += 11) hMarks.push([x, z]);
  }
  const makeMarks = (geo, rows) => {
    const im = new THREE.InstancedMesh(geo, markMat, rows.length);
    const m = new THREE.Matrix4();
    rows.forEach(([x, z], i) => { m.makeTranslation(x, 0.046, z); im.setMatrixAt(i, m); });
    im.instanceMatrix.needsUpdate = true;
    im.renderOrder = 1;
    scene.add(im);
  };
  makeMarks(dashV, vMarks);
  makeMarks(dashH, hMarks);
  // 路口斑马线（每个中央交叉口）
  const zebraGeo = new THREE.PlaneGeometry(1.35, 5.3).rotateX(-Math.PI / 2);
  const zebra = [];
  for (const x of roadCenters) for (const z of roadCenters) {
    for (let q = -3; q <= 3; q++) zebra.push([x + q * 1.8, z - 10.4, 0]);
    for (let q = -3; q <= 3; q++) zebra.push([x - 10.4, z + q * 1.8, Math.PI / 2]);
  }
  const zi = new THREE.InstancedMesh(zebraGeo, markMat, zebra.length);
  const zm = new THREE.Matrix4(), zq = new THREE.Quaternion();
  zebra.forEach(([x, z, rot], i) => { zq.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot); zm.compose(new THREE.Vector3(x, 0.047, z), zq, new THREE.Vector3(1, 1, 1)); zi.setMatrixAt(i, zm); });
  zi.instanceMatrix.needsUpdate = true;
  zi.renderOrder = 1;
  scene.add(zi);

  /* ---------------- 人行道 ---------------- */
  const swTile = 'objects_architecture_sidewalk_set_01_sidewalk_01_s512x512_mesh';
  const swCorner = 'objects_architecture_sidewalk_set_01_sidewalk_01_c512_large_mesh';
  const swUnit = 5.121;
  const edge = CITY.HALF + CITY.SIDEWALK / 2;
  for (let i = -grid; i <= grid; i++) {
    for (let j = -grid; j <= grid; j++) {
      const cx = i * B, cz = j * B;
      const count = Math.floor((CITY.HALF * 2) / swUnit);
      const start = -CITY.HALF + swUnit / 2;
      for (let k = 0; k < count; k++) {
        const t = start + k * swUnit;
        W.place(swTile, cx + t, 0, cz + edge, 0, { collide: false });
        W.place(swTile, cx + t, 0, cz - edge, 0, { collide: false });
        W.place(swTile, cx + edge, 0, cz + t, Math.PI / 2, { collide: false });
        W.place(swTile, cx - edge, 0, cz + t, Math.PI / 2, { collide: false });
      }
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        W.place(swCorner, cx + sx * edge, 0, cz + sz * edge, 0, { collide: false });
      }
    }
  }

  /* ---------------- 夜景灯光 / 近景层次 ---------------- */
  const cityLights = [];
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x1e242a, toneMapped: false });
  const lampGeo = new THREE.SphereGeometry(0.095, 8, 6);
  const addLamp = (x, z, h = 5.4, color = 0xffd6a0) => {
    const bulb = new THREE.Mesh(lampGeo, lampMat);
    bulb.position.set(x, h, z);
    bulb.frustumCulled = false;
    const light = new THREE.PointLight(color, 0, 18, 2.1);
    light.position.copy(bulb.position);
    scene.add(bulb, light);
    cityLights.push({ light, bulb, base: 2.4 + rng() * 1.4, color: new THREE.Color(color) });
  };
  // 在中心街区的交叉口和人行道布置暖色钠灯，与玻璃反射/后期高光共同形成夜景深度。
  for (const x of roadCenters) {
    if (Math.abs(x) > 60) continue; // 灯光预算集中在可游玩的中心城区
    for (let z = -210; z <= 210; z += 46) {
      addLamp(x - 9.5, z, 6.4, 0xffd4a0);
      addLamp(x + 9.5, z + 18, 6.4, 0xffc77d);
    }
  }
  for (const z of roadCenters) {
    if (Math.abs(z) > 60) continue;
    for (let x = -210; x <= 210; x += 58) addLamp(x, z - 9.5, 6.1, 0xffd6a2);
  }
  S.cityLights = cityLights;
  S.lampMat = lampMat;

  /* ---------------- 建筑 ---------------- */
  const KITS = {
    floors: [
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_01_b_mesh',
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_01_c_mesh',
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_01_d_mesh',
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_01_e_mesh',
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_01_f_mesh',
    ],
    seps: [
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_separator_02_mesh',
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_separator_03_mesh',
    ],
    roofs: [
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_straightroof_01_mesh',
      'objects_architecture_skyscraper_generic_01_skyscraper_generic_solidblocks_256_big_01_mesh',
    ],
    fronts: [
      'objects_architecture_storefront_alley_a_storefront_wall_2048_01_mesh',
      'objects_architecture_storefront_residential_r_wall_896_01_mesh',
      'objects_architecture_storefront_shanty_residential_residential_03_1024_mesh',
      'objects_architecture_storefront_shanty_residential_residential_04_1024_mesh',
      'objects_architecture_storefront_commercial_fronts_c_storefront_front_896_01_mesh',
      'objects_architecture_facadech_03_facadech_03_onefloor_s1024_mesh',
    ],
    cheap: [
      'objects_architecture_storefront_residential_r_innerwall_896_01_mesh',
      'objects_architecture_storefront_alley_a_storefront_wall_2048_01_mesh',
    ],
  };
  const tint = (lo, hi) => new THREE.Color(rng.range(lo, hi), rng.range(lo, hi), rng.range(lo, hi));

  /** 一栋由模块堆叠成的楼 */
  function buildTower(x, z, far, styleIdx) {
    const r = rng();
    let floorAsset, floorH = 20.484, head = null, head2 = null;
    if (r < 0.18) { floorAsset = 'objects_architecture_hk_skyscraper_03_hk_skyscraper_03_mesh'; floorH = 40.969; head = 'objects_architecture_hk_skyscraper_03_hk_skyscraper_bottom_03_mesh'; }
    else if (r < 0.36) { floorAsset = 'objects_architecture_hk_skyscraper_02_hk_skyscraper_02_mesh'; floorH = 40.969; head = 'objects_architecture_hk_skyscraper_02_hk_skyscraper_bottom_02_mesh'; head2 = 'objects_architecture_hk_skyscraper_02_hk_skyscraper_roof_02_mesh'; }
    else if (r < 0.56) { floorAsset = 'objects_architecture_skyscraper_waterfront_01_skyscraperwaterfront_01_mesh'; floorH = 20.5; head = 'objects_architecture_skyscraper_waterfront_01_skyscraperwaterfront_baseplate_01_mesh'; }
    else { floorAsset = KITS.floors[styleIdx % KITS.floors.length]; floorH = 20.484; }

    const floors = clamp(Math.round(rng.range(far ? 3 : 1, far ? 7 : 4)), 1, 8);
    const yaw = (rng() < 0.5 ? 0 : Math.PI / 2) + (rng() < 0.25 ? Math.PI : 0);
    const t = tint(0.80, 1.06);
    let y = 0;
    if (head) { W.place(head, x, y, z, yaw, { tint: t }); y += rng() < 0.5 ? 2.561 : 2.0; }
    for (let k = 0; k < floors; k++) {
      W.place(floorAsset, x, y, z, yaw, { tint: t });
      y += floorH;
      if (k < floors - 1 && rng() < 0.4) {
        W.place(KITS.seps[k % 2], x, y, z, yaw, { tint: t });
        y += rng() < 0.5 ? 2.561 : 5.121;
      }
    }
    W.place(KITS.roofs[rng() < 0.5 ? 0 : 1], x, y, z, yaw, { tint: t });
    y += 1.3;
    if (rng() < 0.65) W.place('objects_architecture_skyscraper_generic_01_skyscraper_generic_roofhouse_01_mesh', x + rng.range(-6, 6), y - 1.4, z + rng.range(-8, 8), rng() * 3, { tint: t });
    if (rng() < 0.6) W.place('objects_architecture_skyscraper_generic_01_skyscraper_generic_ventilation_01_mesh', x + rng.range(-7, 7), y, z + rng.range(-9, 9), rng() * 3, { tint: t });
    return y;
  }

  /** 街面（店招/骑楼）：上层用廉价墙体，底层在中心区域用精细店门 */
  function buildFrontage(cx, cz, side, height, detail) {
    const yaw = side * Math.PI / 2;
    const edge = CITY.HALF - 0.4;
    const count = Math.floor((CITY.HALF * 2) / 10.24);
    const dx = side % 2 === 1 ? (side === 1 ? -1 : 1) : 0;
    const dz = side % 2 === 0 ? (side === 0 ? -1 : 1) : 0;
    for (let k = 0; k < count; k++) {
      const t = -CITY.HALF + 5.12 + k * 10.24;
      let x, z;
      if (side % 2 === 0) { x = cx + t; z = cz + (side === 0 ? edge : -edge); }
      else { x = cx + (side === 1 ? edge : -edge); z = cz + t; }
      const floors = clamp(Math.ceil(clamp(height, 4.2, 12) / 6.4), 1, 2);
      for (let f = 0; f < floors; f++) {
        let a;
        if (f === 0 && detail && rng() < 0.62) {
          a = rng() < 0.5
            ? 'objects_architecture_storefront_shanty_residential_residential_03_1024_mesh'
            : 'objects_architecture_storefront_commercial_fronts_c_storefront_front_896_01_mesh';
        } else {
          a = rng() < 0.5 ? KITS.cheap[0] : KITS.cheap[1];
        }
        W.place(a, x, f * 6.4, z, yaw, { tint: tint(0.80, 1.06), collide: f === 0 });
      }
      // 店招 / 霓虹（只在底层上方，且仅中心街区）
      if (detail && rng() < 0.5) {
        const sy = rng.range(3.4, 6.0);
        const awn = rng();
        if (awn < 0.28) W.place('objects_props_awning_01_awning_01_mesh', x + dx * 1.4, sy, z + dz * 1.4, yaw + Math.PI, { collide: false });
        else if (awn < 0.52) W.place('objects_props_awningglass_01_awningglass_01_1024_mesh', x + dx * 1.6, sy, z + dz * 1.6, yaw, { collide: false });
        else if (awn < 0.76) W.place('objects_props_storesign_01_storesign_01_large_mesh', x + dx * 0.7, sy + 1.2, z + dz * 0.7, yaw + Math.PI, { collide: false });
        else W.place(rng() < 0.5
          ? 'objects_props_signs_commercial_signs_sign_v_kanji_512_02_mesh'
          : 'objects_props_signs_neon_generic_neonsignsquarevertical_512x128_01_cyan_mesh',
          x + dx * 0.7, sy + 1.6, z + dz * 0.7, yaw, { collide: false });
      }
    }
  }
  const WHITE = () => new THREE.Color(1, 1, 1);

  const spawns = [];
  const plazaBlocks = [[0, 0]];
  const isPlaza = (i, j) => i === 0 && j === 0;

  for (let i = -grid; i <= grid; i++) {
    for (let j = -grid; j <= grid; j++) {
      const cx = i * B, cz = j * B;
      if (isPlaza(i, j)) continue;
      const nearWater = i <= -grid;
      const far = Math.max(Math.abs(i), Math.abs(j)) >= grid;

      // 主楼
      buildTower(cx + rng.range(-8, 8), cz + rng.range(-8, 8), far, (i + j + 8) % 5);
      // 副楼 / 裙楼
      const n = rng.int(1, 2);
      for (let k = 0; k < n; k++) {
        const ox = rng.range(-1, 1) * 26, oz = rng.range(-1, 1) * 26;
        if (Math.hypot(ox, oz) < 18) continue;
        const px = cx + ox, pz = cz + oz;
        const floors = clamp(rng.int(1, nearWater ? 3 : 4), 1, 5);
        const t = tint(0.78, 1.04);
        const fa = KITS.floors[rng.int(0, 4)];
        let y = 0;
        for (let f = 0; f < floors; f++) {
          W.place(fa, px, y, pz, rng() < 0.5 ? 0 : Math.PI / 2, { tint: t });
          y += 20.484;
        }
        W.place(KITS.roofs[0], px, y, pz, 0, { tint: t });
      }
      // 街面（中心两环街区才有精细店门，控制三角面）
      const detail = Math.abs(i) <= 1 && Math.abs(j) <= 1;
      for (const side of [0, 1, 2, 3]) buildFrontage(cx, cz, side, rng.range(4.5, 11), detail);

      // 街景道具
      scatterProps(cx, cz, nearWater);
      if (!far) spawns.push({ x: cx + rng.range(-30, 30), z: cz + rng.range(-30, 30) });
    }
  }

  function scatterProps(cx, cz) {
    const r = CITY.HALF - 8;
    const place = (name, x, z, y = 0, yaw = 0, o = {}) => W.place(name, x, y, z, yaw, o);
    // 垃圾箱 / 报刊亭 / 自行车
    for (let k = 0; k < 2; k++) {
      const a = rng() * 6.28, d = rng.range(10, r);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const t = rng();
      if (t < 0.22) place('objects_props_streetprops_trashcansmall_02_trashcansmall_02_mesh', x, 0, z, rng() * 6);
      else if (t < 0.4) place('objects_props_dumpster_01_dumpster_01_mesh', x, 0, z, rng() * 6);
      else if (t < 0.55) place('objects_props_bicyclestationbike_01_bicyclestationbike_01_mesh', x, 0, z, rng() * 6);
      else if (t < 0.68) place('objects_props_marketstand_01_marketstand_01_basecluster_mesh', x, 0, z, rng() * 6);
      else if (t < 0.8) place('objects_props_planter_set_01_planterbox_01_256x128_2_mesh', x, 0, z, rng() * 6);
      else if (t < 0.9) place('objects_props_acunit_01_acunit_01_mesh', x, 0, z, rng() * 6);
      else place('objects_props_supplycase_01_supplycase_01_mesh', x, 0, z, rng() * 6);
    }
    // 战争痕迹
    if (rng() < 0.5) {
      const a = rng() * 6.28, d = rng.range(8, r);
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const t = rng();
      if (t < 0.3) place('objects_props_concretebarrier_01_concretebarrier_01_destruction_mesh', x, 0, z, rng() * 6);
      else if (t < 0.55) place('objects_props_sandbagwall_01_sandbagwall_01_mesh', x, 0, z, rng() * 6);
      else if (t < 0.75) place('objects_props_debrispile_02_debrispile_02_b_mesh', x, 0, z, rng() * 6);
      else place('objects_props_rubblepile_01_rubblepile_ground_01b_mesh', x, 0, z, rng() * 6);
    }
    // 灯笼 / 招牌 / 灯柱
    if (rng() < 0.45) {
      const a = rng() * 6.28, d = CITY.HALF - 1.6;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      place(rng() < 0.5
        ? 'objects_props_chineselantern_01_chineselantern_01_mesh'
        : 'levels_sp_sp_shanghai_objects_stone_lantern_01_stone_lantern_01_mesh',
        x, rng() < 0.5 ? 3.4 : 0, z, rng() * 6, { collide: false });
    }
    if (rng() < 0.6) {
      const a = rng() * 6.28, d = CITY.HALF - 0.9;
      place('objects_lights_streetlight_02_streetlight_02_destruction_mesh',
        cx + Math.cos(a) * d, 0, cz + Math.sin(a) * d, a + Math.PI / 2);
    }
    if (rng() < 0.5) {
      place('objects_lights_lightpedestrian_01_lightpedestrian_01_mesh',
        cx + rng.range(-CITY.HALF + 4, CITY.HALF - 4), 0, cz + rng.range(-CITY.HALF + 4, CITY.HALF - 4), rng() * 6);
    }
    // 路口的红绿灯
    place('objects_props_streetprops_trafficlight_01_trafficlight_01_mesh',
      cx + CITY.HALF + 4.4, 0, cz + CITY.HALF + 4.4, rng() * 6);
    // 小杂物
    for (let k = 0; k < 3; k++) {
      const a = rng() * 6.28, d = rng.range(6, r);
      const t = rng();
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      if (t < 0.2) place('objects_props_cratewoodlight_01_cratewoodlight_01_mesh', x, 0, z, rng() * 6);
      else if (t < 0.34) place('objects_props_cardboardbox_01_cardboardbox_01_closed_mesh', x, 0, z, rng() * 6);
      else if (t < 0.46) place('objects_props_cardboardbox_01_cardboardbox_01_open_mesh', x, 0, z, rng() * 6);
      else if (t < 0.56) place('objects_props_trafficcone_01_trafficcone_01_mesh', x, 0, z, rng() * 6);
      else if (t < 0.66) place('objects_props_bucket_01_bucket_01_mesh', x, 0, z, rng() * 6);
      else if (t < 0.74) place('objects_props_oilbarrel_01_oilbarrel_01_mesh', x, 0, z, rng() * 6);
      else if (t < 0.82) place('objects_props_pallet_01_pallet_01_mesh', x, 0, z, rng() * 6);
      else if (t < 0.9) place('objects_props_debrismicro_01_debrismicro_01_mesh', x, 0, z, rng() * 6);
      else place('objects_props_paperpile_01_paperpile_01_mesh', x, 0, z, rng() * 6);
    }
  }

  /* ---------------- 中央喷泉广场 ---------------- */
  const plaza = { x: 0, z: 0 };
  {
    const P = 'levels_sp_sp_shanghai_objects_shanghai_fountain_01_';
    // 原始喷泉组件尺寸达 70×102m，远超 90m 的街区，等比缩到 0.62
    const FS = 0.62;
    W.place(P + 'shanghai_fountain_stairs_01_mesh', plaza.x, -0.30, plaza.z, 0, { collide: false, scale: FS });
    W.place(P + 'shanghai_fountain_curb_01_mesh', plaza.x, 0, plaza.z, 0, { collide: false, scale: FS });
    W.place(P + 'shanghai_fountain_01_mesh', plaza.x, 0, plaza.z, 0, { collide: true, scale: FS });
    W.place(P + 'shanghai_fountain_water_01_mesh', plaza.x, 0.04, plaza.z, 0, { collide: false, scale: FS });
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      W.place(P + `shanghai_fountainwall_0${[8, 9, 11][k % 3]}_mesh`, plaza.x + Math.cos(a) * 17, 0, plaza.z + Math.sin(a) * 17, a, { collide: true });
      W.place(P + 'shanghai_fountain_platform_07_mesh', plaza.x + Math.cos(a) * 10.5, 0, plaza.z + Math.sin(a) * 10.5, a, { collide: true });
    }
    // 广场艺术品（原始 140m 宽，缩到 0.32）
    W.place('levels_sp_sp_shanghai_objects_plazaartwork_01_plazaartwork_01_mesh', plaza.x, 0, plaza.z + 26, 0, { collide: true, scale: 0.32 });
    // 四角石雕 / 长椅 / 灯笼（贴街区边缘，不压到路面）
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      const x = plaza.x + Math.cos(a) * 34, z = plaza.z + Math.sin(a) * 34;
      W.place('objects_props_statuechinese_01_statuechinese_01_mesh', x, 0, z, a + Math.PI, { collide: true });
      W.place('objects_props_marblebench_02_marblebench_02_mesh', plaza.x + Math.cos(a) * 26, 0, plaza.z + Math.sin(a) * 26, a + Math.PI / 2, { collide: true });
    }
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4 + 0.42;
      const d = 31 + (k % 2) * 4;
      W.place('levels_sp_sp_shanghai_objects_stone_lantern_01_stone_lantern_01_mesh',
        plaza.x + Math.cos(a) * d, 0, plaza.z + Math.sin(a) * d, 0, { collide: true });
      W.place('objects_props_chineselantern_01_chineselantern_01_mesh',
        plaza.x + Math.cos(a + 0.3) * 20, 3.4, plaza.z + Math.sin(a + 0.3) * 20, 0, { collide: false });
    }
    W.place('levels_mp_mp_siege_placeholders_chinesesign_03_mesh', plaza.x - 18, 5.4, plaza.z + 41, Math.PI, { collide: false });
    W.place('levels_mp_mp_siege_placeholders_chinesesign_03_mesh', plaza.x + 20, 5.4, plaza.z + 41, 0, { collide: false });
    // 广场上的坦克与直升机残骸（放在街区边缘）
    W.place('gameplay_vehicles_ch_mbt_type99_spec_ch_mbt_type99_sp_shanghaichase_mesh', plaza.x + 33, 0, plaza.z - 30, 0.7, { collide: true });
    W.place('gameplay_vehicles_ch_lthe_z-9_ch_lthe_z-9_wreck_mesh', plaza.x - 34, 0, plaza.z - 28, 2.1, { collide: true });
  }

  /* ---------------- 外滩滨水区 ---------------- */
  {
    const qx = CITY.QUAY_X + 26;
    // 木质栈道
    for (let k = -3; k <= 3; k++) {
      W.place('levels_sp_sp_shanghai_objects_canal_merged_platformwooden_x12_mesh', qx, 0.1, k * 20, Math.PI / 2, { collide: true });
      W.place('levels_sp_sp_shanghai_objects_canal_merged_wl_straight_x6_mesh', qx + 12, 0, k * 20, 0, { collide: true });
    }
    W.place('levels_sp_sp_shanghai_objects_canal_merged_stairs_x4_mesh', qx + 6, 0, -30, Math.PI / 2, { collide: true });
    W.place('levels_sp_sp_shanghai_objects_canal_merged_sidewalk_x3_mesh', qx + 16, 0, 0, 0, { collide: false });
    for (let k = 0; k < 6; k++) {
      const z = -90 + k * 36;
      W.place('levels_sp_sp_shanghai_objects_canal_merged_bkgrd_01_planter_01_mesh', qx + 20, 0, z, 0, { collide: true });
      W.place('levels_sp_sp_shanghai_objects_canal_merged_bkgrd_01_bushes_01_mesh', qx + 22, 0, z + 8, 0, { collide: false });
      W.place('levels_sp_sp_shanghai_objects_canal_merged_bkgrd_01_trees_01_mesh', qx + 26, 0, z + 16, rng() * 6, { collide: true });
    }
    W.place('levels_sp_sp_shanghai_objects_sp_shanghai_boatriver_02_sp_shanghai_boatriver_02_mesh', qx - 34, -1.0, 34, 0.4, { collide: true });
    W.place('levels_sp_sp_shanghai_objects_sp_shanghai_boatriver_02_sp_shanghai_boatriver_02_mesh', qx - 58, -1.0, -62, 2.6, { collide: true });
    // 水上摩天楼与发光地标
    W.place('levels_mp_mp_siege_architecture_mp_siege_skyscraperwaterfront_mp_siege_skyscraperwaterfront_mesh', qx + 62, 0, -120, 0.4, { collide: true });
    W.place('levels_sp_sp_shanghai_objects_bd_building_emissive_01_mesh', qx + 74, 0, 96, 0.2, { collide: true });
    // 远处地标塔：提供参考图那种近景仰视的高密度玻璃天际线层次
    W.place('levels_sp_sp_shanghai_objects_shanghaitower_01_shanghaitower_01_mesh', qx + 162, 0, -165, -0.18, { collide: false, scale: 0.48 });
    W.place('objects_architecture_hk_skyscraper_05_hk_skyscraper_05_v2_backdrop_mesh', qx + 110, 0, -52, 0.26, { collide: true, scale: 0.88 });
    W.place('objects_architecture_skyscraper_waterfront_02_skyscraper_waterfront_02_backdrop_mesh', qx + 172, 0, 76, -0.45, { collide: true, scale: 1.05 });
    W.place('levels_sp_sp_shanghai_objects_sp_shanghai_skyscraper_entrance_sp_shanghai_skyscraper_entrance_mesh', qx + 54, 0, 20, Math.PI / 2, { collide: true });
    W.place('levels_sp_sp_shanghai_objects_sp_shanghai_roadsign_big_01_sp_shanghai_roadsign_big_01_mesh', qx + 40, 0, -20, -0.3, { collide: true });
  }

  /* ---------------- 其它地标 ---------------- */
  {
    W.place('levels_mp_mp_siege_architecture_mp_siege_office_lshape_01_mp_siege_office_lshape_highrise_01_mesh', 1 * B + 20, 0, -1 * B - 18, 0.3, { collide: true });
    W.place('levels_mp_mp_siege_architecture_mp_siege_office_lshape_01_mp_siege_office_lshape_highrise_02_mesh', -1 * B - 24, 0, 1 * B + 22, 1.4, { collide: true });
    W.place('objects_architecture_ch_residentialbuilding_01_ch_residentialbuilding_01_merged_sp_shanghai_mesh', 2 * B + 16, 0, 2 * B + 14, -0.5, { collide: true });
    W.place('objects_architecture_datacenter_02_animation_datacenter_02_animation_mesh', -2 * B - 18, 0, -2 * B - 12, 0.8, { collide: true });
    W.place('levels_sp_sp_shanghai_objects_architecture_shanghaihotel_shanghaihotel_floorlobbymerged_01_mesh', 1 * B - 30, 0, 1 * B + 26, Math.PI, { collide: true });
    W.place('levels_sp_sp_shanghai_objects_architecture_shanghaihotelstaircase_01_shanghaihotelstaircase_01_mesh', 1 * B - 46, 0, 1 * B + 10, Math.PI / 2, { collide: true });
  }

  /* ---------------- 车辆 ---------------- */
  {
    const carAssets = [
      'objects_vehicles_carcivilian_01_carcivilian_01_mesh',
      'objects_vehicles_carcivilian_02_carcivilian_02_mesh',
      'objects_vehicles_carcivilian_01_carcivilian_01_wreck_cluster_mesh',
      'levels_sp_sp_shanghai_objects_policecarshanghai_01_policecarshanghai_01_mesh',
      'levels_sp_sp_shanghai_objects_sp_shanghai_van01_sp_shanghai_van01_broken_mesh',
    ];
    for (let i = -grid; i <= grid + 1; i++) {
      for (const dir of [0, 1]) {
        const n = rng.int(1, 2);
        for (let k = 0; k < n; k++) {
          const along = rng.range(-grid * B, (grid + 1) * B);
          const off = dir === 0 ? -7.4 : 7.4;
          const x = i * B + (dir === 0 ? 0 : B);
          const yaw = dir === 0 ? 0 : Math.PI;
          const t = rng();
          const a = t < 0.42 ? carAssets[0] : t < 0.78 ? carAssets[1] : t < 0.9 ? carAssets[2] : (t < 0.96 ? carAssets[3] : carAssets[4]);
          W.place(a, x + off, 0, along, yaw + (rng() - 0.5) * 0.12, { collide: true });
        }
      }
    }
    W.place('objects_vehicles_truckch_01_truckch_01_mesh', CITY.HALF + 8, 0, -B * 2 - 4, 1.6, { collide: true });
    W.place('objects_vehicles_truckch_01_truckch_01_mesh', -CITY.HALF - 10, 0, B * 1 + 6, 0.2, { collide: true });
  }

  /* ---------------- 远景天际线 ----------------
     原始 siegeskyline 背景块与主城坐标重叠（会与自建街区互相穿插），
     改为程序化环绕高层剪影 + 两座地标塔。 */
  {
    const skyAssets = [
      'objects_architecture_hk_skyscraper_03_hk_skyscraper_03_mesh',
      'objects_architecture_skyscraper_waterfront_01_skyscraperwaterfront_01_mesh',
      'objects_architecture_hk_skyscraper_02_hk_skyscraper_02_mesh',
    ];
    const roofA = 'objects_architecture_skyscraper_waterfront_01_skyscraperwaterfront_roof_01_mesh';
    const roofB = 'objects_architecture_hk_skyscraper_02_hk_skyscraper_roof_02_mesh';
    let built = 0;
    for (let k = 0; k < 130 && built < 96; k++) {
      const a = rng() * Math.PI * 2;
      const d = rng.range(390, 1150);
      const x = Math.cos(a) * d + 60, z = Math.sin(a) * d;
      if (x < CITY.QUAY_X - 30) continue;          // 不落在江面上
      const inner = Math.max(Math.abs(x), Math.abs(z)) < 330;
      if (inner) continue;
      const fa = skyAssets[rng.int(0, 2)];
      const floors = rng.int(2, 9);
      const yaw = (rng() < 0.5 ? 0 : Math.PI / 2) + (rng() < 0.25 ? Math.PI : 0);
      const t = tint(0.55, 0.92);
      let y = 0;
      for (let f = 0; f < floors; f++) {
        W.place(fa, x, y, z, yaw, { tint: t, collide: false });
        y += fa === skyAssets[0] ? 40.969 : 20.484;
      }
      W.place(fa === skyAssets[1] ? roofA : roofB, x, y, z, yaw, { tint: t, collide: false });
      built++;
    }
    // 地标：上海中心与另一座超高层
    W.place('objects_props_siegeskyline_shanghaitower_01_mesh', -360, 0, -610, 0.4, { collide: false });
    W.place('objects_props_siegeskyline_shanghaitower_02_mesh', 500, 0, -720, -0.6, { collide: false });
  }

  /* ---------------- 出生点 ---------------- */
  // 站在通往广场的街道中央，面向喷泉
  const spawn = { x: 0, z: B * 0.5, yaw: 0 };
  const floorY = 0;

  /* ---------------- 敌人出生点 ---------------- */
  const enemySpawns = [];
  for (let k = 0; k < 26; k++) {
    const a = (k / 26) * Math.PI * 2 + 0.2;
    const d = 70 + (k % 4) * 42;
    enemySpawns.push({ x: Math.cos(a) * d, z: Math.sin(a) * d });
  }
  for (const p of spawns) enemySpawns.push(p);

  /* ---------------- 市民 ---------------- */
  const npcSpawns = [];
  for (let k = 0; k < 40; k++) {
    const a = rng() * 6.28, d = rng.range(30, 240);
    npcSpawns.push({ x: Math.cos(a) * d, z: Math.sin(a) * d });
  }

  S.sun = sun; S.hemi = hemi; S.amb = amb; S.skyU = skyU; S.skyMesh = skyMesh;
  S.water = water; S.waterNormal = waterNormal;
  S.spawn = spawn; S.spawnY = floorY;
  S.enemySpawns = enemySpawns; S.npcSpawns = npcSpawns;
  S.extent = (grid + 1) * B;
  S.plaza = plaza;
  return S;
}

/* ---------------------------------------------------------- 市民（NPC） */
export class Civilians {
  constructor(o) {
    this.scene = o.scene;
    this.boxes = o.boxes;
    this.factory = o.factory;
    this.audio = o.audio;
    this.list = [];
    this.rng = makeRNG(99117);
    this.keys = ['civ_a', 'civ_b', 'civ_c', 'hanna', 'pac', 'irish', 'child'];
  }

  spawn(n, points) {
    for (let i = 0; i < n && i < points.length; i++) {
      const key = this.keys[Math.floor(this.rng() * this.keys.length)];
      const inst = this.factory.create(key);
      if (!inst) continue;
      this.scene.add(inst.group);
      const p = points[i];
      const c = {
        inst, key,
        pos: new THREE.Vector3(p.x, this.boxes.floorAt(p.x, p.z, 40), p.z),
        vel: new THREE.Vector3(),
        yaw: this.rng() * 6.28,
        stride: 0,
        panic: 0,
        speed: this.rng() * 0.7 + 0.9,
        target: new THREE.Vector3(p.x, 0, p.z),
        wait: this.rng() * 4,
      };
      this.list.push(c);
    }
    return this.list;
  }

  update(dt, player) {
    const rng = this.rng;
    for (const c of this.list) {
      const dist = c.pos.distanceTo(player.pos);
      // 玩家靠近或附近交火时惊慌
      if (dist < 22) c.panic = Math.min(1, c.panic + dt * 0.9);
      else c.panic = Math.max(0, c.panic - dt * 0.4);

      c.wait -= dt;
      const d = Math.hypot(c.target.x - c.pos.x, c.target.z - c.pos.z);
      if (d < 2 || c.wait < -8) {
        if (c.wait <= 0 || c.wait < -8) {
          const a = rng() * 6.28, r = rng.range(14, 46);
          c.target.set(c.pos.x + Math.cos(a) * r, 0, c.pos.z + Math.sin(a) * r);
          c.wait = rng.range(1.5, 6);
        }
      }
      const spd = (c.panic > 0.5 ? 3.4 : c.speed) * (c.wait > 0 ? 0.15 : 1);
      if (d > 1.2) {
        const dx = (c.target.x - c.pos.x) / d, dz = (c.target.z - c.pos.z) / d;
        c.vel.x = lerp(c.vel.x, dx * spd, 6 * dt);
        c.vel.z = lerp(c.vel.z, dz * spd, 6 * dt);
        c.yaw += ((Math.atan2(dx, dz) - c.yaw + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 5);
      } else {
        c.vel.x = lerp(c.vel.x, 0, 8 * dt);
        c.vel.z = lerp(c.vel.z, 0, 8 * dt);
      }
      c.pos.x += c.vel.x * dt;
      c.pos.z += c.vel.z * dt;
      this.boxes.resolveCylinder(c.pos, 0.34, 1.75, 0.42);
      const hs = Math.hypot(c.vel.x, c.vel.z);
      if (hs > 0.2) c.stride += dt * (4 + hs * 1.6);
      c.inst.setStride(c.stride, clamp(hs / 3.2, 0, 1));
      c.inst.setAim(c.panic > 0.6 ? 0.25 : 0);
      c.pos.y = this.boxes.floorAt(c.pos.x, c.pos.z, c.pos.y + 0.5);
      c.inst.group.position.copy(c.pos);
      c.inst.group.rotation.y = c.yaw;
      c.inst.update(dt, hs);
    }
  }
}
