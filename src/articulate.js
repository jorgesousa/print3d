// Print-in-place articulation analysis.
// 1. Split the mesh into separate shells (connected components).
// 2. Find pairs of shells that are interlocked across a small clearance gap.
// 3. For every pair, fit the rigid motion that slides the contact surface along itself
//    ("kinematic surface" fit: rotation → hinge, helix → screw/twist slide, straight → slider).
// 4. Verify it by voxelising the first shell and moving the second until they collide. If no
//    slide/screw fits, search hinge axes directly — this recovers pivot, axis and limits.
// Pure JS (no three.js) so it runs in a worker and in node.

const MAX_COMPONENTS = 400;

export function findComponents(pos) {
  const nt = (pos.length / 9) | 0;
  const nv = nt * 3;
  const q = new Int32Array(nv * 3);
  for (let i = 0; i < nv * 3; i++) q[i] = Math.round(pos[i] * 1000);
  let size = 1;
  while (size < nv * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const rep = new Int32Array(nv);
  const vid = new Int32Array(nv);
  let next = 0;
  for (let i = 0; i < nv; i++) {
    const a = q[i * 3], b = q[i * 3 + 1], c = q[i * 3 + 2];
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e < 0) { table[h] = next; rep[next] = i; vid[i] = next++; break; }
      const r = rep[e] * 3;
      if (q[r] === a && q[r + 1] === b && q[r + 2] === c) { vid[i] = e; break; }
      h = (h + 1) & mask;
    }
  }
  const parent = new Int32Array(next);
  for (let i = 0; i < next; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < nt; t++) {
    const a = find(vid[t * 3]), b = find(vid[t * 3 + 1]), c = find(vid[t * 3 + 2]);
    parent[b] = a;
    parent[find(c)] = find(a);
  }
  const label = new Int32Array(next).fill(-1);
  const comp = new Int32Array(nt);
  let count = 0;
  for (let t = 0; t < nt; t++) {
    const r = find(vid[t * 3]);
    if (label[r] < 0) label[r] = count++;
    comp[t] = label[r];
  }
  return { comp, count };
}

// ---------------------------------------------------------------------------------------
function boxOfTris(pos, tris) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const t of tris) for (let k = 0; k < 9; k++) {
    const v = pos[t * 9 + k], ax = k % 3;
    if (v < b[ax]) b[ax] = v;
    if (v > b[ax + 3]) b[ax + 3] = v;
  }
  return b;
}
const expand = (b, m) => [b[0] - m, b[1] - m, b[2] - m, b[3] + m, b[4] + m, b[5] + m];
const intersectBox = (a, b) => {
  const r = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2]), Math.min(a[3], b[3]), Math.min(a[4], b[4]), Math.min(a[5], b[5])];
  return r[0] < r[3] && r[1] < r[4] && r[2] < r[5] ? r : null;
};
function triInBox(pos, t, b) {
  const o = t * 9;
  for (let ax = 0; ax < 3; ax++) {
    const a = pos[o + ax], c = pos[o + 3 + ax], d = pos[o + 6 + ax];
    if (Math.max(a, c, d) < b[ax] || Math.min(a, c, d) > b[ax + 3]) return false;
  }
  return true;
}

