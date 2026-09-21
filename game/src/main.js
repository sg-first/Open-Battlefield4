/* ============================================================
   上海 · 开放世界 FPS —— 主程序
   ============================================================ */
import * as THREE from 'three';
import { TexCache } from './obj.js';
import { loadAll, WorldBuilder } from './assets.js';
import { BoxWorld } from './collision.js';
import { FX } from './fx.js';
import { GameAudio } from './audio.js';
import { HUD } from './hud.js';
import { Player } from './player.js';
import { WeaponSystem, WEAPON_DEFS } from './weapons.js';
import { CharacterFactory } from './characters.js';
import { EnemyManager } from './enemies.js';
import { buildWorld, Civilians, skyStateAt, sunDirAt, CITY } from './world.js';
import { PostFX } from './post.js';
import { Inspector } from './inspect.js';
import { clamp, smoothstep, yieldFrame } from './util.js';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------- 渲染器 */
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = true;
renderer.autoClear = false;
$('app').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(78, innerWidth / innerHeight, 0.1, 4200);

/* ---------------------------------------------------------- 载入进度 */
const loadEl = $('loading');
const barIn = $('barIn');
const loadTxt = $('loadTxt');
const loadPct = $('loadPct');

function setProgress(p, txt) {
  barIn.style.width = (clamp(p, 0, 1) * 100).toFixed(1) + '%';
  if (loadPct) loadPct.textContent = (clamp(p, 0, 1) * 100).toFixed(0) + '%';
  if (txt) loadTxt.textContent = txt;
}

/* ---------------------------------------------------------- 启动 */
let started = false;
const state = {
  clock: 17.35,
  timeFlow: 0.02,
  showMap: true,
  paused: false,
};
const OBJECTIVE_MAIN = '目标：清理街区的敌军';

let audio, hud, player, weapons, enemies, civilians, fx, boxes, worldInfo, post, glowMats = [], bgMats = [];
let inspector = null, lastInspect = null;
let builder = null;

