import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ===========================================================================
   NEON RACER
   An endless synthwave run built around a live vapor-wake particle system.
   =========================================================================== */

const $ = (id) => document.getElementById(id);
const dom = {
  root: $('game-root'),
  hud: $('hud'),
  score: $('score'),
  best: $('best'),
  boostFill: $('boostFill'),
  boostPct: $('boostPct'),
  hull: $('hull'),
  hullText: $('hullText'),
  speed: $('speed'),
  speedFill: $('speedFill'),
  distance: $('distance'),
  sector: $('sector'),
  driveMode: $('driveMode'),
  toast: $('toast'),
  boostFx: $('boostFx'),
  hitFlash: $('hitFlash'),
  soundBtn: $('soundBtn'),
  pauseBtn: $('pauseBtn'),
  menu: $('menuScreen'),
  startBtn: $('startBtn'),
  bootStatus: $('bootStatus'),
  menuBest: $('menuBest'),
  pauseScreen: $('pauseScreen'),
  resumeBtn: $('resumeBtn'),
  overScreen: $('overScreen'),
  finalScore: $('finalScore'),
  finalDistance: $('finalDistance'),
  finalSpeed: $('finalSpeed'),
  newBest: $('newBest'),
  restartBtn: $('restartBtn'),
  countdown: $('countdown'),
  countdownNum: $('countdownNum'),
  touchControls: $('touchControls'),
  touchLeft: $('touchLeft'),
  touchRight: $('touchRight'),
  touchBrake: $('touchBrake'),
  touchBoost: $('touchBoost'),
  errorScreen: $('errorScreen'),
};

const TAU = Math.PI * 2;
const LANES = [-9, -3, 3, 9];
const ROAD_HALF = 12.4;
const SHIP_Z_MIN = -1.45;
const SHIP_Z_MAX = 1.35;
const MAX_SPEED_UNITS = 74;
const SPEED_TO_KMH = 5.55;
const STORAGE_KEY = 'neon-racer.vapor.best.v1';
const IS_TOUCH = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
const REDUCED_MOTION = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const lerp = (a, b, t) => a + (b - a) * t;
const damp = (current, target, lambda, dt) => lerp(current, target, 1 - Math.exp(-lambda * dt));
const randomRange = (min, max) => min + Math.random() * (max - min);
const padScore = (n) => String(Math.max(0, Math.floor(n))).padStart(6, '0');
const scoreMarkup = (n) => {
  const padded = padScore(n);
  let split = 0;
  while (split < padded.length - 1 && padded[split] === '0') split += 1;
  return `<span class="digit-muted">${padded.slice(0, split)}</span>${padded.slice(split)}`;
};
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function loadBest() {
  try {
    const value = parseInt(window.localStorage.getItem(STORAGE_KEY), 10);
    return Number.isFinite(value) ? value : 0;
  } catch (error) {
    return 0;
  }
}

function storeBest(value) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(Math.floor(value)));
  } catch (error) {
    /* Private browsing can refuse storage; the run still works. */
  }
}

/* ===========================================================================
   AUDIO — synthesized engine, wind and interface blips
   =========================================================================== */

class RacerAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.engineGain = null;
    this.engineFilter = null;
    this.windGain = null;
    this.oscA = null;
    this.oscB = null;
    this.oscC = null;
    this.noiseBuffer = null;
    this.windSource = null;
    this.enabled = true;
    this.engineOn = false;
  }

  init() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }

    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return;

    try {
      this.ctx = new AudioCtor();
      const now = this.ctx.currentTime;

      this.master = this.ctx.createGain();
      this.master.gain.setValueAtTime(this.enabled ? 0.42 : 0, now);
      this.master.connect(this.ctx.destination);

      this.engineFilter = this.ctx.createBiquadFilter();
      this.engineFilter.type = 'lowpass';
      this.engineFilter.frequency.setValueAtTime(430, now);
      this.engineFilter.Q.setValueAtTime(2.2, now);

      this.engineGain = this.ctx.createGain();
      this.engineGain.gain.setValueAtTime(0.0001, now);
      this.engineFilter.connect(this.engineGain);
      this.engineGain.connect(this.master);

      const makeOsc = (type, freq, gain) => {
        const osc = this.ctx.createOscillator();
        const g = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);
        g.gain.setValueAtTime(gain, now);
        osc.connect(g);
        g.connect(this.engineFilter);
        osc.start();
        return osc;
      };

      this.oscA = makeOsc('sawtooth', 44, 0.16);
      this.oscB = makeOsc('sawtooth', 67, 0.08);
      this.oscC = makeOsc('triangle', 27, 0.24);

      this.noiseBuffer = this.makeNoiseBuffer(2.5);
      const wind = this.ctx.createBufferSource();
      wind.buffer = this.noiseBuffer;
      wind.loop = true;
      const windFilter = this.ctx.createBiquadFilter();
      windFilter.type = 'bandpass';
      windFilter.frequency.setValueAtTime(1150, now);
      windFilter.Q.setValueAtTime(0.55, now);
      this.windGain = this.ctx.createGain();
      this.windGain.gain.setValueAtTime(0.0001, now);
      wind.connect(windFilter);
      windFilter.connect(this.windGain);
      this.windGain.connect(this.master);
      wind.start();
      this.windSource = wind;

      if (this.engineOn) this.setEngine(true, 0.2, false);
    } catch (error) {
      this.ctx = null;
    }
  }

  makeNoiseBuffer(seconds) {
    const rate = this.ctx.sampleRate;
    const buffer = this.ctx.createBuffer(1, rate * seconds, rate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    return buffer;
  }

  toggle() {
    this.enabled = !this.enabled;
    if (this.ctx && this.master) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.enabled ? 0.42 : 0, now, 0.04);
      if (this.enabled && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    }
    return this.enabled;
  }

  startEngine() {
    this.init();
    this.engineOn = true;
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    const now = this.ctx.currentTime;
    this.engineGain.gain.cancelScheduledValues(now);
    this.engineGain.gain.setTargetAtTime(0.09, now, 0.35);
    this.windGain.gain.setTargetAtTime(0.025, now, 0.5);
  }

  stopEngine(fade = 0.8) {
    this.engineOn = false;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.engineGain.gain.cancelScheduledValues(now);
    this.engineGain.gain.setTargetAtTime(0.0001, now, fade * 0.32);
    this.windGain.gain.cancelScheduledValues(now);
    this.windGain.gain.setTargetAtTime(0.0001, now, fade * 0.32);
  }

  duck(paused) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.engineGain.gain.cancelScheduledValues(now);
    this.engineGain.gain.setTargetAtTime(paused ? 0.0001 : (this.engineOn ? 0.09 : 0.0001), now, 0.12);
    this.windGain.gain.setTargetAtTime(paused ? 0.0001 : 0.018, now, 0.12);
  }

  setEngine(speedNorm, boosting) {
    if (!this.ctx || !this.engineOn) return;
    const now = this.ctx.currentTime;
    const clamped = clamp(speedNorm, 0, 1.4);
    this.oscA.frequency.setTargetAtTime(38 + clamped * 52, now, 0.1);
    this.oscB.frequency.setTargetAtTime(56 + clamped * 78, now, 0.1);
    this.oscC.frequency.setTargetAtTime(24 + clamped * 27, now, 0.12);
    this.engineFilter.frequency.setTargetAtTime(260 + clamped * 760 + (boosting ? 420 : 0), now, 0.12);
    this.windGain.gain.setTargetAtTime(0.008 + clamped * 0.03 + (boosting ? 0.018 : 0), now, 0.16);
    this.engineGain.gain.setTargetAtTime(0.062 + clamped * 0.058 + (boosting ? 0.026 : 0), now, 0.18);
  }

  beep(freq = 640, duration = 0.1, type = 'square', volume = 0.08) {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.03);
  }

  countdownTick(final = false) {
    this.beep(final ? 1040 : 520, final ? 0.36 : 0.1, final ? 'triangle' : 'square', final ? 0.12 : 0.065);
    if (final) {
      setTimeout(() => this.beep(1560, 0.28, 'sine', 0.07), 70);
    }
  }

  pickup() {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    [880, 1320, 1760].forEach((freq, index) => {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + index * 0.045);
      gain.gain.setValueAtTime(0.0001, now + index * 0.045);
      gain.gain.exponentialRampToValueAtTime(0.075 / (index + 1), now + index * 0.045 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + index * 0.045 + 0.2);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now + index * 0.045);
      osc.stop(now + index * 0.045 + 0.24);
    });
  }

  boostIgnite() {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    osc.type = 'sawtooth';
    filter.type = 'bandpass';
    filter.Q.setValueAtTime(3.2, now);
    filter.frequency.setValueAtTime(500, now);
    filter.frequency.exponentialRampToValueAtTime(2200, now + 0.36);
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(410, now + 0.34);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.46);
  }

  hit() {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;

    const noise = this.ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    const low = this.ctx.createBiquadFilter();
    low.type = 'lowpass';
    low.frequency.setValueAtTime(1700, now);
    low.frequency.exponentialRampToValueAtTime(130, now + 0.54);
    const nGain = this.ctx.createGain();
    nGain.gain.setValueAtTime(0.28, now);
    nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);
    noise.connect(low);
    low.connect(nGain);
    nGain.connect(this.master);
    noise.start(now);
    noise.stop(now + 0.62);

    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150, now);
    osc.frequency.exponentialRampToValueAtTime(34, now + 0.5);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.52);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + 0.56);
  }
}

/* ===========================================================================
   TEXTURES
   =========================================================================== */

function makeRadialTexture(stops) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  stops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

const GLOW_TEXTURE = makeRadialTexture([
  [0, 'rgba(255,255,255,1)'],
  [0.16, 'rgba(255,255,255,0.85)'],
  [0.42, 'rgba(255,255,255,0.26)'],
  [1, 'rgba(255,255,255,0)'],
]);

const SHADOW_TEXTURE = makeRadialTexture([
  [0, 'rgba(0,0,0,0.9)'],
  [0.5, 'rgba(0,0,0,0.45)'],
  [1, 'rgba(0,0,0,0)'],
]);

function makeNeonSignTexture(label, accent = '#16f4ff', sub = 'NIGHT DISTRICT') {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 320;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = accent;
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 5;
  ctx.strokeRect(18, 18, canvas.width - 36, canvas.height - 36);
  ctx.globalAlpha = 0.4;
  ctx.lineWidth = 1;
  ctx.strokeRect(33, 33, canvas.width - 66, canvas.height - 66);

  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = accent;
  ctx.shadowBlur = 30;
  ctx.fillStyle = '#f4feff';
  ctx.font = '900 122px Orbitron, Arial Black, sans-serif';
  ctx.fillText(label, canvas.width / 2, 150);

  ctx.shadowBlur = 14;
  ctx.fillStyle = accent;
  ctx.font = '600 27px Rajdhani, Arial Narrow, sans-serif';
  ctx.letterSpacing = '8px';
  ctx.fillText(sub, canvas.width / 2, 239);

  ctx.shadowBlur = 0;
  ctx.globalAlpha = 0.28;
  ctx.fillStyle = '#05010c';
  for (let y = 0; y < canvas.height; y += 5) {
    ctx.fillRect(0, y, canvas.width, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/* ===========================================================================
   RENDERER / SCENE
   =========================================================================== */

let renderer;
let scene;
let camera;
let composer;
let bloomPass;

const gameRoot = dom.root;

try {
  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
    alpha: false,
  });
} catch (error) {
  dom.errorScreen.hidden = false;
  throw error;
}

const pixelRatio = Math.min(window.devicePixelRatio || 1, IS_TOUCH ? 1.6 : 1.8);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.88;
renderer.setClearColor(0x030008, 1);
renderer.domElement.setAttribute('aria-hidden', 'true');
gameRoot.appendChild(renderer.domElement);

scene = new THREE.Scene();
scene.background = new THREE.Color(0x030008);
scene.fog = new THREE.Fog(0x08021a, 70, 300);

camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 900);
camera.position.set(0, 3.22, 8.6);
camera.lookAt(0, 1.32, -20);
scene.add(camera);

composer = new EffectComposer(renderer);
composer.setPixelRatio(pixelRatio);
composer.setSize(window.innerWidth, window.innerHeight);
const renderPass = new RenderPass(scene, camera);
bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  0.52,
  0.36,
  0.82,
);
composer.addPass(renderPass);
composer.addPass(bloomPass);
composer.addPass(new OutputPass());

const clock = new THREE.Clock();
const elapsed = { value: 0 };
const worldScroll = { value: 0 };

const fogColor = new THREE.Color(0x08021a);
const cyanColor = new THREE.Color(0x16f4ff);
const magentaColor = new THREE.Color(0xff2bd6);
const violetColor = new THREE.Color(0x7a4dff);
const amberColor = new THREE.Color(0xffd166);
const dangerColor = new THREE.Color(0xff3366);

/* ===========================================================================
   SKY / SUN / STARS
   =========================================================================== */

const skyUniforms = {
  uHigh: { value: new THREE.Color(0x020007) },
  uMid: { value: new THREE.Color(0x0b0321) },
  uHorizon: { value: new THREE.Color(0x2a062f) },
  uGlow: { value: new THREE.Color(0x8a135f) },
};

const sky = new THREE.Mesh(
  new THREE.SphereGeometry(460, 36, 24),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uHigh;
      uniform vec3 uMid;
      uniform vec3 uHorizon;
      uniform vec3 uGlow;
      varying vec3 vDir;
      void main() {
        float h = normalize(vDir).y;
        float up = smoothstep(-0.03, 0.24, h);
        float top = smoothstep(0.18, 0.8, h);
        vec3 col = mix(uHorizon, uMid, up);
        col = mix(col, uHigh, top);
        float band = pow(clamp(1.0 - abs(h + 0.018), 0.0, 1.0), 18.0);
        col += uGlow * band * 0.8;
        col += uGlow * pow(clamp(1.0 - h, 0.0, 1.0), 4.0) * 0.12;
        float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        col += (dither - 0.5) * 0.004;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }),
);
sky.renderOrder = -20;
sky.frustumCulled = false;
scene.add(sky);

