/* ============================================================
   Frostbite 风格后期管线（对标 BF3 / BF4 的后处理栈）

   BF3/BF4（Frostbite 2/3）的离屏后期顺序大致为：
     线性 HDR 渲染 → SSAO/HBAO → 多尺度 Bloom/「Glare」→ 镜头鬼影
     → 胶片 Tonemap（曝光自适应）→ 色彩分级（LUT/分离调色）
     → 色差 → 暗角 → 胶片颗粒 → 锐化（抵消时序 AA 变软）

   参考图（上海围攻）的观感主要由三件事决定：
     1) 极宽的多尺度光晕：亮天空整片往外渗，而不是细碎光斑
     2) 胶片曲线的高光滚降：云不会剪成死白，同时中暗部有 S 型对比
     3) 冷调阴影 + 中性偏暖高光的分离调色，整体略降饱和

   本实现：
     Pass0  世界 → 线性 HalfFloat 目标（带深度纹理）
     Pass0.5 SSAO（深度重建法线，半分辨率）+ 双边模糊
     Pass0.7 第一人称视角模型（必须在 AO 之后：它用另一套 near/far 且会清深度）
     Pass1  bright pass（软膝阈值）+ 13tap 降采样      → bloom[0] (1/2)
     Pass2  链式 4tap 降采样                            → bloom[1..4] (1/4..1/32)
     Pass3  9tap tent 上采样 + 累加                     → 宽域多尺度光晕
     Pass4  横向高斯 glare（1/8）                       → 阳光条带
     Pass5  合成：色差 → 锐化 → bloom/glare/ghost
            → 曝光 + ACES → 分离调色 → S 曲线 → 饱和度
            → 暗角 → 胶片颗粒 → sRGB 输出

   注意：three 在渲染到离屏目标时会关闭 toneMapping（见 WebGLPrograms），
   因此曝光与 ACES 必须在这里自己做，不能依赖 renderer.toneMapping。
   ============================================================ */
import * as THREE from 'three';

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/* ---------------------------------------------- bright pass：降采样 + 软膝阈值 */
const BRIGHT_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;      // 源（全分辨率）纹素
  uniform float uThreshold;
  uniform float uKnee;
  varying vec2 vUv;

  vec3 tap13(vec2 uv) {
    vec3 c = texture2D(tSrc, uv).rgb * 4.0;
    c += ( texture2D(tSrc, uv + vec2(-1.0, -1.0) * uTexel).rgb
         + texture2D(tSrc, uv + vec2( 1.0, -1.0) * uTexel).rgb
         + texture2D(tSrc, uv + vec2(-1.0,  1.0) * uTexel).rgb
         + texture2D(tSrc, uv + vec2( 1.0,  1.0) * uTexel).rgb ) * 2.0;
    c += texture2D(tSrc, uv + vec2(-2.0, -2.0) * uTexel).rgb
       + texture2D(tSrc, uv + vec2( 2.0, -2.0) * uTexel).rgb
       + texture2D(tSrc, uv + vec2(-2.0,  2.0) * uTexel).rgb
       + texture2D(tSrc, uv + vec2( 2.0,  2.0) * uTexel).rgb;
    c += texture2D(tSrc, uv + vec2( 0.0, -4.0) * uTexel).rgb
       + texture2D(tSrc, uv + vec2( 0.0,  4.0) * uTexel).rgb
       + texture2D(tSrc, uv + vec2(-4.0,  0.0) * uTexel).rgb
       + texture2D(tSrc, uv + vec2( 4.0,  0.0) * uTexel).rgb;
    return c / 20.0;
  }

  // Unity/CoD 式软膝：低于阈值平滑衰减，高于阈值线性进入
  vec3 brightKnee(vec3 c) {
    float br = max(c.r, max(c.g, c.b));
    float soft = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
    soft = soft * soft / (4.0 * uKnee + 1e-4);
    float w = max(soft, br - uThreshold) / max(br, 1e-4);
    return c * w;
  }

  void main() { gl_FragColor = vec4(brightKnee(tap13(vUv)), 1.0); }