async function boot() {
  const tex = new TexCache(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  setProgress(0.02, '初始化…');
  await yieldFrame();

  const { assets, glowMats: gm, bgMats: bm } = await loadAll(tex, ({ phase, done, total }) => {
    setProgress(0.05 + 0.72 * (done / total), `${phase}　${done}/${total}`);
  });
  glowMats = gm; bgMats = bm || [];
  setProgress(0.8, '构建街区…');
  await yieldFrame();

  boxes = new BoxWorld();
  builder = new WorldBuilder(scene, assets, boxes);
  worldInfo = buildWorld({ scene, assets, builder, renderer });
  const stats = builder.build();
  boxes.finalize();
  setProgress(0.93, '生成角色与战斗系统…');
  await yieldFrame();

  // 系统
  post = new PostFX(renderer);
  audio = new GameAudio();
  fx = new FX(scene, camera, boxes);
  hud = new HUD({ camera, boxes, extent: worldInfo.extent * 1.05 });
  hud.buildStaticMap();
  camera.position.set(0, 2, 0);
  camera.updateMatrixWorld(true);

  player = new Player({
    camera, boxes, audio, hud, fov: 78,
    spawn: { x: worldInfo.spawn.x, z: worldInfo.spawn.z, yaw: worldInfo.spawn.yaw },
  });
  player.pos.y = boxes.floorAt(player.pos.x, player.pos.z, 50);
  player.spawnPoint.copy(player.pos);

  weapons = new WeaponSystem({
    camera, fx, audio, boxes, hud, assets, fov: 78,
    tuning: loadTuning(),
    environment: worldInfo.environment ? worldInfo.environment.texture : null,
  });
  weapons.setViewport(innerWidth / innerHeight, camera.fov);
  hud.setWeapon(weapons.current);
  hud.setAmmo(weapons.current.mag, weapons.current.reserve);

  const factory = new CharacterFactory(assets);
  enemies = new EnemyManager({
    scene, boxes, factory, assets, fx, audio, hud, player,
    weapons: WEAPON_DEFS,
    spawnPoints: worldInfo.enemySpawns,
  });
  enemies.onPlayerHit = () => hud.screenShake(0.03);

  civilians = new Civilians({ scene, boxes, factory, audio });
  civilians.spawn(26, worldInfo.npcSpawns);

  inspector = new Inspector({ camera, targets: builder.objects, maxDist: 700 });

  hud.setObjective(OBJECTIVE_MAIN);
  hud.setScore(0);

  setProgress(1, '就绪');
  await yieldFrame();
  loadEl.classList.add('done');
  setTimeout(() => { loadEl.style.display = 'none'; }, 700);

  enemies.spawnWave();
  audio.resume();
  audio.ambientStart();

  window.__THREE = THREE;
  window.__game = {
    scene, camera, renderer, player, weapons, enemies, civilians, boxes, worldInfo, stats,
    builder, tex, state, hud, post,
    setClock: (h) => jumpToTime(h),
    toggleTimePanel,
    toggleFly,
    flyMode: () => flyMode,
    inspect: () => inspectForward(false),
    lastInspect: () => lastInspect,
    render: () => {
      post.render(scene, camera, weapons.vmScene, weapons.vmCamera);
    },
  };
  console.log('[上海] 实例', stats.instances, '网格', stats.meshes, '三角面', stats.tris,
    '常驻(Instanced)', builder.instancedTris(), '贴图', tex.count, '显存≈', (tex.bytes / 1048576).toFixed(0) + 'MB',
    '调试占位贴图', tex.placeholderCount || 0);
  console.log('[上海] 三角面 TOP:', builder.topAssets(10)
    .map((t) => `${t.name.replace(/^.*_/, '').slice(0, 26)}x${t.n}=${(t.tris / 1000).toFixed(0)}k`).join(' '));
}

/* ---------------------------------------------------------- 输入 */
const keys = Object.create(null);
const input = { forward: 0, right: 0, jump: false, sprint: false, crouch: false, ads: false, adsZoom: 1 };
const shiftHeld = () => !!(keys['ShiftLeft'] || keys['ShiftRight']);
let mouseDown = false, rmbDown = false;

onkeydown = (e) => {
  const k = e.code;
  if (k === 'Space' || k === 'Tab') e.preventDefault();
  if (keys[k]) return;
  keys[k] = true;
  audio && audio.resume();
  if (!started) return;
  switch (k) {
    case 'KeyR': weapons.startReload(); break;
    case 'Digit1': weapons.selectSlot(0); break;
    case 'Digit2': weapons.selectSlot(1); break;
    case 'KeyQ': weapons.next(-1); break;
    case 'KeyE': weapons.next(1); break;
    case 'KeyM': state.showMap = !state.showMap; $('miniWrap').style.display = state.showMap ? '' : 'none'; break;
    case 'KeyH': document.body.classList.toggle('hidePanels'); break;
    case 'KeyK': toggleTimePanel(); break;
    case 'Minus': case 'NumpadSubtract': jumpToTime(state.clock - (shiftHeld() ? 1 / 6 : 1)); break;
    case 'Equal': case 'NumpadAdd': jumpToTime(state.clock + (shiftHeld() ? 1 / 6 : 1)); break;
    case 'KeyO': toggleTuner(); break;
    case 'KeyP': if (tunerOn) printTuning(); break;
    case 'KeyV': toggleFly(); break;
    case 'BracketLeft': if (tunerOn) tuneStep(-1); break;
    case 'BracketRight': if (tunerOn) tuneStep(1); break;
    case 'Comma': if (tunerOn) tuneSelect(-1); break;
    case 'Period': if (tunerOn) tuneSelect(1); break;
    case 'KeyF': player.respawn(); weapons.refill(); break;
    case 'KeyI': inspectForward(keys['ShiftLeft'] || keys['ShiftRight']); break;
    default: break;
  }
};
onkeyup = (e) => { keys[e.code] = false; };

renderer.domElement.addEventListener('mousedown', (e) => {
  audio && audio.resume();
  if (!started) return;
  if (e.button === 0) mouseDown = true;
  if (e.button === 2) rmbDown = true;
  if (document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
});
onmouseup = (e) => {
  if (e.button === 0) mouseDown = false;
  if (e.button === 2) rmbDown = false;
};
oncontextmenu = (e) => e.preventDefault();
onmousemove = (e) => {
  if (document.pointerLockElement !== renderer.domElement || !started) return;
  const adsScale = weapons && weapons.adsActive ? weapons.def.adsSens : 1;
  player.look(e.movementX || 0, e.movementY || 0, adsScale);
  if (weapons) {
    weapons.swayTarget.x = clamp(weapons.swayTarget.x + (e.movementX || 0) * 0.0016, -1, 1);
    weapons.swayTarget.y = clamp(weapons.swayTarget.y + (e.movementY || 0) * 0.0016, -1, 1);
  }
};
onwheel = (e) => { if (started && weapons) weapons.next(e.deltaY > 0 ? 1 : -1); };
onresize = () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  if (post) post.resize(innerWidth, innerHeight, renderer.getPixelRatio());
  if (weapons) weapons.setViewport(innerWidth / innerHeight, camera.fov);
};
renderer.domElement.addEventListener('click', () => {
  audio && audio.resume();
  if (started && document.pointerLockElement !== renderer.domElement) renderer.domElement.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  $('pauseHint').classList.toggle('on', started && !locked && !timePanelOpen);
  if (started) state.paused = !locked;
});

/* ---------------------------------------------------------- 面前资产识别 */
const fmtV = (v) => `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;

/** 世界静态资产 + 场上角色（角色会随波次刷新，每次识别时重新收集） */
function inspectTargets() {
  const list = builder ? builder.objects.slice() : [];
  if (enemies) for (const e of enemies.enemies) if (e.inst) list.push(e.inst.group);
  if (civilians) for (const c of civilians.list) list.push(c.inst.group);
  return list;
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {});
  } catch (e) { /* 无剪贴板权限时静默失败 */ }
}

/** 准星指向的模型 → 资产名（I 键；按住 Shift 时同时复制到剪贴板） */
function inspectForward(copy) {
  if (!inspector || !hud) return null;
  camera.updateMatrixWorld(true);
  const info = inspector.setTargets(inspectTargets()).pick(700);
  lastInspect = info;
  if (!info) {
    hud.toast('前方无可辨识物体', '把准星对准建筑 / 道具 / 载具 / 角色后再按 I');
    return null;
  }

  const title = info.kind === 'character' ? `角色 · ${info.label}` : info.label;
  const bits = [`${info.dist.toFixed(1)} m`, `命中点 ${fmtV(info.point)}`];
  if (info.kind === 'asset') {
    bits.push(info.instances > 1 ? `实例 #${info.instanceId ?? 0} / ${info.instances}` : '独立摆放');
    bits.push(`原点 ${fmtV(info.origin)}`);
  }
  if (copy) { copyText(info.name); bits.push('已复制到剪贴板'); }
  hud.toast(title, bits.join('　'), copy ? 4.4 : 3.4);

  console.log('[资产识别]', info.name, {
    文件: info.file || '(角色)',
    距离: +info.dist.toFixed(2),
    命中点: [+info.point.x.toFixed(2), +info.point.y.toFixed(2), +info.point.z.toFixed(2)],
    摆放原点: [+info.origin.x.toFixed(2), +info.origin.y.toFixed(2), +info.origin.z.toFixed(2)],
    实例: info.instanceId,
    实例总数: info.instances,
  });
  return info;
}