const sunUniforms = {
  uTop: { value: new THREE.Color(0xffb347).multiplyScalar(1.12) },
  uBottom: { value: new THREE.Color(0xff1f7a).multiplyScalar(1.0) },
  uHalo: { value: new THREE.Color(0xff3a7a).multiplyScalar(0.6) },
  uTime: elapsed,
};

const sun = new THREE.Mesh(
  new THREE.PlaneGeometry(124, 124),
  new THREE.ShaderMaterial({
    uniforms: sunUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: false,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uBottom;
      uniform vec3 uHalo;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float d = length(p);
        float disc = 1.0 - smoothstep(0.965, 1.0, d);
        float rows = 22.0;
        float stripe = step(0.2, fract((1.0 - vUv.y) * rows + 0.15));
        float stripeMask = mix(1.0, stripe, smoothstep(0.86, 0.35, vUv.y));
        float alpha = disc * stripeMask;
        vec3 col = mix(uBottom, uTop, pow(vUv.y, 0.78));
        col *= 0.92 + 0.08 * sin(vUv.x * 96.0 + uTime * 0.15);
        float halo = exp(-max(d - 1.0, 0.0) * 5.5) * (1.0 - smoothstep(1.0, 1.75, d));
        vec3 outCol = col + uHalo * halo * 0.55;
        float outAlpha = alpha * 0.94 + halo * 0.16;
        gl_FragColor = vec4(outCol, outAlpha * 0.8);
      }
    `,
  }),
);
sun.position.set(-82, 60, -360);
sun.renderOrder = -8;
scene.add(sun);

function createStars() {
  const count = 760;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const palette = [new THREE.Color(0xffffff), new THREE.Color(0xa7f9ff), new THREE.Color(0xffb7f2), new THREE.Color(0x8a9dff)];

  for (let i = 0; i < count; i += 1) {
    const spread = randomRange(50, 430);
    const angle = randomRange(0, TAU);
    positions[i * 3] = Math.cos(angle) * spread;
    positions[i * 3 + 1] = randomRange(22, 220);
    positions[i * 3 + 2] = -randomRange(40, 390);
    const color = palette[Math.floor(Math.random() * palette.length)].clone();
    color.multiplyScalar(randomRange(0.35, 1.0));
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({
    size: 1.5,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = -12;
  scene.add(points);
}
createStars();

/* ===========================================================================
   LIGHTING
   =========================================================================== */

scene.add(new THREE.AmbientLight(0x352456, 0.55));
scene.add(new THREE.HemisphereLight(0x2a5cff, 0x250016, 0.72));

const keyLight = new THREE.DirectionalLight(0x8feaff, 2.7);
keyLight.position.set(-7, 12, 5);
scene.add(keyLight);

const rimLight = new THREE.DirectionalLight(0xff3ac8, 2.7);
rimLight.position.set(7, 5, 9);
scene.add(rimLight);

const lowLight = new THREE.PointLight(0x18dfff, 7, 30, 2);
lowLight.position.set(0, 1.2, 5);
scene.add(lowLight);

/* ===========================================================================
   NEON FLOOR / ROAD
   =========================================================================== */

const roadUniforms = {
  uScroll: worldScroll,
  uTime: elapsed,
  uFog: { value: fogColor },
  uCyan: { value: cyanColor },
  uMagenta: { value: magentaColor },
  uViolet: { value: violetColor },
};

const road = new THREE.Mesh(
  new THREE.PlaneGeometry(ROAD_HALF * 2 + 0.8, 520, 1, 1),
  new THREE.ShaderMaterial({
    uniforms: roadUniforms,
    depthWrite: true,
    fog: false,
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform float uScroll;
      uniform float uTime;
      uniform vec3 uFog;
      uniform vec3 uCyan;
      uniform vec3 uMagenta;
      uniform vec3 uViolet;
      varying vec3 vWorld;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      void main() {
        vec3 p = vWorld;
        float x = p.x;
        float dist = distance(p, cameraPosition);

        vec3 col = vec3(0.008, 0.006, 0.027);
        float roadMask = smoothstep(12.55, 11.9, abs(x));

        // long specular wash toward the horizon
        vec3 horizon = vec3(0.24, 0.025, 0.22);
        float wash = smoothstep(-330.0, 12.0, p.z) * exp(-abs(x) * 0.105);
        col += horizon * wash * 0.085;
        col += uViolet * smoothstep(-290.0, 0.0, p.z) * 0.018;

        // dark panel seams across the lane surface
        float panelZ = (p.z - uScroll * 0.25) / 36.0;
        float panelLine = 1.0 - smoothstep(0.0, 0.02 + fwidth(panelZ) * 1.2, abs(fract(panelZ + 0.5) - 0.5));
        col += vec3(0.08, 0.12, 0.22) * panelLine * 0.03;

        // cross-grid light strips rushing toward the camera
        float zc = (p.z - uScroll) / 9.0;
        float lineZ = 1.0 - smoothstep(0.0, 0.018 + fwidth(zc) * 1.3, abs(fract(zc + 0.5) - 0.5));
        col += mix(uCyan, uMagenta, 0.35) * lineZ * 0.075 * smoothstep(0.0, 12.0, abs(x) * 0.5 + 2.0);

        // lane boundaries
        float lc = x / 6.0;
        float laneAA = fwidth(lc) * 1.1;
        float laneLine = 1.0 - smoothstep(0.012, 0.012 + laneAA, abs(fract(lc + 0.5) - 0.5));
        col += uCyan * laneLine * 0.045 * smoothstep(12.0, 10.6, abs(x));

        // hot outer rails
        float edgeDist = abs(abs(x) - 12.27);
        float edge = 1.0 - smoothstep(0.02, 0.075 + fwidth(x) * 0.8, edgeDist);
        float bloomEdge = exp(-edgeDist * 7.5);
        vec3 sideTint = mix(uCyan, uMagenta, smoothstep(-11.0, 11.0, x));
        col += sideTint * (edge * 0.74 + bloomEdge * 0.09);

        // faint reflected dashes in the wet tarmac
        float dash = step(0.58, fract((p.z - uScroll * 1.45) / 21.0));
        float dashLine = 1.0 - smoothstep(0.0, 0.02 + fwidth(zc) * 1.1, abs(fract(lc + 0.5) - 0.5));
        col += uMagenta * dash * dashLine * 0.03;

        // distance fade + edge-of-world fade
        float fog = smoothstep(60.0, 285.0, dist);
        col = mix(col, uFog, fog);
        col *= mix(0.66, 1.0, roadMask);

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }),
);
road.rotation.x = -Math.PI / 2;
road.position.set(0, 0, -218);
scene.add(road);

const floorUniforms = {
  uScroll: worldScroll,
  uFog: { value: fogColor },
  uCyan: { value: cyanColor },
  uMagenta: { value: magentaColor },
};

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(620, 620, 1, 1),
  new THREE.ShaderMaterial({
    uniforms: floorUniforms,
    fog: false,
    depthWrite: true,
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform float uScroll;
      uniform vec3 uFog;
      uniform vec3 uCyan;
      uniform vec3 uMagenta;
      varying vec3 vWorld;
      void main() {
        vec3 p = vWorld;
        float dist = distance(p, cameraPosition);
        vec3 col = vec3(0.004, 0.003, 0.014);

        vec2 g = vec2(p.x / 13.0, (p.z - uScroll) / 13.0);
        vec2 cell = abs(fract(g + 0.5) - 0.5);
        float aa = max(fwidth(g.x), fwidth(g.y)) * 1.2;
        float grid = (1.0 - smoothstep(0.0, 0.016 + aa, cell.x)) + (1.0 - smoothstep(0.0, 0.016 + aa, cell.y));
        float near = 1.0 - smoothstep(30.0, 230.0, dist);
        col += uCyan * grid * 0.028 * near;
        col += uMagenta * exp(-abs(p.x) * 0.012) * 0.01 * smoothstep(-300.0, 30.0, p.z);

        float fog = smoothstep(40.0, 260.0, dist);
        col = mix(col, uFog, fog);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.set(0, -0.075, -230);
scene.add(ground);

const neonBasic = (hex, intensity = 2.1) => new THREE.MeshBasicMaterial({
  color: new THREE.Color(hex).multiplyScalar(intensity),
  fog: true,
});

const edgeRailGeo = new THREE.BoxGeometry(0.075, 0.075, 485);
const leftRail = new THREE.Mesh(edgeRailGeo, neonBasic(0x16f4ff, 1.35));
leftRail.position.set(-12.42, 0.11, -210);
scene.add(leftRail);
const rightRail = new THREE.Mesh(edgeRailGeo, neonBasic(0xff2bd6, 1.25));
rightRail.position.set(12.42, 0.11, -210);
scene.add(rightRail);

/* ===========================================================================
   NEON CITY — instanced buildings with procedural windows
   =========================================================================== */

const buildingSeeds = [];
const cityCount = 156;
const buildingGeometry = new THREE.BoxGeometry(1, 1, 1);
const seedAttribute = new Float32Array(cityCount);
const tintAttribute = new Float32Array(cityCount * 3);

const cityMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: elapsed,
    uFog: { value: fogColor },
    uCyan: { value: cyanColor },
    uMagenta: { value: magentaColor },
    uViolet: { value: violetColor },
  },
  fog: false,
  vertexShader: `
    attribute float aSeed;
    attribute vec3 aTint;
    varying vec2 vUv;
    varying vec3 vWorld;
    varying vec3 vNormalW;
    varying float vSeed;
    varying vec3 vTint;
    varying vec3 vScale;

    void main() {
      vUv = uv;
      vSeed = aSeed;
      vTint = aTint;
      vScale = vec3(
        length(instanceMatrix[0].xyz),
        length(instanceMatrix[1].xyz),
        length(instanceMatrix[2].xyz)
      );
      vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
      vWorld = world.xyz;
      vNormalW = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * normal);
      gl_Position = projectionMatrix * viewMatrix * world;
    }
  `,
  fragmentShader: `
    uniform float uTime;
    uniform vec3 uFog;
    uniform vec3 uCyan;
    uniform vec3 uMagenta;
    uniform vec3 uViolet;
    varying vec2 vUv;
    varying vec3 vWorld;
    varying vec3 vNormalW;
    varying float vSeed;
    varying vec3 vTint;
    varying vec3 vScale;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    void main() {
      vec3 n = normalize(vNormalW);
      float side = 1.0 - smoothstep(0.55, 0.82, abs(n.y));
      vec2 uv = vUv;

      float cols = clamp(floor(vScale.x * 0.95 + vScale.z * 0.28), 5.0, 20.0);
      float rows = clamp(floor(vScale.y * 0.82), 9.0, 42.0);
      vec2 cells = vec2(cols, rows);
      vec2 cell = floor(uv * cells);
      vec2 f = fract(uv * cells);

      float winX = smoothstep(0.22, 0.3, f.x) * (1.0 - smoothstep(0.7, 0.78, f.x));
      float winY = smoothstep(0.23, 0.31, f.y) * (1.0 - smoothstep(0.67, 0.76, f.y));
      float winMask = winX * winY * side;
      float litHash = hash(cell + vSeed * 119.31 + n.x * 3.7);
      float lit = smoothstep(0.68, 0.76, litHash);
      float windowEnergy = 0.22 + 0.5 * hash(cell * 2.17 + vSeed * 31.0);
      float flicker = 0.74 + 0.26 * sin(uTime * (0.3 + litHash * 1.4) + litHash * 30.0);
      vec3 winColor = mix(uCyan, uMagenta, step(0.54, hash(cell * 1.71 + vSeed * 47.0)));
      winColor = mix(winColor, uViolet, 0.3);

      vec3 base = vec3(0.004, 0.004, 0.016) + vTint * 0.004;
      base += vec3(0.012, 0.006, 0.032) * (1.0 - uv.y);
      vec3 col = base;
      col += winColor * lit * winMask * windowEnergy * (0.55 + flicker * 0.45);
      col += uCyan * smoothstep(0.994, 1.0, uv.y) * side * 0.22;

      // LED strip on a fraction of the towers
      float stripX = 0.08 + 0.84 * fract(vSeed * 7.37);
      float strip = 1.0 - smoothstep(0.0, 0.006 + fwidth(uv.x) * 0.9, abs(uv.x - stripX));
      col += uMagenta * strip * side * 0.16 * (0.45 + 0.55 * sin(uTime * 0.8 + vSeed * 23.0));

      // crisp window-frame edges
      float edgeX = 1.0 - smoothstep(0.0, 0.005 + fwidth(uv.x) * 0.8, min(uv.x, 1.0 - uv.x));
      float edgeY = 1.0 - smoothstep(0.0, 0.005 + fwidth(uv.y) * 0.8, min(uv.y, 1.0 - uv.y));
      float edge = max(edgeX, edgeY);
      col += mix(uCyan, uMagenta, fract(vSeed * 3.17)) * edge * 0.12 * (0.7 + 0.3 * sin(uTime * 0.55 + vSeed * 40.0));

      // base haze and dim ground light
      col += uViolet * pow(1.0 - uv.y, 14.0) * side * 0.06;

      float dist = distance(vWorld, cameraPosition);
      float fog = smoothstep(75.0, 295.0, dist);
      col = mix(col, uFog, fog);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
});

const city = new THREE.InstancedMesh(buildingGeometry, cityMaterial, cityCount);
city.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
city.frustumCulled = false;
scene.add(city);

const cityDummy = new THREE.Object3D();
const tintChoices = [
  new THREE.Color(0x16f4ff).multiplyScalar(0.8),
  new THREE.Color(0xff2bd6).multiplyScalar(0.65),
  new THREE.Color(0x8d4dff).multiplyScalar(0.75),
  new THREE.Color(0x4aa4ff).multiplyScalar(0.55),
];

