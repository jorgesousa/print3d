import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.localClippingEnabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = backgroundTexture();
  scene.fog = new THREE.Fog(0x05070c, 1400, 3200);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 5, 6000);
  camera.position.set(1400, 900, 1600);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 230, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 60;
  controls.maxDistance = 2200;
  controls.maxPolarAngle = Math.PI * 0.53;

  // lights
  scene.add(new THREE.HemisphereLight(0x8fb4ff, 0x1a1208, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(500, 900, 600);
  key.castShadow = true;
  key.shadow.mapSize.set(3072, 3072);
  Object.assign(key.shadow.camera, { left: -600, right: 600, top: 600, bottom: -600, near: 200, far: 2200 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.6;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x5aa8ff, 1.6);
  rim.position.set(-700, 500, -800);
  scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffb070, 0.5);
  fill.position.set(-600, 200, 700);
  scene.add(fill);

  // floor with soft glow
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(2600, 96),
    new THREE.MeshStandardMaterial({ color: 0x0a0d13, roughness: 0.42, metalness: 0.5 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1400, 1400),
    new THREE.MeshBasicMaterial({ map: radialTexture('rgba(0,255,163,0.22)'), transparent: true, depthWrite: false, toneMapped: false }),
  );
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.5;
  scene.add(glow);
  const rings = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(330 + i * 70, 331.5 + i * 70, 128),
      new THREE.MeshBasicMaterial({ color: 0x00ffa3, transparent: true, opacity: 0.18 - i * 0.05, toneMapped: false }),
    );
    r.rotation.x = -Math.PI / 2;
    r.position.y = 1;
    rings.add(r);
  }
  scene.add(rings);

  // dust motes in the light
  const dustCount = 500;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 1400;
    dustPos[i * 3 + 1] = Math.random() * 900;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 1400;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    size: 3, map: radialTexture('rgba(255,255,255,1)'), transparent: true, opacity: 0.35, depthWrite: false,
    blending: THREE.AdditiveBlending, color: 0xbfd8ff,
  }));
  scene.add(dust);

  // post-processing
  const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.7, 0.5, 1.0);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    composer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', resize);
  resize();

  return {
    renderer, scene, camera, controls, composer, bloom,
    tick(dt, t) {
      const p = dustGeo.attributes.position;
      for (let i = 0; i < dustCount; i++) {
        let y = p.array[i * 3 + 1] + dt * (6 + (i % 7));
        if (y > 900) y = 0;
        p.array[i * 3 + 1] = y;
        p.array[i * 3] += Math.sin(t * 0.3 + i) * dt * 4;
      }
      p.needsUpdate = true;
      rings.rotation.y = t * 0.05;
    },
  };
}

function backgroundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(512, 420, 40, 512, 512, 760);
  grad.addColorStop(0, '#16233a');
  grad.addColorStop(0.45, '#0a1020');
  grad.addColorStop(1, '#030409');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 1024);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function radialTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grad.addColorStop(0, color);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