/* ---------------------------------------------------------- 自由飞行模式 */
let flyMode = false;
const FLY_BASE = 40;          // 巡航速度 m/s
const FLY_FAST = 120;         // Shift 加速
const FLY_SMOOTH = 9;         // 速度跟随阻尼，越大越跟手
const FLY_LIMIT = { xz: 1400, yMin: -25, yMax: 1200 };

const _flyV = new THREE.Vector3();
const _flyWant = new THREE.Vector3();
const _flyDir = new THREE.Vector3();
const _flyRight = new THREE.Vector3();
const _flyUp = new THREE.Vector3(0, 1, 0);

function toggleFly(on) {
  flyMode = on === undefined ? !flyMode : !!on;
  document.body.classList.toggle('flyMode', flyMode);
  if (flyMode) {
    if (player.dead) player.respawn();
    _flyV.set(0, 0, 0);
    player.vel.set(0, 0, 0);
    player.onGround = true;
    hud.setObjective('模式：自由飞行　·　V 返回地面');
    hud.toast('自由飞行模式', 'WASD 沿视线飞行　空格 上升　Ctrl / C 下降　Shift 加速', 4.6);
  } else {
    const p = camera.position;
    player.pos.set(p.x, boxes.floorAt(p.x, p.z, 400), p.z);
    player.vel.set(0, 0, 0);
    player.onGround = true;
    player.crouch = 0;
    player.noDamage = false;
    _flyV.set(0, 0, 0);
    hud.setObjective(OBJECTIVE_MAIN);
    hud.toast('回到地面', 'WASD 移动　按 V 可再次起飞', 2.8);
  }
}