for (let i = 0; i < cityCount; i += 1) {
  const side = i % 2 === 0 ? -1 : 1;
  const depth = randomRange(6, 19);
  const width = randomRange(5, 16);
  const height = randomRange(7, i % 9 === 0 ? 46 : 29);
  const z = 26 - Math.random() * 390;
  const x = side * randomRange(26, 112);
  const tint = tintChoices[Math.floor(Math.random() * tintChoices.length)];
  const seed = Math.random();

  buildingSeeds.push({
    x,
    z,
    width,
    depth,
    height,
    rotation: randomRange(-0.12, 0.12),
    seed,
    tint,
  });

  seedAttribute[i] = seed;
  tintAttribute[i * 3] = tint.r;
  tintAttribute[i * 3 + 1] = tint.g;
  tintAttribute[i * 3 + 2] = tint.b;

  cityDummy.position.set(x, height / 2, z);
  cityDummy.rotation.set(0, randomRange(-0.16, 0.16), 0);
  cityDummy.scale.set(width, height, depth);
  cityDummy.updateMatrix();
  city.setMatrixAt(i, cityDummy.matrix);
}

buildingGeometry.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seedAttribute, 1));
buildingGeometry.setAttribute('aTint', new THREE.InstancedBufferAttribute(tintAttribute, 3));
city.instanceMatrix.needsUpdate = true;


/* ===========================================================================
   ROADSIDE LIGHTS / GATES / BILLBOARDS
   =========================================================================== */

const POST_SLOTS = 24;
const POST_GAP = 16;
const POST_TOTAL_Z = POST_SLOTS * POST_GAP;
const postZ = [];
for (let i = 0; i < POST_SLOTS; i += 1) postZ.push(32 - i * POST_GAP);

const postDummy = new THREE.Object3D();
const postCount = POST_SLOTS * 2;
const poleMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.075, 2.65, 0.075),
  new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }),
  postCount,
);
const lampMesh = new THREE.InstancedMesh(
  new THREE.BoxGeometry(0.64, 0.055, 0.09),
  new THREE.MeshBasicMaterial({ color: 0xffffff, fog: true }),
  postCount,
);
poleMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
lampMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
poleMesh.frustumCulled = false;
lampMesh.frustumCulled = false;
scene.add(poleMesh, lampMesh);

const poleColorDark = new THREE.Color(0x0a2d4c);
const postLampColors = [
  new THREE.Color(0x16f4ff).multiplyScalar(2.8),
  new THREE.Color(0xff2bd6).multiplyScalar(2.2),
];

for (let i = 0; i < postCount; i += 1) {
  const side = i % 2 === 0 ? -1 : 1;
  const slot = Math.floor(i / 2);
  postDummy.position.set(side * 13.45, 1.325, postZ[slot]);
  postDummy.rotation.set(0, 0, 0);
  postDummy.scale.set(1, 1, 1);
  postDummy.updateMatrix();
  poleMesh.setMatrixAt(i, postDummy.matrix);
  poleMesh.setColorAt(i, poleColorDark);

  postDummy.position.set(side * 13.3, 2.62, postZ[slot]);
  postDummy.updateMatrix();
  lampMesh.setMatrixAt(i, postDummy.matrix);
  lampMesh.setColorAt(i, postLampColors[slot % postLampColors.length]);
}
poleMesh.instanceMatrix.needsUpdate = true;
lampMesh.instanceMatrix.needsUpdate = true;
poleMesh.instanceColor.needsUpdate = true;
lampMesh.instanceColor.needsUpdate = true;

/* --------------------------------------------------------------------------
   Overhead gates
   -------------------------------------------------------------------------- */

const gateBodyMaterial = new THREE.MeshStandardMaterial({
  color: 0x080b1c,
  metalness: 0.8,
  roughness: 0.38,
  emissive: 0x040118,
  emissiveIntensity: 0.7,
});
const gateCyan = neonBasic(0x16f4ff, 1.35);
const gateMagenta = neonBasic(0xff2bd6, 1.25);
const gateAmber = neonBasic(0xffd166, 1.1);

const gateLabels = [
  { text: 'NIGHT CITY', accent: '#16f4ff', sub: 'VAPOR DISTRICT 07' },
  { text: 'SECTOR 07', accent: '#ff2bd6', sub: 'NIGHT RUN PROTOCOL' },
  { text: 'FULL SEND', accent: '#ffd166', sub: 'NO BRAKES // NO SIGNAL' },
];

function addBox(parent, material, w, h, d, x, y, z) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function createGate(labelData) {
  const group = new THREE.Group();

  addBox(group, gateBodyMaterial, 0.82, 10.6, 0.82, -15.0, 5.3, 0);
  addBox(group, gateBodyMaterial, 0.82, 10.6, 0.82, 15.0, 5.3, 0);
  addBox(group, gateBodyMaterial, 30.8, 0.92, 0.88, 0, 10.25, 0);
  addBox(group, gateBodyMaterial, 30.8, 0.32, 0.92, 0, 9.7, 0);

  addBox(group, gateCyan, 0.07, 9.5, 0.09, -14.48, 5.15, 0.43);
  addBox(group, gateMagenta, 0.07, 9.5, 0.09, 14.48, 5.15, 0.43);
  addBox(group, gateCyan, 29.1, 0.065, 0.09, 0, 10.73, 0.46);
  addBox(group, gateMagenta, 29.1, 0.035, 0.1, 0, 9.82, 0.49);
  addBox(group, gateAmber, 22.5, 0.018, 0.08, 0, 9.55, 0.5);

  for (const side of [-1, 1]) {
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 8), gateAmber);
    beacon.position.set(side * 14.0, 11.0, 0.44);
    group.add(beacon);
  }

  const signTexture = makeNeonSignTexture(labelData.text, labelData.accent, labelData.sub);
  const signBacking = addBox(group, gateBodyMaterial, 10.3, 4.1, 0.22, 0, 12.5, 0.1);
  signBacking.rotation.x = -0.015;
  const signMaterial = new THREE.MeshBasicMaterial({
    map: signTexture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: new THREE.Color(1.45, 1.45, 1.45),
    fog: true,
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(9.5, 3.96), signMaterial);
  sign.position.set(0, 12.5, 0.23);
  group.add(sign);

  const lightStrip = new THREE.Mesh(
    new THREE.PlaneGeometry(24.3, 2.2),
    new THREE.MeshBasicMaterial({
      map: GLOW_TEXTURE,
      color: new THREE.Color(labelData.accent).multiplyScalar(0.32),
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: true,
      side: THREE.DoubleSide,
    }),
  );
  lightStrip.rotation.x = -Math.PI / 2;
  lightStrip.position.set(0, 0.035, 0);
  group.add(lightStrip);

  return group;
}

const gates = [];
const gateSpacing = 128;
for (let i = 0; i < 3; i += 1) {
  const gate = createGate(gateLabels[i % gateLabels.length]);
  gate.position.set(0, 0, -150 - i * gateSpacing);
  scene.add(gate);
  gates.push(gate);
}

/* --------------------------------------------------------------------------
   Side billboards
   -------------------------------------------------------------------------- */

const billboardData = [
  { text: 'VAPOR', accent: '#16f4ff', sub: 'FEEL THE WAKE', side: -1, z: -42 },
  { text: 'NIGHT', accent: '#ff2bd6', sub: 'CITY NEVER SLEEPS', side: 1, z: -124 },
  { text: 'SYNTH', accent: '#8d4dff', sub: 'ANALOG DREAMS', side: -1, z: -218 },
  { text: '07', accent: '#ffd166', sub: 'ENDLESS SECTOR', side: 1, z: -307 },
];

function createBillboard(data) {
  const group = new THREE.Group();
  const width = 10.2;
  const height = 4.25;
  const y = 7.35;

  addBox(group, gateBodyMaterial, width + 0.7, height + 0.7, 0.26, 0, y, 0);
  addBox(group, gateCyan, 0.055, 1.8, 0.55, -2.9, 2.9, 0);
  addBox(group, gateCyan, 0.055, 1.8, 0.55, 2.9, 2.9, 0);

  const accent = new THREE.Color(data.accent).multiplyScalar(2.0);
  const accentMat = new THREE.MeshBasicMaterial({ color: accent, fog: true });
  addBox(group, accentMat, width + 0.4, 0.055, 0.08, 0, y + height / 2 + 0.2, 0.2);
  addBox(group, accentMat, width + 0.4, 0.055, 0.08, 0, y - height / 2 - 0.2, 0.2);
  addBox(group, accentMat, 0.055, height + 0.4, 0.08, -width / 2 - 0.2, y, 0.2);
  addBox(group, accentMat, 0.055, height + 0.4, 0.08, width / 2 + 0.2, y, 0.2);

  const texture = makeNeonSignTexture(data.text, data.accent, data.sub);
  const signMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    color: new THREE.Color(1.35, 1.35, 1.35),
    fog: true,
  });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(width, height), signMaterial);
  sign.position.set(0, y, 0.25);
  group.add(sign);

  group.position.set(data.side * 19.5, 0, data.z);
  group.rotation.y = -data.side * 0.28;
  scene.add(group);
  return { group, z: data.z, side: data.side };
}

const billboards = billboardData.map(createBillboard);

/* ===========================================================================
   SHIP
   =========================================================================== */

const ship = new THREE.Group();
ship.position.set(0, 0.92, 0);
scene.add(ship);

const shipBodyMaterial = new THREE.MeshStandardMaterial({
  color: 0x1c2142,
  metalness: 0.58,
  roughness: 0.3,
  emissive: 0x0a0e28,
  emissiveIntensity: 1.0,
});
const shipPanelMaterial = new THREE.MeshStandardMaterial({
  color: 0x2a2c59,
  metalness: 0.62,
  roughness: 0.34,
  emissive: 0x100c30,
  emissiveIntensity: 0.8,
  flatShading: true,
});
const shipDarkMaterial = new THREE.MeshStandardMaterial({
  color: 0x04040d,
  metalness: 0.6,
  roughness: 0.35,
  emissive: 0x020008,
  emissiveIntensity: 0.4,
});
const canopyMaterial = new THREE.MeshStandardMaterial({
  color: 0x04122a,
  metalness: 0.3,
  roughness: 0.05,
  emissive: 0x0d4b74,
  emissiveIntensity: 1.2,
  transparent: true,
  opacity: 0.94,
});
const shipCyanMaterial = neonBasic(0x16f4ff, 1.5);
const shipMagentaMaterial = neonBasic(0xff2bd6, 1.32);
const shipAmberMaterial = neonBasic(0xffd166, 1.25);

// Wings — one swept low-poly extrusion, thin enough to catch the neon rim.
function createWingGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(-0.34, -1.35);
  shape.lineTo(-2.42, 0.33);
  shape.lineTo(-2.06, 1.18);
  shape.lineTo(-0.46, 1.01);
  shape.lineTo(0.46, 1.01);
  shape.lineTo(2.06, 1.18);
  shape.lineTo(2.42, 0.33);
  shape.lineTo(0.34, -1.35);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.085,
    bevelEnabled: true,
    bevelSegments: 1,
    steps: 1,
    bevelSize: 0.025,
    bevelThickness: 0.022,
  });
  geometry.rotateX(Math.PI / 2);
  geometry.computeVertexNormals();
  return geometry;
}

const wing = new THREE.Mesh(createWingGeometry(), shipPanelMaterial);
wing.position.set(0, 0.245, 0.02);
ship.add(wing);

const wingEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(wing.geometry, 32),
  new THREE.LineBasicMaterial({
    color: new THREE.Color(0x8ef4ff).multiplyScalar(1.25),
    transparent: true,
    opacity: 0.7,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
wingEdges.position.copy(wing.position);
ship.add(wingEdges);

function addNeonBeam(parent, material, ax, ay, az, bx, by, bz, thickness = 0.028) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(thickness, thickness, length), material);
  mesh.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  mesh.rotation.y = Math.atan2(dx, dz);
  mesh.rotation.x = -Math.atan2(dy, Math.sqrt(dx * dx + dz * dz));
  parent.add(mesh);
  return mesh;
}

for (const side of [-1, 1]) {
  addNeonBeam(ship, shipCyanMaterial, side * 0.47, 0.295, -1.23, side * 2.31, 0.29, 0.35);
  addNeonBeam(ship, shipMagentaMaterial, side * 2.05, 0.29, 1.19, side * 0.46, 0.29, 1.0);
  addNeonBeam(ship, shipCyanMaterial, side * 2.4, 0.27, 0.33, side * 2.05, 0.27, 1.19, 0.022);
}

// Fuselage
const fuselageGeometry = new THREE.CapsuleGeometry(0.42, 2.35, 8, 18);
fuselageGeometry.rotateX(Math.PI / 2);
fuselageGeometry.scale(1.15, 0.72, 1);
const fuselage = new THREE.Mesh(fuselageGeometry, shipBodyMaterial);
fuselage.position.set(0, 0.38, -0.06);
ship.add(fuselage);

const noseGeometry = new THREE.ConeGeometry(0.43, 1.65, 8);
noseGeometry.rotateX(-Math.PI / 2);
noseGeometry.scale(1.16, 0.66, 1);
const nose = new THREE.Mesh(noseGeometry, shipBodyMaterial);
nose.position.set(0, 0.35, -1.74);
ship.add(nose);

// Central spine + edge lights
addBox(ship, shipCyanMaterial, 0.04, 0.025, 3.2, 0, 0.705, -0.3);
addBox(ship, shipMagentaMaterial, 0.018, 0.022, 1.9, 0, 0.74, 0.6);
for (const side of [-1, 1]) {
  addBox(ship, shipCyanMaterial, 0.026, 0.022, 2.25, side * 0.49, 0.45, -0.12);
  addBox(ship, shipMagentaMaterial, 0.022, 0.03, 1.15, side * 0.43, 0.34, 0.75);
}

// Cockpit
const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.52, 24, 16), canopyMaterial);
canopy.scale.set(0.8, 0.58, 1.35);
canopy.position.set(0, 0.67, -0.4);
ship.add(canopy);

const canopyLinePoints = [];
const canopyCurve = new THREE.EllipseCurve(0, 0, 0.39, 0.69, 0, TAU, false, 0);
for (const point of canopyCurve.getPoints(56)) {
  canopyLinePoints.push(new THREE.Vector3(point.x, 0.02, point.y));
}
const canopyLine = new THREE.LineLoop(
  new THREE.BufferGeometry().setFromPoints(canopyLinePoints),
  new THREE.LineBasicMaterial({
    color: new THREE.Color(0x61f7ff).multiplyScalar(1.6),
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  }),
);
canopyLine.position.set(0, 0.68, -0.41);
canopyLine.rotation.x = 0;
ship.add(canopyLine);

