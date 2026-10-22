import * as THREE from 'three';
import { createScene } from './scene.js';
import { createPrinter, NOZZLE_Y } from './printer.js';
import { DEMO_MODELS } from './models.js';
import { loadModelFile, normalizeModel } from './loaders.js';
import { buildToolpath, createBeadMaterial, FEATURES, TRAVEL_SPEED } from './toolpath.js';
import { createSound } from './sound.js';
import { createInspector } from './inspect.js';

const $ = (id) => document.getElementById(id);
const S = createScene($('viewport'));
const printer = createPrinter(S.scene);
const sound = createSound();

const FILAMENTS = [
  { name: 'Lava Orange', color: '#ff6b1a' },
  { name: 'Bambu Green', color: '#00ae42' },
  { name: 'Ice Cyan', color: '#00b4d8' },
  { name: 'Galaxy Purple', color: '#7b4fd6' },
  { name: 'Pearl White', color: '#ecebe6' },
  { name: 'Matte Charcoal', color: '#30333a' },
  { name: 'Cherry Red', color: '#d7263d' },
  { name: 'Silk Gold', color: '#d9a21b', silk: true },
  { name: 'Silk Copper', color: '#c46a3a', silk: true },
  { name: 'Silk Silver', color: '#b9c0c9', silk: true },
];

const settings = {
  layerHeight: 0.2, lineWidth: 0.45, walls: 2, infillDensity: 0.15,
  topLayers: 4, bottomLayers: 3, skirt: true, skirtDistance: 4,
};

const app = {
  phase: 'idle', phaseT: 0, paused: false, time: 0,
  model: null, scale: 1, tp: null, sliceResult: null,
  cam: 'cinematic', fan: 0,
  temps: { nozzle: 25, bed: 25 },
  sim: { t: 0, idx: 0, doneSegs: 0, mult: 1, speedSel: 'auto', z: 0, layer: -1, type: -1, speed: 0, filament: 0 },
  worker: null, sliceProgress: 0, sliceStage: '',
  levelOffsets: Array.from({ length: 9 }, () => (Math.random() - 0.5) * 0.12),
  captionLock: 0,
};

// ---------------------------------------------------------------- materials & scene objects
const beadMaterial = createBeadMaterial();
const inspector = createInspector({
  S, printer, beadMaterial, sound,
  onCaption: (t, x) => setCaption(t, x),
  onExit: () => { enterPhase('done'); app.phaseT = 100; showDone(); },
});
const holoUniforms = { uTime: { value: 0 }, uColor: { value: new THREE.Color(0x19e6ff) }, uOpacity: { value: 1 } };
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e4);
const holoMaterial = new THREE.ShaderMaterial({
  uniforms: holoUniforms,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  clipping: true, clippingPlanes: [clipPlane],
  vertexShader: /* glsl */ `
    #include <common>
    #include <clipping_planes_pars_vertex>
    varying vec3 vN; varying vec3 vV; varying float vY;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vY = wp.y;
      vec4 mvPosition = viewMatrix * wp;
      vN = normalize(normalMatrix * normal);
      vV = normalize(-mvPosition.xyz);
      gl_Position = projectionMatrix * mvPosition;
      #include <clipping_planes_vertex>
    }`,
  fragmentShader: /* glsl */ `
    #include <common>
    #include <clipping_planes_pars_fragment>
    uniform float uTime; uniform vec3 uColor; uniform float uOpacity;
    varying vec3 vN; varying vec3 vV; varying float vY;
    void main() {
      #include <clipping_planes_fragment>
      float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.2);
      float scan = smoothstep(0.88, 1.0, fract(vY * 0.06 - uTime * 0.35));
      float lines = smoothstep(0.75, 1.0, fract(vY * 1.2)) * 0.35;
      vec3 c = uColor * (0.05 + f * 0.9 + scan * 0.7 + lines * 0.25);
      gl_FragColor = vec4(c * uOpacity, 1.0);
    }`,
});

let ghost = null, beadMesh = null, contourLines = null;
const contourUniforms = { uReveal: { value: 0 }, uFade: { value: 1 } };
const contourMaterial = new THREE.ShaderMaterial({
  uniforms: contourUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `varying float vZ; void main(){ vZ = position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform float uReveal; uniform float uFade; varying float vZ;
    void main(){ if (vZ > uReveal) discard; float e = smoothstep(uReveal - 4.0, uReveal, vZ);
      vec3 c = mix(vec3(0.0, 0.75, 1.0) * 0.7, vec3(1.0), e); gl_FragColor = vec4(c * uFade, 1.0); }`,
});

const scanPlane = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: gridTexture(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, toneMapped: false }),
);
scanPlane.visible = false;
printer.printSpace.add(scanPlane);

const activeBead = new THREE.Mesh(
  new THREE.CylinderGeometry(0.5, 0.5, 1, 10).rotateZ(Math.PI / 2),
  new THREE.MeshStandardMaterial({ color: 0xffa040, emissive: 0xff7a20, emissiveIntensity: 2.6, roughness: 0.4 }),
);
activeBead.visible = false;
printer.printSpace.add(activeBead);

// nozzle heat haze / smoke
const smokeCount = 40;
const smokeGeo = new THREE.BufferGeometry();
const smokePos = new Float32Array(smokeCount * 3);
const smokeLife = new Float32Array(smokeCount).map(() => Math.random());
smokeGeo.setAttribute('position', new THREE.BufferAttribute(smokePos, 3));
const smoke = new THREE.Points(smokeGeo, new THREE.PointsMaterial({
  size: 6, map: radial(), transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffb070,
}));
S.scene.add(smoke);