`;

/* ---------------------------------------------- 链式降采样（4tap box） */
const DOWN_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;      // 源纹素
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb
           + texture2D(tSrc, vUv + vec2( 1.0, -1.0) * uTexel).rgb
           + texture2D(tSrc, vUv + vec2(-1.0,  1.0) * uTexel).rgb
           + texture2D(tSrc, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
    gl_FragColor = vec4(c * 0.25, 1.0);
  }
`;

/* ---------------------------------------------- 上采样（9tap tent，累加进上一层） */
const UP_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;      // 源纹素
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
    c += texture2D(tSrc, vUv + vec2( 1.0,  0.0) * uTexel).rgb
       + texture2D(tSrc, vUv + vec2(-1.0,  0.0) * uTexel).rgb
       + texture2D(tSrc, vUv + vec2( 0.0,  1.0) * uTexel).rgb
       + texture2D(tSrc, vUv + vec2( 0.0, -1.0) * uTexel).rgb;
    c *= 2.0;
    c += texture2D(tSrc, vUv + vec2( 1.0,  1.0) * uTexel).rgb
       + texture2D(tSrc, vUv + vec2(-1.0,  1.0) * uTexel).rgb
       + texture2D(tSrc, vUv + vec2( 1.0, -1.0) * uTexel).rgb
       + texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
    gl_FragColor = vec4(c / 16.0, 1.0);
  }
`;

/* ---------------------------------------------- 横向 glare（阳光条带） */
const STREAK_FRAG = /* glsl */`
  uniform sampler2D tSrc;
  uniform vec2 uTexel;
  uniform float uSpread;
  varying vec2 vUv;
  void main() {
    vec3 c = vec3(0.0);
    float wsum = 0.0;
    for (int i = -6; i <= 6; i++) {
      float f = float(i);
      float w = exp(-f * f / 16.0);
      c += texture2D(tSrc, vUv + vec2(f * uSpread * uTexel.x, 0.0)).rgb * w;
      wsum += w;
    }
    gl_FragColor = vec4(c / wsum, 1.0);
  }
