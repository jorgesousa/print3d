// Real (simplified) FDM slicer running in a Web Worker.
// Input mesh is in print coordinates (mm, Z-up, min z = 0).
import ClipperLib from 'clipper-lib';
import { findComponents } from './articulate.js';

const C = ClipperLib;
const SCALE = 1000; // clipper works on integers -> micrometres

const FEATURE = { SKIRT: 0, OUTER: 1, INNER: 2, SPARSE: 3, SOLID: 4, TOP: 5 };

self.onmessage = (e) => {
  const { positions, settings } = e.data;
  try {
    const result = slice(positions, settings);
    const transfer = [];
    for (const l of result.layers) {
      for (const p of l.paths) transfer.push(p.pts.buffer);
      for (const c of l.contours) transfer.push(c.buffer);
    }
    self.postMessage({ type: 'done', result }, transfer);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack ? err.stack : err) });
  }
};

function slice(pos, s) {
  const lh = s.layerHeight;
  const w = s.lineWidth;
  const triCount = pos.length / 9;
  let maxZ = 0;
  const zmin = new Float32Array(triCount);
  const zmax = new Float32Array(triCount);
  for (let t = 0; t < triCount; t++) {
    const a = pos[t * 9 + 2], b = pos[t * 9 + 5], c = pos[t * 9 + 8];
    zmin[t] = Math.min(a, b, c);
    zmax[t] = Math.max(a, b, c);
    if (zmax[t] > maxZ) maxZ = zmax[t];
  }
  // separate shells (print-in-place parts) are tracked so every path knows its part
  const { comp, count: nComp } = findComponents(pos);
  const multi = nComp > 1 && nComp <= 400;
  const order = Array.from({ length: triCount }, (_, i) => i).sort((a, b) => zmin[a] - zmin[b]);

  // ---- 1. Slice the mesh into closed contours per layer ---------------------------
  const layerZs = [];
  for (let z = lh; z - lh / 2 < maxZ - 1e-4; z += lh) layerZs.push(+z.toFixed(4));
  const L = layerZs.length;
  const shapes = new Array(L);
  const trees = new Array(L);
  const partLoops = new Array(L);
  let active = [];
  let next = 0;
  for (let i = 0; i < L; i++) {
    const zc = layerZs[i] - lh / 2 + 1e-5;
    while (next < triCount && zmin[order[next]] <= zc) active.push(order[next++]);
    active = active.filter((t) => zmax[t] >= zc);
    const { segs, sc } = intersect(pos, active, zc, multi ? comp : null);
    const loops = chainSegments(segs, sc);
    if (multi) partLoops[i] = loops.map((l) => ({ comp: l.comp, path: l, area: Math.abs(C.Clipper.Area(l)), box: pathBox(l) }));
    const { paths, tree } = unionLoops(loops);
    shapes[i] = paths;
    trees[i] = tree;
    if (i % 8 === 0) self.postMessage({ type: 'progress', stage: 'Slicing mesh into layers', p: (i / L) * 0.4 });
  }

  // ---- 2. Walls, skins & infill ------------------------------------------------------
  const infillInset = s.walls * w + 0.25 * w;
  const regions = shapes.map((sh) => offset(sh, -infillInset * SCALE));
  const open = (paths, d) => offset(offset(paths, -d * SCALE), d * SCALE);

  const layers = [];
  const cursor = { x: 0, y: -120 };
  for (let i = 0; i < L; i++) {
    const S = shapes[i];
    const R = regions[i];
    const out = { z: layerZs[i], h: lh, paths: [], contours: [] };
    for (const p of S) out.contours.push(toFloat(rdp(p, 0.05), true));

    // top surface = not covered by the next layer; solid = within N layers of top/bottom
    const above = i + 1 < L ? regions[i + 1] : [];
    const top = open(diff(R, above), w * 0.9);
    let solid;
    if (i < s.bottomLayers || i >= L - s.topLayers) solid = R;
    else {
      let interBelow = regions[i - 1];
      for (let k = 2; k <= s.bottomLayers; k++) interBelow = inter(interBelow, regions[i - k]);
      let interAbove = regions[i + 1];
      for (let k = 2; k <= s.topLayers; k++) interAbove = inter(interAbove, regions[i + k]);
      solid = union(diff(R, interBelow), diff(R, interAbove));
    }
    solid = open(diff(solid, top), w * 0.9);
    const sparse = diff(diff(R, solid), top);

    // smallest shell outline containing the point = the part it belongs to
    const PL = partLoops[i];
    const partAt = (pt) => {
      if (!PL) return 0;
      let best = -1, bestArea = Infinity;
      for (const l of PL) {
        if (l.area >= bestArea || pt.X < l.box[0] || pt.X > l.box[2] || pt.Y < l.box[1] || pt.Y > l.box[3]) continue;
        if (C.Clipper.PointInPolygon(pt, l.path) !== 0) { best = l.comp; bestArea = l.area; }
      }
      return best < 0 ? 0 : best;
    };
    const midPt = (p) => p[(p.length / 2) | 0];

    const islands = collectIslands(trees[i]);
    const buckets = islands.map(() => ({ walls: [[], []], fill: [] }));
    if (!buckets.length) buckets.push({ walls: [[], []], fill: [] });
    const bucketFor = (pt) => {
      let best = 0, bestArea = Infinity;
      for (let k = 0; k < islands.length; k++) {
        const isl = islands[k];
        if (isl.area < bestArea && C.Clipper.PointInPolygon(pt, isl.outer) !== 0) { best = k; bestArea = isl.area; }
      }
      return buckets[best];
    };

    for (let k = 0; k < s.walls; k++) {
      for (const lp of offset(S, -(w / 2 + k * w) * SCALE)) {
        if (lp.length < 3 || Math.abs(C.Clipper.Area(lp)) < (w * w * SCALE * SCALE) / 4) continue;
        bucketFor(lp[0]).walls[k === 0 ? 1 : 0].push({ type: k === 0 ? FEATURE.OUTER : FEATURE.INNER, path: lp, closed: true, part: partAt(lp[0]) });
      }
    }
    const angle = i % 2 ? Math.PI / 4 : -Math.PI / 4;
    const addFill = (region, type, ang, spacing) => {
      if (!region.length) return;
      for (const seg of hatch(region, ang, spacing)) bucketFor(seg[0]).fill.push({ type, path: seg, closed: false, part: partAt(midPt(seg)) });
    };
    addFill(top, FEATURE.TOP, angle, w);
    addFill(solid, FEATURE.SOLID, angle, w);
    const sp = (2 * w) / s.infillDensity;
    addFill(sparse, FEATURE.SPARSE, Math.PI / 4, sp);
    addFill(sparse, FEATURE.SPARSE, -Math.PI / 4, sp);

    if (i === 0 && s.skirt) {
      const sk = offset(S, s.skirtDistance * SCALE, C.JoinType.jtRound).filter((p) => C.Clipper.Orientation(p));
      for (const lp of sk) out.paths.push(emit({ type: FEATURE.SKIRT, path: lp, closed: true, part: -1 }, cursor));
    }

    // islands greedily; inside each: inner walls -> outer wall -> infill
    const remaining = buckets.filter((b) => b.walls[0].length + b.walls[1].length + b.fill.length);
    while (remaining.length) {
      let bi = 0, bd = Infinity;
      remaining.forEach((b, k) => {
        const any = b.walls[0][0] || b.walls[1][0] || b.fill[0];
        const d = dist2(cursor, any.path[0]);
        if (d < bd) { bd = d; bi = k; }
      });
      const b = remaining.splice(bi, 1)[0];
      for (const group of [b.walls[0], b.walls[1], b.fill]) {
        for (const item of greedyOrder(group, cursor)) out.paths.push(emit(item, cursor));
      }
    }
    layers.push(out);
    if (i % 4 === 0) self.postMessage({ type: 'progress', stage: 'Generating toolpaths', p: 0.4 + (i / L) * 0.6 });
  }
  return { layers, maxZ };
}