// Side intakes
for (const side of [-1, 1]) {
  const intake = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.22, 1.22), shipDarkMaterial);
  intake.position.set(side * 0.63, 0.32, 0.18);
  intake.rotation.z = side * 0.12;
  ship.add(intake);
  addBox(ship, shipCyanMaterial, 0.035, 0.03, 1.05, side * 0.73, 0.45, 0.3);
}

// Vertical stabilizers
for (const side of [-1, 1]) {
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.63, 0.62), shipPanelMaterial);
  fin.position.set(side * 0.53, 0.79, 1.17);
  fin.rotation.z = side * 0.32;
  fin.rotation.x = -0.22;
  ship.add(fin);
  addBox(ship, shipMagentaMaterial, 0.022, 0.46, 0.025, side * 0.645, 0.85, 1.46, 0.02);
}

// Engines
const engineMetal = new THREE.MeshStandardMaterial({
  color: 0x080a16,
  metalness: 0.95,
  roughness: 0.18,
  emissive: 0x031022,
  emissiveIntensity: 0.5,
});
const engineCoreMaterial = new THREE.MeshBasicMaterial({
  color: new THREE.Color(0x8bfaff).multiplyScalar(1.25),
  transparent: true,
  opacity: 0.96,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  fog: false,
});
const engineRimMaterial = neonBasic(0xff2bd6, 1.45);
const engineObjects = [];

for (const side of [-1, 1]) {
  const engine = new THREE.Group();
  engine.position.set(side * 0.82, 0.28, 0.72);
  ship.add(engine);

  const casing = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.255, 1.5, 14, 1, true), engineMetal);
  casing.rotation.x = Math.PI / 2;
  engine.add(casing);

  const ringFront = new THREE.Mesh(new THREE.TorusGeometry(0.225, 0.025, 8, 24), engineRimMaterial);
  ringFront.position.z = 0.42;
  engine.add(ringFront);
  const ringBack = ringFront.clone();
  ringBack.position.z = 0.72;
  engine.add(ringBack);

  const nozzle = new THREE.Mesh(new THREE.TorusGeometry(0.215, 0.042, 8, 24), engineRimMaterial);
  nozzle.position.z = 0.775;
  engine.add(nozzle);

  const core = new THREE.Mesh(new THREE.CircleGeometry(0.175, 20), engineCoreMaterial);
  core.position.z = 0.79;
  engine.add(core);

  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: GLOW_TEXTURE,
    color: new THREE.Color(0x2fe8ff).multiplyScalar(0.78),
    transparent: true,
    opacity: 0.55,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }));
  glow.position.set(0, 0, 1.0);
  glow.scale.set(1.18, 1.18, 1.18);
  engine.add(glow);

  const createFlame = (radius, length, hex, opacity) => {
    const geometry = new THREE.ConeGeometry(radius, length, 12, 1, true);
    geometry.rotateX(Math.PI / 2);
    geometry.translate(0, 0, length / 2);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(hex).multiplyScalar(1.15),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const flame = new THREE.Mesh(geometry, material);
    flame.position.z = 0.8;
    engine.add(flame);
    return flame;
  };

  const outerFlame = createFlame(0.21, 1.55, 0xff2bd6, 0.26);
  const innerFlame = createFlame(0.13, 1.0, 0x3df8ff, 0.7);

  engineObjects.push({ engine, glow, outerFlame, innerFlame, side });
}

// Wingtip marker lights
const wingtipLights = [];
for (const side of [-1, 1]) {
  const light = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 8), side < 0 ? shipCyanMaterial : shipMagentaMaterial);
  light.position.set(side * 2.38, 0.3, 0.37);
  ship.add(light);
  wingtipLights.push(light);
}

const enginePointLight = new THREE.PointLight(0x37eaff, 2.4, 11, 2);
enginePointLight.position.set(0, 0.3, 1.8);
ship.add(enginePointLight);

// Defensive bubble used briefly after a collision.
const shield = new THREE.Mesh(
  new THREE.IcosahedronGeometry(2.9, 2),
  new THREE.MeshBasicMaterial({
    color: new THREE.Color(0x4ffaff).multiplyScalar(1.15),
    wireframe: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  }),
);
shield.scale.set(1.08, 0.56, 1.22);
shield.position.set(0, 0.25, 0);
shield.visible = false;
ship.add(shield);

// Ground aura + fake contact shadow follow the ship but do not bank with it.
const shadowMaterial = new THREE.MeshBasicMaterial({
  map: SHADOW_TEXTURE,
  transparent: true,
  opacity: 0.8,
  depthWrite: false,
  color: 0x000000,
  side: THREE.DoubleSide,
  fog: false,
});
const shipShadow = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 11.5), shadowMaterial);
shipShadow.rotation.x = -Math.PI / 2;
shipShadow.position.set(0, 0.018, -0.5);
shipShadow.renderOrder = 2;
scene.add(shipShadow);

const shipAura = new THREE.Mesh(
  new THREE.PlaneGeometry(10.6, 15.4),
  new THREE.MeshBasicMaterial({
    map: GLOW_TEXTURE,
    color: new THREE.Color(0x1cdfff).multiplyScalar(0.6),
    transparent: true,
    opacity: 0.18,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  }),
);
shipAura.rotation.x = -Math.PI / 2;
shipAura.position.set(0, 0.028, -0.5);
shipAura.renderOrder = 3;
scene.add(shipAura);

/* ===========================================================================
   VAPOR TRAILS — twin ribbons
   =========================================================================== */

const UP = new THREE.Vector3(0, 1, 0);