`;

/* ---------------------------------------------- SSAO（深度重建法线） */
const AO_FRAG = /* glsl */`
  uniform sampler2D tDepth;
  uniform vec2 uResolution;
  uniform vec2 uProjScale;    // x = tan(fov/2)·aspect, y = tan(fov/2)
  uniform float uNear;
  uniform float uFar;
  uniform vec3 uKernel[12];
  uniform float uRadius;      // 世界单位（米）：接触暗部的尺度
  uniform float uIntensity;
  uniform float uBias;
  uniform float uPower;
  uniform float uMaxStep;     // 重建法线时单像素允许的深度跳变（米）
  uniform float uPlaneTol;    // 平面拒绝阈值（米）
  varying vec2 vUv;

  // 透视深度 → 沿视线的正距离
  float linearDepth( float d ) {
    float z = 2.0 * d - 1.0;
    return ( 2.0 * uNear * uFar ) / ( uFar + uNear - z * ( uFar - uNear ) );
  }
  // 屏幕 uv + 距离 → 视空间坐标（视空间 -Z 为前方）
  vec3 viewOf( vec2 uv, float dist ) {
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3( ndc.x * uProjScale.x, ndc.y * uProjScale.y, -1.0 ) * dist;
  }
  vec3 viewAt( vec2 uv ) {
    return viewOf( uv, linearDepth( texture2D( tDepth, uv ).r ) );
  }
  // 视空间 → 屏幕 uv（viewAt 的逆运算，省掉投影矩阵）
  vec2 uvOf( vec3 vp ) {
    return vp.xy / ( -vp.z * uProjScale ) * 0.5 + 0.5;
  }
  float hash12( vec2 p ) {
    p = fract( p * vec2( 443.897, 441.423 ) );
    p += dot( p, p.yx + 19.19 );
    return fract( ( p.x + p.y ) * p.x );
  }

  void main() {
    float d = texture2D( tDepth, vUv ).r;
    if ( d >= 0.99999 ) { gl_FragColor = vec4( 1.0 ); return; }   // 天空/背景：不遮蔽

    float distP = linearDepth( d );
    vec3 P = viewOf( vUv, distP );
    vec2 texel = 1.0 / uResolution;

    // 法线由相邻像素的位置差叉乘得到（深度重建，不需要法线 G-buffer）。
    // 深度先夹在 ±uMaxStep：掠射地面上相邻像素的深度差能到几十米，
    // 直接拿去叉乘会得到一个乱指的法线，半球一歪就是满屏假遮挡。
    float dX = linearDepth( texture2D( tDepth, vUv + vec2( texel.x, 0.0 ) ).r );
    float dY = linearDepth( texture2D( tDepth, vUv + vec2( 0.0, texel.y ) ).r );
    vec3 Px = viewOf( vUv + vec2( texel.x, 0.0 ), clamp( dX, distP - uMaxStep, distP + uMaxStep ) );
    vec3 Py = viewOf( vUv + vec2( 0.0, texel.y ), clamp( dY, distP - uMaxStep, distP + uMaxStep ) );
    vec3 N = normalize( cross( Px - P, Py - P ) );
    if ( N.z < 0.0 ) N = -N;

    // 逐像素随机旋转半球核，把固定采样图案打散成噪声（交给模糊消除）
    float a = hash12( gl_FragCoord.xy ) * 6.2831853;
    vec3 rv = vec3( cos( a ), sin( a ), 0.0 );
    vec3 T = normalize( rv - N * dot( rv, N ) );
    vec3 B = cross( N, T );
    mat3 basis = mat3( T, B, N );

    float viewZ = -P.z;
    // bias / 阈值随距离放宽：远处深度量化更粗，固定 bias 会退化成掷硬币
    float bias = uBias * ( 1.0 + viewZ * 0.004 );
    float tol = uPlaneTol * ( 1.0 + viewZ * 0.004 );
    float occ = 0.0;
    for ( int i = 0; i < 12; i++ ) {
      vec3 sp = P + basis * uKernel[ i ] * uRadius;
      if ( sp.z > -uNear ) continue;
      vec2 suv = uvOf( sp );
      if ( suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0 ) continue;
      float sceneZ = linearDepth( texture2D( tDepth, suv ).r );
      if ( sceneZ >= -sp.z - bias ) continue;   // 采样点在场景表面之前 → 没被挡住
      // 平面拒绝：该像素处的场景点若和 P 落在同一张光滑面上，它就不是遮挡体。
      // 掠射地面投到几像素外的"更近的地面"正是这种情况，靠它根治自遮蔽。
      vec3 Q = viewOf( suv, sceneZ );
      if ( dot( Q - P, N ) <= tol ) continue;
      // 距离检查：只有近处的遮挡体可信，远处的深度不参与
      float range = smoothstep( 0.0, 1.0, uRadius / max( abs( viewZ - sceneZ ), 1e-4 ) );
      occ += range;
    }
    float ao = 1.0 - ( occ / 12.0 ) * uIntensity;
    gl_FragColor = vec4( vec3( pow( clamp( ao, 0.0, 1.0 ), uPower ) ), 1.0 );
  }
`;

/* ---------------------------------------------- AO 双边模糊（按深度加权，不糊过边缘） */
const AO_BLUR_FRAG = /* glsl */`
  uniform sampler2D tAO;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;        // AO 缓冲纹素
  uniform float uNear;
  uniform float uFar;
  varying vec2 vUv;

  float linearDepth( float d ) {
    float z = 2.0 * d - 1.0;
    return ( 2.0 * uNear * uFar ) / ( uFar + uNear - z * ( uFar - uNear ) );
  }

  void main() {
    float cd = linearDepth( texture2D( tDepth, vUv ).r );
    float sum = 0.0, wsum = 0.0;
    // 3×3 足够：AO 是半分辨率算的，合成时双线性放大还会再平均 2×2
    for ( int y = -1; y <= 1; y++ ) {
      for ( int x = -1; x <= 1; x++ ) {
        vec2 uv = vUv + vec2( float( x ), float( y ) ) * uTexel;
        float d = linearDepth( texture2D( tDepth, uv ).r );
        float w = 1.0 / ( abs( d - cd ) * 8.0 + 1.0 );
        sum += texture2D( tAO, uv ).r * w;
        wsum += w;
      }
    }
    gl_FragColor = vec4( vec3( sum / max( wsum, 1e-4 ) ), 1.0 );
  }