// evenly spaced points on the triangles inside a box
function sampleSurface(pos, tris, box, spacing, max = 4e6, normals = null) {
  const out = [];
  for (const t of tris) {
    if (!triInBox(pos, t, box)) continue;
    const o = t * 9;
    // start at the vertex opposite the longest edge, so long slivers get a grid along their length only
    const e0 = (pos[o + 3] - pos[o + 6]) ** 2 + (pos[o + 4] - pos[o + 7]) ** 2 + (pos[o + 5] - pos[o + 8]) ** 2;
    const e1 = (pos[o + 6] - pos[o]) ** 2 + (pos[o + 7] - pos[o + 1]) ** 2 + (pos[o + 8] - pos[o + 2]) ** 2;
    const e2 = (pos[o] - pos[o + 3]) ** 2 + (pos[o + 1] - pos[o + 4]) ** 2 + (pos[o + 2] - pos[o + 5]) ** 2;
    const s0 = e0 >= e1 && e0 >= e2 ? 0 : e1 >= e2 ? 1 : 2;
    const A = o + s0 * 3, B = o + ((s0 + 1) % 3) * 3, C = o + ((s0 + 2) % 3) * 3;
    const ax = pos[A], ay = pos[A + 1], az = pos[A + 2];
    const bx = pos[B] - ax, by = pos[B + 1] - ay, bz = pos[B + 2] - az;
    const cx = pos[C] - ax, cy = pos[C + 1] - ay, cz = pos[C + 2] - az;
    const L = Math.sqrt(Math.max(e0, e1, e2));
    const k = Math.min(400, Math.max(1, Math.ceil(L / spacing)));
    const nxr = by * cz - bz * cy, nyr = bz * cx - bx * cz, nzr = bx * cy - by * cx;
    const hgt = Math.hypot(nxr, nyr, nzr) / L; // height over the longest edge
    const kh = Math.min(k, Math.max(1, Math.ceil(hgt / spacing)));
    const nl = Math.hypot(nxr, nyr, nzr) || 1, nx = nxr / nl, ny = nyr / nl, nz = nzr / nl;
    // rows parallel to the long edge, from the apex outwards
    for (let i = 0; i <= kh; i++) {
      const t = i / kh, m = Math.max(1, Math.round(k * t));
      for (let j = 0; j <= m; j++) {
        const u = t * (1 - j / m), v = (t * j) / m;
        const x = ax + bx * u + cx * v, y = ay + by * u + cy * v, z = az + bz * u + cz * v;
        if (x < box[0] || y < box[1] || z < box[2] || x > box[3] || y > box[4] || z > box[5]) continue;
        out.push(x, y, z);
        if (normals) normals.push(nx, ny, nz);
      }
    }
    if (out.length > max * 3) break;
  }
  return new Float32Array(out);
}

// occupancy grid of a closed shell (parity along z columns)
function voxelize(pos, tris, box, res) {
  const nx = Math.max(1, Math.ceil((box[3] - box[0]) / res));
  const ny = Math.max(1, Math.ceil((box[4] - box[1]) / res));
  const nz = Math.max(1, Math.ceil((box[5] - box[2]) / res));
  const ox = box[0], oy = box[1], oz = box[2];
  const cols = new Array(nx * ny);
  const colBox = [box[0], box[1], -Infinity, box[3], box[4], Infinity];
  for (const t of tris) {
    if (!triInBox(pos, t, colBox)) continue;
    const o = t * 9;
    const x0 = pos[o], y0 = pos[o + 1], z0 = pos[o + 2], x1 = pos[o + 3], y1 = pos[o + 4], z1 = pos[o + 5], x2 = pos[o + 6], y2 = pos[o + 7], z2 = pos[o + 8];
    const d = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(d) < 1e-12) continue;
    const i0 = Math.max(0, Math.ceil((Math.min(x0, x1, x2) - ox) / res - 0.5)), i1 = Math.min(nx - 1, Math.floor((Math.max(x0, x1, x2) - ox) / res - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(y0, y1, y2) - oy) / res - 0.5)), j1 = Math.min(ny - 1, Math.floor((Math.max(y0, y1, y2) - oy) / res - 0.5));
    for (let i = i0; i <= i1; i++) {
      const px = ox + (i + 0.5) * res;
      for (let j = j0; j <= j1; j++) {
        const py = oy + (j + 0.5) * res;
        const u = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / d;
        const v = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / d;
        if (u < 0 || v < 0 || u + v > 1) continue;
        (cols[i * ny + j] ||= []).push(z0 + u * (z1 - z0) + v * (z2 - z0));
      }
    }
  }
  const occ = new Uint8Array(nx * ny * nz);
  for (let c = 0; c < nx * ny; c++) {
    const zs = cols[c];
    if (!zs || zs.length < 2) continue;
    zs.sort((a, b) => a - b);
    for (let h = 0; h + 1 < zs.length; h += 2) {
      const a = Math.max(0, Math.ceil((zs[h] - oz) / res - 0.5));
      const b = Math.min(nz - 1, Math.floor((zs[h + 1] - oz) / res - 0.5));
      for (let k = a; k <= b; k++) occ[c * nz + k] = 1;
    }
  }
  return { occ, nx, ny, nz, ox, oy, oz, res };
}