class RibbonTrail {
  constructor(options = {}) {
    this.count = 46;
    this.width = options.width || 0.24;
    this.headColor = new THREE.Color(options.head || 0xc8ffff).multiplyScalar(0.8);
    this.midColor = new THREE.Color(options.mid || 0x16f4ff).multiplyScalar(1.05);
    this.tailColor = new THREE.Color(options.tail || 0xff2bd6).multiplyScalar(0.8);
    this.boostColor = new THREE.Color(0xffd166).multiplyScalar(0.9);

    this.history = Array.from({ length: this.count }, () => new THREE.Vector3());
    this.energy = new Float32Array(this.count);
    this.vertexCount = this.count * 2;
    this.positionArray = new Float32Array(this.vertexCount * 3);
    this.colorArray = new Float32Array(this.vertexCount * 3);
    this.alphaArray = new Float32Array(this.vertexCount);
    this.uvArray = new Float32Array(this.vertexCount * 2);
    this.indices = [];

    for (let i = 0; i < this.count - 1; i += 1) {
      const a = i * 2;
      const b = a + 1;
      const c = (i + 1) * 2;
      const d = c + 1;
      this.indices.push(a, c, b, b, c, d);
    }
    for (let i = 0; i < this.count; i += 1) {
      const t = i / (this.count - 1);
      this.uvArray[i * 4] = 0;
      this.uvArray[i * 4 + 1] = t;
      this.uvArray[i * 4 + 2] = 1;
      this.uvArray[i * 4 + 3] = t;
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positionArray, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colorArray, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphaArray, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('uv', new THREE.BufferAttribute(this.uvArray, 2));
    this.geometry.setIndex(this.indices);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: elapsed,
        uFog: { value: fogColor },
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexShader: `
        attribute vec3 aColor;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          vColor = aColor;
          vAlpha = aAlpha;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        varying vec3 vColor;
        varying float vAlpha;
        varying vec2 vUv;
        void main() {
          float edge = smoothstep(0.0, 0.28, vUv.x) * smoothstep(1.0, 0.72, vUv.x);
          float flow = 0.72 + 0.28 * sin(vUv.y * 62.0 - uTime * 22.0);
          float breakup = 0.8 + 0.2 * sin(vUv.y * 17.0 + uTime * 7.5);
          vec3 col = vColor * (0.35 + edge * 1.3) * flow * breakup;
          float alpha = vAlpha * edge * (0.42 + 0.36 * flow);
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    scene.add(this.mesh);

    this.tangent = new THREE.Vector3();
    this.side = new THREE.Vector3();
    this.tmpColor = new THREE.Color();
    this.hasHead = false;
    this.visible = true;
  }

  reset(head, boosting = false) {
    for (let i = 0; i < this.count; i += 1) {
      this.history[i].copy(head);
      this.history[i].z += i * 0.045;
      this.energy[i] = boosting ? 1 : 0;
    }
    this.hasHead = true;
    this.mesh.visible = true;
    this.rebuildGeometry(boosting ? 1 : 0);
  }

  setVisible(value) {
    this.visible = value;
    this.mesh.visible = value;
  }

  update(head, dt, speedNorm, boosting, time) {
    if (!this.visible) return;
    if (!this.hasHead) {
      this.reset(head, boosting);
      return;
    }

    const drift = 3.0 + speedNorm * 2.15 + (boosting ? 1.2 : 0);
    for (let i = this.count - 1; i >= 1; i -= 1) {
      this.history[i].copy(this.history[i - 1]);
      this.history[i].z += drift * dt;
      this.history[i].y += 0.18 * dt;
      this.energy[i] = this.energy[i - 1] * 0.985;
    }
    this.history[0].copy(head);
    this.energy[0] = boosting ? 1 : 0;

    this.rebuildGeometry(time);
  }

  rebuildGeometry() {
    const positions = this.positionArray;
    const colors = this.colorArray;
    const alphas = this.alphaArray;
    const energyBoost = 0;

    for (let i = 0; i < this.count; i += 1) {
      const t = i / (this.count - 1);
      const point = this.history[i];
      const prev = this.history[Math.max(0, i - 1)];
      const next = this.history[Math.min(this.count - 1, i + 1)];

      this.tangent.subVectors(prev, next);
      if (this.tangent.lengthSq() < 0.000001) this.tangent.set(0, 0, 1);
      this.tangent.normalize();
      this.side.crossVectors(this.tangent, UP);
      if (this.side.lengthSq() < 0.000001) this.side.set(1, 0, 0);
      this.side.normalize();

      const taper = Math.pow(1 - t, 0.34);
      const width = this.width * (0.25 + 0.92 * Math.sin(Math.PI * Math.pow(t, 0.92))) * taper;
      const heightBias = 0.55 + Math.sin(t * Math.PI) * 0.24;
      this.side.x *= width;
      this.side.z *= width;
      this.side.y = width * 0.22;

      const v = i * 6;
      positions[v] = point.x - this.side.x;
      positions[v + 1] = point.y - this.side.y * heightBias;
      positions[v + 2] = point.z - this.side.z;
      positions[v + 3] = point.x + this.side.x;
      positions[v + 4] = point.y + this.side.y * heightBias;
      positions[v + 5] = point.z + this.side.z;

      if (t < 0.24) {
        this.tmpColor.copy(this.headColor).lerp(this.midColor, t / 0.24);
      } else {
        this.tmpColor.copy(this.midColor).lerp(this.tailColor, (t - 0.24) / 0.76);
      }
      const boostMix = clamp(this.energy[i] * (0.2 + t * 0.5), 0, 1);
      if (boostMix > 0.001) this.tmpColor.lerp(this.boostColor, boostMix * 0.55);
      this.tmpColor.multiplyScalar(0.56 + Math.sin(t * Math.PI) * 0.55);

      const baseColorIndex = i * 6;
      colors[baseColorIndex] = this.tmpColor.r;
      colors[baseColorIndex + 1] = this.tmpColor.g;
      colors[baseColorIndex + 2] = this.tmpColor.b;
      colors[baseColorIndex + 3] = this.tmpColor.r * 1.08;
      colors[baseColorIndex + 4] = this.tmpColor.g * 1.08;
      colors[baseColorIndex + 5] = this.tmpColor.b * 1.08;

      const alpha = Math.pow(1 - t, 0.92) * (0.72 + 0.24 * this.energy[i]);
      const ai = i * 2;
      alphas[ai] = alpha * 0.78;
      alphas[ai + 1] = alpha * 0.78;
    }

    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

const leftTrail = new RibbonTrail({
  width: 0.23,
  head: 0xc8ffff,
  mid: 0x16f4ff,
  tail: 0x8d4dff,
});
const rightTrail = new RibbonTrail({
  width: 0.23,
  head: 0xffd5fb,
  mid: 0xff2bd6,
  tail: 0x8d4dff,
});

/* ===========================================================================
   VAPOR PARTICLES — GPU point sprites, CPU-fed lively wake
   =========================================================================== */

const vaporPalette = [
  { color: new THREE.Color(0xa9ffff).multiplyScalar(0.72) },
  { color: new THREE.Color(0x16f4ff).multiplyScalar(0.8) },
  { color: new THREE.Color(0x62c8ff).multiplyScalar(0.68) },
  { color: new THREE.Color(0xff2bd6).multiplyScalar(0.66) },
  { color: new THREE.Color(0x9d6bff).multiplyScalar(0.66) },
];
const boostPalette = [
  { color: new THREE.Color(0xffe2a8).multiplyScalar(0.9) },
  { color: new THREE.Color(0xffd166).multiplyScalar(0.8) },
  { color: new THREE.Color(0xff2bd6).multiplyScalar(0.78) },
  { color: new THREE.Color(0x7dffff).multiplyScalar(0.82) },
];

class VaporParticles {
  constructor(count = 2100) {
    this.count = count;
    this.cursor = 0;

    this.positions = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.sizes = new Float32Array(count);
    this.alphas = new Float32Array(count);
    this.velX = new Float32Array(count);
    this.velY = new Float32Array(count);
    this.velZ = new Float32Array(count);
    this.life = new Float32Array(count);
    this.maxLife = new Float32Array(count);
    this.baseSize = new Float32Array(count);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uScale: { value: 900 },
        uTime: elapsed,
      },
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      fog: false,
      vertexShader: `
        attribute vec3 aColor;
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = aColor;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          float depthFade = smoothstep(1.4, 5.2, -mvPosition.z);
          vAlpha = aAlpha * depthFade;
          gl_PointSize = aSize * uScale / max(0.5, -mvPosition.z);
          gl_PointSize = clamp(gl_PointSize, 0.0, 96.0);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 uv = gl_PointCoord - 0.5;
          float d = length(uv) * 2.0;
          if (d > 1.0) discard;
          float soft = pow(1.0 - d, 1.9);
          float core = smoothstep(0.36, 0.0, d);
          vec3 col = vColor * (soft * 1.2 + core * 1.7);
          gl_FragColor = vec4(col, soft * vAlpha);
        }
      `,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    scene.add(this.points);
    this.colorsDirty = false;

    this.drawingBuffer = new THREE.Vector2();
    this.pixelScale = 900;
  }

  setViewportMetrics() {
    renderer.getDrawingBufferSize(this.drawingBuffer);
    const fovRad = (camera.fov * Math.PI) / 180;
    this.pixelScale = this.drawingBuffer.y / (2 * Math.tan(fovRad / 2));
    this.material.uniforms.uScale.value = this.pixelScale;
  }

  spawn(x, y, z, vx, vy, vz, size, life, r, g, b) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;

    this.positions[i3] = x;
    this.positions[i3 + 1] = y;
    this.positions[i3 + 2] = z;
    this.colors[i3] = r;
    this.colors[i3 + 1] = g;
    this.colors[i3 + 2] = b;
    this.velX[i] = vx;
    this.velY[i] = vy;
    this.velZ[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.baseSize[i] = size;
    this.sizes[i] = size;
    this.alphas[i] = 0.75;
    this.colorsDirty = true;
  }

  emitEngine(x, y, z, boosting, intensity = 1) {
    const palette = boosting ? boostPalette : vaporPalette;
    const c = palette[Math.floor(Math.random() * palette.length)].color;
    const puff = Math.random() < 0.3;
    const spread = (puff ? 0.12 : 0.055) + Math.random() * (puff ? 0.2 : 0.1);
    const brightness = puff ? 0.52 : 1;
    this.spawn(
      x + randomRange(-spread, spread),
      y + randomRange(-spread, spread),
      z + randomRange(-0.15, 0.15),
      randomRange(-0.85, 0.85) * intensity,
      randomRange(0.1, 0.8) * intensity,
      (puff ? randomRange(1.4, 3.8) : randomRange(3.4, 7.2)) * intensity,
      (puff ? randomRange(0.26, 0.57) : randomRange(0.085, 0.25)) * (boosting ? 1.12 : 1),
      puff ? randomRange(0.9, 1.85) : randomRange(0.5, 1.25),
      c.r * brightness,
      c.g * brightness,
      c.b * brightness,
    );
  }

  emitWing(x, y, z, side, strength = 1) {
    const c = (Math.random() < 0.5 ? vaporPalette[0] : vaporPalette[4]).color;
    this.spawn(
      x + randomRange(-0.16, 0.16),
      y + randomRange(-0.08, 0.08),
      z + randomRange(-0.2, 0.2),
      side * randomRange(0.8, 2.7) * strength,
      randomRange(0.15, 1.3),
      randomRange(2.6, 5.6),
      randomRange(0.06, 0.19),
      randomRange(0.45, 1.1),
      c.r,
      c.g,
      c.b,
    );
  }

  burst(x, y, z, count, palette, power = 1) {
    for (let i = 0; i < count; i += 1) {
      const c = palette[Math.floor(Math.random() * palette.length)].color;
      const angle = Math.random() * TAU;
      const speed = randomRange(1.5, 11) * power;
      const up = randomRange(-2.2, 5.6) * power;
      this.spawn(
        x + randomRange(-0.4, 0.4),
        y + randomRange(-0.4, 0.4),
        z + randomRange(-0.6, 0.6),
        Math.cos(angle) * speed,
        up,
        Math.sin(angle) * speed + randomRange(0, 3),
        randomRange(0.12, 0.56) * power,
        randomRange(0.4, 1.35),
        c.r,
        c.g,
        c.b,
      );
    }
  }

  update(dt) {
    const positions = this.positions;
    const sizes = this.sizes;
    const alphas = this.alphas;
    const drag = Math.exp(-0.52 * dt);
    let active = false;

    for (let i = 0; i < this.count; i += 1) {
      if (this.life[i] <= 0) continue;
      active = true;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        this.sizes[i] = 0;
        continue;
      }

      const age = 1 - this.life[i] / this.maxLife[i];
      this.velX[i] *= drag;
      this.velZ[i] *= drag;
      this.velY[i] += 0.42 * dt;

      const i3 = i * 3;
      positions[i3] += (this.velX[i] + Math.sin(age * 7.0 + i * 0.37) * 0.22) * dt;
      positions[i3 + 1] += this.velY[i] * dt;
      positions[i3 + 2] += this.velZ[i] * dt;

      const fade = Math.pow(1 - age, 0.72);
      alphas[i] = fade * 0.58;
      sizes[i] = this.baseSize[i] * (1 + age * 1.7);
    }

    if (active) {
      this.geometry.attributes.position.needsUpdate = true;
      this.geometry.attributes.aSize.needsUpdate = true;
      this.geometry.attributes.aAlpha.needsUpdate = true;
    }
    if (this.colorsDirty) {
      this.geometry.attributes.aColor.needsUpdate = true;
      this.colorsDirty = false;
    }
  }

  clear() {
    this.life.fill(0);
    this.alphas.fill(0);
    this.sizes.fill(0);
    this.geometry.attributes.aAlpha.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
  }
}

const vapor = new VaporParticles(2150);
vapor.setViewportMetrics();

/* ===========================================================================
   SPEED STREAKS
   =========================================================================== */

function createSpeedStreaks() {
  const count = 90;
  const positions = new Float32Array(count * 2 * 3);
  const colors = new Float32Array(count * 2 * 3);
  const data = [];

  const tintA = new THREE.Color(0xa8fbff).multiplyScalar(0.38);
  const tintB = new THREE.Color(0xff9bee).multiplyScalar(0.3);

  for (let i = 0; i < count; i += 1) {
    const x = randomRange(-34, 34);
    const y = randomRange(-13, 18);
    const z = randomRange(-110, -8);
    const length = randomRange(1.1, 4.6);
    const color = Math.random() < 0.32 ? tintB : tintA;
    data.push({ x, y, z, length, speed: randomRange(0.8, 1.6) });
    const base = i * 6;
    colors[base] = color.r;
    colors[base + 1] = color.g;
    colors[base + 2] = color.b;
    colors[base + 3] = color.r * 0.05;
    colors[base + 4] = color.g * 0.05;
    colors[base + 5] = color.b * 0.05;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.LineBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.renderOrder = 18;
  camera.add(lines);
  return { lines, geometry, material, data, positions };
}

const speedStreaks = createSpeedStreaks();

/* ===========================================================================
   CAMERA HELPERS
   =========================================================================== */

const cameraLookTarget = new THREE.Vector3(0, 1.32, -20);
const tempVector = new THREE.Vector3();
const tempVectorB = new THREE.Vector3();


/* ===========================================================================
   GAME STATE
   =========================================================================== */

const game = {
  mode: 'boot',
  best: loadBest(),
  score: 0,
  hull: 3,
  speed: 31,
  distance: 0,
  boost: 100,
  boosting: false,
  braking: false,
  boostLocked: false,
  playerX: 0,
  steerVelocity: 0,
  invulnerable: 0,
  shake: 0,
  topSpeed: 0,
  countdown: 0,
  countdownShown: 3,
  goTimer: 0,
  spawnTimer: 58,
  runTime: 0,
  lastBoost: false,
  wasBoostReady: true,
  shipAlive: true,
  overShown: false,
  deathTimer: 0,
  pausedFrom: 'running',
  audioTimer: 0,
};

const input = {
  left: false,
  right: false,
  boost: false,
  brake: false,
};

const audio = new RacerAudio();
let ready = false;
let overlayTimer = 0;
let toastTimer = 0;
let lastNearMissAt = -10;

const crashPalette = [
  { color: new THREE.Color(0xfff3d0).multiplyScalar(2.1) },
  { color: new THREE.Color(0xffd166).multiplyScalar(1.7) },
  { color: new THREE.Color(0xff426c).multiplyScalar(1.5) },
  { color: new THREE.Color(0x16f4ff).multiplyScalar(1.1) },
];
const pickupPalette = [
  { color: new THREE.Color(0xc8ffff).multiplyScalar(1.8) },
  { color: new THREE.Color(0x16f4ff).multiplyScalar(1.5) },
  { color: new THREE.Color(0x9d6bff).multiplyScalar(1.2) },
];
const nearMissPalette = [
  { color: new THREE.Color(0xffd166).multiplyScalar(1.5) },
  { color: new THREE.Color(0xff2bd6).multiplyScalar(1.2) },
];

/* ===========================================================================
   OBSTACLES — holographic barriers
   =========================================================================== */

const barrierPanelMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uTime: elapsed,
  },
  transparent: true,
  depthWrite: false,
  depthTest: true,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  fog: false,
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform float uTime;
    varying vec2 vUv;
    void main() {
      float edge = smoothstep(0.0, 0.055, vUv.x) * smoothstep(1.0, 0.945, vUv.x)
                 * smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
      float diagonal = smoothstep(0.42, 0.6, fract(vUv.x * 3.4 + vUv.y * 4.8 - uTime * 1.3));
      float scan = smoothstep(0.72, 1.0, 1.0 - vUv.y);
      float glitch = step(0.988, fract(vUv.y * 21.0 + sin(uTime * 2.0) * 0.04));
      vec3 hot = vec3(1.8, 0.13, 0.3);
      vec3 warm = vec3(1.7, 0.52, 0.06);
      vec3 col = mix(hot, warm, diagonal);
      float alpha = edge * (0.055 + diagonal * 0.24 + scan * 0.11 + glitch * 0.32);
      gl_FragColor = vec4(col * (0.5 + diagonal * 0.85), alpha);
    }
  `,
});

const barrierDarkMaterial = new THREE.MeshStandardMaterial({
  color: 0x0c0716,
  metalness: 0.7,
  roughness: 0.38,
  emissive: 0x19030f,
  emissiveIntensity: 0.8,
});
const barrierNeonMaterial = neonBasic(0xff426c, 2.15);
const barrierWarmMaterial = neonBasic(0xffd166, 1.75);