`;

/* ---------------------------------------------- 合成 */
const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tBloom;   // bloom[0]：多尺度累加后的宽域光晕
  uniform sampler2D tGlare;   // 横向条带
  uniform sampler2D tGhost;   // bloom[1]：镜头鬼影采样源
  uniform sampler2D tAO;      // 半分辨率 SSAO（已双边模糊）
  uniform float uAO;
  uniform vec2 uResolution;
  uniform float uExposure;
  uniform float uBloom;
  uniform float uGlare;
  uniform float uGhost;
  uniform float uCA;
  uniform float uSharpen;
  uniform float uContrast;
  uniform float uSaturation;
  uniform vec3 uShadowTint;
  uniform vec3 uHighlightTint;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uTime;
  varying vec2 vUv;

  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

  // Narkowicz ACES 拟合：高光滚降 + 胶片式趾部
  vec3 aces(vec3 x) {
    const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  float hash(vec2 p) {
    p = fract(p * vec2(443.897, 441.423));
    p += dot(p, p.yx + 19.19);
    return fract((p.x + p.y) * p.x);
  }

  void main() {
    vec2 px = 1.0 / uResolution;
    vec2 dir = vUv - 0.5;
    float r2 = dot(dir, dir);

    // 1) 径向色差：离中心越远越明显（BF4 镜头质感）
    vec2 ca = dir * r2 * uCA;
    vec3 col;
    col.r = texture2D(tScene, vUv - ca).r;
    col.g = texture2D(tScene, vUv).g;
    col.b = texture2D(tScene, vUv + ca).b;

    // 2) 轻度 unsharp，保住窗格/栏杆这类微对比
    vec3 blur = ( texture2D(tScene, vUv + vec2(px.x, 0.0)).rgb
                + texture2D(tScene, vUv - vec2(px.x, 0.0)).rgb
                + texture2D(tScene, vUv + vec2(0.0, px.y)).rgb
                + texture2D(tScene, vUv - vec2(0.0, px.y)).rgb ) * 0.25;
    col += (col - blur) * uSharpen;

    // 2.5) 环境光遮蔽：接触暗部。压在 bloom 之前，免得光晕被一起压掉
    col *= mix( 1.0, texture2D(tAO, vUv).r, uAO );

    // 3) 宽域光晕 / 阳光条带 / 镜头鬼影（都在线性 HDR 域叠加）
    vec3 bloom = texture2D(tBloom, vUv).rgb;
    col += bloom * uBloom;
    col += texture2D(tGlare, vUv).rgb * uGlare;

    if (uGhost > 0.001) {
      vec2 toC = 0.5 - vUv;
      vec3 ghost = vec3(0.0);
      for (int i = 1; i <= 4; i++) {
        float f = float(i) * 0.44;
        vec2 guv = 0.5 + toC * f;
        float inb = step(0.0, guv.x) * step(guv.x, 1.0) * step(0.0, guv.y) * step(guv.y, 1.0);
        vec3 tint = mix(vec3(0.86, 0.96, 1.14), vec3(1.16, 0.92, 0.62), float(i) / 4.0);
        ghost += texture2D(tGhost, guv).rgb * tint * inb;
      }
      col += ghost * (uGhost * 0.25);
    }

    // 4) 曝光 + 胶片 Tonemap
    col = aces(max(col, 0.0) * uExposure);

    // 5) 分离调色：冷调阴影 / 中性偏暖高光（BF4 的城市日景底色）
    float luma = dot(col, LUMA);
    float shW = 1.0 - smoothstep(0.02, 0.55, luma);
    float hiW = smoothstep(0.45, 0.98, luma);
    col = mix(col, col * uShadowTint, shW);
    col = mix(col, col * uHighlightTint, hiW);

    // 6) S 型对比 + 饱和度
    col = clamp(col, 0.0, 1.0);
    col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);
    col = mix(vec3(dot(col, LUMA)), col, uSaturation);

    // 7) 暗角（很轻，只做画面聚焦）
    float vig = smoothstep(0.16, 0.72, sqrt(r2));
    col *= 1.0 - vig * uVignette;

    // 8) 胶片颗粒：暗部更强，逐帧抖动
    float g = hash(gl_FragCoord.xy + fract(uTime) * vec2(137.0, 91.0)) - 0.5;
    col += g * uGrain * (1.0 - 0.65 * clamp(luma, 0.0, 1.0));

    gl_FragColor = vec4(max(col, 0.0), 1.0);
    #include <colorspace_fragment>
  }
`;