// spatial hash of points, for nearest-distance queries
function pointHash(P, cell) {
  const m = new Map();
  for (let i = 0; i < P.length; i += 3) {
    const k = cellKey(Math.floor(P[i] / cell), Math.floor(P[i + 1] / cell), Math.floor(P[i + 2] / cell));
    let a = m.get(k);
    if (!a) m.set(k, (a = []));
    a.push(i);
  }
  return m;
}
const cellKey = (x, y, z) => (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);

function basisFor(u) {
  const a = Math.abs(u[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  let v = [u[1] * a[2] - u[2] * a[1], u[2] * a[0] - u[0] * a[2], u[0] * a[1] - u[1] * a[0]];
  const l = Math.hypot(...v);
  v = v.map((x) => x / l);
  const w = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return [v, w];
}

// ---------------------------------------------------------------------------------------
// symmetric eigen-decomposition (Jacobi), ascending
function eigSym(A, N) {
  const a = Float64Array.from(A), V = new Float64Array(N * N);
  for (let i = 0; i < N; i++) V[i * N + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < N; p++) for (let q = p + 1; q < N; q++) off += a[p * N + q] ** 2;
    if (off < 1e-24) break;
    for (let p = 0; p < N; p++) for (let q = p + 1; q < N; q++) {
      const apq = a[p * N + q];
      if (Math.abs(apq) < 1e-30) continue;
      const th = (a[q * N + q] - a[p * N + p]) / (2 * apq);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < N; k++) { const x = a[k * N + p], y = a[k * N + q]; a[k * N + p] = c * x - s * y; a[k * N + q] = s * x + c * y; }
      for (let k = 0; k < N; k++) { const x = a[p * N + k], y = a[q * N + k]; a[p * N + k] = c * x - s * y; a[q * N + k] = s * x + c * y; }
      for (let k = 0; k < N; k++) { const x = V[k * N + p], y = V[k * N + q]; V[k * N + p] = c * x - s * y; V[k * N + q] = s * x + c * y; }
    }
  }
  const out = [];
  for (let i = 0; i < N; i++) out.push({ val: a[i * N + i], vec: Array.from({ length: N }, (_, k) => V[k * N + i]) });
  return out.sort((x, y) => x.val - y.val);
}