// -----------------------------------------------------------------------------------------
function intersect(pos, tris, z, comp) {
  const segs = [];
  const sc = [];
  const pts = [];
  for (const t of tris) {
    const o = t * 9;
    pts.length = 0;
    for (let e = 0; e < 3; e++) {
      const a = o + e * 3, b = o + ((e + 1) % 3) * 3;
      const za = pos[a + 2], zb = pos[b + 2];
      if ((za > z) === (zb > z)) continue;
      // canonical edge orientation so shared edges yield identical points
      let p = a, q = b;
      if (za > zb || (za === zb && (pos[a] > pos[b] || (pos[a] === pos[b] && pos[a + 1] > pos[b + 1])))) { p = b; q = a; }
      const k = (z - pos[p + 2]) / (pos[q + 2] - pos[p + 2]);
      pts.push(pos[p] + (pos[q] - pos[p]) * k, pos[p + 1] + (pos[q + 1] - pos[p + 1]) * k);
    }
    if (pts.length !== 4) continue;
    const ax = pos[o], ay = pos[o + 1], az = pos[o + 2];
    const ux = pos[o + 3] - ax, uy = pos[o + 4] - ay, uz = pos[o + 5] - az;
    const vx = pos[o + 6] - ax, vy = pos[o + 7] - ay, vz = pos[o + 8] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz;
    const dx = pts[2] - pts[0], dy = pts[3] - pts[1];
    if (dx * dx + dy * dy < 1e-14) continue;
    // solid on the left => outer loops counter-clockwise
    if (nx * dy - ny * dx >= 0) segs.push(pts[0], pts[1], pts[2], pts[3]);
    else segs.push(pts[2], pts[3], pts[0], pts[1]);
    sc.push(comp ? comp[t] : 0);
  }
  return { segs, sc };
}