/* ---------------------------------------------------------- 默认参数 */
const BASE = {
  bloom: 0.50,
  glare: 0.11,
  ghost: 0.05,
  ca: 0.0050,
  sharpen: 0.28,
  contrast: 0.32,
  saturation: 1.04,
  vignette: 0.24,
  grain: 0.036,
  shadowTint: [0.87, 0.99, 1.15],
  highlightTint: [1.06, 1.00, 0.92],
  // SSAO
  ao: 0.85,          // 合成时的混合强度（0 = 关闭）
  aoRadius: 0.7,     // 采样半径（世界单位/米）：决定暗部的尺度
  aoIntensity: 1.1,
  aoPower: 1.4,
  aoBias: 0.025,
  aoMaxStep: 0.6,    // 重建法线时单像素最大深度跳变（超过就按平面处理）
  aoPlaneTol: 0.04,  // 平面拒绝阈值：同平面的点不算遮挡
};

/** SSAO 半球核：向中心偏置，靠近表面的样本更密（接触暗部才有细节） */
function makeAOKernel(n = 12) {
  let seed = 0x9E3779B9;
  const rnd = () => {
    seed = (Math.imul(seed ^ (seed >>> 15), 0x85EBCA6B) >>> 0);
    seed = (Math.imul(seed ^ (seed >>> 13), 0xC2B2AE35) >>> 0);
    return ((seed ^ (seed >>> 16)) >>> 0) / 4294967296;
  };
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd());
    if (v.lengthSq() < 1e-4) v.set(0.2, 0.2, 0.4);
    v.normalize().multiplyScalar(0.25 + 0.75 * rnd() * rnd());
    out.push(v);
  }
  return out;
}
const AO_KERNEL = makeAOKernel(12);

