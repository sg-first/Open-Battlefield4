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

/* ---------------------------------------------------------- 夜间路灯格点
   这里是夜景照明唯一的「灯位定义」。实体灯头/灯杆按它生成，
   NightLightPool 注入到路面/人行道材质里的光池着色器也按同一组
   参数解析求值 —— 两处不同源的话，地上的光斑就会和灯头对不上。 */
export const LAMP = {
  H: 6.4,                                 // 灯头高度
  SIDE: 9.5,                              // 灯位离道路中心线的横向距离
  SPAN_V: 46,                             // 纵向街道沿 Z 的灯间距
  SPAN_H: 58,                             // 横向街道沿 X 的灯间距
  RANGE: (CITY.GRID + 1) * CITY.BLOCK,    // 348：灯位覆盖整个路网
};

/* ---------------------------------------------------------- 天空 */
const SKY_KEYS = [
  { e: -0.45, top: '#080f24', mid: '#16203c', bot: '#242f4a', sun: '#7f9ac6', dir: 0.22, amb: 0.30, hemi: 0.34, fog: 0x131b30, exp: 1.18 },
  { e: -0.12, top: '#122043', mid: '#33365f', bot: '#6b4f5e', sun: '#c08ea6', dir: 0.50, amb: 0.30, hemi: 0.40, fog: 0x2d3350, exp: 1.14 },
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

  /* ---------------- 夜景路灯（覆盖整个路网）----------------
     灯位是规则格点（见顶部的 LAMP）：纵向/横向街道两侧都布灯，
     间距 46 / 58m，一直铺到路网边缘 —— 之前只在 |x|≤60、|z|≤210
     的「中心区」布灯，外围那几条街根本没有灯位，夜里自然是全黑。
     灯头/灯杆只是可见实体；真正的"光池"由 NightLightPool 把同一组
     格点参数注入路面/人行道材质后逐像素解析求值，因此任何一条街
     都亮，且不受动态光源数量（几百盏就编译炸了）的限制。 */
  const lampMat = new THREE.MeshBasicMaterial({ color: 0x1e242a, toneMapped: false });
  const lampGeo = new THREE.SphereGeometry(0.115, 8, 6);
  const lampPoles = [];
  const lamps = [];
  // 建筑发光点（塔楼/裙楼中心）：环境窗光从中挑最近的几栋做暖色洗墙
  const glowPoints = [];
  const addLamp = (x, z) => { lamps.push({ x, z }); lampPoles.push([x, z, LAMP.H]); };

  // 纵向街道：两侧灯位对齐同一 z 格点（z 必须是 SPAN_V 的整数倍，着色器按此索引）
  const lampZ0 = Math.ceil(-LAMP.RANGE / LAMP.SPAN_V) * LAMP.SPAN_V;
  for (const x of roadCenters) {
    for (let z = lampZ0; z <= LAMP.RANGE; z += LAMP.SPAN_V) {
      addLamp(x - LAMP.SIDE, z);
      addLamp(x + LAMP.SIDE, z);
    }
  }
  // 横向街道：x 方向错开半格，避免路口处两种灯位完全重合
  const lampX0 = Math.ceil(-LAMP.RANGE / LAMP.SPAN_H) * LAMP.SPAN_H + LAMP.SPAN_H * 0.5;
  for (const z of roadCenters) {
    for (let x = lampX0; x <= LAMP.RANGE; x += LAMP.SPAN_H) {
      addLamp(x, z - LAMP.SIDE);
      addLamp(x, z + LAMP.SIDE);
    }
  }
  // 灯头：整批一个 InstancedMesh（逐个 Mesh 会有两百多个 draw call）
  if (lamps.length) {
    const bulbs = new THREE.InstancedMesh(lampGeo, lampMat, lamps.length);
    const bm = new THREE.Matrix4(), bv = new THREE.Vector3(), bq = new THREE.Quaternion(), bs = new THREE.Vector3(1, 1, 1);
    lamps.forEach((l, i) => { bv.set(l.x, LAMP.H, l.z); bulbs.setMatrixAt(i, bm.compose(bv, bq, bs)); });
    bulbs.instanceMatrix.needsUpdate = true;
    scene.add(bulbs);
  }
  // 灯杆：给悬在半空的灯头一个落地支撑（否则白天只能看到飘着的小球）
  if (lampPoles.length) {
    const poleGeo = new THREE.CylinderGeometry(0.075, 0.11, 1, 6, 1);
    poleGeo.translate(0, 0.5, 0);   // 底面贴合 y=0
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.68, metalness: 0.35 });
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, lampPoles.length);
    const pm = new THREE.Matrix4(), pv = new THREE.Vector3(), pq = new THREE.Quaternion(), ps = new THREE.Vector3();
    lampPoles.forEach(([x, z, h], i) => {
      pv.set(x, 0, z); ps.set(1, h, 1);
      pm.compose(pv, pq, ps);
      poles.setMatrixAt(i, pm);
    });
    poles.instanceMatrix.needsUpdate = true;
    poles.castShadow = true;
    scene.add(poles);
  }
  S.lampPoles = lampPoles;
  S.lamps = lamps;
  S.lampMat = lampMat;
  S.lampWarm = new THREE.Color(0xffcf92);
  S.glowPoints = glowPoints;
  // 大地基底面也采样街道光贴图：街区内部的天井不至于变成死黑
  S.groundExtra = [mainLand.material];

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
    glowPoints.push({ x, z });
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
    const roofIdx = rng() < 0.5 ? 0 : 1;
    W.place(KITS.roofs[roofIdx], x, y, z, yaw, { tint: t });
    // 屋顶真实顶面（straightroof 1.28m / solidblocks 2.56m）：楼顶设备必须落在这个面上
    const roofTop = y + (roofIdx === 0 ? 1.28 : 2.56);
    if (rng() < 0.65) W.place('objects_architecture_skyscraper_generic_01_skyscraper_generic_roofhouse_01_mesh', x + rng.range(-6, 6), roofTop - 0.12, z + rng.range(-8, 8), rng() * 3, { tint: t });
    if (rng() < 0.6) W.place('objects_architecture_skyscraper_generic_01_skyscraper_generic_ventilation_01_mesh', x + rng.range(-7, 7), roofTop, z + rng.range(-9, 9), rng() * 3, { tint: t });
    return roofTop;
  }

  /** 街面（店招/骑楼）：上层用廉价墙体，底层在中心区域用精细店门 */
  function buildFrontage(cx, cz, side, height, detail) {
    const yaw = side * Math.PI / 2;
    const edge = CITY.HALF - 0.4;
    const count = Math.floor((CITY.HALF * 2) / 10.24);
    // 指向街区外侧（临街面）：招牌/雨棚必须朝街安装，不能缩进街区内部
    const dx = side % 2 === 1 ? (side === 1 ? 1 : -1) : 0;
    const dz = side % 2 === 0 ? (side === 0 ? 1 : -1) : 0;
    for (let k = 0; k < count; k++) {
      const t = -CITY.HALF + 5.12 + k * 10.24;
      let x, z;
      if (side % 2 === 0) { x = cx + t; z = cz + (side === 0 ? edge : -edge); }
      else { x = cx + (side === 1 ? edge : -edge); z = cz + t; }
      const floors = clamp(Math.ceil(clamp(height, 4.2, 12) / 6.4), 1, 2);
      const wallTop = floors * 6.4;   // 每段墙体高 6.4m
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
      // 店招 / 霓虹：中心街区密一些，外圈也有但稀疏（避免整条街都是光墙）
      // 安装规则：贴住墙面外表面（外推量 ≤ 半厚，避免与墙之间出现悬空缝隙），
      // 且整块招牌的顶端不超过墙顶；墙太矮挂不下时直接跳过，杜绝悬在空中的招牌。
      if (rng() < (detail ? 0.55 : 0.3)) {
        let name, h, out, minY, spin, stand = false;
        const awn = rng();
        if (awn < 0.28) { name = 'objects_props_awning_01_awning_01_mesh'; h = 1.29; out = 0.60; minY = 3.0; spin = Math.PI; }
        else if (awn < 0.52) { name = 'objects_props_awningglass_01_awningglass_01_1024_mesh'; h = 0.95; out = 1.55; minY = 3.0; spin = 0; }
        else if (awn < 0.76) { name = 'objects_props_storesign_01_storesign_01_large_mesh'; h = 1.41; out = 0.12; minY = 3.0; spin = Math.PI; }
        else if (rng() < (detail ? 0.5 : 0.12)) {
          // 竖版 V 型招牌是落地灯箱：整块板身从 y=0 一直贯通到 11.4m，没有挂墙支架，
          // 因此立在店门外的人行道上（墙外 2m ≈ 人行道中线），板面平行临街面。
          name = 'objects_props_signs_commercial_signs_sign_v_kanji_512_02_mesh'; out = 2.0; spin = 0; stand = true;
        }
        else { name = 'objects_props_signs_neon_generic_neonsignsquarevertical_512x128_01_cyan_mesh'; h = 5.12; out = 0.10; minY = 1.6; spin = 0; }

        if (stand) {
          W.place(name, x + dx * out, 0, z + dz * out, yaw + spin, { collide: true });
        } else {
          const hi = wallTop - h - 0.15;
          if (hi >= minY) {
            const sy = rng.range(minY, Math.min(hi, minY + 2.4));
            W.place(name, x + dx * out, sy, z + dz * out, yaw + spin, { collide: false });
          }
        }
      }
    }
  }
  const WHITE = () => new THREE.Color(1, 1, 1);

  const spawns = [];
  const fires = [];              // 燃烧点（烟柱 + 火光），交给 FX 生成
  const plazaBlocks = [[0, 0]];
  const isPlaza = (i, j) => i === 0 && j === 0;

  for (let i = -grid; i <= grid; i++) {
    for (let j = -grid; j <= grid; j++) {
      const cx = i * B, cz = j * B;
      if (isPlaza(i, j)) continue;
      const nearWater = i <= -grid;
      const far = Math.max(Math.abs(i), Math.abs(j)) >= grid;

      // 主楼
      const tx = cx + rng.range(-8, 8), tz = cz + rng.range(-8, 8);
      const towerTop = buildTower(tx, tz, far, (i + j + 8) % 5);
      // 部分楼顶着火：烟柱必须从楼体上方冒出来（横向偏移控制在楼面内），否则会变成悬空的烟
      if (rng() < 0.24) {
        const fa = rng() * 6.28, fd = rng.range(0, 5);
        fires.push({
          x: tx + Math.cos(fa) * fd,
          y: Math.max(8, towerTop - 1.5),
          z: tz + Math.sin(fa) * fd,
          s: rng.range(0.85, 1.25),
        });
      }
      // 副楼 / 裙楼
      const n = rng.int(1, 2);
      for (let k = 0; k < n; k++) {
        const ox = rng.range(-1, 1) * 26, oz = rng.range(-1, 1) * 26;
        if (Math.hypot(ox, oz) < 18) continue;
        const px = cx + ox, pz = cz + oz;
        glowPoints.push({ x: px, z: pz });
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
    // 注意参数顺序与 W.place 一致 (x, y, z)：调用处一律写 place(name, x, 0, z, yaw)
    const place = (name, x, y = 0, z = 0, yaw = 0, o = {}) => W.place(name, x, y, z, yaw, o);
    const pick = (list) => list[Math.floor(rng() * list.length)];
    const jit = (v, j = 0.6) => v + (rng() - 0.5) * j;

    // 常用资产按用途命名——道具要"成组"出现（桌配椅、垃圾斗配垃圾袋、摊位配货箱），而不是孤立乱撒
    const PR = {
      trashCan: 'objects_props_streetprops_trashcansmall_02_trashcansmall_02_mesh',
      dumpster: 'objects_props_dumpster_01_dumpster_01_mesh',
      bike: 'objects_props_bicyclestationbike_01_bicyclestationbike_01_mesh',
      stand: 'objects_props_marketstand_01_marketstand_01_basecluster_mesh',
      planter: 'objects_props_planter_set_01_planterbox_01_256x128_2_mesh',
      planterWall: 'objects_props_planter_set_01_planterwall_01_256x28_mesh',
      acUnit: 'objects_props_acunit_01_acunit_01_mesh',
      acLarge: 'objects_props_airconditioner_large_01_airconditioner_large_01_mesh',
      supply: 'objects_props_supplycase_01_supplycase_01_mesh',
      mcrate: 'objects_props_cratemilitary_01_cratemilitary_01_mesh',
      barrier: 'objects_props_concretebarrier_01_concretebarrier_01_destruction_mesh',
      sandbag: 'objects_props_sandbagwall_01_sandbagwall_01_mesh',
      debrisPile: 'objects_props_debrispile_02_debrispile_02_b_mesh',
      rubble: 'objects_props_rubblepile_01_rubblepile_ground_01b_mesh',
      girder: 'objects_props_metal_girder_01_metal_girder_01_mesh',
      pipe: 'objects_props_pipesystem_02_pipesystem_02d_mesh',
      crate: 'objects_props_cratewoodlight_01_cratewoodlight_01_mesh',
      boxC: 'objects_props_cardboardbox_01_cardboardbox_01_closed_mesh',
      boxO: 'objects_props_cardboardbox_01_cardboardbox_01_open_mesh',
      cone: 'objects_props_trafficcone_01_trafficcone_01_mesh',
      bucket: 'objects_props_bucket_01_bucket_01_mesh',
      barrel: 'objects_props_oilbarrel_01_oilbarrel_01_mesh',
      pallet: 'objects_props_pallet_01_pallet_01_mesh',
      microDebris: 'objects_props_debrismicro_01_debrismicro_01_mesh',
      paper: 'objects_props_paperpile_01_paperpile_01_mesh',
      cables: 'objects_props_cables_01_cable_bundle_medium_mesh',
      manhole: 'objects_props_manholecover_01_manholecover_01_mesh',
      puddle: 'objects_props_puddle_puddle_01_mesh',
      bench: 'objects_props_benchmodern_01_benchmodern_01_cluster_mesh',
      marbleBench: 'objects_props_marblebench_02_marblebench_02_mesh',
      chair: 'objects_props_cafechair_01_cafechair_01_mesh',
      table: 'objects_props_cafetable_01_cafetable_01_mesh',
      bollard: 'objects_props_crossingbollard_crossingbollard_01_mesh',
      railing: 'levels_mp_mp_siege_placeholders_railing_01_mesh',
      lantern: 'objects_props_chineselantern_01_chineselantern_01_mesh',
      stoneLantern: 'levels_sp_sp_shanghai_objects_stone_lantern_01_stone_lantern_01_mesh',
      streetLight: 'objects_lights_streetlight_02_streetlight_02_destruction_mesh',
      pedLight: 'objects_lights_lightpedestrian_01_lightpedestrian_01_mesh',
      trafficLight: 'objects_props_streetprops_trafficlight_01_trafficlight_01_mesh',
    };

    // (side, 沿墙距离 t, 离街区中心距离 d) → [x, y, z]；side 0/2 = ±Z 边，1/3 = ±X 边
    // 返回值可直接展开进 place()：place(name, ...at(side, t, d), yaw)
    const at = (side, t, d) => side % 2 === 0
      ? [cx + t, 0, cz + (side === 0 ? d : -d)]
      : [cx + (side === 1 ? d : -d), 0, cz + t];

    const WALK = CITY.HALF + CITY.SIDEWALK / 2;   // 人行道带（贴店面、避开车道）
    const YARD = [34, CITY.HALF - 5];             // 天井带（主楼与骑楼之间，飞行视角可见）

    /* ---- 主题堆放：每组道具互相呼应，围绕一个"生活场景" ---- */

    // 店外咖啡座：桌子 + 围放的椅子 + 花箱
    const cafe = (side, t) => {
      const yaw = side * Math.PI / 2;
      for (let k = 0, n = rng.int(1, 2); k < n; k++) {
        const [x, , z] = at(side, jit(t + k * 2.4), WALK);
        place(PR.table, x, 0, z, yaw + (rng() - 0.5) * 0.4);
        for (let c = 0, m = rng.int(1, 2); c < m; c++) {
          const a = rng() * 6.28;
          place(PR.chair, x + Math.cos(a) * 0.95, 0, z + Math.sin(a) * 0.95, a + Math.PI);
        }
      }
      if (rng() < 0.7) place(PR.planter, ...at(side, jit(t + rng.range(-1.5, 1.5)), WALK + 1.1), yaw);
      if (rng() < 0.4) place(PR.planterWall, ...at(side, jit(t + rng.range(-2, 2)), WALK - 1.0), yaw);
    };

    // 垃圾点：垃圾斗 + 一排垃圾桶 + 散落的纸箱纸堆
    const garbage = (side, t) => {
      const yaw = side * Math.PI / 2;
      if (rng() < 0.55) place(PR.dumpster, ...at(side, jit(t), WALK), yaw + (rng() < 0.5 ? 0 : Math.PI));
      for (let k = 0, n = rng.int(2, 3); k < n; k++) {
        place(PR.trashCan, ...at(side, jit(t + rng.range(-2.6, 2.6)), WALK + rng.range(-0.5, 0.5)), rng() * 6);
      }
      for (let k = 0, n = rng.int(2, 4); k < n; k++) {
        place(pick([PR.boxC, PR.boxO, PR.paper, PR.bucket]), ...at(side, jit(t + rng.range(-3, 3), 1.2), WALK + rng.range(-0.8, 0.8)), rng() * 6);
      }
    };

    // 早点摊/排档：摊位 + 周围的货箱油桶 + 托盘
    const market = (side, t) => {
      const yaw = side * Math.PI / 2;
      place(PR.stand, ...at(side, jit(t), WALK + 0.4), yaw + (rng() < 0.5 ? 0 : Math.PI));
      for (let k = 0, n = rng.int(2, 4); k < n; k++) {
        place(pick([PR.crate, PR.boxC, PR.boxO, PR.barrel]), ...at(side, jit(t + rng.range(-2.4, 2.4), 1.2), WALK + rng.range(-0.6, 1.0)), rng() * 6);
      }
      if (rng() < 0.6) place(PR.pallet, ...at(side, jit(t + rng.range(-2.5, 2.5)), WALK), rng() * 6);
    };

    // 停车带：一排自行车 + 护柱
    const bikes = (side, t) => {
      const yaw = side * Math.PI / 2;
      for (let k = 0, n = rng.int(2, 3); k < n; k++) {
        place(PR.bike, ...at(side, t + k * 1.35 + rng.range(-0.15, 0.15), WALK + 0.2), yaw + (rng() - 0.5) * 0.25);
      }
      if (rng() < 0.5) place(PR.bollard, ...at(side, jit(t - 2), WALK), yaw);
    };

    // 施工围挡：一溜锥形桶 + 沙袋/水泥墩 + 线缆钢梁
    const worksite = (side, t) => {
      const yaw = side * Math.PI / 2;
      for (let k = 0, n = rng.int(3, 5); k < n; k++) {
        place(PR.cone, ...at(side, t + k * 1.7, WALK + rng.range(-0.2, 0.2)), rng() * 6);
      }
      place(rng() < 0.5 ? PR.sandbag : PR.barrier, ...at(side, jit(t + rng.range(-1, 5)), WALK - 0.4), yaw);
      if (rng() < 0.6) place(rng() < 0.5 ? PR.cables : PR.girder, ...at(side, jit(t + rng.range(-2, 4)), WALK + 0.5), rng() * 6);
    };

    // 杂物堆：纸箱/托盘/油桶挤在一小片区域
    const junk = (side, t) => {
      const d = rng() < 0.6 ? WALK : rng.range(YARD[0], YARD[1]);
      for (let k = 0, n = rng.int(3, 5); k < n; k++) {
        place(pick([PR.boxC, PR.boxO, PR.pallet, PR.barrel, PR.bucket, PR.crate, PR.paper, PR.supply]),
          ...at(side, jit(t + rng.range(-1.6, 1.6), 1.4), d + rng.range(-0.8, 0.8)), rng() * 6);
      }
    };

    // 天井：主楼背后/骑楼内侧的杂物与战争痕迹（飞行视角下街区内部不再空荡）
    const courtyard = (side, t) => {
      const d = rng.range(YARD[0], YARD[1]);
      place(pick([PR.rubble, PR.debrisPile, PR.acUnit, PR.acLarge, PR.pipe, PR.sandbag, PR.mcrate]),
        ...at(side, jit(t + rng.range(-3, 3), 2.4), d), rng() * 6);
      for (let k = 0, n = rng.int(2, 4); k < n; k++) {
        place(pick([PR.microDebris, PR.boxC, PR.paper, PR.barrel, PR.pallet]),
          ...at(side, jit(t + rng.range(-4, 4), 3), d + rng.range(-2.5, 2.5)), rng() * 6);
      }
    };

    /* ---- 沿四条边扫过：每 ~11m 一段分配一个主题，沿街形成有节奏的店面外摆 ---- */
    for (const side of [0, 1, 2, 3]) {
      for (let s = 0; s < 8; s++) {
        const t = -CITY.HALF + 5.6 + s * 11.25 + rng.range(-1.2, 1.2);
        const roll = rng();
        if (roll < 0.24) cafe(side, t);
        else if (roll < 0.44) garbage(side, t);
        else if (roll < 0.60) market(side, t);
        else if (roll < 0.74) bikes(side, t);
        else if (roll < 0.88) worksite(side, t);
        else junk(side, t);
        if (rng() < 0.4) courtyard(side, t);   // 部分段落在天井里补一堆
      }
    }

    // 路面细节：井盖顺着行车线排、水洼零星点缀（属于马路，不属于人行道）
    for (const side of [0, 1, 2, 3]) {
      for (let k = 0; k < 2; k++) {
        const [x, , z] = at(side, rng.range(-CITY.HALF + 8, CITY.HALF - 8), B / 2 + rng.range(-3.5, 3.5));
        place(PR.manhole, x, 0.03, z, rng() * 6, { collide: false });
      }
      for (let k = 0, n = rng.int(0, 2); k < n; k++) {
        const [x, , z] = at(side, rng.range(-CITY.HALF + 8, CITY.HALF - 8), B / 2 + rng.range(-5.5, 5.5));
        place(PR.puddle, x, 0.03, z, rng() * 6, { collide: false });
      }
    }

    // 路灯贴人行道、灯笼摆在店门口、行人灯随机分布
    for (let k = 0; k < 2; k++) {
      place(PR.streetLight, ...at(k === 0 ? 0 : 2, rng.range(-CITY.HALF + 6, CITY.HALF - 6), WALK + 0.9), (k === 0 ? 0 : Math.PI));
    }
    for (let k = 0; k < 2; k++) {
      place(rng() < 0.5 ? PR.lantern : PR.stoneLantern, ...at(rng.int(0, 3), rng.range(-CITY.HALF + 6, CITY.HALF - 6), WALK + 0.6), rng() * 6, { collide: false });
    }
    for (let k = 0; k < 2; k++) {
      place(PR.pedLight, ...at(rng.int(0, 3), rng.range(-CITY.HALF + 6, CITY.HALF - 6), WALK), rng() * 6);
    }
    // 路口的红绿灯
    place(PR.trafficLight, cx + CITY.HALF + 4.4, 0, cz + CITY.HALF + 4.4, rng() * 6);
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
        plaza.x + Math.cos(a + 0.3) * 20, 0, plaza.z + Math.sin(a + 0.3) * 20, 0, { collide: false });
    }
    // 广场上的坦克与直升机残骸（放在街区边缘）
    W.place('gameplay_vehicles_ch_mbt_type99_spec_ch_mbt_type99_sp_shanghaichase_mesh', plaza.x + 33, 0, plaza.z - 30, 0.7, { collide: true });
    W.place('gameplay_vehicles_ch_lthe_z-9_ch_lthe_z-9_wreck_mesh', plaza.x - 34, 0, plaza.z - 28, 2.1, { collide: true });
    // 烧着的坦克与直升机残骸：广场地面上的火点，玩家在广场上就能看到黑烟冲上天
    fires.push({ x: plaza.x + 33, y: 1.7, z: plaza.z - 30, s: 0.62 });
    fires.push({ x: plaza.x - 34, y: 1.3, z: plaza.z - 28, s: 0.5 });
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

    // 战场感：马路上横七竖八的弃车与残骸——不等距、不定向、带一点侧倾
    const wreckYaw = () => {
      const u = rng();
      if (u < 0.38) return rng.range(-0.35, 0.35);                 // 基本顺向，撞歪了
      if (u < 0.74) return Math.PI / 2 + rng.range(-0.45, 0.45);   // 横在路中央
      return rng() * Math.PI * 2;                                  // 彻底乱转
    };
    const wreck = (x, z, yawBias = wreckYaw()) => {
      const t = rng();
      // 残骸为主（wreck_cluster / 烧毁面包车），夹杂几辆遗弃的完好车
      const a = t < 0.34 ? carAssets[2] : t < 0.56 ? carAssets[0] : t < 0.78 ? carAssets[1] : t < 0.92 ? carAssets[4] : carAssets[3];
      W.place(a, x, 0, z, yawBias, {
        collide: true,
        tiltX: rng.range(-0.05, 0.05),
        tiltZ: rng.range(-0.065, 0.065),
      });
      // 每隔若干辆挑一辆还在烧的：街面上也立起直冲上天的黑烟柱
      if (wreckN++ % 26 === 0 && fires.length < 14) fires.push({ x, y: 1.3, z, s: rng.range(0.6, 0.9) });
    };
    let wreckN = 0;
    // 两条方向的车道都扫一遍：每 20~42m 一辆，横向位置覆盖整幅路面（偶尔蹭上路缘）
    for (const rc of roadCenters) {
      for (let s = cityMin + 12; s < cityMax - 8; s += rng.range(20, 42)) {
        wreck(rc + rng.range(-10.8, 10.8), s);           // 纵向路（沿 Z）
        wreck(s, rc + rng.range(-10.8, 10.8));           // 横向路（沿 X）
      }
    }
    // 部分十字路口中央再横一辆，堵住路口
    for (const rx of roadCenters) {
      for (const rz of roadCenters) {
        if (rng() < 0.4) wreck(rx + rng.range(-4.5, 4.5), rz + rng.range(-4.5, 4.5));
      }
    }
  }

  /* ---------------- 路面战场痕迹：街垒 / 瓦砾 / 沙袋工事 / 散落物 ---------------- */
  {
    const pick = (list) => list[Math.floor(rng() * list.length)];
    // 长轴在 Z 的（水泥墩 4m / 沙袋墙 5.3m / 钢梁）与长轴在 X 的（防爆栅栏 2.8m / 铁丝网）分别定朝向，
    // 保证它们能横跨路面排成街垒。axis 0 = 道路沿 Z，axis 1 = 道路沿 X。
    const crossYaw = (axis, longZ) => axis === 0 ? (longZ ? Math.PI / 2 : 0) : (longZ ? 0 : Math.PI / 2);
    const RD = {
      barrier: 'objects_props_concretebarrier_01_concretebarrier_01_destruction_mesh',
      sandbag: 'objects_props_sandbagwall_01_sandbagwall_01_mesh',
      riot: 'objects_props_riotfence_riotfence_01_mesh',
      fence: 'objects_props_fenceparc_01_fenceparc_01_mesh',
      rubble: 'objects_props_rubblepile_01_rubblepile_ground_01b_mesh',
      debris: 'objects_props_debrispile_02_debrispile_02_b_mesh',
      girder: 'objects_props_metal_girder_01_metal_girder_01_mesh',
      pipe: 'objects_props_pipesystem_02_pipesystem_02d_mesh',
      cables: 'objects_props_cables_01_cable_bundle_medium_mesh',
      cone: 'objects_props_trafficcone_01_trafficcone_01_mesh',
      barrel: 'objects_props_oilbarrel_01_oilbarrel_01_mesh',
      box: 'objects_props_cardboardbox_01_cardboardbox_01_closed_mesh',
      micro: 'objects_props_debrismicro_01_debrismicro_01_mesh',
      paper: 'objects_props_paperpile_01_paperpile_01_mesh',
    };
    // 道路局部坐标 → 世界：u 沿路推进，v 横跨路面（相对路中心线）
    const onRoad = (axis, rc, u, v) => axis === 0 ? [rc + v, 0, u] : [u, 0, rc + v];

    // 街垒：一排水泥墩/防爆栅栏横跨半幅路，垒后补沙袋、周围撒锥形桶
    const roadblock = (axis, rc, u, v) => {
      const n = rng.int(2, 4);
      const useBarrier = rng() < 0.6;
      for (let k = 0; k < n; k++) {
        const name = useBarrier ? RD.barrier : (rng() < 0.7 ? RD.riot : RD.fence);
        W.place(name, ...onRoad(axis, rc, u + rng.range(-0.3, 0.3), v + (k - (n - 1) / 2) * 3.4),
          crossYaw(axis, name === RD.barrier) + rng.range(-0.06, 0.06), { collide: true });
      }
      W.place(RD.sandbag, ...onRoad(axis, rc, u + rng.range(-2.5, 2.5), v + (rng() < 0.5 ? 3.2 : -3.2)),
        crossYaw(axis, true) + rng.range(-0.35, 0.35), { collide: true });
      for (let k = 0, m = rng.int(1, 3); k < m; k++) {
        W.place(RD.cone, ...onRoad(axis, rc, u + rng.range(-7, 7), v + rng.range(-4, 4)), rng() * 6);
      }
    };
    // 炸出来的瓦砾
    const rubbleField = (axis, rc, u, v) => {
      W.place(rng() < 0.5 ? RD.rubble : RD.debris, ...onRoad(axis, rc, u, v), rng() * 6);
      for (let k = 0, n = rng.int(2, 4); k < n; k++) {
        W.place(pick([RD.micro, RD.box, RD.paper, RD.cables]), ...onRoad(axis, rc, u + rng.range(-4, 4), v + rng.range(-4, 4)), rng() * 6);
      }
    };
    // 散落的战场垃圾：钢梁/管子横在路面上，油桶滚到一边
    const scatterField = (axis, rc, u, v) => {
      for (let k = 0, n = rng.int(2, 4); k < n; k++) {
        const name = pick([RD.girder, RD.pipe, RD.cables, RD.barrel, RD.box, RD.micro]);
        W.place(name, ...onRoad(axis, rc, u + rng.range(-3, 3), v + rng.range(-5, 5)),
          name === RD.girder ? crossYaw(axis, true) + rng.range(-0.8, 0.8) : rng() * 6);
      }
    };
    // 沙袋工事：并排的沙袋墙 + 锥桶，偶尔再加一个水泥墩
    const sandbagNest = (axis, rc, u, v) => {
      for (let k = 0, n = rng.int(2, 3); k < n; k++) {
        W.place(RD.sandbag, ...onRoad(axis, rc, u + (k - (n - 1) / 2) * 4.6 + rng.range(-0.4, 0.4), v),
          crossYaw(axis, true) + rng.range(-0.2, 0.2), { collide: true });
      }
      for (let k = 0, m = rng.int(1, 2); k < m; k++) {
        W.place(RD.cone, ...onRoad(axis, rc, u + rng.range(-5, 5), v + rng.range(-3, 3)), rng() * 6);
      }
      if (rng() < 0.5) W.place(RD.barrier, ...onRoad(axis, rc, u + rng.range(-3, 3), v + (rng() < 0.5 ? 5 : -5)), crossYaw(axis, true), { collide: true });
    };

    for (const rc of roadCenters) {
      for (let s = cityMin + 16; s < cityMax - 10; s += rng.range(30, 60)) {
        for (const axis of [0, 1]) {
          const roll = rng(), u = s + rng.range(-6, 6), v = rng.range(-9, 9);
          if (roll < 0.3) roadblock(axis, rc, u, v);
          else if (roll < 0.55) rubbleField(axis, rc, u, v);
          else if (roll < 0.8) scatterField(axis, rc, u, v);
          else if (roll < 0.92) sandbagNest(axis, rc, u, v);
          // 其余位置留空，别把每段路都塞满
        }
      }
    }
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
      // 必须落在地面范围内（地面 x∈[-300,1400]，z∈[-1100,1100]）：
      // 越界就会立在江面或地面之外，看起来整栋悬空。
      if (x < CITY.QUAY_X + 6 || x > 1380 || Math.abs(z) > 1080) continue;
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
    W.place('objects_props_siegeskyline_shanghaitower_01_mesh', -250, 0, -610, 0.4, { collide: false });
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
  S.fires = fires;
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