function chainSegments(segs, sc) {
  const n = segs.length / 4;
  const key = (x, y, c) => c + ':' + Math.round(x * 2e4) + ',' + Math.round(y * 2e4);
  const starts = new Map();
  for (let i = 0; i < n; i++) {
    const k = key(segs[i * 4], segs[i * 4 + 1], sc[i]);
    const arr = starts.get(k);
    if (arr) arr.push(i); else starts.set(k, [i]);
  }
  const used = new Uint8Array(n);
  const loops = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    const loop = [];
    const lc = sc[i];
    loop.comp = lc;
    let cur = i;
    while (cur >= 0 && !used[cur]) {
      used[cur] = 1;
      const ex = segs[cur * 4 + 2], ey = segs[cur * 4 + 3];
      loop.push({ X: Math.round(segs[cur * 4] * SCALE), Y: Math.round(segs[cur * 4 + 1] * SCALE) });
      const cands = starts.get(key(ex, ey, lc));
      cur = -1;
      if (cands) for (const c of cands) if (!used[c]) { cur = c; break; }
      if (cur < 0 && n < 20000) {
        // tolerate tiny gaps from imperfect meshes
        let best = -1, bd = 0.02 * 0.02;
        for (let j = 0; j < n; j++) {
          if (used[j] || sc[j] !== lc) continue;
          const d = (segs[j * 4] - ex) ** 2 + (segs[j * 4 + 1] - ey) ** 2;
          if (d < bd) { bd = d; best = j; }
        }
        cur = best;
      }
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

function unionLoops(loops) {
  const run = (fill) => {
    const c = new C.Clipper();
    c.AddPaths(loops, C.PolyType.ptSubject, true);
    const tree = new C.PolyTree();
    c.Execute(C.ClipType.ctUnion, tree, fill, fill);
    return tree;
  };
  const area = (ps) => ps.reduce((a, p) => a + C.Clipper.Area(p), 0);
  let tree = run(C.PolyFillType.pftNonZero);
  let paths = C.Clipper.PolyTreeToPaths(tree);
  // meshes with inconsistent winding: fall back to even-odd
  const eo = run(C.PolyFillType.pftEvenOdd);
  const eoPaths = C.Clipper.PolyTreeToPaths(eo);
  if (area(eoPaths) > area(paths) * 1.05) { tree = eo; paths = eoPaths; }
  // cleaning can collapse slivers into empty / 1-2 point paths -> drop them
  paths = C.Clipper.CleanPolygons(paths, 0.01 * SCALE).filter((p) => p.length >= 3);
  return { paths, tree };
}

function pathBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of p) { if (q.X < x0) x0 = q.X; if (q.X > x1) x1 = q.X; if (q.Y < y0) y0 = q.Y; if (q.Y > y1) y1 = q.Y; }
  return [x0, y0, x1, y1];
}

function collectIslands(tree) {
  const out = [];
  const walk = (node) => {
    for (const child of node.Childs()) {
      if (!child.IsHole()) out.push({ outer: child.Contour(), area: Math.abs(C.Clipper.Area(child.Contour())) });
      walk(child);
    }
  };
  walk(tree);
  return out;
}