function createBarrierMesh() {
  const group = new THREE.Group();

  addBox(group, barrierDarkMaterial, 4.55, 0.32, 0.95, 0, 0.16, 0);
  addBox(group, barrierDarkMaterial, 0.16, 2.5, 0.32, -2.15, 1.32, 0);
  addBox(group, barrierDarkMaterial, 0.16, 2.5, 0.32, 2.15, 1.32, 0);
  addBox(group, barrierDarkMaterial, 4.55, 0.18, 0.32, 0, 2.5, 0);

  addBox(group, barrierNeonMaterial, 0.075, 2.34, 0.12, -2.15, 1.34, 0.2);
  addBox(group, barrierNeonMaterial, 0.075, 2.34, 0.12, 2.15, 1.34, 0.2);
  addBox(group, barrierNeonMaterial, 4.3, 0.065, 0.14, 0, 2.53, 0.2);
  addBox(group, barrierWarmMaterial, 4.1, 0.03, 0.1, 0, 2.62, 0.22);

  const panel = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 2.13, 1, 1), barrierPanelMaterial);
  panel.position.set(0, 1.4, 0.16);
  group.add(panel);

  for (const side of [-1, 1]) {
    addNeonBeam(group, barrierWarmMaterial, side * 1.35, 0.85, 0.22, side * 0.38, 2.15, 0.22, 0.035);
    const beacon = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), barrierWarmMaterial);
    beacon.position.set(side * 2.15, 2.78, 0.15);
    group.add(beacon);
  }

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(10.5, 6.2),
    new THREE.MeshBasicMaterial({
      map: GLOW_TEXTURE,
      color: new THREE.Color(0xff3055).multiplyScalar(0.8),
      transparent: true,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.set(0, 0.038, 0);
  group.add(glow);

  group.visible = false;
  scene.add(group);
  return group;
}

const barrierPool = [];
for (let i = 0; i < 7; i += 1) {
  const group = createBarrierMesh();
  barrierPool.push({
    group,
    active: false,
    resolved: false,
    passed: false,
    x: 0,
    z: 0,
    halfWidth: 2.15,
  });
}

function activateBarrier(lane, z) {
  const item = barrierPool.find((entry) => !entry.active);
  if (!item) return null;
  item.active = true;
  item.resolved = false;
  item.passed = false;
  item.x = lane;
  item.z = z;
  item.group.visible = true;
  item.group.position.set(lane, 0, z);
  return item;
}

function deactivateBarrier(item) {
  item.active = false;
  item.group.visible = false;
}

/* ===========================================================================
   VAPOR CELLS — collectible energy orbs
   =========================================================================== */

const orbCoreGeometry = new THREE.IcosahedronGeometry(0.34, 1);
const orbOuterGeometry = new THREE.SphereGeometry(0.62, 12, 8);
const orbRingGeometry = new THREE.TorusGeometry(0.76, 0.022, 6, 32);

const orbCoreMaterial = new THREE.MeshStandardMaterial({
  color: 0x071722,
  metalness: 0.55,
  roughness: 0.18,
  emissive: new THREE.Color(0x16f4ff),
  emissiveIntensity: 4.4,
});
const orbWireMaterial = new THREE.MeshBasicMaterial({
  color: new THREE.Color(0x62faff).multiplyScalar(1.2),
  wireframe: true,
  transparent: true,
  opacity: 0.36,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const orbRingMaterial = neonBasic(0x7dffff, 1.6);
const orbGlowMaterial = new THREE.SpriteMaterial({
  map: GLOW_TEXTURE,
  color: new THREE.Color(0x32f5ff).multiplyScalar(0.95),
  transparent: true,
  opacity: 0.7,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
  fog: false,
});

function createOrb() {
  const group = new THREE.Group();
  const visual = new THREE.Group();
  group.add(visual);

  const core = new THREE.Mesh(orbCoreGeometry, orbCoreMaterial);
  core.position.y = 1.42;
  visual.add(core);

  const outer = new THREE.Mesh(orbOuterGeometry, orbWireMaterial);
  outer.position.y = 1.42;
  visual.add(outer);

  const ringA = new THREE.Mesh(orbRingGeometry, orbRingMaterial);
  ringA.position.y = 1.42;
  ringA.rotation.x = Math.PI / 2;
  visual.add(ringA);

  const ringB = new THREE.Mesh(orbRingGeometry, orbRingMaterial);
  ringB.position.y = 1.42;
  ringB.rotation.y = Math.PI / 2;
  visual.add(ringB);

  const glow = new THREE.Sprite(orbGlowMaterial);
  glow.position.y = 1.42;
  glow.scale.set(2.2, 2.2, 2.2);
  visual.add(glow);

  const marker = new THREE.Mesh(
    new THREE.PlaneGeometry(4.0, 4.0),
    new THREE.MeshBasicMaterial({
      map: GLOW_TEXTURE,
      color: new THREE.Color(0x16f4ff).multiplyScalar(0.55),
      transparent: true,
      opacity: 0.22,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
      side: THREE.DoubleSide,
    }),
  );
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.04;
  group.add(marker);

  group.visible = false;
  scene.add(group);
  return { group, visual, ringA, ringB, core };
}

const orbPool = [];
for (let i = 0; i < 9; i += 1) {
  const orb = createOrb();
  orbPool.push({ ...orb, active: false, x: 0, z: 0, phase: Math.random() * TAU });
}

function activateOrb(lane, z) {
  const item = orbPool.find((entry) => !entry.active);
  if (!item) return null;
  item.active = true;
  item.x = lane;
  item.z = z;
  item.phase = Math.random() * TAU;
  item.group.visible = true;
  item.group.position.set(lane, 0, z);
  return item;
}

function deactivateOrb(item) {
  item.active = false;
  item.group.visible = false;
}


/* ===========================================================================
   WORLD MOTION
   =========================================================================== */

function updateCity(delta) {
  if (delta === 0) return;
  for (let i = 0; i < cityCount; i += 1) {
    const building = buildingSeeds[i];
    building.z += delta;
    if (building.z > 34) building.z -= 405;

    cityDummy.position.set(building.x, building.height / 2, building.z);
    cityDummy.rotation.set(0, building.rotation, 0);
    cityDummy.scale.set(building.width, building.height, building.depth);
    cityDummy.updateMatrix();
    city.setMatrixAt(i, cityDummy.matrix);
  }
  city.instanceMatrix.needsUpdate = true;
}

function updatePosts(delta) {
  for (let i = 0; i < POST_SLOTS; i += 1) {
    postZ[i] += delta;
    if (postZ[i] > 38) postZ[i] -= POST_TOTAL_Z;
  }

  for (let i = 0; i < postCount; i += 1) {
    const side = i % 2 === 0 ? -1 : 1;
    const z = postZ[Math.floor(i / 2)];

    postDummy.position.set(side * 13.45, 1.325, z);
    postDummy.rotation.set(0, 0, 0);
    postDummy.scale.set(1, 1, 1);
    postDummy.updateMatrix();
    poleMesh.setMatrixAt(i, postDummy.matrix);

    postDummy.position.set(side * 13.3, 2.62, z);
    postDummy.updateMatrix();
    lampMesh.setMatrixAt(i, postDummy.matrix);
  }
  poleMesh.instanceMatrix.needsUpdate = true;
  lampMesh.instanceMatrix.needsUpdate = true;
}

function updateGatesAndBillboards(delta) {
  for (const gate of gates) {
    gate.position.z += delta;
    if (gate.position.z > 54) gate.position.z -= gateSpacing * 3;
  }

  for (const billboard of billboards) {
    billboard.z += delta;
    if (billboard.z > 34) billboard.z -= 392;
    billboard.group.position.z = billboard.z;
  }
}

function updateSpeedStreaks(dt) {
  const { material, geometry, positions, data } = speedStreaks;
  const speedNorm = clamp(game.speed / MAX_SPEED_UNITS, 0, 1);
  const boost = game.boosting ? 1 : 0;
  const targetOpacity =
    game.mode === 'menu' ? 0.08 :
    game.mode === 'over' ? 0.03 :
    game.mode === 'paused' ? material.opacity :
    0.08 + speedNorm * 0.12 + boost * 0.16;

  material.opacity = damp(material.opacity, targetOpacity, 6, dt);
  const velocity = 15 + game.speed * 2.6 + boost * 110;

  for (let i = 0; i < data.length; i += 1) {
    const line = data[i];
    line.z += velocity * line.speed * dt;

    if (line.z > -3) {
      line.z = -randomRange(58, 122);
      line.x = randomRange(-34, 34);
      line.y = randomRange(-13, 18);
      line.length = randomRange(1.1, 4.6) * (1 + boost * 1.1);
    }

    const base = i * 6;
    const length = line.length * (1 + boost * 0.9) * (0.6 + speedNorm * 0.8);
    positions[base] = line.x;
    positions[base + 1] = line.y;
    positions[base + 2] = line.z;
    positions[base + 3] = line.x * 0.995;
    positions[base + 4] = line.y * 0.995;
    positions[base + 5] = line.z - length;
  }
  geometry.attributes.position.needsUpdate = true;
}

function updateBarriers(dt, delta) {
  for (const barrier of barrierPool) {
    if (!barrier.active) continue;

    barrier.z += delta;
    barrier.group.position.z = barrier.z;

    if (game.mode === 'running' && !barrier.resolved) {
      const dx = Math.abs(barrier.x - game.playerX);
      const zInCombat = barrier.z > SHIP_Z_MIN - 1.0 && barrier.z < SHIP_Z_MAX + 1.0;

      if (zInCombat && dx < barrier.halfWidth + 0.92) {
        resolveBarrierImpact(barrier);
      } else if (!barrier.passed && barrier.z > SHIP_Z_MAX + 1.25) {
        barrier.passed = true;
        if (dx < 5.7) awardNearMiss(barrier);
      }
    }

    if (barrier.z > 30) deactivateBarrier(barrier);
  }
}

function updateOrbs(dt, delta) {
  const t = elapsed.value;
  for (const orb of orbPool) {
    if (!orb.active) continue;

    orb.z += delta;
    orb.group.position.z = orb.z;
    orb.phase += dt;
    orb.visual.position.y = Math.sin(t * 2.1 + orb.phase) * 0.13;
    orb.visual.rotation.y += dt * 1.35;
    orb.ringA.rotation.z += dt * 1.8;
    orb.ringB.rotation.x -= dt * 1.45;
    const pulse = 1 + Math.sin(t * 4.0 + orb.phase) * 0.045;
    orb.visual.scale.setScalar(pulse);

    if (
      game.mode === 'running' &&
      Math.abs(orb.z) < 2.35 &&
      Math.abs(orb.x - game.playerX) < 1.75
    ) {
      collectOrb(orb);
      continue;
    }

    if (orb.z > 24) deactivateOrb(orb);
  }
}

function spawnWave() {
  const shuffled = LANES.slice().sort(() => Math.random() - 0.5);
  const blockedCount = game.distance > 650 && Math.random() < 0.42 ? 2 : 1;
  const blocked = shuffled.slice(0, blockedCount);
  const open = shuffled.slice(blockedCount);
  const baseZ = -158 - Math.random() * 25;

  for (const lane of blocked) {
    activateBarrier(lane, baseZ + randomRange(-1.5, 1.5));
  }

  if (open.length > 0 && Math.random() < 0.68) {
    const lane = open[Math.floor(Math.random() * open.length)] + randomRange(-0.45, 0.45);
    activateOrb(lane, baseZ + randomRange(18, 46));
  }
}

function awardNearMiss(barrier) {
  game.score += 35;
  const now = elapsed.value;
  if (now - lastNearMissAt > 1.1) {
    showToast('NEAR MISS  //  +35', 'is-gold');
    lastNearMissAt = now;
  }
  vapor.burst(barrier.x, 1.2, barrier.z, 14, nearMissPalette, 0.45);
}

function resolveBarrierImpact(barrier) {
  if (barrier.resolved) return;
  barrier.resolved = true;
  barrier.passed = true;
  deactivateBarrier(barrier);

  if (game.invulnerable > 0) {
    game.score += 15;
    vapor.burst(barrier.x, 1.35, barrier.z, 24, pickupPalette, 0.7);
    return;
  }

  game.hull -= 1;
  game.invulnerable = 1.8;
  game.shake = 1.35;
  game.speed *= 0.61;
  game.boost = Math.max(0, game.boost - 22);
  audio.hit();
  dom.hitFlash.classList.remove('is-hit');
  void dom.hitFlash.offsetWidth;
  dom.hitFlash.classList.add('is-hit');

  ship.updateMatrixWorld(true);
  const burst = ship.localToWorld(tempVector.set(0, 0.3, 0.25));
  vapor.burst(burst.x, burst.y, burst.z, 70, crashPalette, 0.95);

  if (game.hull <= 0) {
    game.hull = 0;
    lethalImpact();
  } else {
    showToast(`HULL FRACTURE  //  ${game.hull} LEFT`, 'is-hot');
    updateHullDisplay(true);
    updateHud(true);
  }
}

function lethalImpact() {
  game.mode = 'over';
  game.shipAlive = false;
  game.overShown = false;
  game.deathTimer = 0;
  game.boosting = false;
  game.braking = false;
  game.speed *= 0.24;
  game.boost = 0;
  game.shake = 1.8;
  game.invulnerable = 0;

  audio.stopEngine(1.4);
  dom.hitFlash.classList.remove('is-hit', 'is-dead');
  void dom.hitFlash.offsetWidth;
  dom.hitFlash.classList.add('is-dead');
  dom.boostFx.classList.remove('is-active');

  ship.updateMatrixWorld(true);
  const burst = ship.localToWorld(tempVector.set(0, 0.25, -0.25));
  vapor.burst(burst.x, burst.y, burst.z, 160, crashPalette, 1.45);
  vapor.burst(burst.x, burst.y + 0.5, burst.z + 1.0, 50, nearMissPalette, 0.8);

  ship.visible = false;
  shipShadow.visible = false;
  shipAura.visible = false;
  leftTrail.setVisible(false);
  rightTrail.setVisible(false);

  document.body.classList.remove('is-racing');
  dom.pauseBtn.setAttribute('aria-pressed', 'false');
  dom.pauseBtn.setAttribute('aria-label', 'Pause game');
  clearInputs();

  updateHullDisplay(true);
  updateHud(true);
  captureFinalStats();
  hideToast();

  overlayTimer = window.setTimeout(() => showGameOverScreen(), 950);
}

function collectOrb(orb) {
  game.score += 150;
  game.boost = clamp(game.boost + 34, 0, 100);
  deactivateOrb(orb);
  audio.pickup();
  vapor.burst(orb.x, 1.42, orb.z, 42, pickupPalette, 0.72);
  showToast('VAPOR CELL  //  +150', '');
}

/* ===========================================================================
   VAPOR EMISSION
   =========================================================================== */

const trailHeadLeft = new THREE.Vector3();
const trailHeadRight = new THREE.Vector3();
const emissionScratch = new THREE.Vector3();
let vaporAccumulator = 0;
let wingAccumulator = 0;

function resetTrails() {
  ship.updateMatrixWorld(true);
  ship.localToWorld(trailHeadLeft.set(-0.82, 0.28, 1.66));
  ship.localToWorld(trailHeadRight.set(0.82, 0.28, 1.66));
  leftTrail.reset(trailHeadLeft, false);
  rightTrail.reset(trailHeadRight, false);
  leftTrail.setVisible(true);
  rightTrail.setVisible(true);
  vaporAccumulator = 0;
  wingAccumulator = 0;
}

function updateVapor(dt) {
  const canEmit = game.mode === 'menu' || game.mode === 'countdown' || game.mode === 'running';

  if (!canEmit) {
    vapor.update(dt);
    return;
  }

  const speedNorm = clamp(game.speed / MAX_SPEED_UNITS, 0, 1.25);
  const boost = game.boosting;
  ship.updateMatrixWorld(true);

  ship.localToWorld(trailHeadLeft.set(-0.82, 0.28, 1.66));
  ship.localToWorld(trailHeadRight.set(0.82, 0.28, 1.66));

  leftTrail.update(trailHeadLeft, dt, speedNorm, boost, elapsed.value);
  rightTrail.update(trailHeadRight, dt, speedNorm, boost, elapsed.value);

  const density = IS_TOUCH ? 0.66 : 1;
  const emitRate = (58 + speedNorm * 118 + (boost ? 205 : 0)) * density;
  vaporAccumulator += emitRate * dt;
  let emitCount = Math.min(26, Math.floor(vaporAccumulator));
  vaporAccumulator -= emitCount;

  for (let i = 0; i < emitCount; i += 1) {
    const useLeft = Math.random() < 0.5;
    const source = useLeft ? trailHeadLeft : trailHeadRight;
    vapor.emitEngine(source.x, source.y, source.z, boost, 0.9 + speedNorm * 0.28);
  }

  const wingRate = (Math.abs(game.steerVelocity) * 7.2 + (boost ? 13 : 0)) * density;
  wingAccumulator += wingRate * dt;
  let wingCount = Math.min(12, Math.floor(wingAccumulator));
  wingAccumulator -= wingCount;

  const strength = clamp(Math.abs(game.steerVelocity) / 9, 0.25, 1.4);
  for (let i = 0; i < wingCount; i += 1) {
    const side = Math.random() < 0.5 ? -1 : 1;
    ship.localToWorld(emissionScratch.set(side * 2.28, 0.28, 0.55));
    vapor.emitWing(emissionScratch.x, emissionScratch.y, emissionScratch.z, side, strength);
  }

  vapor.update(dt);
}

/* ===========================================================================
   SHIP ANIMATION / CAMERA
   =========================================================================== */

function updateShipVisual(dt) {
  const t = elapsed.value;

  if (game.mode === 'menu') {
    const autoX = Math.sin(t * 0.52) * 3.15 + Math.sin(t * 0.23 + 1.4) * 0.65;
    game.playerX = autoX;
    game.steerVelocity = Math.cos(t * 0.52) * 1.64;
  } else if (game.mode === 'countdown' || game.mode === 'running') {
    const steerInput = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    game.steerVelocity = damp(game.steerVelocity, steerInput * 10.6, 10.5, dt);
    game.playerX += game.steerVelocity * dt;
    if (game.playerX > 9.55) {
      game.playerX = 9.55;
      game.steerVelocity = Math.min(0, game.steerVelocity);
    } else if (game.playerX < -9.55) {
      game.playerX = -9.55;
      game.steerVelocity = Math.max(0, game.steerVelocity);
    }
  } else {
    game.steerVelocity = damp(game.steerVelocity, 0, 3.2, dt);
  }

  if (!game.shipAlive) {
    shipShadow.position.x = damp(shipShadow.position.x, game.playerX, 5, dt);
    return;
  }

  const hover = 0.92 + Math.sin(t * 2.1) * 0.028 + Math.sin(t * 5.6) * 0.008 + (game.boosting ? 0.035 : 0);
  ship.position.x = damp(ship.position.x, game.playerX, 18, dt);
  ship.position.y = damp(ship.position.y, hover, 8, dt);

  let bankTarget = -game.steerVelocity * 0.026 - ((input.right ? 1 : 0) - (input.left ? 1 : 0)) * 0.14;
  if (game.mode === 'menu') bankTarget += Math.sin(t * 0.52 + 0.8) * 0.06;
  ship.rotation.z = damp(ship.rotation.z, bankTarget, 7.5, dt);
  ship.rotation.y = damp(ship.rotation.y, -game.steerVelocity * 0.017, 7, dt);
  ship.rotation.x = damp(ship.rotation.x, -0.015 - (game.boosting ? 0.04 : 0), 5, dt);

  const speedNorm = clamp(game.speed / MAX_SPEED_UNITS, 0, 1.1);
  const compactShip = camera.aspect < 0.9;
  ship.scale.setScalar(compactShip ? 0.92 : 1);
  const flameBoost = game.boosting ? 1 : 0;
  for (const engine of engineObjects) {
    const flicker = 0.87 + Math.sin(t * 38 + engine.side * 2.1) * 0.13;
    engine.outerFlame.scale.set(1, 1, (0.72 + speedNorm * 0.75 + flameBoost * 1.65) * flicker);
    engine.innerFlame.scale.set(1, 1, (0.7 + speedNorm * 0.7 + flameBoost * 1.3) * flicker);
    engine.outerFlame.material.opacity = 0.2 + speedNorm * 0.08 + flameBoost * 0.12;
    engine.innerFlame.material.opacity = 0.48 + speedNorm * 0.2 + flameBoost * 0.22;
    engine.glow.scale.setScalar(0.88 + speedNorm * 0.12 + flameBoost * 0.2 + flicker * 0.04);
    engine.glow.material.opacity = 0.38 + speedNorm * 0.14 + flameBoost * 0.14;
  }
  enginePointLight.intensity = 2.2 + speedNorm * 2.2 + flameBoost * 4 + Math.sin(t * 24) * 0.7;

  const shieldActive = game.invulnerable > 0 && game.shipAlive;
  shield.visible = shieldActive;
  if (shieldActive) {
    const flash = 0.5 + 0.5 * Math.sin(t * 28);
    shield.material.opacity = 0.035 + flash * 0.075;
    shield.rotation.y += dt * 2.2;
    shield.rotation.x += dt * 0.8;
  }

  shipShadow.position.x = damp(shipShadow.position.x, game.playerX, 18, dt);
  shipShadow.position.z = -0.5;
  shipShadow.material.opacity = 0.72;
  shipShadow.scale.setScalar((compactShip ? 0.92 : 1) * (1 + speedNorm * 0.08));

  shipAura.position.x = damp(shipAura.position.x, game.playerX, 18, dt);
  shipAura.material.opacity = damp(
    shipAura.material.opacity,
    0.12 + speedNorm * 0.075 + (game.boosting ? 0.08 : 0),
    5,
    dt,
  );
  const auraBase = compactShip ? 0.92 : 1;
  shipAura.scale.set(
    auraBase * (1 + Math.sin(t * 2.0) * 0.02),
    auraBase * (1 + speedNorm * 0.18),
    1,
  );

  ship.updateMatrixWorld(true);
}

function updateCamera(dt) {
  const speedNorm = clamp(game.speed / MAX_SPEED_UNITS, 0, 1);
  const boost = game.boosting ? 1 : 0;
  const t = elapsed.value;
  const portrait = camera.aspect < 0.9;

  // Portrait screens need a longer lens position and a tighter camera follow so
  // the wide craft and its vapor wake stay inside the narrow horizontal frustum.
  const followFactor = portrait ? 0.92 : 0.42;
  const lookFactor = portrait ? 0.9 : 0.34;
  const baseY = portrait ? 3.52 : 3.2;
  const baseZ = portrait ? 11.4 : 8.6;
  const baseFov = portrait ? 62 : 60;

  camera.position.x = damp(camera.position.x, game.playerX * followFactor, 4.4, dt);
  camera.position.y = damp(camera.position.y, baseY - boost * 0.045 + speedNorm * 0.06, 3.6, dt);
  camera.position.z = damp(camera.position.z, baseZ + speedNorm * 0.12 + boost * 0.08, 3, dt);

  cameraLookTarget.set(
    game.playerX * lookFactor,
    (portrait ? 1.36 : 1.3) - boost * 0.02,
    portrait ? -24 : -22,
  );
  camera.lookAt(cameraLookTarget);

  const targetFov = baseFov + speedNorm * 2.4 + boost * 6.2 + (game.mode === 'over' ? -1.5 : 0);
  camera.fov = damp(camera.fov, targetFov, 2.8, dt);
  camera.updateProjectionMatrix();

  const shakeAmount = REDUCED_MOTION ? game.shake * 0.02 : game.shake * 0.11 + speedNorm * 0.006 + boost * 0.007;
  if (shakeAmount > 0.0001) {
    camera.position.x += Math.sin(t * 53.1) * shakeAmount;
    camera.position.y += Math.cos(t * 47.3) * shakeAmount * 0.65;
    camera.rotation.z += Math.sin(t * 41.7) * shakeAmount * 0.065;
  }
  camera.rotation.z += -ship.rotation.z * 0.075;

  vapor.setViewportMetrics();
}


/* ===========================================================================
   RUN SIMULATION
   =========================================================================== */

function updateSpeedAndResources(dt) {
  const mode = game.mode;

  game.invulnerable = Math.max(0, game.invulnerable - dt);
  game.shake = damp(game.shake, 0, 2.6, dt);

  if (mode === 'menu') {
    game.speed = damp(game.speed, 26 + Math.sin(elapsed.value * 0.7) * 2.2, 1.4, dt);
    game.boosting = false;
    game.braking = false;
    game.lastBoost = false;
    return;
  }

  if (mode === 'countdown') {
    game.speed = damp(game.speed, 30.5, 1.4, dt);
    game.boosting = false;
    game.braking = false;
    game.lastBoost = false;
    game.boost = clamp(game.boost + 2 * dt, 0, 100);
    return;
  }

  if (mode === 'running') {
    const baseSpeed = 38 + Math.min(game.distance * 0.0065, 16.5);
    const canBoost = input.boost && game.boost > 0.5 && !input.brake && !game.boostLocked;
    const wasBoosting = game.boosting;

    game.braking = input.brake;
    game.boosting = canBoost;

    if (game.boosting && !wasBoosting) {
      audio.boostIgnite();
    }

    let target = baseSpeed;
    if (game.boosting) target += 19;
    if (game.braking) target -= 18;

    game.speed = damp(game.speed, target, game.braking ? 4.2 : 1.9, dt);

    if (game.boosting) {
      game.boost = Math.max(0, game.boost - 24 * dt);
      if (game.boost <= 0) {
        game.boost = 0;
        game.boosting = false;
        game.boostLocked = true;
        showToast('VAPOR CHARGE EMPTY', 'is-hot');
      }
    } else {
      game.boost = Math.min(100, game.boost + (game.braking ? 7.5 : 4.8) * dt);
      if (!input.boost) game.boostLocked = false;
    }

    game.distance += game.speed * dt;
    game.score += game.speed * dt * (1.55 + (game.boosting ? 1.05 : 0));
    game.topSpeed = Math.max(game.topSpeed, game.speed);
    game.runTime += dt;

    game.spawnTimer -= game.speed * dt;
    if (game.spawnTimer <= 0) {
      spawnWave();
      const gap = clamp(84 - game.distance * 0.011, 44, 84);
      game.spawnTimer = gap * randomRange(0.92, 1.08);
    }

    game.lastBoost = game.boosting;
    return;
  }

  if (mode === 'over') {
    game.speed = damp(game.speed, 5.5, 1.1, dt);
    game.boosting = false;
    game.braking = false;
    game.deathTimer += dt;
  }
}

function updateCountdown(dt) {
  if (game.mode !== 'countdown') return;
  game.countdown -= dt;

  if (game.countdown > 0) {
    const number = Math.ceil(game.countdown);
    if (number !== game.countdownShown) {
      game.countdownShown = number;
      setCountdownNumber(String(number), false);
      audio.countdownTick(false);
    }
    return;
  }

  if (game.countdownShown !== 0) {
    game.countdownShown = 0;
    game.goTimer = 0;
    setCountdownNumber('GO', true);
    audio.countdownTick(true);
  }

  game.goTimer += dt;
  if (game.goTimer > 0.5) {
    game.mode = 'running';
    game.spawnTimer = 48;
    dom.countdown.classList.remove('is-active');
    dom.countdown.setAttribute('aria-hidden', 'true');
  }
}

function setCountdownNumber(text, isGo) {
  dom.countdownNum.textContent = text;
  dom.countdownNum.classList.toggle('is-go', isGo);
  dom.countdownNum.classList.remove('is-pop');
  void dom.countdownNum.offsetWidth;
  dom.countdownNum.classList.add('is-pop');
}

/* ===========================================================================
   UI
   =========================================================================== */

const hudCache = {
  speed: -1,
  score: -1,
  best: -1,
  distance: '',
  sector: '',
  boost: -1,
  drive: '',
  speedFill: -1,
  boostFill: -1,
};
const hullCells = Array.from(dom.hull.querySelectorAll('.hull__cell'));
const boostMeter = dom.boostFill.parentElement;
const speedMeter = dom.speedFill.parentElement;

function setTextIfChanged(node, value, key) {
  if (hudCache[key] !== value) {
    hudCache[key] = value;
    node.textContent = value;
  }
}

function updateHud(force = false) {
  const speedKmh = Math.round(game.speed * SPEED_TO_KMH);
  const score = Math.floor(game.score);
  const distanceKm = (game.distance * 0.002).toFixed(2);
  const sector = String(Math.min(99, 1 + Math.floor(game.distance / 1300))).padStart(2, '0');
  const boostRounded = Math.round(game.boost);

  if (force || score !== hudCache.score) {
    hudCache.score = score;
    dom.score.innerHTML = scoreMarkup(score);
  }
  if (force || game.best !== hudCache.best) {
    hudCache.best = game.best;
    dom.best.innerHTML = scoreMarkup(game.best);
    dom.menuBest.innerHTML = scoreMarkup(game.best);
  }
  if (force || speedKmh !== hudCache.speed) {
    hudCache.speed = speedKmh;
    dom.speed.textContent = String(speedKmh).padStart(3, '0');
  }
  if (force || distanceKm !== hudCache.distance) {
    hudCache.distance = distanceKm;
    dom.distance.textContent = distanceKm;
  }
  if (force || sector !== hudCache.sector) {
    hudCache.sector = sector;
    dom.sector.textContent = sector;
  }
  if (force || boostRounded !== hudCache.boost) {
    hudCache.boost = boostRounded;
    dom.boostPct.textContent = `${boostRounded}%`;
  }

  const boostRatio = clamp(game.boost / 100, 0, 1);
  const boostFill = Math.round(boostRatio * 200) / 200;
  if (force || boostFill !== hudCache.boostFill) {
    hudCache.boostFill = boostFill;
    dom.boostFill.style.transform = `scaleX(${boostFill})`;
  }

  const speedFill = Math.round(clamp(speedKmh / 420, 0, 1) * 100) / 100;
  if (force || speedFill !== hudCache.speedFill) {
    hudCache.speedFill = speedFill;
    dom.speedFill.style.transform = `scaleX(${speedFill})`;
  }

  let driveMode = 'CRUISE';
  if (game.mode === 'menu') driveMode = 'STANDBY';
  else if (game.mode === 'countdown') driveMode = 'SYNCING';
  else if (game.mode === 'paused') driveMode = 'PAUSED';
  else if (game.mode === 'over') driveMode = 'OFFLINE';
  else if (game.boosting) driveMode = 'OVERDRIVE';
  else if (game.braking) driveMode = 'BRAKING';
  else if (game.speed > 58) driveMode = 'REDLINE';

  if (force || driveMode !== hudCache.drive) {
    hudCache.drive = driveMode;
    dom.driveMode.textContent = driveMode;
    dom.driveMode.classList.toggle('is-boosting', driveMode === 'OVERDRIVE');
  }

  boostMeter.classList.toggle('is-boosting', game.boosting);
  boostMeter.classList.toggle('is-low', game.boost < 25);
  dom.boostFx.classList.toggle('is-active', game.boosting && game.mode === 'running');
}

function updateHullDisplay(force = false) {
  for (let i = 0; i < hullCells.length; i += 1) {
    hullCells[i].classList.toggle('is-on', i < game.hull);
  }
  dom.hull.classList.toggle('is-critical', game.hull === 1);
  const labels = ['OFFLINE', 'CRITICAL', 'DAMAGED', 'STABLE'];
  dom.hullText.textContent = labels[clamp(game.hull, 0, 3)];
}

function showToast(message, variant = '') {
  window.clearTimeout(toastTimer);
  dom.toast.className = 'hud-toast is-visible';
  if (variant) dom.toast.classList.add(variant);
  dom.toast.textContent = message;
  toastTimer = window.setTimeout(() => {
    dom.toast.classList.remove('is-visible');
  }, 1450);
}

function hideToast() {
  window.clearTimeout(toastTimer);
  dom.toast.classList.remove('is-visible');
}

function setScreenActive(screen, active) {
  screen.classList.toggle('is-active', active);
  screen.setAttribute('aria-hidden', active ? 'false' : 'true');
}

function captureFinalStats() {
  const finalScore = Math.floor(game.score);
  const isNewBest = finalScore > game.best && finalScore > 0;
  if (isNewBest) {
    game.best = finalScore;
    storeBest(finalScore);
  }

  game.finalScore = finalScore;
  game.finalNewBest = isNewBest;
  game.finalDistance = (game.distance * 0.002).toFixed(2);
  game.finalSpeed = Math.round(game.topSpeed * SPEED_TO_KMH);

  dom.finalScore.innerHTML = scoreMarkup(finalScore);
  dom.finalDistance.textContent = game.finalDistance;
  dom.finalSpeed.textContent = String(game.finalSpeed).padStart(3, '0');
  dom.newBest.hidden = !isNewBest;
  dom.best.innerHTML = scoreMarkup(game.best);
  dom.menuBest.innerHTML = scoreMarkup(game.best);
}

function showGameOverScreen() {
  if (game.mode !== 'over' || game.overShown) return;
  game.overShown = true;
  dom.hud.classList.remove('is-active');
  dom.hud.setAttribute('aria-hidden', 'true');
  dom.countdown.classList.remove('is-active');
  dom.countdown.setAttribute('aria-hidden', 'true');
  setScreenActive(dom.pauseScreen, false);
  setScreenActive(dom.overScreen, true);
  dom.toast.classList.remove('is-visible');
  dom.restartBtn.focus({ preventScroll: true });
}

/* ===========================================================================
   STATE TRANSITIONS
   =========================================================================== */

function clearInputs() {
  input.left = false;
  input.right = false;
  input.boost = false;
  input.brake = false;
  dom.touchLeft.classList.remove('is-pressed');
  dom.touchRight.classList.remove('is-pressed');
  dom.touchBoost.classList.remove('is-pressed');
  dom.touchBrake.classList.remove('is-pressed');
}

function resetRunState() {
  window.clearTimeout(overlayTimer);
  overlayTimer = 0;

  game.mode = 'countdown';
  game.score = 0;
  game.hull = 3;
  game.speed = 26;
  game.distance = 0;
  game.boost = 100;
  game.boosting = false;
  game.braking = false;
  game.boostLocked = false;
  game.playerX = 0;
  game.steerVelocity = 0;
  game.invulnerable = 0;
  game.shake = 0;
  game.topSpeed = 0;
  game.spawnTimer = 48;
  game.runTime = 0;
  game.lastBoost = false;
  game.shipAlive = true;
  game.overShown = false;
  game.deathTimer = 0;

  for (const barrier of barrierPool) deactivateBarrier(barrier);
  for (const orb of orbPool) deactivateOrb(orb);

  vapor.clear();
  ship.visible = true;
  ship.position.set(0, 0.92, 0);
  ship.rotation.set(0, 0, 0);
  shipShadow.visible = true;
  shipAura.visible = true;
  shipShadow.position.x = 0;
  shipAura.position.x = 0;
  shipAura.material.opacity = 0.32;
  shield.visible = false;

  document.body.classList.add('is-racing');
  dom.hud.classList.add('is-active');
  dom.hud.setAttribute('aria-hidden', 'false');
  dom.boostFx.classList.remove('is-active');
  dom.hitFlash.classList.remove('is-hit', 'is-dead');
  dom.pauseBtn.setAttribute('aria-pressed', 'false');
  dom.pauseBtn.setAttribute('aria-label', 'Pause game');
  dom.newBest.hidden = true;

  setScreenActive(dom.pauseScreen, false);
  setScreenActive(dom.overScreen, false);

  updateHullDisplay(true);
  updateHud(true);

  ship.updateMatrixWorld(true);
  resetTrails();
}

function startRun() {
  if (!ready || (game.mode !== 'menu' && game.mode !== 'over')) return;

  window.clearTimeout(overlayTimer);
  overlayTimer = 0;
  audio.init();
  audio.startEngine();

  resetRunState();

  const menuVisible = dom.menu.classList.contains('is-active');
  if (menuVisible) {
    dom.menu.classList.remove('is-active');
    dom.menu.classList.add('is-leaving');
    dom.menu.setAttribute('aria-hidden', 'true');
    window.setTimeout(() => dom.menu.classList.remove('is-leaving'), 620);
  }
  setScreenActive(dom.overScreen, false);

  dom.countdown.classList.add('is-active');
  dom.countdown.setAttribute('aria-hidden', 'false');
  game.countdown = 3;
  game.countdownShown = 3;
  game.goTimer = 0;
  setCountdownNumber('3', false);
  audio.countdownTick(false);

  dom.startBtn.blur();
  dom.restartBtn.blur();
}

function pauseGame() {
  if (game.mode !== 'running' && game.mode !== 'countdown') return;
  game.pausedFrom = game.mode;
  game.mode = 'paused';
  game.boosting = false;
  clearInputs();
  setScreenActive(dom.pauseScreen, true);
  dom.pauseBtn.setAttribute('aria-pressed', 'true');
  dom.pauseBtn.setAttribute('aria-label', 'Resume game');
  dom.countdown.classList.remove('is-active');
  dom.boostFx.classList.remove('is-active');
  audio.duck(true);
  dom.resumeBtn.focus({ preventScroll: true });
}

function resumeGame() {
  if (game.mode !== 'paused') return;
  game.mode = game.pausedFrom === 'countdown' ? 'countdown' : 'running';
  if (game.mode === 'countdown') {
    dom.countdown.classList.add('is-active');
    dom.countdown.setAttribute('aria-hidden', 'false');
  }
  setScreenActive(dom.pauseScreen, false);
  dom.pauseBtn.setAttribute('aria-pressed', 'false');
  dom.pauseBtn.setAttribute('aria-label', 'Pause game');
  audio.init();
  audio.duck(false);
  dom.resumeBtn.blur();
}

function toggleSound() {
  const enabled = audio.toggle();
  dom.soundBtn.setAttribute('aria-pressed', String(enabled));
  dom.soundBtn.setAttribute('aria-label', enabled ? 'Mute sound' : 'Enable sound');
  if (enabled) {
    audio.init();
    audio.beep(740, 0.08, 'triangle', 0.045);
  }
}

/* ===========================================================================
   INPUT
   =========================================================================== */

const keyMap = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'boost',
  KeyW: 'boost',
  ArrowDown: 'brake',
  KeyS: 'brake',
};

window.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.code === 'KeyM') {
    event.preventDefault();
    toggleSound();
    return;
  }

  if (event.code === 'KeyP' || event.code === 'Escape') {
    event.preventDefault();
    if (game.mode === 'paused') resumeGame();
    else pauseGame();
    return;
  }

  const isStartKey = event.code === 'Space' || event.code === 'Enter';
  if (isStartKey) {
    if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
    event.preventDefault();
    if (event.repeat) return;

    if (game.mode === 'menu') {
      startRun();
    } else if (game.mode === 'over') {
      startRun();
    } else if (game.mode === 'paused') {
      resumeGame();
    } else if ((game.mode === 'running' || game.mode === 'countdown') && event.code === 'Space') {
      input.boost = true;
    }
    return;
  }

  if (event.code === 'KeyR' && game.mode === 'over') {
    event.preventDefault();
    startRun();
    return;
  }

  const mapped = keyMap[event.code];
  if (!mapped) return;
  event.preventDefault();
  if (event.repeat) return;
  input[mapped] = true;
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') input.boost = false;
  const mapped = keyMap[event.code];
  if (mapped) input[mapped] = false;
});

