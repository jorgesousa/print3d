import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const NOZZLE_Y = 290; // world height of the nozzle tip
const GANTRY_Y = NOZZLE_Y + 78;
const FRAME_TOP = 420;
const HALF = 170;
export const CHUTE = { x: -140, y: 140 }; // print coordinates, beside the bed

const mat = {
  chassis: new THREE.MeshStandardMaterial({ color: 0x15181f, roughness: 0.55, metalness: 0.35 }),
  frame: new THREE.MeshStandardMaterial({ color: 0x23272f, roughness: 0.35, metalness: 0.8 }),
  rod: new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.18, metalness: 1 }),
  carbon: new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.3, metalness: 0.5 }),
  head: new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.4, metalness: 0.25 }),
  headFront: new THREE.MeshStandardMaterial({ color: 0x8a9099, roughness: 0.45, metalness: 0.2 }),
  alu: new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.28, metalness: 1 }),
  brass: new THREE.MeshStandardMaterial({ color: 0xd8a34a, roughness: 0.25, metalness: 1, emissive: 0x000000 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0x9fb8d0, roughness: 0.04, metalness: 0.1, transparent: true, opacity: 0.09, depthWrite: false, side: THREE.DoubleSide,
  }),
  accent: new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00ffa3).multiplyScalar(2.2), toneMapped: false }),
  led: new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff3dd).multiplyScalar(1.4), toneMapped: false }),
  ptfe: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.15, transparent: true, opacity: 0.35, depthWrite: false }),
};