/** 飞行模式下的相机推进（无重力、无碰撞） */
function updateFly(dt) {
  const p = player;
  const speed = input.sprint ? FLY_FAST : FLY_BASE;

  // 与地面模式共用一套 yaw / pitch，鼠标转视角手感一致
  camera.rotation.set(p.pitch, p.yaw, 0, 'YXZ');
  camera.updateMatrixWorld(true);

  camera.getWorldDirection(_flyDir);
  _flyRight.crossVectors(_flyDir, _flyUp);
  if (_flyRight.lengthSq() < 1e-8) _flyRight.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
  _flyRight.normalize();

  let up = 0;
  if (keys['Space']) up += 1;
  if (keys['ControlLeft'] || keys['ControlRight'] || keys['KeyC']) up -= 1;

  _flyWant.set(0, 0, 0)
    .addScaledVector(_flyDir, input.forward * speed)
    .addScaledVector(_flyRight, input.right * speed)
    .addScaledVector(_flyUp, up * speed * 0.75);
  _flyV.lerp(_flyWant, 1 - Math.exp(-FLY_SMOOTH * dt));
  camera.position.addScaledVector(_flyV, dt);

  // 别飞出世界
  camera.position.x = clamp(camera.position.x, -FLY_LIMIT.xz, FLY_LIMIT.xz);
  camera.position.z = clamp(camera.position.z, -FLY_LIMIT.xz, FLY_LIMIT.xz);
  camera.position.y = clamp(camera.position.y, FLY_LIMIT.yMin, FLY_LIMIT.yMax);

  // 同步玩家状态：小地图 / 阳光阴影 / HUD 坐标都跟着相机走
  p.pos.set(camera.position.x, camera.position.y - p.cfg.eyeStand, camera.position.z);
  p.vel.set(0, 0, 0);
  p.speed = _flyV.length();
  p.onGround = true;
  p.crouch = 0;

  // 速度感：高速时轻微拉 FOV
  const fast = clamp((_flyV.length() - FLY_BASE) / (FLY_FAST - FLY_BASE), 0, 1);
  const fovT = p.fovBase * (1 + fast * 0.12);
  camera.fov += (fovT - camera.fov) * (1 - Math.exp(-6 * dt));
  camera.updateProjectionMatrix();
}

/* ---------------------------------------------------------- 时间跳转 */
const timeBox = $('timeBox'), timeRange = $('timeRange'), timeVal = $('timeVal');
let timePanelOpen = false;