// ---------------------------------------------------------------- UI building
const demoIcons = {
  vase: '<path d="M9 3h6M10 3c0 3-4 5-4 10s3 8 6 8 6-3 6-8-4-7-4-10"/>',
  rook: '<path d="M7 21h10M8 18h8l-1-9H9zM7 9h10V4h-2v2h-2V4h-2v2H9V4H7z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/><circle cx="12" cy="12" r="7"/>',
  planter: '<path d="M4 6h16l-2 14H6zM3 6h18"/>',
  rocket: '<path d="M12 2c3 3 4 7 4 11l-4 3-4-3c0-4 1-8 4-11zM8 13l-3 4 3 1M16 13l3 4-3 1M10 20h4"/>',
};
const demoGrid = $('demo-grid');
for (const m of DEMO_MODELS) {
  const b = document.createElement('button');
  b.className = 'demo';
  b.dataset.id = m.id;
  b.innerHTML = `<svg viewBox="0 0 24 24">${demoIcons[m.id]}</svg><b>${m.name}</b><span>${m.desc}</span>`;
  b.onclick = () => selectDemo(m.id);
  demoGrid.appendChild(b);
}
const swatches = $('swatches');
FILAMENTS.forEach((f, i) => {
  const b = document.createElement('button');
  b.className = 'swatch' + (f.silk ? ' silk' : '') + (i === 0 ? ' on' : '');
  b.style.background = f.color;
  b.style.color = f.color;
  b.title = f.name;
  b.onclick = () => {
    swatches.querySelectorAll('.swatch').forEach((s) => s.classList.remove('on'));
    b.classList.add('on');
    setFilament(f);
  };
  swatches.appendChild(b);
});
const swName = document.createElement('div');
swName.className = 'swatch-name';
swatches.appendChild(swName);

const legend = $('legend');
FEATURES.forEach((f, i) => {
  const d = document.createElement('div');
  d.dataset.i = i;
  d.innerHTML = `<i style="background:${f.color}"></i>${f.name}`;
  legend.appendChild(d);
});

function setFilament(f) {
  beadMaterial.color.set(f.color);
  beadMaterial.metalness = f.silk ? 0.55 : 0;
  beadMaterial.roughness = f.silk ? 0.25 : 0.5;
  printer.setFilamentColor(f.color, f.silk);
  document.documentElement.style.setProperty('--fil', f.color);
  swName.textContent = f.name + (f.silk ? ' · silk PLA' : ' · PLA');
}
setFilament(FILAMENTS[0]);

// settings
$('lh').addEventListener('click', (e) => {
  const v = e.target.dataset.v;
  if (!v) return;
  $('lh').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.target));
  settings.layerHeight = +v;
  $('lh-out').textContent = (+v).toFixed(2) + ' mm';
  settingsChanged();
});
$('infill').oninput = (e) => { settings.infillDensity = e.target.value / 100; $('infill-out').textContent = e.target.value + '%'; settingsChanged(); };
$('walls').oninput = (e) => { settings.walls = +e.target.value; $('walls-out').textContent = e.target.value; settingsChanged(); };
$('scale').oninput = (e) => { app.scale = e.target.value / 100; $('scale-out').textContent = e.target.value + '%'; applyModel(); };
function settingsChanged() {
  if (app.phase !== 'idle') resetToIdle();
  updateModelInfo();
}

// transport
const barObserver = new ResizeObserver(() => {
  const h = Math.max($('transport').offsetHeight, $('inspect').offsetHeight);
  document.documentElement.style.setProperty('--transport-h', `${Math.ceil(h)}px`);
});
barObserver.observe($('transport'));
barObserver.observe($('inspect'));
$('play').onclick = () => {
  app.paused = !app.paused;
  $('play').textContent = app.paused ? '▶' : '❚❚';
};
$('speed').onchange = (e) => { app.sim.speedSel = e.target.value; updateMult(); };
$('cams').addEventListener('click', (e) => { if (e.target.dataset.c) setCam(e.target.dataset.c); });
$('feat').onchange = (e) => (beadMaterial.userData.uniforms.uColorMode.value = e.target.checked ? 1 : 0);
$('ghost').onchange = () => {};
$('sound').onchange = (e) => sound.setEnabled(e.target.checked);
$('explain-btn').onclick = () => $('hotend').classList.toggle('hidden');
$('hotend-close').onclick = () => { $('hotend').classList.add('hidden'); app.hotendDismissed = true; };
$('start').onclick = () => (app.phase === 'idle' ? startSlicing() : resetToIdle());
$('again').onclick = () => { resetToIdle(); startSlicing(); };
$('another').onclick = () => resetToIdle();
$('inspect-btn').onclick = () => startInspect();
function startInspect() {
  if (!app.tp || !beadMesh || app.phase !== 'done') return;
  if (!app.model.artic) { app.inspectPending = true; updateInspectBtn(); return; }
  app.inspectPending = false;
  $('done').classList.add('hidden');
  enterPhase('inspect');
  setCam('cinematic');
  const tp = app.tp;
  inspector.start(beadMesh, tp, {
    grams: (tp.filamentLength * 2.405 * 1.24) / 1000,
    walls: settings.walls, infill: settings.infillDensity, layerHeight: settings.layerHeight, lineWidth: settings.lineWidth,
  }, app.model.artic);
}

// print-in-place detection runs in parallel with slicing
function startArticulation() {
  const m = app.model;
  if (m.artic || app.articWorker) return;
  const worker = new Worker(new URL('./articulate.worker.js', import.meta.url), { type: 'module' });
  app.articWorker = worker;
  app.articP = 0;
  const pos = m.positions.slice();
  const finish = (r) => {
    worker.terminate();
    if (app.articWorker !== worker) return;
    app.articWorker = null;
    m.artic = r;
    updateModelInfo();
    updateInspectBtn();
    if (app.inspectPending) startInspect();
  };
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'progress') { app.articP = d.p; app.articStage = d.stage; updateInspectBtn(); }
    else if (d.type === 'done') finish(d.result);
    else if (d.type === 'error') { console.error(d.message); finish({ parts: 1, joints: [] }); }
  };
  worker.postMessage({ positions: pos }, [pos.buffer]);
}