// Rigid motion (twist) under which the contact surface slides along itself: every point's
// velocity v + w×x must be tangent, n·(v + w×x) = 0. Least squares → 6×6 eigenproblem,
// re-weighted so faces that do not take part in the slide (end stops, outer skin) drop out.
function fitTwist(P, N) {
  const n = P.length / 3;
  if (n < 30) return null;
  let c = [0, 0, 0];
  for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) c[k] += P[i + k];
  c = c.map((x) => x / n);
  let r2 = 0;
  for (let i = 0; i < P.length; i += 3) r2 += (P[i] - c[0]) ** 2 + (P[i + 1] - c[1]) ** 2 + (P[i + 2] - c[2]) ** 2;
  const L = Math.sqrt(r2 / n) || 1;
  const step = Math.max(1, Math.floor(n / 60000));
  const row = (i, r) => {
    const x = (P[i] - c[0]) / L, y = (P[i + 1] - c[1]) / L, z = (P[i + 2] - c[2]) / L;
    const nx = N[i], ny = N[i + 1], nz = N[i + 2];
    r[0] = y * nz - z * ny; r[1] = z * nx - x * nz; r[2] = x * ny - y * nx; r[3] = nx; r[4] = ny; r[5] = nz;
  };
  const r = new Float64Array(6);
  let ev = null, sig = 0;
  for (let it = 0; it < 8; it++) {
    const M = new Float64Array(36);
    let W = 0;
    const res = [];
    for (let i = 0; i < P.length; i += 3 * step) {
      row(i, r);
      let w = 1;
      if (ev) {
        let d = 0;
        for (let k = 0; k < 6; k++) d += r[k] * ev[0].vec[k];
        w = 1 / (1 + (d / sig) ** 2);
      }
      W += w;
      for (let p = 0; p < 6; p++) for (let q = p; q < 6; q++) M[p * 6 + q] += w * r[p] * r[q];
    }
    for (let p = 0; p < 6; p++) for (let q = p; q < 6; q++) M[q * 6 + p] = M[p * 6 + q] /= W;
    ev = eigSym(M, 6);
    for (let i = 0; i < P.length; i += 3 * step) {
      row(i, r);
      let d = 0;
      for (let k = 0; k < 6; k++) d += r[k] * ev[0].vec[k];
      res.push(Math.abs(d));
    }
    res.sort((a, b) => a - b);
    sig = Math.max(res[res.length >> 1] * 1.5, 1e-5);
  }
  const vec = ev[0].vec;
  const w = vec.slice(0, 3), v = vec.slice(3).map((x) => x * L);
  const wl = Math.hypot(...w), vl = Math.hypot(...v);
  // straight slide: (almost) no rotation per mm of travel
  if (wl * 400 < vl) return { kind: 'slide', u: v.map((x) => x / vl), p: c, rot: 0, lin: 1 };
  const u = w.map((x) => x / wl), vv = v.map((x) => x / wl);
  const pitch = u[0] * vv[0] + u[1] * vv[1] + u[2] * vv[2]; // mm along the axis per radian
  const p = [u[1] * vv[2] - u[2] * vv[1] + c[0], u[2] * vv[0] - u[0] * vv[2] + c[1], u[0] * vv[1] - u[1] * vv[0] + c[2]];
  return { kind: 'screw', u, p, rot: 1, lin: pitch };
}