window.addEventListener('blur', () => {
  clearInputs();
  if (game.mode === 'running' || game.mode === 'countdown') pauseGame();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && (game.mode === 'running' || game.mode === 'countdown')) pauseGame();
});

function bindTouchButton(button, inputKey) {
  const press = (event) => {
    event.preventDefault();
    input[inputKey] = true;
    button.classList.add('is-pressed');
    if (event.pointerId !== undefined && button.setPointerCapture) {
      try {
        button.setPointerCapture(event.pointerId);
      } catch (error) {
        /* Pointer capture is a bonus, not a requirement. */
      }
    }
  };
  const release = (event) => {
    if (event) event.preventDefault();
    input[inputKey] = false;
    button.classList.remove('is-pressed');
  };

  button.addEventListener('pointerdown', press);
  button.addEventListener('pointerup', release);
  button.addEventListener('pointercancel', release);
  button.addEventListener('lostpointercapture', release);
  button.addEventListener('contextmenu', (event) => event.preventDefault());
}

bindTouchButton(dom.touchLeft, 'left');
bindTouchButton(dom.touchRight, 'right');
bindTouchButton(dom.touchBoost, 'boost');
bindTouchButton(dom.touchBrake, 'brake');

dom.startBtn.addEventListener('click', () => {
  startRun();
});
dom.restartBtn.addEventListener('click', () => {
  startRun();
});
dom.resumeBtn.addEventListener('click', () => {
  resumeGame();
});
dom.pauseBtn.addEventListener('click', () => {
  if (game.mode === 'paused') resumeGame();
  else pauseGame();
  dom.pauseBtn.blur();
});
dom.soundBtn.addEventListener('click', () => {
  toggleSound();
  dom.soundBtn.blur();
});
document.addEventListener('contextmenu', (event) => {
  if (event.target.closest('button')) event.preventDefault();
});