const fmtClock = (t) => {
  const h = Math.floor(t) % 24, m = Math.floor((t % 1) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};

/** 直接跳到某个时刻（小时，0..24），并立刻刷新天空/光照/雾 */
function jumpToTime(h, quiet) {
  const v = ((+h % 24) + 24) % 24;
  if (!Number.isFinite(v)) return;
  state.clock = v;
  if (worldInfo) updateSky(0);
  if (timePanelOpen) syncTimePanel();
  if (!quiet && hud) hud.toast('时间 → ' + fmtClock(v), '按 K 打开时间面板可跳到任意时刻');
}

function syncTimePanel() {
  if (timeRange) timeRange.value = String(Math.round(state.clock * 4) / 4);   // 对齐 15 分钟步进
  if (timeVal) timeVal.textContent = fmtClock(state.clock);
}

function requestLock() {
  if (!started) return;
  try {
    const r = renderer.domElement.requestPointerLock();
    if (r && r.catch) r.catch(() => {});
  } catch (e) { /* 冷却期内会被拒绝，点击画面即可重新锁定 */ }
}

function toggleTimePanel(on) {
  timePanelOpen = on === undefined ? !timePanelOpen : !!on;
  if (!timeBox) return;
  timeBox.classList.toggle('on', timePanelOpen);
  if (timePanelOpen) {
    syncTimePanel();
    if (document.pointerLockElement) document.exitPointerLock();   // 让出鼠标以便拖动滑块
  } else {
    requestLock();
  }
}

if (timeRange) {
  timeRange.addEventListener('input', () => jumpToTime(parseFloat(timeRange.value), true));
}
for (const b of document.querySelectorAll('#timeBox button[data-t]')) {
  b.addEventListener('click', () => jumpToTime(parseFloat(b.dataset.t), true));
}

/* ---------------------------------------------------------- 手持模型调参 */
let tunerOn = false;
let tuneIdx = 0;
const TUNE_KEYS = ['px', 'py', 'pz', 'rx', 'ry', 'rz'];
const TUNE_GROUPS = [['scar', '基准'], ['scar_ads', '开镜'], ['ump', '基准'], ['ump_ads', '开镜']];
let tuning = null;

function loadTuning() {
  const blank = {};
  for (const [g] of TUNE_GROUPS) blank[g] = { px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 };
  try {
    const s = localStorage.getItem('bf4_sh_tuning');
    if (s) {
      const v = JSON.parse(s);
      for (const [g] of TUNE_GROUPS) if (v[g]) Object.assign(blank[g], v[g]);
    }
  } catch (e) { /* ignore */ }
  tuning = blank;
  return blank;
}
function toggleTuner() {
  tunerOn = !tunerOn;
  $('tuner').classList.toggle('on', tunerOn);
  updateTunerUI();
}
function tuneSelect(d) {
  tuneIdx = (tuneIdx + d + TUNE_GROUPS.length * TUNE_KEYS.length) % (TUNE_GROUPS.length * TUNE_KEYS.length);
  updateTunerUI();
}
function tuneStep(d) {
  const gi = Math.floor(tuneIdx / TUNE_KEYS.length) % TUNE_GROUPS.length;
  const ki = tuneIdx % TUNE_KEYS.length;
  const g = TUNE_GROUPS[gi][0], k = TUNE_KEYS[ki];
  const scale = keys['ShiftLeft'] || keys['ShiftRight'] ? 10 : 1;
  const stepSize = (k[0] === 'r' ? 0.01 : 0.005) * scale * d;
  tuning[g][k] = +(tuning[g][k] + stepSize).toFixed(4);
  localStorage.setItem('bf4_sh_tuning', JSON.stringify(tuning));
  updateTunerUI();
}
function updateTunerUI() {
  const gi = Math.floor(tuneIdx / TUNE_KEYS.length) % TUNE_GROUPS.length;
  const ki = tuneIdx % TUNE_KEYS.length;
  const g = TUNE_GROUPS[gi][0], k = TUNE_KEYS[ki];
  const el = $('tunerBody');
  if (el) {
    el.innerHTML = TUNE_GROUPS.map((grp, i) =>
      `<div class="tr ${i === gi ? 'sel' : ''}"><b>${grp[0]}</b> ${grp[1]}</div>`).join('')
      + `<div class="val">当前：<b>${g}.${k}</b> = ${tuning[g][k].toFixed(4)}</div>`;
  }
}
function printTuning() {
  console.log('手持模型调参：', JSON.stringify(tuning));
}

/* ---------------------------------------------------------- 天空与光照 */
const _sunDir = new THREE.Vector3();
const _vmSun = new THREE.Vector3();
const _camQ = new THREE.Quaternion();
const _vmSunCol = new THREE.Color();
const _vmSkyCol = new THREE.Color();
const _vmGndCol = new THREE.Color();
const VM_FILL_NEUTRAL = new THREE.Color(0xffffff);
function updateSky(dt) {
  if (!timePanelOpen) state.clock = (state.clock + dt * state.timeFlow) % 24;   // 调整时间面板打开时定格
  const dir = sunDirAt(state.clock);
  _sunDir.copy(dir);
  const st = skyStateAt(dir.y);
  const U = worldInfo.skyU;
  U.top.value.set(st.top); U.mid.value.set(st.mid); U.bot.value.set(st.bot);
  U.sunCol.value.set(st.sun); U.sunDir.value.copy(dir);
  U.sunI.value = 1;
  U.cloudTime.value.x += dt * 0.0014;
  U.cloudTime.value.y += dt * 0.00045;

  const sun = worldInfo.sun;
  sun.position.copy(dir).multiplyScalar(260).add(player.pos);
  sun.target.position.copy(player.pos);
  sun.target.updateMatrixWorld();
  sun.color.set(st.sun);
  sun.intensity = st.dir * 1.15;
  worldInfo.hemi.intensity = st.hemi;
  worldInfo.amb.intensity = st.amb;
  scene.fog.color.setHex(st.fog);
  renderer.toneMappingExposure = st.exp;

  // 夜间自发光
  const night = clamp(1 - smoothstep(-0.06, 0.20, dir.y), 0, 1);
  if (!window.__glowSet || Math.abs(window.__glowNight - night) > 0.01) {
    window.__glowNight = night;
    for (const m of glowMats) m.emissiveIntensity = night * 1.5 * (m.userData.glow || 1);
  }
  post && post.setNight(night);
  // 曝光由后期链自己做（渲染到离屏目标时 renderer 的 toneMapping/曝光不生效）
  post && post.setExposure(st.exp);
  scene.environmentIntensity = 0.82 + (1 - night) * 0.22;

  // 手持模型跟随场景光照：太阳色/方向 + 天空补光 + 环境反射强度
  if (weapons) {
    camera.getWorldQuaternion(_camQ).invert();
    _vmSun.copy(_sunDir).applyQuaternion(_camQ);
    // 相机看向 -Z：夹住 z 让光源始终略微在身前，转身背对太阳时枪面不会全黑
    if (_vmSun.z > -0.2) _vmSun.z = -0.2;
    _vmSun.normalize();
    weapons.setSkyLighting({
      sunColor: _vmSunCol.set(st.sun),
      sunDir: _vmSun,
      sunIntensity: 1.0 + st.dir * 0.75,
      // 纯天空色当补光会把暗色枪身染成蓝灰，向白去饱和后再用
      skyColor: _vmSkyCol.set(st.top).lerp(VM_FILL_NEUTRAL, 0.6),
      groundColor: _vmGndCol.set(st.bot).lerp(VM_FILL_NEUTRAL, 0.4),
      fillIntensity: 0.45 + st.hemi * 0.6,
      envIntensity: scene.environmentIntensity,
    });
  }
  if (worldInfo.cityLights) {
    for (const it of worldInfo.cityLights) {
      it.light.intensity = night * it.base;
      it.bulb.material.color.copy(it.color).multiplyScalar(0.08 + night * 1.45);
    }
  }

  // 远景建筑融入雾色
  const haze = new THREE.Color(st.bot).lerp(new THREE.Color(st.mid), 0.35);
  for (const m of bgMats) m.color.copy(haze).lerp(new THREE.Color(0xffffff), 0.45);
}

/* ---------------------------------------------------------- 主循环 */
let last = performance.now();
let fpsAcc = 0, fpsN = 0, fps = 60;
let tSec = 0;

function frame() {
  requestAnimationFrame(frame);
  const now = performance.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.1) dt = 0.1;
  fpsAcc += dt; fpsN++;
  if (fpsAcc > 0.5) { fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; }
  tSec += dt;

  if (!started) {
    if (post) post.render(scene, camera);
    else { renderer.clear(); renderer.render(scene, camera); }
    return;
  }

  const frozen = state.paused || (player.dead && !flyMode);

  // ---- 输入映射
  input.forward = (keys['KeyW'] ? 1 : 0) - (keys['KeyS'] ? 1 : 0);
  input.right = (keys['KeyD'] ? 1 : 0) - (keys['KeyA'] ? 1 : 0);
  input.sprint = !!(keys['ShiftLeft'] || keys['ShiftRight']);
  input.crouch = !!(keys['ControlLeft'] || keys['KeyC']);
  input.jump = !!keys['Space'];
  input.ads = rmbDown && !weapons.isReloading;
  input.adsZoom = input.ads ? weapons.def.adsZoom : 1;

  if (!frozen) {
    if (flyMode) updateFly(dt);
    else player.update(dt, input);
    camera.updateMatrixWorld(true);
    weapons.setTrigger(mouseDown);
    weapons.update(dt, {
      time: tSec,
      speed: player.speed,
      onGround: player.onGround,
      crouch: player.crouch > 0.4,
      ads: input.ads,
      sprint: input.sprint,
      raycastEnemies: (o, d, m) => enemies.raycastEnemies(o, d, m),
      addRecoil: (p, y) => player.addRecoil(p, y),
      onShot: (def) => { player.shake(0.006); },
      playerPos: player.pos,
    });
    enemies.update(dt);
    civilians.update(dt, player);
  }

  fx.update(dt);
  audio.ambientUpdate(dt);
  if (worldInfo.waterNormal) {
    worldInfo.waterNormal.offset.x += dt * 0.006;
    worldInfo.waterNormal.offset.y += dt * 0.004;
  }
  updateSky(dt);
  hud.update(dt, {
    player, weapon: weapons, enemies: enemies.enemies,
    fps, clock: state.clock, ads: weapons.adsActive,
  });

  // ---- 渲染：世界 + 第一人称武器一起进线性 HDR，再走完整后期链
  post.render(scene, camera, weapons.vmScene, weapons.vmCamera);
}

/* ---------------------------------------------------------- 启动 */
boot().then(() => {
  started = true;
  last = performance.now();
  frame();
}).catch((e) => {
  console.error(e);
  loadTxt.textContent = '启动失败：' + (e && e.message ? e.message : e);
  loadTxt.style.color = '#ff8b7a';
});