// ---------------------------------------------------------------------------------------
// Joint between shells A and B: voxelise A around the contact, rotate B's surface points
// and count how many end up inside A.
function measureJoint(pos, trisA, trisB, near, twist) {
  let bx = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let cx = 0, cy = 0, cz = 0;
  const nn = near.length / 3;
  for (let i = 0; i < near.length; i += 3) {
    for (let k = 0; k < 3; k++) { bx[k] = Math.min(bx[k], near[i + k]); bx[k + 3] = Math.max(bx[k + 3], near[i + k]); }
    cx += near[i]; cy += near[i + 1]; cz += near[i + 2];
  }
  const c0 = [cx / nn, cy / nn, cz / nn];
  const box = expand(bx, 4);
  const dim = Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
  const res = Math.max(0.1, dim / 220);
  const V = voxelize(pos, trisA, box, res);

  // B points within ~3 mm of A (coarse dilation of A's occupancy)
  const cs = Math.max(1, Math.round(1 / res));
  const mx = Math.ceil(V.nx / cs), my = Math.ceil(V.ny / cs), mz = Math.ceil(V.nz / cs);
  const coarse = new Uint8Array(mx * my * mz);
  for (let i = 0; i < V.nx; i++) for (let j = 0; j < V.ny; j++) for (let k = 0; k < V.nz; k++) {
    if (V.occ[(i * V.ny + j) * V.nz + k]) coarse[(((i / cs) | 0) * my + ((j / cs) | 0)) * mz + ((k / cs) | 0)] = 1;
  }
  const Sall = sampleSurface(pos, trisB, box, res * 1.5);
  const keep = [];
  for (let s = 0; s < Sall.length; s += 3) {
    const I = Math.floor((Sall[s] - V.ox) / res / cs), J = Math.floor((Sall[s + 1] - V.oy) / res / cs), K = Math.floor((Sall[s + 2] - V.oz) / res / cs);
    let ok = false;
    for (let a = -3; a <= 3 && !ok; a++) for (let b = -3; b <= 3 && !ok; b++) for (let d = -3; d <= 3 && !ok; d++) {
      const x = I + a, y = J + b, z = K + d;
      if (x >= 0 && y >= 0 && z >= 0 && x < mx && y < my && z < mz && coarse[(x * my + y) * mz + z]) ok = true;
    }
    if (ok) keep.push(Sall[s], Sall[s + 1], Sall[s + 2]);
  }
  // random order makes collisions show up early, so failing tests exit fast
  const nAll = keep.length / 3;
  const idx = new Uint32Array(nAll);
  for (let i = 0; i < nAll; i++) idx[i] = i;
  let seed = 12345;
  for (let i = nAll - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    const r = seed % (i + 1);
    const t = idx[i]; idx[i] = idx[r]; idx[r] = t;
  }
  const n = Math.min(nAll, 16000);
  const S = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const k = idx[i] * 3; S[i * 3] = keep[k]; S[i * 3 + 1] = keep[k + 1]; S[i * 3 + 2] = keep[k + 2]; }
  const nSub = Math.min(n, 3000);
  const tolFor = (m) => Math.max(2, Math.round(m * 0.00025));

  const hits = (c, u, ang, m, lim, lin = 0, rot = 1) => {
    const co = Math.cos(ang * rot), si = Math.sin(ang * rot), [ux, uy, uz] = u, tr = ang * lin;
    const { occ, nx, ny, nz, ox, oy, oz } = V;
    let h = 0;
    for (let i = 0, e = m * 3; i < e; i += 3) {
      const x = S[i] - c[0], y = S[i + 1] - c[1], z = S[i + 2] - c[2];
      const d = (ux * x + uy * y + uz * z) * (1 - co);
      const rx = x * co + (uy * z - uz * y) * si + ux * (d + tr) + c[0];
      const ry = y * co + (uz * x - ux * z) * si + uy * (d + tr) + c[1];
      const rz = z * co + (ux * y - uy * x) * si + uz * (d + tr) + c[2];
      const I = Math.floor((rx - ox) / res), J = Math.floor((ry - oy) / res), K = Math.floor((rz - oz) / res);
      if (I < 0 || J < 0 || K < 0 || I >= nx || J >= ny || K >= nz) continue;
      if (occ[(I * ny + J) * nz + K] && ++h > lim) return h;
    }
    return h;
  };
  const tolAll = tolFor(n), tolSub = tolFor(nSub);
  if (hits(c0, [0, 0, 1], 0, n, tolAll * 4) > tolAll * 4) return { overlap: true };
  const free = (c, u, ang, m) => hits(c, u, ang, m, m === n ? tolAll : tolSub) <= (m === n ? tolAll : tolSub);
  const sweep = (c, u, sg, m = n, step = 2) => {
    let a = 0;
    for (let k = step; k <= 90; k += step) { if (!free(c, u, (sg * k * Math.PI) / 180, m)) break; a = k; }
    return a;
  };

  // sliding / screwing joints (a straight rail, a helical dovetail…)
  if (twist) {
    const { u, p, lin, rot } = twist;
    // parameter unit: radians for a screw, mm for a straight slide
    const step = rot ? (2 * Math.PI) / 180 : 0.5;
    const max = rot ? Math.PI : Math.max(box[3] - box[0], box[4] - box[1], box[5] - box[2]);
    const run = (sg) => {
      let a = 0;
      for (let k = step; k <= max + 1e-9; k += step) {
        if (hits(p, u, sg * k, n, tolAll, lin, rot) > tolAll) break;
        a = k;
      }
      return a;
    };
    const hi = run(1), lo = run(-1);
    // a real slide travels a few mm (a hinge pin could only wiggle inside its clearance)
    const travel = (hi + lo) * Math.abs(lin);
    if (travel >= 2 && (rot === 0 || hi + lo >= (6 * Math.PI) / 180)) {
      const [v, w] = basisFor(u);
      return { pivot: p, axes: [u, v, w], lo: [-lo, 0, 0], hi: [hi, 0, 0], kind: twist.kind, rot, lin };
    }
  }

  const axes = [[0, 0, 1]];
  for (let k = 0; k < 12; k++) axes.push([Math.cos((k * Math.PI) / 12), Math.sin((k * Math.PI) / 12), 0]);
  const probe = (6 * Math.PI) / 180;
  const cands = [];
  for (const u of axes) {
    const [e1, e2] = basisFor(u);
    let local = null;
    const tryP = (p) => {
      if (!free(p, u, probe, nSub) && !free(p, u, -probe, nSub)) return;
      const a = sweep(p, u, 1, nSub, 4), b = sweep(p, u, -1, nSub, 4);
      if (!local || a + b > local.a + local.b) local = { u, p, a, b };
    };
    const grid = (p0, R, st) => {
      for (let s = -R; s <= R + 1e-9; s += st) for (let t = -R; t <= R + 1e-9; t += st) {
        tryP([p0[0] + e1[0] * s + e2[0] * t, p0[1] + e1[1] * s + e2[1] * t, p0[2] + e1[2] * s + e2[2] * t]);
      }
    };
    grid(c0, 4, 1);
    if (!local) continue;
    grid(local.p, 1, 0.25);
    grid(local.p, 0.25, 0.0625);
    cands.push(local);
  }
  cands.sort((x, y) => y.a + y.b - (x.a + x.b));
  let best = null;
  for (const c of cands.slice(0, 3)) {
    const a = sweep(c.p, c.u, 1), b = sweep(c.p, c.u, -1);
    if (!best || a + b > best.a + best.b) best = { u: c.u, p: c.p, a, b };
  }
  if (!best || best.a + best.b < 6) return { rigid: true };
  const [v, w] = basisFor(best.u);
  const rv = [sweep(best.p, v, 1), sweep(best.p, v, -1)];
  const rw = [sweep(best.p, w, 1), sweep(best.p, w, -1)];
  const rad = Math.PI / 180;
  return {
    pivot: best.p,
    axes: [best.u, v, w],
    lo: [-best.b * rad, -rv[1] * rad, -rw[1] * rad],
    hi: [best.a * rad, rv[0] * rad, rw[0] * rad],
    kind: 'hinge', rot: 1, lin: 0,
  };
}

