/* ============================================================
   轻量电影级后期：高光扩散、局部锐化、色彩分级、暗角
   世界先渲染到离屏目标，再合成到屏幕；第一人称武器在合成后渲染，
   保证枪械清晰且不受场景后期影响。
   ============================================================ */
import * as THREE from 'three';

const VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */`
  uniform sampler2D tScene;
  uniform vec2 uResolution;
  uniform float uBloom;
  uniform float uSharpen;
  uniform float uContrast;
  uniform float uSaturation;
  uniform float uVignette;
  varying vec2 vUv;

  vec3 saturateColor(vec3 c, float s) {
    float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(luma), c, s);
  }

  void main() {
    vec2 px = 1.0 / uResolution;
    vec3 color = texture2D(tScene, vUv).rgb;

    // 阈值高光的宽核采样：玻璃、霓虹、太阳获得克制的光晕。
    vec3 bloom = vec3(0.0);
    float weight = 0.0;
    for (int x = -2; x <= 2; x++) {
      for (int y = -2; y <= 2; y++) {
        vec2 offset = vec2(float(x), float(y)) * px * 3.25;
        vec3 sampleColor = texture2D(tScene, vUv + offset).rgb;
        float peak = max(max(sampleColor.r, sampleColor.g), sampleColor.b);
        float mask = smoothstep(0.70, 1.22, peak);
        float w = 1.0 / (1.0 + float(x * x + y * y));
        bloom += sampleColor * mask * w;
        weight += w;
      }
    }
    color += bloom / max(weight, 0.001) * uBloom;

    // 轻度 unsharp mask，强化窗格、路面和道具轮廓。
    vec3 right = texture2D(tScene, vUv + vec2(px.x, 0.0)).rgb;
    vec3 left = texture2D(tScene, vUv - vec2(px.x, 0.0)).rgb;
    vec3 up = texture2D(tScene, vUv + vec2(0.0, px.y)).rgb;
    vec3 down = texture2D(tScene, vUv - vec2(0.0, px.y)).rgb;
    vec3 blur = (right + left + up + down) * 0.25;
    color += (color - blur) * uSharpen;

    color = saturateColor(color, uSaturation);
    color = (color - 0.5) * uContrast + 0.5;

    // 边缘轻微压暗，保持第一人称画面聚焦。
    vec2 centerOffset = vUv - 0.5;
    float vignette = smoothstep(0.18, 0.72, dot(centerOffset, centerOffset) * 2.0);
    color *= 1.0 - vignette * uVignette;

    gl_FragColor = vec4(max(color, 0.0), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(2, 2, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this.target.texture.colorSpace = THREE.LinearSRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
    this.camera.position.z = 1;

    this.uniforms = {
      tScene: { value: this.target.texture },
      uResolution: { value: new THREE.Vector2(2, 2) },
      uBloom: { value: 0.16 },
      uSharpen: { value: 0.18 },
      uContrast: { value: 1.06 },
      uSaturation: { value: 1.08 },
      uVignette: { value: 0.12 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    this.scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material));

    this.resize(innerWidth, innerHeight, renderer.getPixelRatio());
  }

  resize(width, height, pixelRatio = 1) {
    const renderWidth = Math.max(2, Math.floor(width * pixelRatio));
    const renderHeight = Math.max(2, Math.floor(height * pixelRatio));
    this.target.setSize(renderWidth, renderHeight);
    this.uniforms.uResolution.value.set(renderWidth, renderHeight);
  }

  /** 渲染世界到离屏目标，再合成到默认帧缓冲。 */
  render(world, camera) {
    const renderer = this.renderer;
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(world, camera);
    renderer.setRenderTarget(null);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }

  setNight(night) {
    this.uniforms.uBloom.value = 0.12 + night * 0.18;
    this.uniforms.uVignette.value = 0.10 + night * 0.08;
    this.uniforms.uContrast.value = 1.045 + night * 0.035;
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}