export function createPrinter(scene) {
  const root = new THREE.Group();
  scene.add(root);
  const shadow = (m) => { m.castShadow = true; m.receiveShadow = true; return m; };

  // chassis + frame
  shadow(addBox(root, new RoundedBoxGeometry(HALF * 2 + 10, 80, HALF * 2 + 10, 4, 8), mat.chassis, 0, 40, 0));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    shadow(addBox(root, new RoundedBoxGeometry(18, FRAME_TOP - 80, 18, 2, 3), mat.frame, sx * HALF, 80 + (FRAME_TOP - 80) / 2, sz * HALF));
  }
  for (const s of [-1, 1]) {
    shadow(addBox(root, new RoundedBoxGeometry(HALF * 2 + 18, 18, 18, 2, 3), mat.frame, 0, FRAME_TOP, s * HALF));
    shadow(addBox(root, new RoundedBoxGeometry(18, 18, HALF * 2 + 18, 2, 3), mat.frame, s * HALF, FRAME_TOP, 0));
  }
  // glass: sides, back, top
  const glassH = FRAME_TOP - 80;
  addBox(root, new THREE.PlaneGeometry(HALF * 2, glassH), mat.glass, 0, 80 + glassH / 2, -HALF);
  for (const s of [-1, 1]) {
    const g = addBox(root, new THREE.PlaneGeometry(HALF * 2, glassH), mat.glass, s * HALF, 80 + glassH / 2, 0);
    g.rotation.y = Math.PI / 2;
  }
  const top = addBox(root, new THREE.PlaneGeometry(HALF * 2, HALF * 2), mat.glass, 0, FRAME_TOP + 9, 0);
  top.rotation.x = -Math.PI / 2;

  // chamber LED strip + light
  addBox(root, new THREE.BoxGeometry(HALF * 1.7, 3, 4), mat.led, 0, FRAME_TOP - 14, HALF - 14);
  const chamberLight = new THREE.PointLight(0xfff1dc, 1800, 700, 1.6);
  chamberLight.position.set(0, FRAME_TOP - 30, 120);
  root.add(chamberLight);

  // front accent stripe on chassis
  addBox(root, new THREE.BoxGeometry(HALF * 2 - 40, 2.5, 1), mat.accent, 0, 74, HALF + 5.6);

  // front screen
  const screenCanvas = document.createElement('canvas');
  screenCanvas.width = 320; screenCanvas.height = 180;
  const screenTex = new THREE.CanvasTexture(screenCanvas);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  const screen = addBox(root, new THREE.PlaneGeometry(80, 45), new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false }), 105, 40, HALF + 5.2);
  addBox(root, new RoundedBoxGeometry(88, 53, 2, 2, 3), mat.carbon, 105, 40, HALF + 4.6);

  // Z axis: lead screws + guide rods at the back
  for (const x of [-120, 120]) {
    shadow(addBox(root, new THREE.CylinderGeometry(4, 4, FRAME_TOP - 90, 16), mat.rod, x, 80 + (FRAME_TOP - 90) / 2, -150));
    shadow(addBox(root, new THREE.CylinderGeometry(3, 3, FRAME_TOP - 90, 12), mat.alu, x * 0.55, 80 + (FRAME_TOP - 90) / 2, -152));
  }

  // bed
  const bed = new THREE.Group();
  root.add(bed);
  shadow(addBox(bed, new RoundedBoxGeometry(236, 8, 236, 2, 2), mat.alu, 0, -5.5, 0));
  const bedHeater = new THREE.MeshStandardMaterial({ color: 0x2a0a05, emissive: 0xff3300, emissiveIntensity: 0, roughness: 0.8 });
  addBox(bed, new THREE.BoxGeometry(220, 1, 220), bedHeater, 0, -10, 0);
  const plateMat = new THREE.MeshStandardMaterial({ map: peiTexture(), roughness: 0.78, metalness: 0.35 });
  shadow(addBox(bed, new THREE.BoxGeometry(222, 1.2, 222), plateMat, 0, -0.6, 0));
  for (const x of [-120, 120]) {
    shadow(addBox(bed, new RoundedBoxGeometry(22, 14, 50, 2, 3), mat.frame, x, -9, -128));
  }
  // print space: children use print coordinates (x, y, z-up) -> world (x, z, -y)
  const printSpace = new THREE.Group();
  printSpace.rotation.x = -Math.PI / 2;
  bed.add(printSpace);

  // gantry
  for (const s of [-1, 1]) shadow(addBox(root, new THREE.CylinderGeometry(4, 4, HALF * 2, 16), mat.rod, s * (HALF - 18), GANTRY_Y, 0)).rotation.x = Math.PI / 2;
  const gantry = new THREE.Group();
  root.add(gantry);
  gantry.position.y = GANTRY_Y;
  const beam = shadow(addBox(gantry, new THREE.BoxGeometry(HALF * 2 - 30, 14, 14), mat.carbon, 0, 0, 0));
  beam.userData.carbon = true;
  for (const s of [-1, 1]) shadow(addBox(gantry, new RoundedBoxGeometry(28, 26, 34, 2, 4), mat.frame, s * (HALF - 18), 0, 0));

  // toolhead (origin = nozzle tip)
  const head = new THREE.Group();
  root.add(head);
  shadow(addBox(head, new RoundedBoxGeometry(58, 72, 52, 4, 8), mat.head, 0, 52, -2));
  shadow(addBox(head, new RoundedBoxGeometry(54, 58, 6, 3, 3), mat.headFront, 0, 54, 24));
  addBox(head, new THREE.BoxGeometry(40, 2, 1), mat.accent, 0, 80, 27.3);
  // fan
  const fanRing = addBox(head, new THREE.TorusGeometry(15, 2, 10, 40), mat.head, 0, 50, 27.5);
  fanRing.rotation.z = Math.PI / 2;
  const fan = new THREE.Group();
  fan.position.set(0, 50, 27);
  head.add(fan);
  for (let i = 0; i < 7; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(5, 9, 0.8), mat.carbon);
    const a = (i / 7) * Math.PI * 2;
    blade.position.set(Math.cos(a) * 9.5, Math.sin(a) * 9.5, 0);
    blade.rotation.z = a - Math.PI / 2;
    blade.rotation.y = 0.5;
    fan.add(blade);
  }
  // Sousa Lab badge: a fixed hub cap with a glowing "S" while the blades spin around it
  addBox(head, new THREE.CylinderGeometry(7.4, 7.4, 3, 32), mat.carbon, 0, 50, 27.4).rotation.x = Math.PI / 2;
  addBox(head, new THREE.TorusGeometry(7.4, 0.45, 8, 40), new THREE.MeshBasicMaterial({ color: new THREE.Color(0x00ffa3).multiplyScalar(0.75), toneMapped: false }), 0, 50, 28.9);
  addBox(head, new THREE.CircleGeometry(6.6, 40), new THREE.MeshBasicMaterial({ map: brandBadgeTexture(), color: new THREE.Color(1.1, 1.1, 1.1), transparent: true, toneMapped: false }), 0, 50, 28.95);
  // part cooling duct
  shadow(addBox(head, new RoundedBoxGeometry(14, 22, 30, 2, 3), mat.head, -24, 14, 4)).rotation.z = 0.35;
  shadow(addBox(head, new RoundedBoxGeometry(14, 22, 30, 2, 3), mat.head, 24, 14, 4)).rotation.z = -0.35;
  // hotend
  const heaterMat = new THREE.MeshStandardMaterial({ color: 0xaab0b8, roughness: 0.3, metalness: 1, emissive: 0xff4400, emissiveIntensity: 0 });
  shadow(addBox(head, new RoundedBoxGeometry(18, 11, 16, 2, 1.5), heaterMat, 0, 10, 0));
  shadow(addBox(head, new THREE.CylinderGeometry(3.6, 3.6, 3.5, 6), mat.brass, 0, 3.6, 0));
  const tipMat = new THREE.MeshStandardMaterial({ color: 0xd8a34a, roughness: 0.25, metalness: 1, emissive: 0xff5a00, emissiveIntensity: 0 });
  shadow(addBox(head, new THREE.CylinderGeometry(2.6, 0.45, 2.1, 20), tipMat, 0, 1.05, 0));
  const nozzleLight = new THREE.PointLight(0xff6a1a, 0, 120, 1.8);
  nozzleLight.position.set(0, 2, 6);
  head.add(nozzleLight);
  // filament inlet
  addBox(head, new THREE.CylinderGeometry(4, 4, 8, 16), mat.alu, 0, 91, -4);

  // spool on the right side
  const spoolPos = new THREE.Vector3(HALF + 70, 250, -40);
  const spoolHolder = shadow(addBox(root, new RoundedBoxGeometry(70, 14, 20, 2, 4), mat.frame, HALF + 35, 250, -40));
  spoolHolder.rotation.z = 0;
  const spool = new THREE.Group();
  spool.position.copy(spoolPos);
  root.add(spool);
  const flangeMat = new THREE.MeshStandardMaterial({ color: 0x111215, roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.85 });
  for (const s of [-1, 1]) {
    const f = shadow(addBox(spool, new THREE.CylinderGeometry(95, 95, 3, 64, 1, false), flangeMat, s * 34, 0, 0));
    f.rotation.z = Math.PI / 2;
  }
  const windTex = windingTexture();
  const filamentMat = new THREE.MeshStandardMaterial({ color: 0xff6b1a, roughness: 0.35, metalness: 0.0, bumpMap: windTex, bumpScale: 1.5 });
  const wound = shadow(addBox(spool, new THREE.CylinderGeometry(78, 78, 65, 96, 1, true), filamentMat, 0, 0, 0));
  wound.rotation.z = Math.PI / 2;
  const hub = shadow(addBox(spool, new THREE.CylinderGeometry(28, 28, 70, 32), mat.carbon, 0, 0, 0));
  hub.rotation.z = Math.PI / 2;
  for (let i = 0; i < 6; i++) {
    const marker = addBox(spool, new THREE.BoxGeometry(2, 30, 6), mat.headFront, 36, 0, 0);
    const a = (i / 6) * Math.PI * 2;
    marker.position.set(36.5, Math.cos(a) * 50, Math.sin(a) * 50);
    marker.rotation.x = -a;
  }

  // AMS: a box of four spools on top of the printer, plus the purge chute and its bin
  const ams = new THREE.Group();
  ams.visible = false;
  root.add(ams);
  const AMS_Y = FRAME_TOP + 10;
  shadow(addBox(ams, new RoundedBoxGeometry(310, 16, 120, 2, 4), mat.chassis, 0, AMS_Y + 8, 0));
  addBox(ams, new RoundedBoxGeometry(310, 84, 120, 2, 6), mat.glass, 0, AMS_Y + 58, 0);
  const slotX = [-108, -36, 36, 108];
  const amsSpools = [], amsLeds = [];
  for (const x of slotX) {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.35, bumpMap: windTex, bumpScale: 1.5 });
    const s = shadow(addBox(ams, new THREE.CylinderGeometry(32, 32, 62, 48), m, x, AMS_Y + 52, 0));
    s.rotation.x = Math.PI / 2;
    amsSpools.push(s);
    amsLeds.push(addBox(ams, new THREE.BoxGeometry(30, 4, 2), new THREE.MeshBasicMaterial({ color: 0x20262f, toneMapped: false }), x, AMS_Y + 8, 61));
  }
  shadow(addBox(root, new RoundedBoxGeometry(34, 50, 34, 2, 4), mat.head, CHUTE.x, 105, -CHUTE.y));
  const blob = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshStandardMaterial({ roughness: 0.5 }));
  blob.visible = false;
  root.add(blob);

  // PTFE tube + filament inside (rebuilt as the head moves)
  const ptfe = new THREE.Mesh(new THREE.BufferGeometry(), mat.ptfe);
  const filamentCore = new THREE.Mesh(new THREE.BufferGeometry(), filamentMat);
  root.add(ptfe, filamentCore);

  const state = { x: 0, y: 0, bedZ: 0, fanSpeed: 0, fanAngle: 0, spoolAngle: 0, temp: 25, slot: 0, fill: 1 };
  const tmp = new THREE.Vector3();

  function updateTube() {
    const hx = head.position.x, hz = head.position.z;
    const inlet = new THREE.Vector3(hx, NOZZLE_Y + 95, hz - 4);
    const sx = slotX[state.slot];
    const curve = new THREE.CatmullRomCurve3([
      ...(ams.visible ? [
        new THREE.Vector3(sx, AMS_Y + 20, -64),
        new THREE.Vector3(sx * 0.7, AMS_Y + 30, -100),
        new THREE.Vector3(hx * 0.5, AMS_Y + 10, (hz - 120) * 0.5),
      ] : [
        new THREE.Vector3(spoolPos.x, spoolPos.y + 78, spoolPos.z - 10),
        new THREE.Vector3(spoolPos.x - 10, FRAME_TOP + 40, spoolPos.z - 40),
        new THREE.Vector3((hx + HALF) * 0.5, FRAME_TOP + 70, (hz - 120) * 0.5),
      ]),
      tmp.set(hx, NOZZLE_Y + 150, hz - 4).clone(),
      inlet,
    ]);
    ptfe.geometry.dispose();
    filamentCore.geometry.dispose();
    ptfe.geometry = new THREE.TubeGeometry(curve, 70, 2.6, 10, false);
    filamentCore.geometry = new THREE.TubeGeometry(curve, 70, 0.9, 6, false);
    filamentCore.geometry.setDrawRange(0, Math.round(state.fill * 70) * 36);
  }

  const printer = {
    root, ams, bed, printSpace, head, gantry, spool, filamentMat, chamberLight,
    setHead(x, y) {
      state.x = x; state.y = y;
      head.position.set(x, NOZZLE_Y, -y);
      gantry.position.z = -y;
    },
    setBedZ(z) {
      state.bedZ = z;
      bed.position.y = NOZZLE_Y - z;
    },
    setTemps(nozzle, bedT) {
      state.temp = nozzle;
      const h = THREE.MathUtils.clamp((nozzle - 40) / 190, 0, 1);
      tipMat.emissiveIntensity = h * h * 2.2;
      heaterMat.emissiveIntensity = h * h * 0.35;
      nozzleLight.intensity = h * h * 900;
      bedHeater.emissiveIntensity = THREE.MathUtils.clamp((bedT - 25) / 40, 0, 1) * 0.8;
    },
    setFan(speed) { state.fanSpeed = speed; },
    setFilamentColor(color, silk) {
      filamentMat.color.set(color);
      filamentMat.metalness = silk ? 0.55 : 0;
      filamentMat.roughness = silk ? 0.22 : 0.35;
    },
    feedFilament(mm) {
      state.spoolAngle += mm / 70;
      spool.rotation.x = -state.spoolAngle;
      amsSpools[state.slot].rotation.y = -state.spoolAngle * 2;
    },
    setAms(on) {
      ams.visible = on;
      spool.visible = spoolHolder.visible = !on;
    },
    setSlotColor(i, color) { amsSpools[i].material.color.set(color); },
    // fill: how far the filament reaches along the tube, 0 = AMS, 1 = hotend
    setLoaded(slot, fill = 1) {
      state.slot = slot;
      state.fill = fill;
      amsLeds.forEach((l, i) => l.material.color.set(i === slot ? 0x00ffa3 : 0x20262f));
    },
    // the purge blob hangs under the nozzle, then falls into the chute (drop 0..1)
    setBlob(size, color, drop = 0) {
      blob.visible = size > 0;
      if (!blob.visible) return;
      blob.scale.setScalar(size);
      blob.material.color.copy(color);
      blob.position.set(CHUTE.x, NOZZLE_Y - size - drop * (NOZZLE_Y - size - 130), -CHUTE.y);
    },
    tick(dt) {
      state.fanAngle += dt * state.fanSpeed * 40;
      fan.rotation.z = state.fanAngle;
      updateTube();
    },
    drawScreen(info) {
      const g = screenCanvas.getContext('2d');
      g.fillStyle = '#05070b';
      g.fillRect(0, 0, 320, 180);
      g.fillStyle = '#00ffa3';
      g.font = '600 22px Inter, system-ui, sans-serif';
      g.fillText(info.title, 18, 38);
      g.fillStyle = '#9aa4b2';
      g.font = '500 16px Inter, system-ui, sans-serif';
      g.fillText(info.sub, 18, 64);
      g.fillStyle = '#1d232d';
      g.fillRect(18, 120, 284, 14);
      g.fillStyle = '#00ffa3';
      g.fillRect(18, 120, 284 * info.progress, 14);
      g.fillStyle = '#e8edf3';
      g.font = '700 30px Inter, system-ui, sans-serif';
      g.fillText(`${Math.floor(info.progress * 100)}%`, 18, 108);
      g.font = '500 16px "JetBrains Mono", monospace';
      g.fillStyle = '#ffb27a';
      g.fillText(`${Math.round(info.nozzle)}°C`, 200, 100);
      g.fillStyle = '#7ac8ff';
      g.fillText(`${Math.round(info.bed)}°C`, 262, 100);
      g.fillStyle = '#9aa4b2';
      g.fillText(info.footer, 18, 162);
      screenTex.needsUpdate = true;
    },
  };
  printer.setHead(0, 0);
  printer.setBedZ(60);
  updateTube();
  return printer;
}