// ---------------------------------------------------------------------------------------
export function analyseArticulation(pos, onProgress = () => {}) {
  const nt = (pos.length / 9) | 0;
  const { comp, count } = findComponents(pos);
  const none = { comp, count, compPart: new Int32Array(count), parts: 1, joints: [] };
  if (count < 2 || count > MAX_COMPONENTS) return none;

  const tris = Array.from({ length: count }, () => []);
  for (let t = 0; t < nt; t++) tris[comp[t]].push(t);
  const boxes = tris.map((l) => boxOfTris(pos, l));

  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; };
  const fuse = (a, b) => { parent[find(b)] = find(a); };

  // slivers / debris are not parts: attach them to the closest real shell
  const big = tris.map((l) => l.length >= 12);
  for (let i = 0; i < count; i++) {
    if (big[i]) continue;
    const b = boxes[i];
    const c = [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
    let bj = -1, bd = Infinity;
    for (let j = 0; j < count; j++) {
      if (!big[j]) continue;
      const B = boxes[j];
      const d = Math.hypot(Math.max(B[0] - c[0], 0, c[0] - B[3]), Math.max(B[1] - c[1], 0, c[1] - B[4]), Math.max(B[2] - c[2], 0, c[2] - B[5]));
      if (d < bd) { bd = d; bj = j; }
    }
    if (bj >= 0) fuse(bj, i);
  }

  const pairs = [];
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) {
    if (!big[a] || !big[b]) continue;
    const r = intersectBox(expand(boxes[a], 0.8), expand(boxes[b], 0.8));
    if (r) pairs.push([a, b, r]);
  }

  const D = 0.7;
  const rawJoints = [];
  pairs.forEach(([a, b, region], pi) => {
    onProgress(pi / Math.max(pairs.length, 1), 'Looking for joints');
    // make B the smaller shell (its points get rotated)
    if (tris[a].length < tris[b].length) [a, b] = [b, a];
    const SA = sampleSurface(pos, tris[a], region, 0.3, 1.5e6);
    const NB = [];
    const SB = sampleSurface(pos, tris[b], region, 0.3, 1.5e6, NB);
    if (!SA.length || !SB.length) return;
    const H = pointHash(SA, D);
    const near = [], nearN = [];
    let dmin = Infinity;
    for (let i = 0; i < SB.length; i += 3) {
      const x = SB[i], y = SB[i + 1], z = SB[i + 2];
      const X = Math.floor(x / D), Y = Math.floor(y / D), Z = Math.floor(z / D);
      let best = Infinity;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const l = H.get(cellKey(X + dx, Y + dy, Z + dz));
        if (!l) continue;
        for (const j of l) {
          const d = (SA[j] - x) ** 2 + (SA[j + 1] - y) ** 2 + (SA[j + 2] - z) ** 2;
          if (d < best) best = d;
        }
      }
      best = Math.sqrt(best);
      if (best < dmin) dmin = best;
      if (best < D) { near.push(x, y, z); nearN.push(NB[i], NB[i + 1], NB[i + 2]); }
    }
    if (near.length / 3 < 25) return;
    if (dmin < 0.02) { fuse(a, b); return; } // touching shells are one solid
    rawJoints.push({ a, b, near: new Float32Array(near), nearN: new Float32Array(nearN), gap: dmin });
  });

  const joints = [];
  rawJoints.forEach((j, k) => {
    onProgress(k / rawJoints.length, 'Measuring joint range of motion');
    const twist = fitTwist(j.near, j.nearN);
    const m = measureJoint(pos, tris[j.a], tris[j.b], j.near, twist && (twist.rot === 0 || Math.abs(twist.lin) > 0.5) ? twist : null);
    if (m.overlap || m.rigid) { fuse(j.a, j.b); return; }
    const cn = [0, 0, 0], nn = j.near.length / 3;
    for (let i = 0; i < j.near.length; i += 3) for (let k = 0; k < 3; k++) cn[k] += j.near[i + k] / nn;
    joints.push({ a: j.a, b: j.b, gap: j.gap, contact: cn, ...m });
  });

  // number the fused groups
  const compPart = new Int32Array(count);
  const id = new Map();
  for (let i = 0; i < count; i++) {
    const r = find(i);
    if (!id.has(r)) id.set(r, id.size);
    compPart[i] = id.get(r);
  }
  const seen = new Set();
  const out = [];
  for (const j of joints) {
    const a = compPart[j.a], b = compPart[j.b];
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || seen.has(key)) continue;
    seen.add(key);
    out.push({ a, b, pivot: j.pivot, axes: j.axes, lo: j.lo, hi: j.hi, gap: j.gap, kind: j.kind, rot: j.rot, lin: j.lin, contact: j.contact });
  }
  return { comp, count, compPart, parts: id.size, joints: out };
}
