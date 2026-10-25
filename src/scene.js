/**
 * Three.js presentation layer.
 *
 * World mapping: ECL (x, y, z) -> Three (x, z, -y).
 * Distances: 1 AU = 20 world units (linear, no compression).
 * Disc sizes: physical radii are multiplied by 12 for visibility; this is
 * labelled in the UI and is not a distance-scale distortion.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CATALOG, CATALOG_BY_ID } from './catalog.js';
import { AU_KM, DAY_MS, northPoleDirection, orbitPolyline } from './astronomy.js';

const AU_TO_WORLD = 20;
const SIZE_EXAGGERATION = 12;
const WORLD_UNITS_PER_KM = (AU_TO_WORLD / AU_KM) * SIZE_EXAGGERATION;
const ORBIT_SEGMENTS = 288;
const STAR_COUNT = 1700;
const CAM_PRESET = {
  system: {
    direction: new THREE.Vector3(0.66, 0.47, 0.59).normalize(),
    fitRadius: 660,
    margin: 1.72,
    minDistance: 820,
  },
  inner: {
    direction: new THREE.Vector3(0.61, 0.58, 0.54).normalize(),
    fitRadius: 36,
    margin: 1.3,
    minDistance: 72,
  },
};

const PRIORITY = ['sun', 'earth', 'jupiter', 'saturn', 'neptune', 'uranus', 'mars', 'venus', 'mercury', 'moon'];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function smoothNoise(x, y, seed) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const hash = (ix, iy) => {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const n00 = hash(xi, yi);
  const n10 = hash(xi + 1, yi);
  const n01 = hash(xi, yi + 1);
  const n11 = hash(xi + 1, yi + 1);
  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

/**
 * Seam-free horizontal noise for equirectangular textures. The longitude is
 * mapped around a circle before sampling, so u=0 and u=1 meet exactly.
 */
function periodicFbm(cosU, sinU, v, seed, scaleU, scaleV, octaves = 4) {
  let value = 0;
  let amplitude = 0.5;
  let frequency = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i += 1) {
    const x = cosU * scaleU * frequency + 31 + i * 2.7;
    const y = sinU * scaleU * frequency + v * scaleV * frequency + 17;
    value += smoothNoise(x, y, seed + i * 7.3) * amplitude;
    norm += amplitude;
    amplitude *= 0.5;
    frequency *= 2.03;
  }
  return value / norm;
}

function colorFromDefinition(hex) {
  const color = new THREE.Color(hex);
  const hsl = {};
  color.getHSL(hsl);
  return hsl;
}