function bloomRT(w, h) {
  return new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    const pr = renderer.getPixelRatio();
    const w = Math.max(2, Math.floor(innerWidth * pr));
    const h = Math.max(2, Math.floor(innerHeight * pr));

    /* 线性 HDR 场景目标 */
    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.sceneRT.texture.colorSpace = THREE.LinearSRGBColorSpace;

    /* 深度纹理：SSAO 靠它重建视空间位置与法线（不需要法线 G-buffer） */
    this.depthTexture = new THREE.DepthTexture(w, h);
    this.depthTexture.minFilter = THREE.NearestFilter;
    this.depthTexture.magFilter = THREE.NearestFilter;
    this.sceneRT.depthTexture = this.depthTexture;

    /* SSAO：半分辨率计算 + 双边模糊 */
    const aw = Math.max(2, Math.floor(w / 2)), ah = Math.max(2, Math.floor(h / 2));
    this.aoRT = bloomRT(aw, ah);
    this.aoBlurRT = bloomRT(aw, ah);

    /* bloom 金字塔：1/2 .. 1/32 */
    this.bloom = [];
    for (let i = 0; i < 5; i++) {
      const d = 1 / (2 << i);
      this.bloom.push(bloomRT(Math.max(1, Math.floor(w * d)), Math.max(1, Math.floor(h * d))));
    }
    /* 横向 glare 缓冲（1/8） */
    this.glareRT = bloomRT(this.bloom[2].width, this.bloom[2].height);

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    const mk = (frag, uniforms, opts = {}) => new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NoBlending,
    });

    const T = (t) => ({ value: t });

    this.brightMat = mk(BRIGHT_FRAG, {
      tSrc: T(this.sceneRT.texture),
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uThreshold: { value: 1.15 },
      uKnee: { value: 0.50 },
    });

    this.downMats = [];
    for (let i = 0; i < this.bloom.length - 1; i++) {
      this.downMats.push(mk(DOWN_FRAG, {
        tSrc: T(this.bloom[i].texture),
        uTexel: { value: new THREE.Vector2() },
      }));
    }
    this.upMats = [];
    for (let i = 0; i < this.bloom.length - 1; i++) {
      this.upMats.push(mk(UP_FRAG, {
        tSrc: T(this.bloom[i + 1].texture),
        uTexel: { value: new THREE.Vector2() },
      }, { additive: true }));
    }
    this.streakMat = mk(STREAK_FRAG, {
      tSrc: T(this.bloom[2].texture),
      uTexel: { value: new THREE.Vector2() },
      uSpread: { value: 5.0 },
    });

    this.compositeMat = mk(COMPOSITE_FRAG, {
      tScene: T(this.sceneRT.texture),
      tBloom: T(this.bloom[0].texture),
      tGlare: T(this.glareRT.texture),
      tGhost: T(this.bloom[1].texture),
      uResolution: { value: new THREE.Vector2(w, h) },
      uExposure: { value: 1.0 },
      uBloom: { value: BASE.bloom },
      uGlare: { value: BASE.glare },
      uGhost: { value: BASE.ghost },
      uCA: { value: BASE.ca },
      uSharpen: { value: BASE.sharpen },
      uContrast: { value: BASE.contrast },
      uSaturation: { value: BASE.saturation },
      uShadowTint: { value: new THREE.Vector3(...BASE.shadowTint) },
      uHighlightTint: { value: new THREE.Vector3(...BASE.highlightTint) },
      uVignette: { value: BASE.vignette },
      uGrain: { value: BASE.grain },
      uTime: { value: 0 },
      tAO: T(this.aoBlurRT.texture),
      uAO: { value: BASE.ao },
    });

    /* SSAO 两个 pass 共用近/远平面 uniform（渲染时按相机刷新） */
    const uNear = { value: 0.1 }, uFar = { value: 4200 };
    this.aoMat = mk(AO_FRAG, {
      tDepth: T(this.depthTexture),
      uResolution: { value: new THREE.Vector2(aw, ah) },
      uProjScale: { value: new THREE.Vector2(1, 1) },
      uNear, uFar,
      uKernel: { value: AO_KERNEL },
      uRadius: { value: BASE.aoRadius },
      uIntensity: { value: BASE.aoIntensity },
      uBias: { value: BASE.aoBias },
      uPower: { value: BASE.aoPower },
      uMaxStep: { value: BASE.aoMaxStep },
      uPlaneTol: { value: BASE.aoPlaneTol },
    });
    this.aoBlurMat = mk(AO_BLUR_FRAG, {
      tAO: T(this.aoRT.texture),
      tDepth: T(this.depthTexture),
      uTexel: { value: new THREE.Vector2(1 / aw, 1 / ah) },
      uNear, uFar,
    });

    this.clock = new THREE.Clock();
    this.resize(innerWidth, innerHeight, pr);
  }

  /* ------------------------------------------------- 尺寸 */
  resize(width, height, pixelRatio = 1) {
    const r = this.renderer;
    const w = Math.max(2, Math.floor(width * (pixelRatio ?? r.getPixelRatio())));
    const h = Math.max(2, Math.floor(height * (pixelRatio ?? r.getPixelRatio())));
    this.sceneRT.setSize(w, h);
    // 深度纹理的尺寸由 three 在 setupDepthTexture 里按渲染目标同步，这里不用管
    this.brightMat.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.compositeMat.uniforms.uResolution.value.set(w, h);

    /* SSAO 缓冲跟场景目标同比缩半 */
    const aw = Math.max(2, Math.floor(w / 2)), ah = Math.max(2, Math.floor(h / 2));
    this.aoRT.setSize(aw, ah);
    this.aoBlurRT.setSize(aw, ah);
    this.aoMat.uniforms.uResolution.value.set(aw, ah);
    this.aoBlurMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
    for (let i = 0; i < this.bloom.length; i++) {
      const d = 1 / (2 << i);
      const bw = Math.max(1, Math.floor(w * d)), bh = Math.max(1, Math.floor(h * d));
      this.bloom[i].setSize(bw, bh);
      if (i < this.downMats.length) this.downMats[i].uniforms.uTexel.value.set(1 / bw, 1 / bh);
      if (i > 0 && i - 1 < this.upMats.length) {
        this.upMats[i - 1].uniforms.uTexel.value.set(1 / bw, 1 / bh);
      }
    }
    this.glareRT.setSize(this.bloom[2].width, this.bloom[2].height);
    this.streakMat.uniforms.uTexel.value.set(
      1 / this.bloom[2].width, 1 / this.bloom[2].height);
  }

  /* ------------------------------------------------- 单个全屏 pass */
  _pass(mat, target) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  /** 渲染世界（可含第一人称视角模型）到 HDR，再走整条后期链输出到屏幕 */
  render(world, camera, vmScene = null, vmCamera = null) {
    const r = this.renderer;

    /* Pass0：线性 HDR（渲染到目标时 three 自动关闭 toneMapping） */
    r.setRenderTarget(this.sceneRT);
    r.clear();
    r.render(world, camera);

    /* Pass0.5：SSAO。必须夹在世界与第一人称武器之间 ——
       武器用另一套 near/far（0.01~6）渲染并 clearDepth，
       跑在它后面的话深度缓冲里已经没有世界几何了。 */
    const tanY = Math.tan(camera.fov * Math.PI / 360);
    this.aoMat.uniforms.uProjScale.value.set(tanY * camera.aspect, tanY);
    this.aoMat.uniforms.uNear.value = camera.near;
    this.aoMat.uniforms.uFar.value = camera.far;
    this._pass(this.aoMat, this.aoRT);
    this._pass(this.aoBlurMat, this.aoBlurRT);

    if (vmScene && vmCamera) {
      r.setRenderTarget(this.sceneRT);   // 回到场景目标，颜色保留，只清深度
      r.clearDepth();
      r.render(vmScene, vmCamera);
    }

    /* Pass1：bright pass + 降到 1/2 */
    this._pass(this.brightMat, this.bloom[0]);

    /* Pass2：链式降采样 */
    for (let i = 0; i < this.downMats.length; i++) {
      this._pass(this.downMats[i], this.bloom[i + 1]);
    }

    /* Pass3：由最粗层往回 tent 上采样并累加 → 多尺度宽域光晕 */
    for (let i = this.upMats.length - 1; i >= 0; i--) {
      this._pass(this.upMats[i], this.bloom[i]);
    }

    /* Pass4：横向 glare */
    this._pass(this.streakMat, this.glareRT);

    /* Pass5：合成输出 */
    this.compositeMat.uniforms.uTime.value = this.clock.getElapsedTime();
    r.setRenderTarget(null);
    this._pass(this.compositeMat, null);
  }

  /* ------------------------------------------------- 状态接口 */
  setExposure(e) {
    this.compositeMat.uniforms.uExposure.value = e;
  }

  /** SSAO 混合强度（0 = 关闭）。半径/强度在 aoMat.uniforms 里直接调 */
  setAO(v) {
    this.compositeMat.uniforms.uAO.value = Math.max(0, Math.min(1, v));
  }

  /** night ∈ [0,1]：夜里光晕/颗粒/暗角更强，阴影更冷 */
  setNight(night) {
    const u = this.compositeMat.uniforms;
    u.uBloom.value = BASE.bloom + night * 0.22;
    u.uGlare.value = BASE.glare * (1.0 - night);
    u.uGhost.value = BASE.ghost * (1.0 - night);
    u.uCA.value = BASE.ca * (1.0 + night * 0.6);
    u.uVignette.value = BASE.vignette + night * 0.10;
    u.uGrain.value = BASE.grain + night * 0.025;
    u.uContrast.value = BASE.contrast + night * 0.06;
    const s = BASE.shadowTint;
    u.uShadowTint.value.set(
      s[0] - night * 0.07, s[1] - night * 0.01, s[2] + night * 0.08);
    this.brightMat.uniforms.uThreshold.value = 1.15 - night * 0.30;
  }

  dispose() {
    this.sceneRT.dispose();
    this.depthTexture.dispose();
    this.aoRT.dispose();
    this.aoBlurRT.dispose();
    for (const t of this.bloom) t.dispose();
    this.glareRT.dispose();
    for (const m of [this.brightMat, this.streakMat, this.compositeMat, this.aoMat, this.aoBlurMat,
      ...this.downMats, ...this.upMats]) m.dispose();
  }
}