// "S" in the Sousa Lab gradient, cut into horizontal layer lines like a printed part
function brandBadgeTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const draw = () => {
    const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 256);
    g.globalCompositeOperation = 'source-over';
    const grad = g.createLinearGradient(0, 40, 0, 216);
    grad.addColorStop(0, '#7dffd2');
    grad.addColorStop(1, '#00c2ff');
    g.fillStyle = grad;
    g.font = '800 216px Inter, "Helvetica Neue", Arial, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0, 255, 190, 0.6)';
    g.shadowBlur = 8;
    g.fillText('S', 128, 140);
    g.shadowBlur = 0;
    g.globalCompositeOperation = 'destination-out';
    for (let y = 30; y < 240; y += 17) g.fillRect(0, y, 256, 5);
    tex.needsUpdate = true;
  };
  draw();
  document.fonts?.load('800 216px Inter').then(draw, () => {});
  return tex;
}

function addBox(parent, geometry, material, x, y, z) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  parent.add(m);
  return m;
}

function peiTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 1024;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 1024, 1024);
  grad.addColorStop(0, '#a5843f');
  grad.addColorStop(0.5, '#8a6c30');
  grad.addColorStop(1, '#9b7a37');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1024, 1024);
  for (let i = 0; i < 90000; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.5 ? `rgba(255,225,160,${Math.random() * 0.18})` : `rgba(40,25,5,${Math.random() * 0.22})`;
    g.fillRect(Math.random() * 1024, Math.random() * 1024, 1.6, 1.6);
  }
  g.strokeStyle = 'rgba(20,14,4,0.55)';
  g.lineWidth = 2;
  g.strokeRect(20, 20, 984, 984);
  g.fillStyle = 'rgba(25,16,4,0.6)';
  for (let i = 0; i <= 20; i++) {
    const p = 46 + i * 46.6;
    const len = i % 5 === 0 ? 22 : 11;
    g.fillRect(p, 20, 2, len); g.fillRect(p, 1004 - len, 2, len);
    g.fillRect(20, p, len, 2); g.fillRect(1004 - len, p, len, 2);
  }
  g.font = '600 22px Inter, system-ui, sans-serif';
  g.fillText('TEXTURED PEI  ·  PRINT3D', 380, 990);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function windingTexture() {
  const c = document.createElement('canvas');
  c.width = 16; c.height = 256;
  const g = c.getContext('2d');
  for (let y = 0; y < 256; y += 4) {
    g.fillStyle = '#fff';
    g.fillRect(0, y, 16, 3);
    g.fillStyle = '#555';
    g.fillRect(0, y + 3, 16, 1);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(30, 1);
  return t;
}
