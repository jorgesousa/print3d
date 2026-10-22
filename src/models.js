import * as THREE from 'three';

// All generators return non-indexed Float32Array positions in print space (mm, Z-up).

function toPrint(geometry, rotateYUp = true) {
  let g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (rotateYUp) g.rotateX(Math.PI / 2);
  const pos = fixWinding(new Float32Array(g.attributes.position.array));
  g.dispose();
  return pos;
}

// Ensure outward-facing winding (positive signed volume) so overlapping shells union correctly.
export function fixWinding(pos) {
  let vol = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const cx = pos[i + 6], cy = pos[i + 7], cz = pos[i + 8];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol < 0) {
    for (let i = 0; i < pos.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = pos[i + 3 + k];
        pos[i + 3 + k] = pos[i + 6 + k];
        pos[i + 6 + k] = t;
      }
    }
  }
  return pos;
}

export function mergePositions(list) {
  const total = list.reduce((a, p) => a + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of list) { out.set(p, o); o += p.length; }
  return out;
}

function twistedVase() {
  const H = 72, M = 160, N = 110;
  const prof = (t) => 15 + 11 * Math.sin(Math.PI * (t * 0.85 + 0.12)) - 3 * Math.sin(Math.PI * t * 2.2) * t;
  const verts = [];
  for (let j = 0; j <= N; j++) {
    const t = j / N;
    const twist = t * 1.6;
    for (let i = 0; i < M; i++) {
      const a = (i / M) * Math.PI * 2;
      const r = prof(t) * (1 + 0.11 * Math.cos(6 * (a + twist)));
      verts.push([Math.cos(a) * r, Math.sin(a) * r, t * H]);
    }
  }
  const pos = [];
  const tri = (a, b, c) => pos.push(...a, ...b, ...c);
  for (let j = 0; j < N; j++) for (let i = 0; i < M; i++) {
    const a = verts[j * M + i], b = verts[j * M + ((i + 1) % M)];
    const c = verts[(j + 1) * M + i], d = verts[(j + 1) * M + ((i + 1) % M)];
    tri(a, b, d); tri(a, d, c);
  }
  const bot = [0, 0, 0], topc = [0, 0, H];
  for (let i = 0; i < M; i++) {
    tri(bot, verts[(i + 1) % M], verts[i]);
    tri(topc, verts[N * M + i], verts[N * M + ((i + 1) % M)]);
  }
  return fixWinding(new Float32Array(pos));
}

function gear() {
  const teeth = 22, rOut = 34, rRoot = 30;
  const shape = new THREE.Shape();
  const steps = teeth * 8;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const ph = (i % 8) / 8;
    const r = ph < 0.15 || ph > 0.85 ? rRoot : ph < 0.3 ? rRoot + ((ph - 0.15) / 0.15) * (rOut - rRoot) : ph < 0.7 ? rOut : rOut - ((ph - 0.7) / 0.15) * (rOut - rRoot);
    const x = Math.cos(a) * r, y = Math.sin(a) * r;
    i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y);
  }
  const hole = (cx, cy, r) => { const p = new THREE.Path(); p.absarc(cx, cy, r, 0, Math.PI * 2, true); return p; };
  shape.holes.push(hole(0, 0, 5));
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    shape.holes.push(hole(Math.cos(a) * 18, Math.sin(a) * 18, 5.5));
  }
  const body = new THREE.ExtrudeGeometry(shape, { depth: 9, bevelEnabled: true, bevelThickness: 0.8, bevelSize: 0.8, bevelSegments: 2, curveSegments: 24 });
  body.translate(0, 0, 0.8);
  const hubShape = new THREE.Shape();
  hubShape.absarc(0, 0, 10, 0, Math.PI * 2, false);
  hubShape.holes.push(hole(0, 0, 5));
  const hub = new THREE.ExtrudeGeometry(hubShape, { depth: 18, bevelEnabled: false, curveSegments: 48 });
  return mergePositions([toPrint(body, false), toPrint(hub, false)]);
}

function lathe(points, segments) {
  return new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments);
}

function rook() {
  const body = lathe([
    [0, 0], [21, 0], [21, 4], [19, 6], [17.5, 8], [17.5, 10], [14, 14], [12, 20], [11, 36], [12.5, 40],
    [16, 42], [16, 46], [15, 47], [15, 54], [10.5, 54], [10.5, 50], [0, 50],
  ], 96);
  const parts = [toPrint(body)];
  for (let k = 0; k < 6; k++) {
    const a0 = (k / 6) * Math.PI * 2 + 0.12, a1 = a0 + (Math.PI * 2) / 6 - 0.42;
    const s = new THREE.Shape();
    s.absarc(0, 0, 15, a0, a1, false);
    s.absarc(0, 0, 10.5, a1, a0, true);
    const g = new THREE.ExtrudeGeometry(s, { depth: 8, bevelEnabled: false, curveSegments: 12 });
    g.translate(0, 0, 53.5);
    parts.push(toPrint(g, false));
  }
  return mergePositions(parts);
}

function planter() {
  const g = lathe([
    [0, 0], [19, 0], [26, 14], [30, 30], [28, 46], [30, 50], [27.5, 50], [25.5, 46], [27.5, 30], [23.5, 15], [17, 3.2], [0, 3.2],
  ], 9);
  return toPrint(g);
}

function rocket() {
  const body = lathe([
    [0, 0], [7, 0], [9.5, 3], [10, 8], [10, 42], [9.4, 50], [7.6, 58], [4.6, 65], [0, 71],
  ], 72);
  const parts = [toPrint(body)];
  for (let k = 0; k < 3; k++) {
    const s = new THREE.Shape();
    s.moveTo(7, 0); s.lineTo(23, 0); s.lineTo(23, 4); s.lineTo(9, 26); s.lineTo(7, 26); s.lineTo(7, 0);
    const g = new THREE.ExtrudeGeometry(s, { depth: 2.6, bevelEnabled: false });
    g.translate(0, 0, -1.3);
    g.rotateX(Math.PI / 2);
    g.rotateZ((k / 3) * Math.PI * 2);
    parts.push(toPrint(g, false));
  }
  return mergePositions(parts);
}

export const DEMO_MODELS = [
  { id: 'vase', name: 'Twisted Vase', desc: 'Organic twist · solid infill', build: twistedVase },
  { id: 'rook', name: 'Castle Rook', desc: 'Chess piece · battlements', build: rook },
  { id: 'gear', name: 'Spur Gear', desc: '22 teeth · holes & hub', build: gear },
  { id: 'planter', name: 'Low-poly Planter', desc: 'Hollow · faceted walls', build: planter },
  { id: 'rocket', name: 'Rocket', desc: 'Three fins · nose cone', build: rocket },
];