function createTexture(def) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(canvas.width, canvas.height);
  const data = image.data;
  const hsl = colorFromDefinition(def.color);
  const seed = CATALOG.indexOf(def) + 1;
  const gasGiant = ['jupiter', 'saturn', 'uranus', 'neptune'].includes(def.id);
  const rocky = ['mercury', 'moon', 'mars', 'venus', 'earth'].includes(def.id);
  const cosTable = new Float32Array(canvas.width);
  const sinTable = new Float32Array(canvas.width);
  for (let x = 0; x < canvas.width; x += 1) {
    const angle = (x / canvas.width) * Math.PI * 2;
    cosTable[x] = Math.cos(angle);
    sinTable[x] = Math.sin(angle);
  }

  for (let y = 0; y < canvas.height; y += 1) {
    const v = y / (canvas.height - 1);
    const latitude = (0.5 - v) * Math.PI;
    for (let x = 0; x < canvas.width; x += 1) {
      const u = x / (canvas.width - 1);
      let h = hsl.h;
      let s = hsl.s;
      let l = hsl.l;
      const large = periodicFbm(cosTable[x], sinTable[x], v, seed, 3.3, 2.4);
      const fine = periodicFbm(cosTable[x], sinTable[x], v, seed + 9, 8.2, 11.5);

      if (gasGiant) {
        const wave = Math.sin(v * Math.PI * (def.id === 'jupiter' ? 15 : 11) + large * 2.1);
        const band = Math.sin(v * Math.PI * (def.id === 'saturn' ? 24 : 18) + fine * 0.7);
        const striation = Math.sin(v * Math.PI * 74 + fine * 0.6);
        l += wave * 0.072 + band * 0.03 + striation * 0.012 + (large - 0.5) * 0.04;
        s += (large - 0.5) * 0.06;
        if (def.id === 'neptune') {
          l -= 0.02;
          s += 0.03;
          if (u > 0.56 && u < 0.67 && v > 0.56 && v < 0.65) l -= 0.055;
        }
        if (def.id === 'jupiter') {
          const oval = ((u - 0.62) / 0.085) ** 2 + ((v - 0.62) / 0.035) ** 2;
          if (oval < 1) {
            l += (1 - oval) * 0.055;
            h -= 0.015;
            s += 0.06;
          }
        }
      } else if (rocky) {
        const lowFrequencyContrast = (def.id === 'mercury' || def.id === 'moon') ? 0.045 : 0.14;
        l += (large - 0.5) * lowFrequencyContrast + (fine - 0.5) * 0.03;
        s += (fine - 0.5) * 0.04;
        if (def.id === 'earth') {
          const land = periodicFbm(cosTable[x], sinTable[x], v, seed + 30, 2.9, 2.1);
          if (land > 0.585) {
            h = 0.24 + (land - 0.585) * 0.35;
            s = 0.28;
            l = 0.33 + (land - 0.585) * 0.7;
            if (land > 0.74) l = 0.52;
          }
          if (v < 0.12 || v > 0.88) {
            const polar = Math.pow(Math.abs(v - 0.5) / 0.5, 5);
            l += polar * 0.22;
            s *= 0.65;
          }
        } else if (def.id === 'mars') {
          if (v < 0.095 || v > 0.915) {
            const polar = Math.pow(Math.abs(v - 0.5) / 0.5, 5);
            l += polar * 0.16;
            s *= 0.6;
          }
        } else if (def.id === 'venus') {
          const swirl = Math.sin((u * 4 + v * 8 + large * 2.2) * Math.PI);
          l += swirl * 0.025;
          s -= 0.02;
        } else if (def.id === 'moon' || def.id === 'mercury') {
          if (fine > 0.72) l -= 0.07;
          if (large < 0.25) l += 0.045;
        }
      }

      const [r, g, b] = hslToRgb((h + 1) % 1, clamp(s, 0, 1), clamp(l, 0.06, 0.94));
      const idx = (y * canvas.width + x) * 4;
      data[idx] = Math.round(r * 255);
      data[idx + 1] = Math.round(g * 255);
      data[idx + 2] = Math.round(b * 255);
      data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  if (['mercury', 'moon', 'mars'].includes(def.id)) {
    addCraters(ctx, canvas, seed);
  }
  if (def.id === 'earth') {
    addCloudWisps(ctx, canvas, seed);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 4;
  return texture;
}

function addCraters(ctx, canvas, seed) {
  const random = mulberry32(1777 + seed * 101);
  const count = Math.round(220 * (canvas.width / 512));
  for (let i = 0; i < count; i += 1) {
    const cx = random() * canvas.width;
    const cy = canvas.height * (0.08 + random() * 0.84);
    const radius = 0.5 + Math.pow(random(), 2.8) * 4.5;
    const squash = 0.55 + random() * 0.4;
    for (const offset of [-canvas.width, 0, canvas.width]) {
      ctx.beginPath();
      ctx.ellipse(cx + offset, cy, radius, radius * squash, random() * Math.PI, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(22, 22, 21, ${0.03 + random() * 0.05})`;
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(cx + offset, cy, radius * 1.05, radius * squash * 1.05, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(244, 238, 224, ${0.04 + random() * 0.05})`;
      ctx.lineWidth = Math.max(0.5, radius * 0.17);
      ctx.stroke();
    }
  }
}

function addCloudWisps(ctx, canvas, seed) {
  const random = mulberry32(4200 + seed);
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (let i = 0; i < 150; i += 1) {
    const x = random() * canvas.width;
    const y = canvas.height * (0.12 + random() * 0.76);
    const rx = 10 + random() * 55;
    const ry = 2 + random() * 8;
    const alpha = 0.025 + random() * 0.07;
    for (const offset of [-canvas.width, 0, canvas.width]) {
      ctx.beginPath();
      ctx.ellipse(x + offset, y, rx, ry, (random() - 0.5) * 0.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(245, 249, 255, ${alpha})`;
      ctx.fill();
    }
  }
  ctx.restore();
}

function createSunTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const u = x / canvas.width;
      const v = y / canvas.height;
      const angle = u * Math.PI * 2;
      const n = periodicFbm(Math.cos(angle), Math.sin(angle), v, 41, 5.2, 5.5, 3);
      const ridge = Math.sin((u * 18 + v * 11 + n) * Math.PI) * 0.5 + 0.5;
      const value = clamp(0.75 + n * 0.2 + ridge * 0.08, 0, 1);
      const idx = (y * canvas.width + x) * 4;
      dataSet(image.data, idx, 255, Math.round(196 + 45 * value), Math.round(95 + 58 * value), 255);
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function dataSet(data, idx, r, g, b, a) {
  data[idx] = r;
  data[idx + 1] = g;
  data[idx + 2] = b;
  data[idx + 3] = a;
}

function createRadialTexture(stops) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [offset, color] of stops) gradient.addColorStop(offset, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createStarTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.28, 'rgba(255,255,255,0.72)');
  gradient.addColorStop(0.6, 'rgba(210,224,255,0.2)');
  gradient.addColorStop(1, 'rgba(210,224,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(canvas);
}

function createRingGeometry(inner, outer, segments = 180) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (let j = 0; j < 2; j += 1) {
      const radius = j === 0 ? inner : outer;
      positions.push(cos * radius, 0, sin * radius);
      uvs.push(j, i / segments);
    }
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, d, a, d, c);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
}

function createRingTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 2;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createLinearGradient(0, 0, canvas.width, 0);
  const random = mulberry32(0x5a7c2);
  for (let i = 0; i <= 320; i += 1) {
    const t = i / 320;
    let alpha = 0.22
      + 0.15 * Math.sin(t * 48 + 1.2)
      + 0.09 * Math.sin(t * 113 + 0.4)
      + 0.045 * random();
    alpha *= Math.min(1, t / 0.045) * Math.min(1, (1 - t) / 0.06);
    if (t > 0.56 && t < 0.61) alpha *= 0.15;
    if (t > 0.2 && t < 0.24) alpha *= 0.34;
    if (t > 0.34 && t < 0.36) alpha *= 0.55;
    alpha = Math.max(0, Math.min(0.6, alpha));
    const warm = Math.round(218 + 22 * Math.min(1, alpha * 1.5));
    gradient.addColorStop(t, `rgba(${warm}, ${Math.round(warm * 0.94)}, ${Math.round(warm * 0.8)}, ${alpha.toFixed(3)})`);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

function eclipticToWorld(position, target = new THREE.Vector3()) {
  return target.set(
    position.x * AU_TO_WORLD,
    position.z * AU_TO_WORLD,
    -position.y * AU_TO_WORLD,
  );
}

function createCanvasElement(tag, className, parent) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (parent) parent.appendChild(element);
  return element;
}

export class SolarScene {
  constructor({ container, markerLayer, onSelect, onHover, reducedMotion = false }) {
    this.container = container;
    this.markerLayer = markerLayer;
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.reducedMotion = reducedMotion;
    this.catalog = CATALOG;
    this.byId = CATALOG_BY_ID;
    this.selectedId = 'earth';
    this.focusedId = null;
    this.snapshot = null;
    this.worldPositions = {};
    this.screenPositions = {};
    this.bodyEntries = {};
    this.labelEntries = {};
    this.orbitCaches = {};
    this.labelWidths = {};
    this.transition = null;
    this.focusLastPos = new THREE.Vector3();
    this.pointerDown = null;
    this.hoveredId = null;
    this.presetName = 'system';
    this._lastOrbitUpdate = 0;
    this._resizeHandler = () => this.resize();
    this._fontHandler = () => this.measureLabels();
    this._projectionHelper = new THREE.Vector3();
    this._cameraDirection = new THREE.Vector3();

    this._initRenderer();
    this._initScene();
    this._buildBodies();
    this._buildGrid();
    this._buildStars();
    this._buildLabels();
    this._bindEvents();
    this.resize();
    this.setView('system', { animate: false });
    this.setLabelsVisible(true);
  }

  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.domElement.setAttribute('aria-label', 'Interactive three-dimensional Solar System');
    this.container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.05, 14000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.rotateSpeed = 0.72;
    this.controls.zoomSpeed = 0.9;
    this.controls.panSpeed = 0.7;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.01;
    this.controls.maxDistance = 9000;
    this.controls.target.set(0, 0, 0);

    const hemi = new THREE.HemisphereLight(0x8299b4, 0x080c12, 0.42);
    this.scene.add(hemi);
    this.sunLight = new THREE.PointLight(0xffffff, 3.6, 0, 0);
    this.scene.add(this.sunLight);

    this.bodyGroup = new THREE.Group();
    this.scene.add(this.bodyGroup);
    this.orbitGroup = new THREE.Group();
    this.scene.add(this.orbitGroup);
    this.gridGroup = new THREE.Group();
    this.scene.add(this.gridGroup);
    this.starGroup = new THREE.Group();
    this.scene.add(this.starGroup);
    this.moonOrbitGroup = new THREE.Group();
    this.scene.add(this.moonOrbitGroup);

    this.bodyGeometry = new THREE.SphereGeometry(1, 64, 42);
    this.ringTexture = createRingTexture();
    this.sunTexture = createSunTexture();
    this.textureCache = {};
  }

  _buildBodies() {
    for (const def of this.catalog) {
      const entry = {
        def,
        radius: def.radiusKm * WORLD_UNITS_PER_KM,
        group: new THREE.Group(),
        spinPivot: new THREE.Group(),
      };
      entry.group.name = `body-${def.id}`;
      this.bodyGroup.add(entry.group);
      this.bodyEntries[def.id] = entry;

      if (def.id === 'sun') {
        this._buildSun(entry);
        continue;
      }

      if (!this.textureCache[def.texture]) {
        this.textureCache[def.texture] = createTexture(def);
      }
      const material = new THREE.MeshStandardMaterial({
        map: this.textureCache[def.texture],
        roughness: 0.92,
        metalness: 0,
        emissive: new THREE.Color(def.color).multiplyScalar(0.018),
        emissiveIntensity: 1,
      });
      entry.material = material;
      const mesh = new THREE.Mesh(this.bodyGeometry, material);
      mesh.scale.setScalar(entry.radius);
      entry.mesh = mesh;
      entry.spinPivot.add(mesh);
      entry.group.add(entry.spinPivot);

      if (def.rings) {
        this._buildRings(entry);
      }

      if (def.id !== 'moon') {
        const orbit = this._createOrbitLine(def, false);
        entry.orbit = orbit;
        this.orbitGroup.add(orbit.line);
      } else {
        const orbit = this._createOrbitLine(def, true);
        entry.orbit = orbit;
        this.moonOrbitGroup.add(orbit.line);
      }
    }

    this.moonOrbitGroup.visible = true;
  }

  _buildSun(entry) {
    const material = new THREE.MeshBasicMaterial({
      map: this.sunTexture,
      color: 0xffe3a5,
    });
    entry.material = material;
    const mesh = new THREE.Mesh(this.bodyGeometry, material);
    mesh.scale.setScalar(entry.radius);
    entry.mesh = mesh;
    entry.spinPivot.add(mesh);
    entry.group.add(entry.spinPivot);

    const glowTexture = createRadialTexture([
      [0, 'rgba(255,245,214,0.92)'],
      [0.16, 'rgba(255,223,152,0.54)'],
      [0.42, 'rgba(240,181,88,0.18)'],
      [0.7, 'rgba(218,141,48,0.04)'],
      [1, 'rgba(218,141,48,0)'],
    ]);
    const glowMaterial = new THREE.SpriteMaterial({
      map: glowTexture,
      color: 0xffd489,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      opacity: 0.9,
    });
    const glow = new THREE.Sprite(glowMaterial);
    glow.scale.setScalar(entry.radius * 6.2);
    glow.renderOrder = 3;
    entry.glow = glow;
    entry.group.add(glow);

    const innerGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: createRadialTexture([
        [0, 'rgba(255,255,240,0.95)'],
        [0.5, 'rgba(255,231,166,0.2)'],
        [1, 'rgba(255,220,140,0)'],
      ]),
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0.7,
    }));
    innerGlow.scale.setScalar(entry.radius * 2.8);
    entry.innerGlow = innerGlow;
    entry.group.add(innerGlow);
  }

  _buildRings(entry) {
    const inner = entry.radius * 1.24;
    const outer = entry.radius * 2.28;
    const geometry = createRingGeometry(inner, outer, 220);
    const material = new THREE.MeshBasicMaterial({
      map: this.ringTexture,
      transparent: true,
      color: 0xf0dbb4,
      opacity: 0.52,
      side: THREE.DoubleSide,
      depthWrite: false,
      alphaTest: 0.008,
    });
    const ring = new THREE.Mesh(geometry, material);
    ring.renderOrder = 2;
    entry.ring = ring;
    entry.ringGroup = new THREE.Group();
    entry.ringGroup.add(ring);
    entry.group.add(entry.ringGroup);
  }

  _createOrbitLine(def, moon) {
    const material = new LineMaterial({
      color: new THREE.Color(def.color),
      linewidth: moon ? 0.8 : 1.25,
      transparent: true,
      opacity: moon ? 0.24 : 0.28,
      depthWrite: false,
      vertexColors: false,
    });
    material.resolution.set(1, 1);
    const geometry = new LineGeometry();
    geometry.setPositions([0, 0, 0, 0, 0, 0]);
    const line = new Line2(geometry, material);
    line.frustumCulled = false;
    line.renderOrder = 1;
    return { line, material, baseColor: new THREE.Color(def.color), accentColor: new THREE.Color(def.accent), moon };
  }

  _buildGrid() {
    const positions = [];
    const ringRadii = [1, 2, 5, 10, 20, 30];
    for (const radiusAu of ringRadii) {
      const radius = radiusAu * AU_TO_WORLD;
      const segments = 220;
      for (let i = 0; i < segments; i += 1) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        positions.push(
          Math.cos(a0) * radius, 0, Math.sin(a0) * radius,
          Math.cos(a1) * radius, 0, Math.sin(a1) * radius,
        );
      }
    }
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      positions.push(0, 0, 0, cos * 30 * AU_TO_WORLD, 0, sin * 30 * AU_TO_WORLD);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const material = new THREE.LineBasicMaterial({
      color: 0x67809a,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    });
    const grid = new THREE.LineSegments(geometry, material);
    grid.renderOrder = 0;
    this.gridGroup.add(grid);
    this.gridMaterial = material;
    this.gridGroup.visible = false;
  }

  _buildStars() {
    const random = mulberry32(0x5e1ec7);
    const positions = [];
    const colors = [];
    const color = new THREE.Color();
    for (let i = 0; i < STAR_COUNT; i += 1) {
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      const radius = 2400 + random() * 1700;
      positions.push(
        Math.sin(phi) * Math.cos(theta) * radius,
        Math.cos(phi) * radius,
        Math.sin(phi) * Math.sin(theta) * radius,
      );
      const warmth = random();
      color.setHSL(0.56 + warmth * 0.1, 0.16 + random() * 0.2, 0.62 + random() * 0.3);
      colors.push(color.r, color.g, color.b);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({
      size: 1.35,
      sizeAttenuation: false,
      map: createStarTexture(),
      transparent: true,
      opacity: 0.62,
      vertexColors: true,
      depthWrite: false,
      alphaTest: 0.015,
    });
    const stars = new THREE.Points(geometry, material);
    stars.renderOrder = -10;
    this.starGroup.add(stars);
  }

  _buildLabels() {
    for (const def of this.catalog) {
      const label = createCanvasElement('div', 'body-label', this.markerLayer);
      label.dataset.bodyId = def.id;
      label.style.setProperty('--body-color', def.color);
      const button = createCanvasElement('button', 'body-label-hit', label);
      button.type = 'button';
      button.setAttribute('aria-label', `Select ${def.name}`);
      const dot = createCanvasElement('span', 'marker-dot', button);
      dot.setAttribute('aria-hidden', 'true');
      const text = createCanvasElement('span', 'label-text', button);
      text.textContent = def.name;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.onSelect(def.id, { focus: true });
      });
      button.addEventListener('pointerenter', () => this._setHovered(def.id));
      button.addEventListener('pointerleave', () => this._setHovered(null));
      button.addEventListener('focus', () => this._setHovered(def.id));
      button.addEventListener('blur', () => this._setHovered(null));
      this.labelEntries[def.id] = { root: label, button, text, dot, width: 80 };
    }
  }

  measureLabels() {
    for (const entry of Object.values(this.labelEntries)) {
      const measured = entry.button.offsetWidth;
      // A decluttered label has its text hidden, so offsetWidth shrinks to
      // just the dot. Keep the last full measurement instead of poisoning
      // subsequent collision calculations.
      if (measured > 30) entry.width = Math.max(48, measured);
      else if (!entry.width) entry.width = Math.max(48, 30 + entry.text.textContent.length * 6.2);
    }
    this._labelsNeedLayout = true;
  }

  _bindEvents() {
    window.addEventListener('resize', this._resizeHandler);
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(this._fontHandler).catch(() => {});
    }
    if (window.ResizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this.resize());
      this._resizeObserver.observe(this.container);
    }

    this.renderer.domElement.addEventListener('pointerdown', (event) => {
      if (this.transition) this._cancelTransition();
      this.pointerDown = { x: event.clientX, y: event.clientY, button: event.button };
    });
    this.renderer.domElement.addEventListener('pointerup', (event) => {
      if (!this.pointerDown || this.pointerDown.button !== 0) {
        this.pointerDown = null;
        return;
      }
      const dx = event.clientX - this.pointerDown.x;
      const dy = event.clientY - this.pointerDown.y;
      this.pointerDown = null;
      if (Math.hypot(dx, dy) > 7) return;
      const hit = this.pickAt(event.clientX, event.clientY);
      this.onSelect(hit, { focus: Boolean(hit), fromCanvas: true });
    });
    this.renderer.domElement.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      this._hoverPointer(event);
    });
    this.renderer.domElement.addEventListener('pointerleave', () => this._setHovered(null));
  }

  _hoverPointer(event) {
    const hit = this.pickAt(event.clientX, event.clientY, 20);
    this._setHovered(hit);
    this.canvas.classList.toggle('is-hovering', Boolean(hit));
  }

  _setHovered(id) {
    if (this.hoveredId === id) return;
    if (this.hoveredId && this.labelEntries[this.hoveredId]) {
      this.labelEntries[this.hoveredId].root.classList.remove('is-hover');
    }
    this.hoveredId = id;
    if (id && this.labelEntries[id]) {
      this.labelEntries[id].root.classList.add('is-hover');
    }
    this.canvas.classList.toggle('is-hovering', Boolean(id));
    this.onHover?.(id);
  }

  setLabelsVisible(visible) {
    this.labelsVisible = visible;
    this.markerLayer.classList.toggle('labels-off', !visible);
    this._labelsNeedLayout = true;
  }

  setOrbitsVisible(visible) {
    this.orbitsVisible = visible;
    this.orbitGroup.visible = visible;
    this.moonOrbitGroup.visible = visible;
  }

  setGridVisible(visible) {
    this.gridVisible = visible;
    this.gridGroup.visible = visible;
  }

  setSelected(id) {
    this.selectedId = id;
    for (const [bodyId, entry] of Object.entries(this.labelEntries)) {
      entry.root.classList.toggle('is-selected', bodyId === id);
    }
    for (const [bodyId, entry] of Object.entries(this.bodyEntries)) {
      if (!entry.orbit) continue;
      const selected = bodyId === id;
      entry.orbit.material.opacity = selected ? 0.92 : (entry.orbit.moon ? 0.2 : 0.25);
      entry.orbit.material.linewidth = selected ? (entry.orbit.moon ? 1.4 : 2.0) : (entry.orbit.moon ? 0.7 : 1.1);
      entry.orbit.material.color.copy(selected ? entry.orbit.accentColor : entry.orbit.baseColor);
      entry.orbit.material.needsUpdate = true;
    }
    this._labelsNeedLayout = true;
  }

  _resetControlMomentum() {
    // OrbitControls keeps private damping accumulators. Clear them when a
    // command changes the camera, or an old pan can nudge the newly focused
    // target off the selected planet.
    this.controls._panOffset?.set(0, 0, 0);
    this.controls._sphericalDelta?.set(0, 0, 0);
    if ('_scale' in this.controls) this.controls._scale = 1;
  }

  focusBody(id) {
    if (!this.byId[id]) return;
    this._resetControlMomentum();
    this.focusedId = id;
    this.presetName = null;
    this._focusInitialized = false;
    const world = this.worldPositions[id] || new THREE.Vector3();
    const entry = this.bodyEntries[id];
    const distance = this._focusDistance(id, entry.radius);
    const direction = this._focusCameraDirection(id, world);
    const start = performance.now();
    this.transition = {
      type: 'focus',
      startPos: this.camera.position.clone(),
      startTarget: this.controls.target.clone(),
      direction,
      distance,
      bodyId: id,
      started: start,
      duration: this.reducedMotion ? 1 : 950,
    };
    this.controls.minDistance = Math.max(0.003, entry.radius * 1.35);
    this.controls.maxDistance = 9000;
    this.labelEntries[id]?.root.classList.add('is-selected');
  }

  _focusCameraDirection(id, world) {
    if (id === 'sun' || world.lengthSq() < 1e-12) {
      return CAM_PRESET.system.direction.clone();
    }
    // Put the camera on the sunlit side, slightly above the ecliptic and off
    // to one side, so the selected disc shows both illuminated terrain and a
    // readable terminator rather than a featureless night face.
    const toSun = world.clone().multiplyScalar(-1).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(toSun, up);
    if (side.lengthSq() < 1e-12) side.set(1, 0, 0);
    side.normalize();
    return toSun.multiplyScalar(0.78)
      .addScaledVector(up, 0.38)
      .addScaledVector(side, 0.26)
      .normalize();
  }

  _focusDistance(id, radius) {
    if (id === 'earth') return Math.max(radius * 11.6, 0.118);
    if (id === 'saturn') return Math.max(radius * 7.0, 0.02);
    return Math.max(radius * 4.4, 0.02);
  }

  clearFocus() {
    this._resetControlMomentum();
    this.focusedId = null;
    this._focusInitialized = false;
    if (this.transition?.type === 'focus') this.transition = null;
  }

  setView(name, { animate = true } = {}) {
    const preset = CAM_PRESET[name] || CAM_PRESET.system;
    this.clearFocus();
    this._resetControlMomentum();
    this.presetName = name;
    this.controls.minDistance = 0.04;
    this.controls.maxDistance = 9000;
    const target = new THREE.Vector3(0, 0, 0);
    const distance = this._presetDistance(preset, name);
    const direction = this._presetDirection(preset, name);
    const endPos = direction.multiplyScalar(distance);
    if (!animate || this.reducedMotion) {
      this.transition = null;
      this.camera.position.copy(endPos);
      this.controls.target.copy(target);
      this.controls.update();
      this._updateCameraClip();
      return;
    }
    this.transition = {
      type: 'preset',
      startPos: this.camera.position.clone(),
      startTarget: this.controls.target.clone(),
      endPos,
      endTarget: target,
      started: performance.now(),
      duration: 900,
      presetName: name,
    };
  }

  _presetDirection(preset, name) {
    if (this.camera.aspect < 0.82) {
      if (name === 'system') return new THREE.Vector3(0.34, 0.86, 0.38).normalize();
      if (name === 'inner') return new THREE.Vector3(0.46, 0.76, 0.46).normalize();
    }
    return preset.direction.clone();
  }

  _presetDistance(preset, name) {
    const vFov = (this.camera.fov * Math.PI) / 180;
    const horizontalHalfFov = Math.atan(Math.tan(vFov / 2) * Math.max(this.camera.aspect, 0.2));
    const margin = name === 'system' && this.camera.aspect < 0.82 ? 1.3 : preset.margin;
    const fitDistance = (preset.fitRadius / Math.tan(horizontalHalfFov)) * margin;
    return Math.max(preset.minDistance, fitDistance);
  }

  _cancelTransition() {
    if (!this.transition) return;
    if (this.transition.bodyId) {
      this.focusLastPos.copy(this.worldPositions[this.transition.bodyId] || new THREE.Vector3());
      this._focusInitialized = true;
    }
    this.transition = null;
  }

  resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    for (const entry of Object.values(this.bodyEntries)) {
      entry.orbit?.material.resolution.set(width, height);
    }
    this.measureLabels();
    this._labelsNeedLayout = true;
  }

  update(snapshot) {
    this.snapshot = snapshot;
    this._updateWorldPositions(snapshot);
    this._updateOrbitPaths(snapshot.utcMs);
    this._updateTransitions();
    this._trackFocusedBody();

    this.controls.update();
    this._updateCameraClip();
    this._updateFocusedOrbitVisibility();
    this._updateLabels();
    this.renderer.render(this.scene, this.camera);
  }

  _updateWorldPositions(snapshot) {
    for (const def of this.catalog) {
      const record = snapshot.positions[def.id];
      if (!record) continue;
      const world = this.worldPositions[def.id] || new THREE.Vector3();
      eclipticToWorld(record, world);
      this.worldPositions[def.id] = world;
      const entry = this.bodyEntries[def.id];
      entry.group.position.copy(world);
    }
    const earth = snapshot.positions.earth;
    if (earth) {
      const moonOrbitWorld = new THREE.Vector3(earth.x * AU_TO_WORLD, earth.z * AU_TO_WORLD, -earth.y * AU_TO_WORLD);
      this.moonOrbitGroup.position.copy(moonOrbitWorld);
    }

    const saturnRing = this.bodyEntries.saturn?.ringGroup;
    if (saturnRing) {
      const pole = northPoleDirection('saturn', snapshot.utcMs);
      const axis = new THREE.Vector3(pole.x, pole.z, -pole.y).normalize();
      saturnRing.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    }
  }

  _updateOrbitPaths(nowMs) {
    const startedEmpty = Object.keys(this.orbitCaches).length === 0;
    const realNow = performance.now();
    if (!startedEmpty && realNow - this._lastOrbitUpdate < 120) return;

    const ordered = [...this.catalog];
    const focusId = this.focusedId || this.selectedId;
    if (focusId) {
      const index = ordered.findIndex((body) => body.id === focusId);
      if (index > 0) ordered.unshift(ordered.splice(index, 1)[0]);
    }

    let rebuilt = 0;
    for (const def of ordered) {
      if (!def.orbitalPeriodDays || !this.bodyEntries[def.id]?.orbit) continue;
      const cache = this.orbitCaches[def.id];
      const thresholdDays = clamp(def.orbitalPeriodDays * 0.01, 0.35, 18);
      if (cache && Math.abs(nowMs - cache.epochMs) < thresholdDays * DAY_MS) continue;
      const polyline = orbitPolyline(def.id, nowMs, ORBIT_SEGMENTS);
      if (!polyline) continue;
      const positions = new Float32Array(polyline.points.length * 3);
      for (let i = 0; i < polyline.points.length; i += 1) {
        const point = polyline.points[i];
        const offset = i * 3;
        positions[offset] = point.x * AU_TO_WORLD;
        positions[offset + 1] = point.z * AU_TO_WORLD;
        positions[offset + 2] = -point.y * AU_TO_WORLD;
      }
      const geometry = new LineGeometry();
      geometry.setPositions(positions);
      const line = this.bodyEntries[def.id].orbit.line;
      line.geometry.dispose();
      line.geometry = geometry;
      this.orbitCaches[def.id] = { epochMs: nowMs, points: polyline.points.length };
      rebuilt += 1;
      if (!startedEmpty && rebuilt >= 2) break;
    }
    if (rebuilt > 0) this._lastOrbitUpdate = realNow;
  }

  _updateTransitions() {
    if (!this.transition) return;
    const now = performance.now();
    const raw = clamp((now - this.transition.started) / Math.max(1, this.transition.duration), 0, 1);
    const t = this.reducedMotion ? 1 : easeInOutCubic(raw);
    const transition = this.transition;
    if (transition.type === 'focus') {
      const world = this.worldPositions[transition.bodyId] || new THREE.Vector3();
      const endPos = world.clone().addScaledVector(transition.direction, transition.distance);
      this.camera.position.lerpVectors(transition.startPos, endPos, t);
      this.controls.target.lerpVectors(transition.startTarget, world, t);
      if (raw >= 1) {
        this.focusLastPos.copy(world);
        this.transition = null;
      }
    } else {
      this.camera.position.lerpVectors(transition.startPos, transition.endPos, t);
      this.controls.target.lerpVectors(transition.startTarget, transition.endTarget, t);
      if (raw >= 1) {
        this.transition = null;
        this.focusLastPos.set(0, 0, 0);
      }
    }
  }

  _trackFocusedBody() {
    if (!this.focusedId || this.transition) return;
    const world = this.worldPositions[this.focusedId];
    if (!world) return;
    if (!this._focusInitialized) {
      this.focusLastPos.copy(world);
      this._focusInitialized = true;
      return;
    }
    const delta = world.clone().sub(this.focusLastPos);
    if (delta.lengthSq() > 0) {
      this.camera.position.add(delta);
      this.controls.target.add(delta);
    }
    this.focusLastPos.copy(world);
  }

  _updateCameraClip() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = clamp(distance * 0.008, 0.00002, 3);
    this.camera.near = near;
    this.camera.far = 14000;
    this.camera.updateProjectionMatrix();
  }

  _updateFocusedOrbitVisibility() {
    for (const def of this.catalog) {
      const entry = this.bodyEntries[def.id];
      if (!entry?.orbit) continue;
      const world = this.worldPositions[def.id];
      const close = def.id === this.focusedId && world
        && this.camera.position.distanceTo(world) < entry.radius * 14;
      entry.orbit.line.visible = this.orbitsVisible !== false && !close;
    }
  }

  _isPointInFront(world) {
    this.camera.getWorldDirection(this._cameraDirection);
    return world.clone().sub(this.camera.position).dot(this._cameraDirection) > 0;
  }

  _screenFor(world) {
    this._projectionHelper.copy(world).project(this.camera);
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    return {
      x: (this._projectionHelper.x * 0.5 + 0.5) * width,
      y: (-this._projectionHelper.y * 0.5 + 0.5) * height,
      z: this._projectionHelper.z,
      width,
      height,
    };
  }

  _updateLabels() {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    const order = [...PRIORITY];
    if (this.selectedId) {
      order.splice(order.indexOf(this.selectedId), 1);
      order.unshift(this.selectedId);
    }
    if (this.focusedId) {
      order.splice(order.indexOf(this.focusedId), 1);
      order.unshift(this.focusedId);
    }

    const placed = [];
    const planetScreen = {};
    for (const def of this.catalog) {
      planetScreen[def.id] = this.screenPositions[def.id] || null;
    }

    for (const id of order) {
      const def = this.byId[id];
      const entry = this.labelEntries[id];
      const world = this.worldPositions[id];
      if (!def || !entry || !world) continue;
      const screen = this._screenFor(world);
      this.screenPositions[id] = screen;
      planetScreen[id] = screen;

      const inFront = this._isPointInFront(world);
      const onScreen = inFront && screen.x > -80 && screen.x < width + 80 && screen.y > -30 && screen.y < height + 70;
      if (!onScreen) {
        entry.root.classList.add('is-offscreen');
        continue;
      }
      entry.root.classList.remove('is-offscreen');

      if (id === 'moon' && this.selectedId !== 'moon' && this.focusedId !== 'moon') {
        const earthScreen = planetScreen.earth || (this.worldPositions.earth ? this._screenFor(this.worldPositions.earth) : null);
        if (earthScreen && Math.hypot(earthScreen.x - screen.x, earthScreen.y - screen.y) < 11) {
          entry.root.classList.add('is-offscreen');
          continue;
        }
      }

      const cameraDistance = Math.max(1e-8, this.camera.position.distanceTo(world));
      const vFov = (this.camera.fov * Math.PI) / 180;
      const pixelsPerWorld = height / (2 * Math.tan(vFov / 2) * cameraDistance);
      const bodyRadiusPx = this.bodyEntries[id].radius * pixelsPerWorld;
      const isClose = bodyRadiusPx > 24;
      entry.root.classList.toggle('is-close', isClose);

      let anchorX = screen.x;
      let anchorY = screen.y;
      if (isClose) {
        anchorY = clamp(screen.y - Math.min(bodyRadiusPx + 12, height * 0.34), 20, height - 20);
      }

      let flip = id === 'sun';
      const labelWidth = entry.width;
      if (!isClose && anchorX + labelWidth > width - 10) {
        flip = true;
      }
      entry.root.classList.toggle('is-flip', flip);

      const box = isClose
        ? { left: anchorX - labelWidth / 2, right: anchorX + labelWidth / 2, top: anchorY - 11, bottom: anchorY + 11 }
        : flip
          ? { left: anchorX - labelWidth + 4, right: anchorX + 4, top: anchorY - 11, bottom: anchorY + 11 }
          : { left: anchorX - 4, right: anchorX + labelWidth - 4, top: anchorY - 11, bottom: anchorY + 11 };

      let overlaps = false;
      for (const other of placed) {
        if (!(box.right < other.left || box.left > other.right || box.bottom < other.top || box.top > other.bottom)) {
          overlaps = true;
          break;
        }
      }

      const mustShow = id === this.selectedId || id === this.focusedId;
      if (this.labelsVisible && (mustShow || !overlaps)) {
        entry.root.classList.remove('label-text-hidden');
        placed.push(box);
      } else {
        entry.root.classList.add('label-text-hidden');
      }

      entry.root.style.transform = `translate3d(${anchorX.toFixed(2)}px, ${anchorY.toFixed(2)}px, 0)`;
    }
  }

  pickAt(clientX, clientY, threshold = 20) {
    const rect = this.canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const candidates = [];
    for (const def of this.catalog) {
      const world = this.worldPositions[def.id];
      if (!world || !this._isPointInFront(world)) continue;
      const screen = this.screenPositions[def.id] || this._screenFor(world);
      if (!screen) continue;
      if (def.id === 'moon') {
        const earthScreen = this.screenPositions.earth;
        if (this.selectedId !== 'moon' && this.focusedId !== 'moon' && earthScreen
          && Math.hypot(earthScreen.x - screen.x, earthScreen.y - screen.y) < 11) {
          continue;
        }
      }
      const bodyRadiusPx = this.bodyEntries[def.id].radius
        * (this.container.clientHeight / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * Math.max(1e-8, this.camera.position.distanceTo(world))));
      const distance = Math.hypot(screen.x - x, screen.y - y);
      const hitRadius = Math.max(threshold, Math.min(60, bodyRadiusPx + 8));
      if (distance <= hitRadius) {
        candidates.push({ id: def.id, distance, priority: PRIORITY.indexOf(def.id) });
      }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => a.distance - b.distance || a.priority - b.priority);
    return candidates[0].id;
  }

  focusScreenPosition(id) {
    const world = this.worldPositions[id];
    if (!world) return null;
    return this._screenFor(world);
  }

  debugState() {
    return {
      selectedId: this.selectedId,
      focusedId: this.focusedId,
      presetName: this.presetName,
      camera: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
        near: this.camera.near,
        far: this.camera.far,
        distance: this.camera.position.distanceTo(this.controls.target),
      },
      target: {
        x: this.controls.target.x,
        y: this.controls.target.y,
        z: this.controls.target.z,
      },
      focusPosition: this.worldPositions[this.focusedId]
        ? {
            x: this.worldPositions[this.focusedId].x,
            y: this.worldPositions[this.focusedId].y,
            z: this.worldPositions[this.focusedId].z,
          }
        : null,
      labelPositions: Object.fromEntries(
        Object.entries(this.screenPositions).map(([id, screen]) => [id, screen ? { x: screen.x, y: screen.y } : null]),
      ),
      orbitCacheEpochs: Object.fromEntries(
        Object.entries(this.orbitCaches).map(([id, cache]) => [id, cache.epochMs]),
      ),
      renderSize: { width: this.container.clientWidth, height: this.container.clientHeight },
    };
  }
}