/* ===========================================================================
   RESIZE
   =========================================================================== */

let resizeQueued = false;
function resizeRenderer() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(width, height);
  bloomPass.setSize(width, height);
  vapor.setViewportMetrics();
  resizeQueued = false;
}

window.addEventListener('resize', () => {
  if (resizeQueued) return;
  resizeQueued = true;
  window.requestAnimationFrame(resizeRenderer);
});

/* ===========================================================================
   AUDIO FOLLOW
   =========================================================================== */

function updateAudio(dt) {
  game.audioTimer -= dt;
  if (game.audioTimer > 0) return;
  game.audioTimer = 0.12;

  if (game.mode === 'running' || game.mode === 'countdown') {
    audio.setEngine(clamp(game.speed / MAX_SPEED_UNITS, 0, 1.2), game.boosting);
  }
}

/* ===========================================================================
   MAIN UPDATE / RENDER LOOP
   =========================================================================== */

function updateFrame(dt) {
  elapsed.value += dt;

  if (game.mode === 'countdown') updateCountdown(dt);
  updateSpeedAndResources(dt);
  updateShipVisual(dt);

  const delta = game.speed * dt;
  worldScroll.value += delta;
  updateCity(delta);
  updatePosts(delta);
  updateGatesAndBillboards(delta);
  updateBarriers(dt, delta);
  updateOrbs(dt, delta);
  updateSpeedStreaks(dt);
  updateVapor(dt);
  updateCamera(dt);
  updateHud(false);
  updateAudio(dt);
}

function animate() {
  window.requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!document.hidden && ready && game.mode !== 'paused') {
    updateFrame(dt);
  }

  composer.render();
}

/* ===========================================================================
   BOOT
   =========================================================================== */

function initialize() {
  game.mode = 'menu';
  game.speed = 31;
  game.best = loadBest();

  setScreenActive(dom.menu, true);
  setScreenActive(dom.pauseScreen, false);
  setScreenActive(dom.overScreen, false);
  dom.countdown.classList.remove('is-active');
  dom.countdown.setAttribute('aria-hidden', 'true');
  dom.hud.classList.remove('is-active');
  dom.hud.setAttribute('aria-hidden', 'true');

  dom.best.innerHTML = scoreMarkup(game.best);
  dom.menuBest.innerHTML = scoreMarkup(game.best);
  dom.score.innerHTML = scoreMarkup(0);
  dom.speed.textContent = '000';
  dom.boostPct.textContent = '100%';
  dom.boostFill.style.transform = 'scaleX(1)';
  dom.speedFill.style.transform = 'scaleX(0)';
  updateHullDisplay(true);
  updateHud(true);

  ship.updateMatrixWorld(true);
  resetTrails();

  ready = true;
  dom.startBtn.disabled = false;
  dom.bootStatus.classList.add('is-ready');
  const bootLabel = dom.bootStatus.querySelector('span');
  if (bootLabel) bootLabel.textContent = 'RENDER CORE ONLINE';

  clock.getDelta();
  animate();
}

window.addEventListener('error', (event) => {
  if (!ready) {
    dom.errorScreen.hidden = false;
    const message = dom.errorScreen.querySelector('p');
    if (message) message.textContent = 'The render core hit an unexpected error. Reload the page or enable hardware acceleration, then try again.';
  }
});

async function bootGame() {
  try {
    // Local fonts are tiny; this makes the procedural gate/billboard lettering
    // crisp without ever blocking boot for longer than 2.2 seconds.
    if (document.fonts && document.fonts.ready) {
      await Promise.race([
        document.fonts.ready.then(() => undefined),
        new Promise((resolve) => window.setTimeout(resolve, 2200)),
      ]).catch(() => {});
    }

    initialize();
    window.__NEON_READY__ = true;

    /* Opt-in console handle for debugging and automated smoke tests. */
    if (new URLSearchParams(window.location.search).has('debug')) {
      window.__NEON_RACER__ = {
        state: game,
        start: startRun,
        pause: pauseGame,
        resume: resumeGame,
        damage() {
          if (game.mode === 'running' && game.invulnerable <= 0) {
            game.hull = Math.max(1, game.hull - 1);
            game.invulnerable = 1.5;
            game.shake = 1;
          }
        },
        crash() {
          if (game.mode === 'running') {
            game.hull = 0;
            game.invulnerable = 0;
            lethalImpact();
          }
        },
        hit() {
          if (game.mode !== 'running') return;
          game.invulnerable = 0;
          const barrier = activateBarrier(game.playerX, 0);
          if (barrier) resolveBarrierImpact(barrier);
        },
      };
    }
  } catch (error) {
    console.error('[NEON RACER] boot failure', error);
    dom.errorScreen.hidden = false;
    const message = dom.errorScreen.querySelector('p');
    if (message) message.textContent = 'The render core could not initialise. Reload the page or enable hardware acceleration, then try again.';
  }
}

bootGame();