function offset(paths, delta, join = C.JoinType.jtMiter) {
  paths = paths.filter((p) => p.length >= 3);
  if (!paths.length) return [];
  const co = new C.ClipperOffset(2.5, 0.02 * SCALE);
  co.AddPaths(paths, join, C.EndType.etClosedPolygon);
  const sol = new C.Paths();
  co.Execute(sol, delta);
  return sol;
}
function boolOp(a, b, type) {
  if (!a.length) return type === C.ClipType.ctUnion ? b : [];
  if (!b.length) return type === C.ClipType.ctIntersection ? [] : a;
  const c = new C.Clipper();
  c.AddPaths(a, C.PolyType.ptSubject, true);
  c.AddPaths(b, C.PolyType.ptClip, true);
  const sol = new C.Paths();
  c.Execute(type, sol, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return sol;
}
const diff = (a, b) => boolOp(a, b, C.ClipType.ctDifference);
const inter = (a, b) => boolOp(a, b, C.ClipType.ctIntersection);
const union = (a, b) => boolOp(a, b, C.ClipType.ctUnion);

function hatch(region, angle, spacing) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of region) for (const pt of p) {
    const u = pt.X * ca + pt.Y * sa, v = -pt.X * sa + pt.Y * ca;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const sp = spacing * SCALE;
  const lines = [];
  for (let k = Math.ceil(minV / sp); k * sp <= maxV; k++) {
    const v = k * sp;
    const u0 = minU - 10, u1 = maxU + 10;
    lines.push([
      { X: Math.round(u0 * ca - v * sa), Y: Math.round(u0 * sa + v * ca) },
      { X: Math.round(u1 * ca - v * sa), Y: Math.round(u1 * sa + v * ca) },
    ]);
  }
  if (!lines.length) return [];
  const c = new C.Clipper();
  c.AddPaths(lines, C.PolyType.ptSubject, false);
  c.AddPaths(region, C.PolyType.ptClip, true);
  const tree = new C.PolyTree();
  c.Execute(C.ClipType.ctIntersection, tree, C.PolyFillType.pftNonZero, C.PolyFillType.pftNonZero);
  return C.Clipper.OpenPathsFromPolyTree(tree).filter(
    (p) => p.length >= 2 && (p[0].X - p[p.length - 1].X) ** 2 + (p[0].Y - p[p.length - 1].Y) ** 2 > (0.3 * SCALE) ** 2,
  );
}

function dist2(cursor, b) {
  return (cursor.x * SCALE - b.X) ** 2 + (cursor.y * SCALE - b.Y) ** 2;
}

function greedyOrder(items, cursor) {
  const left = items.slice();
  const out = [];
  let cx = cursor.x * SCALE, cy = cursor.y * SCALE;
  while (left.length) {
    let bi = 0, bd = Infinity, bIdx = 0;
    for (let k = 0; k < left.length; k++) {
      const it = left[k];
      if (it.closed) {
        const step = Math.max(1, Math.floor(it.path.length / 24));
        for (let j = 0; j < it.path.length; j += step) {
          const d = (it.path[j].X - cx) ** 2 + (it.path[j].Y - cy) ** 2;
          if (d < bd) { bd = d; bi = k; bIdx = j; }
        }
      } else {
        const a = it.path[0], b = it.path[it.path.length - 1];
        const da = (a.X - cx) ** 2 + (a.Y - cy) ** 2, db = (b.X - cx) ** 2 + (b.Y - cy) ** 2;
        if (da < bd) { bd = da; bi = k; bIdx = 0; }
        if (db < bd) { bd = db; bi = k; bIdx = -1; }
      }
    }
    const it = left.splice(bi, 1)[0];
    if (it.closed) {
      if (it.type === FEATURE.OUTER) bIdx = rearSeam(it.path); // aligned seam at the back
      it.path = it.path.slice(bIdx).concat(it.path.slice(0, bIdx));
    } else if (bIdx === -1) it.path = it.path.slice().reverse();
    const last = it.closed ? it.path[0] : it.path[it.path.length - 1];
    cx = last.X; cy = last.Y;
    out.push(it);
  }
  return out;
}

function rearSeam(path) {
  let best = 0;
  for (let j = 1; j < path.length; j++) {
    if (path[j].Y > path[best].Y + 1 || (Math.abs(path[j].Y - path[best].Y) <= 1 && path[j].X < path[best].X)) best = j;
  }
  return best;
}

function emit(item, cursor) {
  const pts = rdp(item.path, item.closed ? 0.025 : 0.01);
  const arr = toFloat(pts, item.closed);
  cursor.x = arr[arr.length - 2];
  cursor.y = arr[arr.length - 1];
  return { type: item.type, pts: arr, part: item.part ?? 0 };
}

function toFloat(path, closed) {
  if (!path.length) return new Float32Array(0);
  const n = path.length + (closed ? 1 : 0);
  const arr = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const p = path[i % path.length];
    arr[i * 2] = p.X / SCALE;
    arr[i * 2 + 1] = p.Y / SCALE;
  }
  return arr;
}

// Ramer–Douglas–Peucker on integer paths (tolerance in mm)
function rdp(path, tolMm) {
  if (path.length < 4) return path;
  const tol2 = (tolMm * SCALE) ** 2;
  const keep = new Uint8Array(path.length);
  keep[0] = keep[path.length - 1] = 1;
  const stack = [[0, path.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = path[a], B = path[b];
    const dx = B.X - A.X, dy = B.Y - A.Y;
    const len2 = dx * dx + dy * dy || 1;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const cr = (path[i].X - A.X) * dy - (path[i].Y - A.Y) * dx;
      const d = (cr * cr) / len2;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol2) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return path.filter((_, i) => keep[i]);
}