function updateInspectBtn() {
  const b = $('inspect-btn');
  const busy = !!app.inspectPending && !(app.model && app.model.artic);
  b.disabled = busy;
  b.innerHTML = busy ? `⏳ Checking for joints… ${Math.round((app.articP || 0) * 100)}%` : '✋ Pick it up';
}
$('scrub').oninput = (e) => {
  if (!app.tp) return;
  if (app.phase !== 'printing') {
    $('done').classList.add('hidden');
    enterPhase('printing');
    app.temps.nozzle = 220; app.temps.bed = 60;
  }
  seek((e.target.value / 1000) * app.tp.totalTime);
};
S.controls.addEventListener('start', () => { if (!app.programmaticCam) setCam('orbit'); });

function setCam(c) {
  app.cam = c;
  $('cams').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.c === c));
}

// file upload
$('file').onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dragover').classList.add('show'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dragover').classList.remove('show'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dragover').classList.remove('show');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

async function loadFile(file) {
  try {
    toast(`Loading ${file.name}…`, true);
    const raw = await loadModelFile(file);
    setModel({ name: file.name.replace(/\.[^.]+$/, ''), raw, source: 'upload' });
    demoGrid.querySelectorAll('.demo').forEach((b) => b.classList.remove('on'));
    toast(`Loaded “${file.name}” — ${(raw.length / 9).toLocaleString()} triangles`, true);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not read that file');
  }
}

function selectDemo(id) {
  const m = DEMO_MODELS.find((d) => d.id === id);
  demoGrid.querySelectorAll('.demo').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
  setModel({ name: m.name, raw: m.build(), source: 'demo' });
}

function setModel(model) {
  resetToIdle();
  app.model = model;
  applyModel();
}

function applyModel() {
  const m = app.model;
  if (!m) return;
  if (app.phase !== 'idle') resetToIdle();
  const n = normalizeModel(m.raw, 70);
  for (let i = 0; i < n.positions.length; i++) n.positions[i] *= app.scale;
  m.positions = n.positions;
  m.artic = null;
  m.size = n.size.map((s) => s * app.scale);
  m.fitScale = n.scale * app.scale;
  if (ghost) { ghost.geometry.dispose(); printer.printSpace.remove(ghost); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
  g.computeVertexNormals();
  ghost = new THREE.Mesh(g, holoMaterial);
  ghost.renderOrder = 5;
  printer.printSpace.add(ghost);
  updateModelInfo();
}

function updateModelInfo() {
  const m = app.model;
  if (!m) return;
  const [x, y, z] = m.size;
  $('model-info').innerHTML =
    `<b>${escapeHtml(m.name)}</b><br>${x.toFixed(1)} × ${y.toFixed(1)} × ${z.toFixed(1)} mm · ${(m.positions.length / 9).toLocaleString()} triangles<br>` +
    `≈ ${Math.ceil(z / settings.layerHeight)} layers at ${settings.layerHeight} mm` +
    (m.artic && m.artic.joints.length ? ` · <b>${m.artic.parts} linked parts</b>` : '') +
    (Math.abs(m.fitScale - 1) > 0.01 ? ` · scaled to ${(m.fitScale * 100).toFixed(0)}%` : '');
}

// ---------------------------------------------------------------- phases
const CAPTIONS = {
  inspect: ['Step 6 · Hands-on', ''],
  idle: ['Ready when you are', 'Pick a model, choose a filament colour and hit <b>Slice &amp; Print</b> to see how a 3D printer turns a digital file into a real object.'],
  slicing: ['Step 1 · Slicing', 'The <b>slicer</b> cuts the 3D model into hundreds of thin horizontal layers, then plans every single move of the nozzle — walls, infill and skins — and writes them as <b>G-code</b>.'],
  heating: ['Step 2 · Heating up', 'The hotend heats to <b>220 °C</b> to melt PLA plastic, and the bed warms to <b>60 °C</b> so the first layer sticks firmly.'],
  leveling: ['Step 3 · Auto bed levelling', 'The nozzle taps the bed at a grid of points to measure tiny height differences — the printer then compensates so the first layer is perfectly even.'],
  printing: ['Step 4 · Printing', ''],
  cooling: ['Step 5 · Cool down', 'The part cools and shrinks slightly, letting it pop off the flexible PEI plate. Done!'],
};
const ORDER = ['slicing', 'heating', 'leveling', 'printing', 'cooling', 'inspect'];

function enterPhase(p) {
  app.phase = p;
  app.phaseT = 0;
  const idx = ORDER.indexOf(p);
  $('steps').querySelectorAll('div').forEach((d, i) => {
    d.classList.toggle('on', i === idx);
    d.classList.toggle('done', idx > i || (p === 'done' && d.dataset.p !== 'inspect'));
  });
  if (p !== 'printing' && p !== 'inspect') setCaption(...CAPTIONS[p === 'done' ? 'cooling' : p]);
  $('start').innerHTML = p === 'idle' ? '<span class="cta-glow"></span>▶&nbsp; Slice &amp; Print' : p === 'done' || p === 'inspect' ? '↺&nbsp; New print' : '■&nbsp; Cancel';
  $('scrub').disabled = !app.tp;
  if (p === 'heating' && !app.hotendDismissed) $('hotend').classList.remove('hidden');
  if (p !== 'heating') $('hotend').classList.add('hidden');
}

function setCaption(title, text) {
  $('caption-title').innerHTML = title;
  $('caption-text').innerHTML = text;
}

function resetToIdle() {
  if (app.worker) { app.worker.terminate(); app.worker = null; }
  if (app.articWorker) { app.articWorker.terminate(); app.articWorker = null; }
  app.inspectPending = false;
  updateInspectBtn();
  inspector.reset();
  if (beadMesh) { beadMesh.geometry.dispose(); beadMesh.removeFromParent(); beadMesh = null; }
  if (contourLines) { contourLines.geometry.dispose(); printer.printSpace.remove(contourLines); contourLines = null; }
  app.tp = null;
  app.sliceResult = null;
  activeBead.visible = false;
  scanPlane.visible = false;
  $('done').classList.add('hidden');
  $('gcode').innerHTML = '';
  gcodeLines.length = 0;
  $('scrub').value = 0;
  app.sim.layer = -1;
  holoUniforms.uOpacity.value = 1;
  clipPlane.constant = 1e4;
  enterPhase('idle');
}

function startSlicing() {
  if (!app.model) return;
  resetToIdle();
  if (ghost) ghost.rotation.z = 0;
  enterPhase('slicing');
  app.sliceProgress = 0;
  app.sliceStage = 'Preparing mesh';
  app.sliceDoneAt = null;
  app.revealT = 0;
  app.scanP = 0;
  startArticulation();
  const worker = new Worker(new URL('./slicer.worker.js', import.meta.url), { type: 'module' });
  app.worker = worker;
  const pos = app.model.positions.slice();
  worker.onmessage = (e) => {
    const d = e.data;
    if (d.type === 'progress') { app.sliceProgress = d.p; app.sliceStage = d.stage; }
    else if (d.type === 'error') { console.error(d.message); toast('Slicing failed: ' + d.message.split('\n')[0]); resetToIdle(); }
    else if (d.type === 'done') {
      worker.terminate();
      app.worker = null;
      onSliced(d.result);
    }
  };
  worker.postMessage({ positions: pos, settings: { ...settings } }, [pos.buffer]);
}

function onSliced(result) {
  const segs = result.layers.reduce((a, l) => a + l.paths.length, 0);
  if (!segs) { toast('Nothing to print — the model may be too thin or not watertight.'); resetToIdle(); return; }
  app.sliceResult = result;
  app.sliceProgress = 1;
  const tp = buildToolpath(result, settings);
  app.tp = tp;
  beadMesh = new THREE.Mesh(tp.geometry, beadMaterial);
  beadMesh.castShadow = true;
  beadMesh.receiveShadow = true;
  beadMesh.frustumCulled = false;
  beadMesh.customDepthMaterial = inspector.depthMaterial;
  printer.printSpace.add(beadMesh);

  // contour lines for the slicing visualisation
  const step = Math.max(1, Math.ceil(result.layers.length / 140));
  let count = 0;
  for (let i = 0; i < result.layers.length; i += step) for (const c of result.layers[i].contours) count += c.length / 2 - 1;
  const arr = new Float32Array(count * 6);
  let o = 0;
  for (let i = 0; i < result.layers.length; i += step) {
    const z = result.layers[i].z;
    for (const c of result.layers[i].contours) {
      for (let k = 0; k < c.length / 2 - 1; k++) {
        arr[o++] = c[k * 2]; arr[o++] = c[k * 2 + 1]; arr[o++] = z;
        arr[o++] = c[k * 2 + 2]; arr[o++] = c[k * 2 + 3]; arr[o++] = z;
      }
    }
  }
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  contourLines = new THREE.LineSegments(lg, contourMaterial);
  contourLines.frustumCulled = false;
  contourUniforms.uReveal.value = 0;
  contourUniforms.uFade.value = 1;
  printer.printSpace.add(contourLines);
  app.sliceDoneAt = app.phaseT;
  updateMult();
  $('scrub').disabled = false;
}

function updateMult() {
  if (!app.tp) return;
  const sel = app.sim.speedSel;
  app.sim.mult = sel === 'auto' ? Math.max(1, app.tp.totalTime / 120) : +sel;
  $('playback-info').textContent = `real ${fmtTime(app.tp.totalTime)} · playing ${app.sim.mult.toFixed(app.sim.mult < 10 ? 1 : 0)}×`;
}

// ---------------------------------------------------------------- simulation
const gcodeLines = [];
let lastType = -1;

function seek(t) {
  const mv = app.tp.moves;
  app.sim.t = Math.max(0, Math.min(t, app.tp.totalTime - 1e-6));
  let lo = 0, hi = mv.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (mv.t0[mid] <= app.sim.t) lo = mid; else hi = mid - 1;
  }
  app.sim.idx = lo;
  let k = lo - 1;
  while (k >= 0 && mv.geo[k] < 0) k--;
  app.sim.doneSegs = k >= 0 ? mv.geo[k] + 1 : 0;
  app.sim.layer = -1;
  lastType = -1;
  gcodeLines.length = 0;
  miniReset = true;
}

function stepPrint(dt) {
  const tp = app.tp, mv = tp.moves, sim = app.sim;
  sim.t += dt * sim.mult;
  const startIdx = sim.idx;
  while (sim.idx < mv.count - 1 && mv.t0[sim.idx] + mv.dur[sim.idx] <= sim.t) {
    const m = sim.idx;
    if (mv.geo[m] >= 0) {
      sim.doneSegs = mv.geo[m] + 1;
      const len = Math.hypot(mv.x1[m] - mv.x0[m], mv.y1[m] - mv.y0[m]);
      printer.feedFilament((len * settings.lineWidth * settings.layerHeight) / 2.405);
    }
    sim.idx++;
  }
  const m = sim.idx;
  const f = THREE.MathUtils.clamp((sim.t - mv.t0[m]) / mv.dur[m], 0, 1);
  const x = mv.x0[m] + (mv.x1[m] - mv.x0[m]) * f;
  const y = mv.y0[m] + (mv.y1[m] - mv.y0[m]) * f;
  let z = mv.z[m];
  const layer = mv.layer[m];
  if (mv.type[m] < 0 && tp.layerStartMove[layer] === m && layer > 0) z = mv.z[m - 1] + (z - mv.z[m - 1]) * Math.min(1, f * 3);
  printer.setHead(x, y);
  printer.setBedZ(z);
  sim.z = z;

  const extruding = mv.geo[m] >= 0;
  const segLen = Math.hypot(mv.x1[m] - mv.x0[m], mv.y1[m] - mv.y0[m]);
  beadMaterial.userData.uniforms.uPrinted.value = mv.d0[m] + (extruding ? f * segLen : 0);
  tp.geometry.setDrawRange(0, sim.doneSegs * 24);
  if (extruding && f > 0) {
    const L = f * segLen;
    activeBead.visible = true;
    activeBead.position.set((mv.x0[m] + x) / 2, (mv.y0[m] + y) / 2, z - settings.layerHeight / 2);
    activeBead.rotation.z = Math.atan2(mv.y1[m] - mv.y0[m], mv.x1[m] - mv.x0[m]);
    activeBead.scale.set(Math.max(L, 0.01), settings.lineWidth * 1.05, settings.layerHeight);
  } else activeBead.visible = false;

  sim.speed = extruding ? (layer === 0 ? 45 : FEATURES[mv.type[m]].speed) : TRAVEL_SPEED;
  if (extruding) sim.type = mv.type[m];
  if (layer !== sim.layer) { sim.layer = layer; miniReset = true; }
  // part cooling fan ramps up after the first layers
  app.fan = layer < 1 ? 0 : layer < 3 ? 0.5 : 1;

  // G-code stream (only the latest few moves of this frame)
  const from = Math.max(startIdx, sim.idx - 5);
  for (let k = from; k <= sim.idx; k++) {
    if (k === startIdx && k !== 0 && gcodeLines.length) continue;
    if (tp.layerStartMove[mv.layer[k]] === k) {
      gcodeLines.push(`<span class="l">;LAYER_CHANGE</span>`, `<span class="c">;Z:${mv.z[k].toFixed(2)}</span>`, `G1 Z${mv.z[k].toFixed(2)} F720`);
    }
    if (mv.geo[k] >= 0 && mv.type[k] !== lastType) {
      lastType = mv.type[k];
      gcodeLines.push(`<span class="c">;TYPE:${FEATURES[lastType].name}</span>`);
    }
    gcodeLines.push(gcodeFor(k));
  }
  if (gcodeLines.length > 40) gcodeLines.splice(0, gcodeLines.length - 40);

  if (sim.idx >= mv.count - 1 && f >= 1) finishPrint();
}

function gcodeFor(k) {
  const mv = app.tp.moves;
  const X = (mv.x1[k] + 128).toFixed(3), Y = (mv.y1[k] + 128).toFixed(3);
  if (mv.geo[k] < 0) return `<span class="t">G0 X${X} Y${Y} F${TRAVEL_SPEED * 60}</span>`;
  const len = Math.hypot(mv.x1[k] - mv.x0[k], mv.y1[k] - mv.y0[k]);
  const e = (len * settings.lineWidth * settings.layerHeight) / 2.405;
  const sp = mv.layer[k] === 0 ? 45 : FEATURES[mv.type[k]].speed;
  return `G1 X${X} Y${Y} E${e.toFixed(5)} F${sp * 60}`;
}

function finishPrint() {
  activeBead.visible = false;
  app.tp.geometry.setDrawRange(0, app.tp.segments * 24);
  enterPhase('cooling');
  app.coolFrom = { x: printer.head.position.x, y: -printer.head.position.z, z: app.sim.z };
}

// ---------------------------------------------------------------- per-phase updates
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = THREE.MathUtils.lerp;

function update(dt) {
  const p = app.phase;
  app.phaseT += dt;
  const T = app.phaseT;
  const H = app.model ? app.model.size[2] : 50;
  let progress = 0;

  if (p === 'idle') {
    if (ghost) ghost.rotation.z += dt * 0.35;
    printer.setBedZ(lerp(NOZZLE_Y - printer.bed.position.y, H + 25, 1 - Math.exp(-dt * 2)));
    moveHeadTo(-80, 95, dt);
    app.temps.nozzle = lerp(app.temps.nozzle, 25, dt * 0.4);
    app.temps.bed = lerp(app.temps.bed, 25, dt * 0.3);
    app.fan = 0;
  } else if (p === 'slicing') {
    if (ghost) ghost.rotation.z = lerp(ghost.rotation.z, Math.round(ghost.rotation.z / (Math.PI * 2)) * Math.PI * 2, dt * 3);
    const bbox = app.model.size;
    scanPlane.visible = true;
    scanPlane.scale.set(bbox[0] + 30, bbox[1] + 30, 1);
    const shown = app.sliceDoneAt == null ? Math.min(app.sliceProgress, 0.98) : 1;
    app.scanP = lerp(app.scanP || 0, shown, 1 - Math.exp(-dt * 3));
    let revealT = 0;
    if (app.tp && app.scanP > 0.97) {
      app.revealT = (app.revealT || 0) + dt;
      revealT = Math.min(app.revealT / 2.2, 1);
      contourUniforms.uReveal.value = ease(revealT) * (H + 1);
      scanPlane.position.z = ease(revealT) * H;
      holoUniforms.uOpacity.value = 1 - revealT * 0.75;
    } else scanPlane.position.z = (T * 25) % Math.max(H, 1);
    scanPlane.material.opacity = 0.9;
    progress = app.tp ? 0.5 + revealT * 0.5 : app.sliceProgress * 0.5;
    const L = app.tp ? app.tp.layers.length : '…';
    setCaption(
      CAPTIONS.slicing[0],
      CAPTIONS.slicing[1] + `<br><span style="color:#7fdfff">${app.tp ? `Sliced into <b>${L}</b> layers · <b>${app.tp.moves.count.toLocaleString()}</b> moves · ${(app.tp.filamentLength / 1000).toFixed(2)} m of filament` : app.sliceStage + '… ' + Math.round(app.sliceProgress * 100) + '%'}</span>`,
    );
    if (revealT >= 1 && (app.revealT || 0) > 2.9) {
      app.revealT = 0; app.scanP = 0; app.sliceDoneAt = null;
      scanPlane.visible = false;
      enterPhase('heating');
    }
  } else if (p === 'heating') {
    const D = 5.5;
    const k = Math.min(T / D, 1);
    app.temps.nozzle = 25 + (220 - 25) * (1 - Math.pow(1 - k, 2.2));
    app.temps.bed = 25 + (60 - 25) * Math.min(1, k * 1.3);
    contourUniforms.uFade.value = Math.max(0, 1 - T / 1.5);
    holoUniforms.uOpacity.value = lerp(holoUniforms.uOpacity.value, 0, dt * 2.5);
    printer.setBedZ(lerp(NOZZLE_Y - printer.bed.position.y, 6, 1 - Math.exp(-dt * 1.4)));
    moveHeadTo(0, 0, dt * 0.6);
    progress = k;
    if (T > D) {
      if (contourLines) contourLines.visible = false;
      enterPhase('leveling');
    }
  } else if (p === 'leveling') {
    const pts = [[-50, -50], [0, -50], [50, -50], [50, 0], [0, 0], [-50, 0], [-50, 50], [0, 50], [50, 50]];
    const slot = 0.62;
    const i = Math.min(Math.floor(T / slot), pts.length);
    app.levelIdx = i;
    if (i < pts.length) {
      const q = (T - i * slot) / slot;
      const prev = i ? pts[i - 1] : [0, 0];
      const k = ease(Math.min(q / 0.55, 1));
      printer.setHead(lerp(prev[0], pts[i][0], k), lerp(prev[1], pts[i][1], k));
      printer.setBedZ(q < 0.55 ? 4 : 4 - 4 * Math.sin(((q - 0.55) / 0.45) * Math.PI));
    } else {
      // move to start of the print
      const mv = app.tp.moves;
      const q = Math.min((T - pts.length * slot) / 0.8, 1);
      printer.setHead(lerp(50, mv.x0[0], ease(q)), lerp(50, mv.y0[0], ease(q)));
      printer.setBedZ(lerp(4, mv.z[0], q));
      if (q >= 1) {
        enterPhase('printing');
        seek(0);
        if (app.cam !== 'orbit') setCam('cinematic');
      }
    }
    progress = Math.min(T / (pts.length * slot + 0.8), 1);
  } else if (p === 'printing') {
    stepPrint(dt);
    progress = app.sim.t / app.tp.totalTime;
    clipPlane.constant = -(NOZZLE_Y - 0.05);
    holoUniforms.uOpacity.value = lerp(holoUniforms.uOpacity.value, $('ghost').checked ? 0.3 : 0, dt * 3);
    app.temps.nozzle = 220 + Math.sin(app.time * 1.7) * 0.6;
    app.temps.bed = 60 + Math.sin(app.time * 0.6) * 0.2;
    if (app.time > app.captionLock) {
      app.captionLock = app.time + 3;
      const sim = app.sim;
      setCaption(
        sim.layer === 0 ? `First layer · ${sim.type >= 0 ? FEATURES[sim.type].name : 'Travel'}` : `Now printing · ${sim.type >= 0 ? FEATURES[sim.type].name : 'Travel'}`,
        sim.layer === 0 && sim.type !== 0
          ? 'First layer — printed slowly and squished into the bed for maximum adhesion. Everything else is built on top of it.'
          : sim.type >= 0 ? FEATURES[sim.type].tip : 'Travel move — the nozzle hops to the next spot without extruding.',
      );
    }
    if (!$('scrub').matches(':active')) $('scrub').value = Math.round(progress * 1000);
  } else if (p === 'cooling' || p === 'done') {
    const c = app.coolFrom;
    const k = ease(Math.min(T / 1.6, 1));
    printer.setHead(lerp(c.x, -80, k), lerp(c.y, 95, k));
    printer.setBedZ(lerp(c.z, c.z + 40, ease(Math.min(T / 2.5, 1))));
    app.temps.nozzle = lerp(app.temps.nozzle, 25, dt * 0.25);
    app.temps.bed = lerp(app.temps.bed, 25, dt * 0.15);
    app.fan = T < 6 ? 1 : 0;
    holoUniforms.uOpacity.value = 0;
    beadMaterial.userData.uniforms.uPrinted.value += dt * 30;
    progress = 1;
    if (p === 'cooling' && T > 2.6) { showDone(); app.phase = 'done'; }
  } else if (p === 'inspect') {
    app.temps.nozzle = lerp(app.temps.nozzle, 25, dt * 0.25);
    app.temps.bed = lerp(app.temps.bed, 25, dt * 0.15);
    app.fan = 0;
    progress = 1;
  }
  $('phase-progress').style.width = (progress * 100).toFixed(1) + '%';
  printer.setTemps(app.temps.nozzle, app.temps.bed);
  printer.setFan(app.fan);
}

function moveHeadTo(x, y, dt) {
  const hx = printer.head.position.x, hy = -printer.head.position.z;
  const k = 1 - Math.exp(-dt * 3);
  printer.setHead(lerp(hx, x, k), lerp(hy, y, k));
}

function showDone() {
  const tp = app.tp;
  const grams = (tp.filamentLength * 2.405 * 1.24) / 1000;
  $('done-stats').innerHTML = [
    ['Layers', tp.layers.length],
    ['Real print time', fmtTime(tp.totalTime)],
    ['Filament', `${(tp.filamentLength / 1000).toFixed(2)} m`],
    ['Weight', `${grams.toFixed(1)} g`],
    ['Nozzle moves', tp.moves.count.toLocaleString()],
    ['Extruded path', `${(tp.totalExtrude / 1000).toFixed(1)} m`],
  ].map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
  $('done').classList.remove('hidden');
}

// ---------------------------------------------------------------- camera director
const camPos = new THREE.Vector3(), camTarget = new THREE.Vector3();
function updateCamera(dt) {
  if (app.cam === 'orbit') {
    S.controls.autoRotate = app.phase === 'idle';
    S.controls.autoRotateSpeed = 0.6;
    return;
  }
  S.controls.autoRotate = false;
  const t = app.time;
  const hp = printer.head.position;
  const H = app.model ? app.model.size[2] : 50;
  const bedTop = printer.bed.position.y;
  if (app.phase === 'inspect' && inspector.active) {
    inspector.cameraGoal(t, camPos, camTarget);
  } else if (app.cam === 'nozzle' && app.phase !== 'idle') {
    camTarget.set(hp.x, NOZZLE_Y - 3, hp.z);
    camPos.set(hp.x + 52, NOZZLE_Y + 10, hp.z + 100);
  } else {
    switch (app.phase) {
      case 'idle': {
        const a = t * 0.12;
        camTarget.set(0, 230, 0);
        camPos.set(Math.sin(a) * 980, 560, Math.cos(a) * 980);
        break;
      }
      case 'slicing': {
        const a = 0.25 + Math.sin(t * 0.25) * 0.3;
        camTarget.set(0, bedTop + H * 0.45, 0);
        const R = 210 + H * 2.2;
        camPos.set(Math.sin(a) * R, bedTop + H * 0.8 + 60, Math.cos(a) * R);
        break;
      }
      case 'heating':
        camTarget.set(hp.x - 10, NOZZLE_Y + 6, hp.z);
        camPos.set(hp.x + 95, NOZZLE_Y + 30, hp.z + 235);
        break;
      case 'leveling':
        camTarget.set(0, NOZZLE_Y - 25, -10);
        camPos.set(240, NOZZLE_Y + 250, 520);
        break;
      case 'printing': {
        const z = app.sim.z;
        const shot = Math.floor(t / 10) % 3;
        if (shot === 0) {
          // low tracking shot just under the toolhead
          const a = 0.55 + Math.sin(t * 0.09) * 0.3;
          const R = 170 + H * 0.9;
          camTarget.set(hp.x * 0.4, NOZZLE_Y - z * 0.55 - 2, hp.z * 0.4);
          camPos.set(Math.sin(a) * R, NOZZLE_Y + 4, Math.cos(a) * R);
        } else if (shot === 1) {
          // wide establishing 3/4 view
          const a = 0.3 + Math.sin(t * 0.05) * 0.35;
          camTarget.set(0, NOZZLE_Y - 10 - z * 0.3, 0);
          camPos.set(Math.sin(a) * 560, NOZZLE_Y + 170, Math.cos(a) * 560);
        } else {
          // side sweep at layer height
          const a = -0.5 + Math.sin(t * 0.08) * 0.35;
          const R = 230 + H * 1.2;
          camTarget.set(0, NOZZLE_Y - z * 0.5 - 4, 0);
          camPos.set(Math.sin(a) * R, NOZZLE_Y + 22, Math.cos(a) * R);
        }
        break;
      }
      default: {
        const a = t * 0.18;
        camTarget.set(0, bedTop + H * 0.45, 0);
        const R = 230 + H * 1.8;
        camPos.set(Math.sin(a) * R, bedTop + H + 60, Math.cos(a) * R);
      }
    }
  }
  const k = 1 - Math.exp(-dt * (app.cam === 'nozzle' ? 4 : 1.6));
  app.programmaticCam = true;
  S.camera.position.lerp(camPos, k);
  S.controls.target.lerp(camTarget, k);
  app.programmaticCam = false;
}

// ---------------------------------------------------------------- HUD
let hudTimer = 0, miniReset = true;
const mini = $('minimap'), mctx = mini.getContext('2d');
const miniDone = document.createElement('canvas');
miniDone.width = mini.width; miniDone.height = mini.height;
let miniDoneIdx = 0;

function updateHUD(dt) {
  hudTimer += dt;
  if (hudTimer < 0.08) return;
  hudTimer = 0;
  const { nozzle, bed } = app.temps;
  $('t-nozzle').textContent = `${nozzle.toFixed(0)}°C`;
  $('t-nozzle-bar').style.width = `${(nozzle / 300) * 100}%`;
  $('t-bed').textContent = `${bed.toFixed(0)}°C`;
  $('t-bed-bar').style.width = `${(bed / 110) * 100}%`;
  $('t-fan').textContent = `${Math.round(app.fan * 100)}%`;
  const printing = app.phase === 'printing';
  const sim = app.sim;
  if (app.tp && (printing || app.phase === 'cooling' || app.phase === 'done' || app.phase === 'inspect')) {
    const done = app.phase !== 'printing';
    $('t-layer').textContent = done ? `${app.tp.layers.length}/${app.tp.layers.length}` : `${sim.layer + 1}/${app.tp.layers.length}`;
    $('t-z').textContent = `${sim.z.toFixed(2)} mm`;
    $('t-speed').textContent = done ? '0 mm/s' : `${sim.speed} mm/s`;
    const used = done ? app.tp.filamentLength : (app.tp.filamentLength * (app.tp.moves.d0[sim.idx] / app.tp.totalExtrude));
    $('t-fil').textContent = `${(used / 1000).toFixed(2)} m`;
    $('t-eta').textContent = done ? 'done' : fmtTime(app.tp.totalTime - sim.t);
    $('scrub-l').textContent = `${Math.floor((done ? 1 : sim.t / app.tp.totalTime) * 100)}%`;
  } else {
    for (const id of ['t-layer', 't-z', 't-eta']) $(id).textContent = '—';
    $('t-speed').textContent = '0 mm/s';
    $('t-fil').textContent = '0.00 m';
  }
  legend.querySelectorAll('div').forEach((d) => d.classList.toggle('on', printing && +d.dataset.i === sim.type));
  $('gcode').innerHTML = gcodeLines.slice(-12).join('\n');
  sound.update(printing && !app.paused ? sim.speed : 0, app.fan);
  printer.drawScreen({
    title: app.model ? app.model.name.slice(0, 22) : 'PRINT3D',
    sub: app.phase === 'printing' ? `Layer ${sim.layer + 1}/${app.tp.layers.length}` : { idle: 'Idle', slicing: 'Slicing…', heating: 'Heating…', leveling: 'Auto-levelling', cooling: 'Cooling', done: 'Finished', inspect: 'Finished' }[app.phase],
    progress: app.phase === 'printing' ? sim.t / app.tp.totalTime : app.phase === 'done' || app.phase === 'cooling' || app.phase === 'inspect' ? 1 : 0,
    nozzle, bed, footer: app.tp ? `ETA ${fmtTime(app.phase === 'printing' ? app.tp.totalTime - sim.t : 0)}` : 'Ready',
  });
  drawMinimap();
}

function drawMinimap() {
  const W = mini.width, H = mini.height;
  mctx.clearRect(0, 0, W, H);
  mctx.strokeStyle = 'rgba(255,255,255,0.04)';
  mctx.lineWidth = 1;
  for (let x = 0; x < W; x += 20) { mctx.beginPath(); mctx.moveTo(x, 0); mctx.lineTo(x, H); mctx.stroke(); }
  for (let y = 0; y < H; y += 20) { mctx.beginPath(); mctx.moveTo(0, y); mctx.lineTo(W, y); mctx.stroke(); }

  if (app.phase === 'leveling') {
    $('mini-layer').textContent = 'bed mesh';
    const pts = [[-50, -50], [0, -50], [50, -50], [50, 0], [0, 0], [-50, 0], [-50, 50], [0, 50], [50, 50]];
    pts.forEach(([x, y], i) => {
      if (i >= (app.levelIdx ?? 0) + 1) return;
      const px = W / 2 + x * 1.9, py = H / 2 - y * 1.9;
      const v = app.levelOffsets[i];
      const col = v > 0 ? `rgba(255,140,66,${0.3 + Math.abs(v) * 6})` : `rgba(90,184,255,${0.3 + Math.abs(v) * 6})`;
      mctx.fillStyle = col;
      mctx.beginPath(); mctx.arc(px, py, 22, 0, Math.PI * 2); mctx.fill();
      mctx.fillStyle = '#e8edf3';
      mctx.font = '600 13px JetBrains Mono, monospace';
      mctx.textAlign = 'center';
      mctx.fillText((v >= 0 ? '+' : '') + v.toFixed(3), px, py + 4);
    });
    return;
  }
  if (!app.tp || (app.phase !== 'printing' && app.phase !== 'cooling' && app.phase !== 'done' && app.phase !== 'inspect')) {
    $('mini-layer').textContent = '';
    return;
  }
  const tp = app.tp, mv = tp.moves, sim = app.sim;
  const layer = app.phase === 'printing' ? Math.max(sim.layer, 0) : tp.layers.length - 1;
  const size = app.model.size;
  const sc = Math.min((W - 30) / size[0], (H - 30) / size[1]);
  const X = (x) => W / 2 + x * sc, Y = (y) => H / 2 - y * sc;
  $('mini-layer').textContent = `layer ${layer + 1}`;
  const a = tp.layerStartMove[layer];
  const b = layer + 1 < tp.layers.length ? tp.layerStartMove[layer + 1] : mv.count;
  const end = app.phase === 'printing' ? sim.idx : b;

  // full layer plan (dim)
  mctx.lineWidth = Math.max(1, settings.lineWidth * sc * 0.8);
  mctx.lineCap = 'round';
  mctx.globalAlpha = 0.16;
  drawMoves(mctx, a, b, X, Y);
  // completed part of the layer, drawn incrementally
  if (miniReset) { miniDone.getContext('2d').clearRect(0, 0, W, H); miniDoneIdx = a; miniReset = false; }
  const dctx = miniDone.getContext('2d');
  dctx.lineWidth = mctx.lineWidth;
  dctx.lineCap = 'round';
  drawMoves(dctx, miniDoneIdx, end, X, Y);
  miniDoneIdx = end;
  mctx.globalAlpha = 1;
  mctx.drawImage(miniDone, 0, 0);
  if (app.phase === 'printing') {
    const hx = X(printer.head.position.x), hy = Y(-printer.head.position.z);
    const g = mctx.createRadialGradient(hx, hy, 0, hx, hy, 14);
    g.addColorStop(0, 'rgba(255,220,160,1)');
    g.addColorStop(1, 'rgba(255,120,40,0)');
    mctx.fillStyle = g;
    mctx.beginPath(); mctx.arc(hx, hy, 14, 0, Math.PI * 2); mctx.fill();
  }
}

function drawMoves(ctx, a, b, X, Y) {
  const mv = app.tp.moves;
  let cur = -2;
  ctx.beginPath();
  for (let k = a; k < b; k++) {
    const t = mv.type[k];
    if (t < 0) continue;
    if (t !== cur) {
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = FEATURES[t].color;
      cur = t;
    }
    ctx.moveTo(X(mv.x0[k]), Y(mv.y0[k]));
    ctx.lineTo(X(mv.x1[k]), Y(mv.y1[k]));
  }
  ctx.stroke();
}

// ---------------------------------------------------------------- smoke
function updateSmoke(dt) {
  const hot = app.phase === 'printing' && !app.paused;
  const hp = printer.head.position;
  for (let i = 0; i < smokeCount; i++) {
    smokeLife[i] += dt * 0.8;
    if (smokeLife[i] > 1) {
      smokeLife[i] = 0;
      smokePos[i * 3] = hp.x + (Math.random() - 0.5) * 4;
      smokePos[i * 3 + 1] = hot ? NOZZLE_Y : -1000;
      smokePos[i * 3 + 2] = hp.z + (Math.random() - 0.5) * 4;
    }
    smokePos[i * 3 + 1] += dt * 14;
    smokePos[i * 3] += Math.sin(app.time * 2 + i) * dt * 3;
  }
  smokeGeo.attributes.position.needsUpdate = true;
  smoke.material.opacity = hot ? 0.18 : 0;
}

// ---------------------------------------------------------------- loop
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  app.time += dt;
  holoUniforms.uTime.value = app.time;
  if (!app.paused) update(dt);
  inspector.update(dt, app.time, app.cam);
  updateCamera(dt);
  S.controls.update();
  printer.tick(app.paused ? 0 : dt);
  S.tick(dt, app.time);
  updateSmoke(dt);
  updateHUD(dt);
  S.composer.render();
}

// ---------------------------------------------------------------- helpers
function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(sec).padStart(2, '0')}s`;
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
let toastTimer;
function toast(msg, ok = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (ok ? ' ok' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 3200);
}
function gridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(256, 256, 40, 256, 256, 300);
  grad.addColorStop(0, 'rgba(0,229,255,0.35)');
  grad.addColorStop(1, 'rgba(0,229,255,0.02)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(120,240,255,0.5)';
  g.lineWidth = 1;
  for (let i = 0; i <= 512; i += 32) {
    g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 512); g.stroke();
    g.beginPath(); g.moveTo(0, i); g.lineTo(512, i); g.stroke();
  }
  g.strokeStyle = 'rgba(180,255,255,1)';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 506, 506);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function radial() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// boot
selectDemo('vase');
frame();
window.__app = app;
if (import.meta.env.DEV) window.__inspector = inspector;
