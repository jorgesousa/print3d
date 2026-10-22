// Hands-on inspection of the finished print: pop it off the bed, turn it in your hands,
// cut it open, explode its layers and drop / throw it with rigid-body physics.
// Print-in-place models are split into their real parts, linked by joints whose pivot, axis
// and range of motion were measured from the geometry (see articulate.js), and simulated
// as a multibody system with XPBD (Müller et al. 2020, "Detailed rigid body simulation").
import * as THREE from 'three';
import { createBeadMaterial, createBeadDepthMaterial } from './toolpath.js';
import { radialTexture } from './scene.js';

const PAD = new THREE.Vector3(0, 0, 440);
const FLOOR_Y = 0;
const ARENA_R = 250;
const GRAVITY = -9810; // mm/s²
const RESTITUTION = 0.38;
const MU_S = 0.6, MU_D = 0.45;
const GRAB_K = 900, GRAB_DAMP = 22, JOINT_DAMP = 3;
const SUBSTEP = 1 / 1000;
const MASK_ALL = 62; // every feature except the skirt (it stays on the bed)
const MASK_NO_WALLS = 62 & ~(2 | 4);

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const DEG = 180 / Math.PI;

// directions for support points / picking polytopes
const DIRS = (() => {
  const N = 160, ga = Math.PI * (3 - Math.sqrt(5)), out = [];
  for (let k = 0; k < N; k++) {
    const y = 1 - (k / (N - 1)) * 2, r = Math.sqrt(1 - y * y), a = ga * k;
    out.push(v3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return out;
})();

export function createInspector({ S, printer, beadMaterial, sound, onCaption, onExit }) {
  const $ = (id) => document.getElementById(id);
  const U = beadMaterial.userData.uniforms;
  const depthMaterial = createBeadDepthMaterial(U);
  const cutPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9);
  const localCut = new THREE.Plane();
  beadMaterial.clippingPlanes = [cutPlane];
  beadMaterial.clipShadows = true;
  depthMaterial.clippingPlanes = [cutPlane];

  const skirtMaterial = createBeadMaterial();
  skirtMaterial.userData.uniforms.uMask.value = 1;
  skirtMaterial.userData.uniforms.uPrinted.value = 1e12;

  const pad = new THREE.Group();
  pad.position.copy(PAD);
  const padGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(620, 620),
    new THREE.MeshBasicMaterial({ map: radialTexture('rgba(0,212,255,0.35)'), transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
  );
  padGlow.rotation.x = -Math.PI / 2;
  padGlow.position.y = 0.8;
  pad.add(padGlow);
  const padRings = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(120 + i * 55, 121.5 + i * 55, 128),
      new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0, depthWrite: false, toneMapped: false }),
    );
    r.rotation.x = -Math.PI / 2;
    r.position.y = 1.2;
    pad.add(r);
    padRings.push(r);
  }
  S.scene.add(pad);

  const markMat = (color, opacity) =>
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const MAT = {
    hinge: markMat(0x22e4ff, 0.85), ball: markMat(0xffb347, 0.85), slide: markMat(0xb98cff, 0.9), faint: markMat(0x9fefff, 0.28),
    axis: markMat(0xffffff, 0.75), needle: markMat(0xffffff, 0.95), dot: markMat(0xff4fd8, 0.95),
  };

  // ---- state
  // p/q: pose of the whole assembly (Y-up, centred on its centre of mass) while it is held;
  // with gravity every body has its own pose.
  const st = {
    active: false, mode: 'off', t: 0, srcMesh: null, tp: null, info: null, skirtMesh: null,
    bodies: [], joints: [], order: [], root: 0, mass: 1, com: v3(), radius: 30,
    bbox: new THREE.Box3(), nLayers: 1,
    p: v3(), q: new THREE.Quaternion(), w: v3(),
    p0: v3(), q0: new THREE.Quaternion(), bedPos: v3(),
    hold: v3(), qRest: new THREE.Quaternion(), focus: v3(), viewR: 30,
    gravity: false, sleeping: false, sleepT: 0, grab: null, drag: null, popped: false, landed: false,
    resetT: -1, padFade: 0, lastImpact: 0, lastMove: 0, blend: null,
    flex: false, flexAmt: 0, flexT: 0, showJoints: false,
    cut: 'off', cutPos: 0.5, explode: 0, maxLayer: 1, hideWalls: false,
  };

  // ------------------------------------------------------------------ build bodies
  function build(tp, artic) {
    const geo = tp.geometry;
    const P = geo.attributes.position.array;
    const T = geo.attributes.aType.array;
    const idx = geo.index.array;
    const { segPart, segLen } = tp;
    const nSeg = segPart.length;

    const box = st.bbox.makeEmpty();
    const tmp = v3();
    for (let i = 0; i < T.length; i++) if (T[i] !== 0) box.expandByPoint(tmp.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]));
    st.nLayers = tp.layers.length;

    // ---- which part does every segment belong to
    const multi = artic && artic.parts > 1;
    const nParts = multi ? artic.parts : 1;
    const segP = new Int32Array(nSeg);
    const len = new Float64Array(nParts);
    for (let s = 0; s < nSeg; s++) {
      const c = segPart[s];
      const p = c < 0 ? -1 : multi ? artic.compPart[c] ?? 0 : 0;
      segP[s] = p;
      if (p >= 0) len[p] += segLen[s];
    }
    // the heaviest set of parts linked by joints is articulated; anything else rides along rigidly
    const uf = Array.from({ length: nParts }, (_, i) => i);
    const find = (x) => { while (uf[x] !== x) x = uf[x] = uf[uf[x]]; return x; };
    const jointsIn = multi ? artic.joints.filter((j) => len[j.a] > 0 && len[j.b] > 0) : [];
    for (const j of jointsIn) uf[find(j.b)] = find(j.a);
    const setLen = new Map();
    for (let p = 0; p < nParts; p++) if (len[p] > 0) setLen.set(find(p), (setLen.get(find(p)) || 0) + len[p]);
    let mainSet = -1, best = -1;
    for (const [k, l] of setLen) if (l > best) { best = l; mainSet = k; }
    let rootPart = -1;
    for (let p = 0; p < nParts; p++) if (find(p) === mainSet && (rootPart < 0 || len[p] > len[rootPart])) rootPart = p;
    if (rootPart < 0) rootPart = 0;
    const bodyOf = new Int32Array(nParts).fill(-1);
    let NB = 0;
    bodyOf[rootPart] = NB++;
    if (jointsIn.length) for (let p = 0; p < nParts; p++) if (p !== rootPart && len[p] > 0 && find(p) === mainSet) bodyOf[p] = NB++;
    for (let p = 0; p < nParts; p++) if (bodyOf[p] < 0) bodyOf[p] = 0;

    // ---- per body: centre of mass, sample points
    const totalLen = len.reduce((a, b) => a + b, 0) || 1;
    const segB = new Int32Array(nSeg);
    const count = new Int32Array(NB);
    for (let s = 0; s < nSeg; s++) { segB[s] = segP[s] < 0 ? -1 : bodyOf[segP[s]]; if (segB[s] >= 0) count[segB[s]]++; }
    const bodies = [];
    for (let b = 0; b < NB; b++) {
      bodies.push({
        len: 0, c: v3(), o: v3(), m: 1, invM: 1, invIb: new THREE.Matrix3(), hull: [], h: new Float32Array(DIRS.length),
        p: v3(), q: new THREE.Quaternion(), v: v3(), w: v3(), pp: v3(), pq: new THREE.Quaternion(),
        L: { p: v3(), q: new THREE.Quaternion() }, from: { p: v3(), q: new THREE.Quaternion() },
        parent: -1, joint: -1, depth: 0, group: null, mesh: null, geo: null, contact: false,
        samples: [], weights: [],
      });
    }
    for (let s = 0; s < nSeg; s++) {
      const b = segB[s];
      if (b < 0) continue;
      const B = bodies[b];
      B.len += segLen[s];
      if (s % Math.max(1, Math.floor(count[b] / 5000))) continue;
      const A = idx[s * 24];
      for (let k = 0; k < 4; k++) {
        const o = (A + k) * 3;
        B.samples.push(P[o], P[o + 1], P[o + 2]);
        B.weights.push(segLen[s] + 1e-3);
      }
    }
    const grams = st.info.grams;
    st.mass = 0;
    const C = st.com.set(0, 0, 0);
    for (const B of bodies) {
      let wx = 0, wy = 0, wz = 0, ws = 0;
      for (let i = 0, k = 0; i < B.samples.length; i += 3, k++) {
        const w = B.weights[k];
        wx += B.samples[i] * w; wy += B.samples[i + 1] * w; wz += B.samples[i + 2] * w; ws += w;
      }
      B.c.set(wx / ws, wy / ws, wz / ws);
      B.m = Math.max(0.03, (grams * B.len) / totalLen);
      B.invM = 1 / B.m;
      st.mass += B.m;
      C.addScaledVector(B.c, B.m);
    }
    C.divideScalar(st.mass);
    const toFrame = (x, y, z, c, out) => out.set(x - c.x, z - c.z, -(y - c.y));
    st.radius = 5;
    for (const B of bodies) {
      toFrame(B.c.x, B.c.y, B.c.z, C, B.o);
      // body frame samples (Y-up, centred on the body's COM)
      const n = B.samples.length / 3;
      const X = new Float32Array(B.samples.length);
      for (let i = 0; i < n; i++) {
        X[i * 3] = B.samples[i * 3] - B.c.x;
        X[i * 3 + 1] = B.samples[i * 3 + 2] - B.c.z;
        X[i * 3 + 2] = -(B.samples[i * 3 + 1] - B.c.y);
      }
      // support points ≈ convex hull (floor contacts + picking polytope)
      const ids = new Set();
      DIRS.forEach((d, k) => {
        let bi = 0, bd = -Infinity;
        for (let i = 0; i < X.length; i += 3) {
          const v = X[i] * d.x + X[i + 1] * d.y + X[i + 2] * d.z;
          if (v > bd) { bd = v; bi = i; }
        }
        B.h[k] = bd;
        ids.add(bi);
      });
      B.hull = [...ids].map((i) => v3(X[i], X[i + 1], X[i + 2]));
      for (const hp of B.hull) st.radius = Math.max(st.radius, tmp.copy(hp).add(B.o).length());
      // inertia tensor
      let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0, ws = 0;
      for (let i = 0, k = 0; i < X.length; i += 3, k++) {
        const x = X[i], y = X[i + 1], z = X[i + 2], w = B.weights[k];
        xx += w * (y * y + z * z); yy += w * (x * x + z * z); zz += w * (x * x + y * y);
        xy -= w * x * y; xz -= w * x * z; yz -= w * y * z; ws += w;
      }
      const reg = ((xx + yy + zz) / ws) * 0.04 + 0.5;
      const I = new THREE.Matrix3().set(xx / ws + reg, xy / ws, xz / ws, xy / ws, yy / ws + reg, yz / ws, xz / ws, yz / ws, zz / ws + reg).multiplyScalar(B.m);
      B.invIb.copy(I).invert();
      B.samples = B.weights = null;

      // render the printed beads of this body, sharing the toolpath buffers
      const g = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'aDist', 'aType', 'aLayer']) g.setAttribute(name, geo.attributes[name]);
      B.geo = g;
    }
    // per body index buffers
    const ib = bodies.map((_, b) => new Uint32Array(count[b] * 24));
    const fill = new Int32Array(NB);
    for (let s = 0; s < nSeg; s++) {
      const b = segB[s];
      if (b < 0) continue;
      ib[b].set(idx.subarray(s * 24, s * 24 + 24), fill[b]);
      fill[b] += 24;
    }
    bodies.forEach((B, b) => {
      B.geo.setIndex(new THREE.BufferAttribute(ib[b], 1));
      B.geo.boundingSphere = new THREE.Sphere(v3(), 1e4);
      B.group = new THREE.Group();
      const orient = new THREE.Group();
      orient.rotation.x = -Math.PI / 2; // print space is Z-up
      orient.position.set(-B.c.x, -B.c.z, B.c.y);
      B.mesh = new THREE.Mesh(B.geo, beadMaterial);
      B.mesh.castShadow = true;
      B.mesh.receiveShadow = true;
      B.mesh.frustumCulled = false;
      B.mesh.customDepthMaterial = depthMaterial;
      orient.add(B.mesh);
      B.group.add(orient);
      S.scene.add(B.group);
    });

    // ---- joints (print coords -> assembly frame)
    const joints = [];
    for (const j of jointsIn) {
      const A = bodyOf[j.a], Bb = bodyOf[j.b];
      if (A === Bb) continue;
      const pivot = toFrame(j.pivot[0], j.pivot[1], j.pivot[2], C, v3());
      const axes = j.axes.map((a) => v3(a[0], a[2], -a[1]).normalize());
      const c = j.contact || j.pivot;
      // a joint moves by `ang`: it turns rot·ang about the axis and slides lin·ang along it
      // (hinge: rot 1, lin 0 · screw: rot 1, lin = pitch in mm/rad · straight slide: rot 0, lin 1)
      const J = {
        A, B: Bb, pivot, axes, lo: j.lo.slice(), hi: j.hi.slice(), gap: j.gap,
        contact: toFrame(c[0], c[1], c[2], C, v3()),
        rot: j.rot ?? 1, lin: j.lin ?? 0, kind: j.kind || 'hinge',
        rA: pivot.clone().sub(bodies[A].o), rB: pivot.clone().sub(bodies[Bb].o), ang: 0, depth: 0, marker: null, needle: null,
      };
      if (J.kind === 'hinge') {
        const prim = J.hi[0] - J.lo[0];
        const sec = Math.max(J.hi[1] - J.lo[1], J.hi[2] - J.lo[2]);
        if (sec > prim * 0.6) J.kind = 'ball';
      }
      J.sliding = J.kind === 'screw' || J.kind === 'slide';
      // rotation limits per axis (a straight slide may not turn at all)
      J.rlo = J.rot ? J.lo.slice() : [0, 0, 0];
      J.rhi = J.rot ? J.hi.slice() : [0, 0, 0];
      if (J.sliding) { J.rlo[1] = J.rlo[2] = J.rhi[1] = J.rhi[2] = 0; }
      joints.push(J);
    }
    // spanning tree for forward kinematics
    st.root = 0;
    const order = [0];
    const seen = new Uint8Array(NB);
    seen[0] = 1;
    for (let k = 0; k < order.length; k++) {
      const b = order[k];
      joints.forEach((J, ji) => {
        const other = J.A === b ? J.B : J.B === b ? J.A : -1;
        if (other < 0 || seen[other]) return;
        seen[other] = 1;
        bodies[other].parent = b;
        bodies[other].joint = ji;
        bodies[other].depth = bodies[b].depth + 1;
        order.push(other);
      });
    }
    for (let b = 0; b < NB; b++) if (!seen[b]) order.push(b);
    st.bodies = bodies;
    st.joints = joints;
    st.order = order;
    joints.forEach((J) => { J.depth = Math.min(bodies[J.A].depth, bodies[J.B].depth); });
    st.coax = findCoaxialLoop(bodies, joints);
    st.slides = joints.some((J) => J.sliding);
    buildMarkers();
  }

  // A closed loop of joints (e.g. the slats of a twisty egg) cannot be flexed joint by joint —
  // the last joint would tear. When every joint is the same screw/slide/turn about one shared
  // axis, each body instead gets its own position along that screw, and a wave runs round it.
  function findCoaxialLoop(bodies, joints) {
    if (joints.length < bodies.length) return null;
    const J0 = joints[0], u = J0.axes[0].clone(), p = J0.pivot.clone();
    const sgn = [];
    for (const J of joints) {
      const d = J.axes[0].dot(u);
      if (J.rot !== J0.rot || Math.abs(d) < 0.995) return null;
      if (Math.abs(J.lin - J0.lin) > 0.05 * Math.abs(J0.lin) + 0.05) return null;
      if (J.rot) {
        const off = J.pivot.clone().sub(p);
        off.addScaledVector(u, -off.dot(u));
        if (off.length() > 1.5) return null;
      }
      sgn.push(Math.sign(d));
    }
    const e1 = v3(), e2 = v3();
    e1.copy(Math.abs(u.y) < 0.9 ? v3(0, 1, 0) : v3(1, 0, 0)).cross(u).normalize();
    e2.crossVectors(u, e1);
    const phi = bodies.map((B) => {
      const d = B.o.clone().sub(p);
      return Math.atan2(d.dot(e2), d.dot(e1));
    });
    // largest wave the tightest joint allows
    let amp = Infinity;
    joints.forEach((J, k) => {
      let dp = Math.abs(phi[J.B] - phi[J.A]);
      if (dp > Math.PI) dp = 2 * Math.PI - dp;
      const allow = Math.min(J.hi[0], -J.lo[0]);
      amp = Math.min(amp, allow / Math.max(2 * Math.sin(dp / 2), 0.05));
    });
    if (!(amp > 0)) return null;
    // keep the ripple readable: at most ~12 mm of travel and 35° of turn per part
    amp = Math.min(amp * 0.88, 12 / Math.max(Math.abs(J0.lin), 1e-6), 0.6 / Math.max(J0.rot, 1e-6));
    return { u, p, rot: J0.rot, lin: J0.lin, sgn, phi, amp, t: new Float64Array(bodies.length) };
  }

  function buildMarkers() {
    const { bodies, joints } = st;
    for (const J of joints) {
      const A = bodies[J.A], B = bodies[J.B];
      const u = J.axes[0];
      if (J.sliding) { buildSlideMarker(J, A, B); continue; }
      const d = B.o.clone().sub(J.pivot);
      d.addScaledVector(u, -d.dot(u));
      if (d.lengthSq() < 1e-4) d.copy(J.axes[1]);
      const len = d.length();
      const e1 = d.normalize();
      const e2 = v3().crossVectors(u, e1);
      const R = THREE.MathUtils.clamp(len * 0.55, 2.4, 7);

      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      g.matrix.makeBasis(e1, e2, u).setPosition(J.rA);
      const arc = new THREE.Mesh(new THREE.RingGeometry(R - 0.32, R + 0.32, 48, 1, J.lo[0], J.hi[0] - J.lo[0]), J.kind === 'hinge' ? MAT.hinge : MAT.ball);
      const circle = new THREE.Mesh(new THREE.RingGeometry(R - 0.07, R + 0.07, 72), MAT.faint);
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, R * 1.7, 8), MAT.axis);
      rod.rotation.x = Math.PI / 2; // cylinder Y -> local Z (the hinge axis)
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.75, 16, 12), MAT.dot);
      g.add(arc, circle, rod, dot);
      g.children.forEach((c) => (c.renderOrder = 30));
      A.group.add(g);

      // needle fixed to the moving part, sweeping across the arc as the joint turns
      const n = new THREE.Group();
      n.matrixAutoUpdate = false;
      n.matrix.makeBasis(e1, e2, u).setPosition(J.rB);
      const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, R * 1.12, 6), MAT.needle);
      stick.rotation.z = -Math.PI / 2; // Y -> local X (e1)
      stick.position.x = R * 0.56;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8), MAT.needle);
      tip.position.x = R * 1.12;
      n.add(stick, tip);
      n.children.forEach((c) => (c.renderOrder = 31));
      B.group.add(n);
      J.marker = g;
      J.needle = n;
    }
    setJointMarkers(st.showJoints);
  }

  // where the contact point of B travels relative to A at joint parameter s
  function jointPath(J, s, out) {
    qa.setFromAxisAngle(J.axes[0], J.rot * s);
    return out.copy(J.contact).sub(J.pivot).applyQuaternion(qa).add(J.pivot).addScaledVector(J.axes[0], J.lin * s);
  }

  // screw / slide: the rail the part rides on (helix or straight), plus a bead riding on it
  function buildSlideMarker(J, A, B) {
    const pts = [];
    const N = 48;
    for (let i = 0; i <= N; i++) pts.push(jointPath(J, J.lo[0] + ((J.hi[0] - J.lo[0]) * i) / N, v3()).sub(A.o));
    const g = new THREE.Group();
    const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), N, 0.38, 6), MAT.slide);
    const ends = pts[0].distanceTo(pts[N]);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, ends + 6, 6), MAT.faint);
    rod.position.copy(pts[0]).add(pts[N]).multiplyScalar(0.5);
    rod.quaternion.setFromUnitVectors(v3(0, 1, 0), J.axes[0]);
    if (J.rot) {
      // the screw axis itself: rail = helix around it
      rod.position.copy(J.pivot).sub(A.o).addScaledVector(J.axes[0], J.lin * (J.lo[0] + J.hi[0]) * 0.5);
      rod.scale.y = (Math.abs(J.lin) * (J.hi[0] - J.lo[0]) + 6) / (ends + 6);
    }
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.6, 12, 8), MAT.dot);
    dot.position.copy(J.contact).sub(A.o);
    g.add(rail, rod, dot);
    g.children.forEach((c) => (c.renderOrder = 30));
    A.group.add(g);
    const n = new THREE.Group();
    const bead = new THREE.Mesh(new THREE.SphereGeometry(0.95, 14, 10), MAT.needle);
    bead.position.copy(J.contact).sub(B.o);
    n.add(bead);
    n.children.forEach((c) => (c.renderOrder = 31));
    B.group.add(n);
    J.marker = g;
    J.needle = n;
  }

  function setJointMarkers(on) {
    st.showJoints = on;
    for (const J of st.joints) { J.marker.visible = on; J.needle.visible = on; }
  }

  function disposeBodies() {
    for (const B of st.bodies) {
      B.group.traverse((o) => { if (o.geometry && o.geometry !== B.geo) o.geometry.dispose(); });
      B.group.removeFromParent();
      // free only this body's index buffer; the vertex buffers are shared with the bed mesh
      for (const name of Object.keys(B.geo.attributes)) B.geo.deleteAttribute(name);
      B.geo.dispose();
    }
    st.bodies = [];
    st.joints = [];
    st.order = [];
  }

  // ------------------------------------------------------------------ kinematics
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  const ka = v3(), kb = v3();

  // pose every body from the assembly pose + joint angles
  function compose() {
    const { bodies, joints } = st;
    const cx = st.coax && st.flexAmt > 0 ? st.coax : null;
    for (const b of st.order) {
      const B = bodies[b];
      if (cx) {
        const t = cx.t[b];
        B.L.q.setFromAxisAngle(cx.u, cx.rot * t);
        B.L.p.copy(B.o).sub(cx.p).applyQuaternion(B.L.q).add(cx.p).addScaledVector(cx.u, cx.lin * t);
      } else if (B.parent < 0) { B.L.q.identity(); B.L.p.copy(B.o); }
      else {
        const Pa = bodies[B.parent], J = joints[B.joint];
        const sign = b === J.B ? 1 : -1;
        qa.setFromAxisAngle(J.axes[0], sign * J.rot * J.ang);
        B.L.q.copy(Pa.L.q).multiply(qa);
        ka.copy(J.pivot).sub(Pa.o).addScaledVector(J.axes[0], sign * J.lin * J.ang).applyQuaternion(Pa.L.q).add(Pa.L.p); // pivot now
        B.L.p.copy(B.o).sub(J.pivot).applyQuaternion(B.L.q).add(ka);
      }
    }
    const bl = st.blend ? ease(Math.min(st.blend.t / st.blend.dur, 1)) : 1;
    for (const B of bodies) {
      kb.copy(B.L.p).applyQuaternion(st.q).add(st.p);
      qb.copy(st.q).multiply(B.L.q);
      if (bl < 1) { B.p.lerpVectors(B.from.p, kb, bl); B.q.slerpQuaternions(B.from.q, qb, bl); }
      else { B.p.copy(kb); B.q.copy(qb); }
    }
  }

  function setFlexAngles(dt) {
    const target = st.flex && st.mode === 'float' && !st.gravity ? 1 : 0;
    st.flexAmt += (target - st.flexAmt) * (1 - Math.exp(-dt * 2.2));
    if (st.flexAmt < 1e-4 && !target) st.flexAmt = 0;
    st.flexT += dt * st.flexAmt;
    if (st.coax) {
      const c = st.coax;
      for (let b = 0; b < st.bodies.length; b++) c.t[b] = st.flexAmt * c.amp * Math.sin(st.flexT * 1.6 - c.phi[b]);
      return;
    }
    for (const J of st.joints) {
      const mid = (J.lo[0] + J.hi[0]) / 2, amp = ((J.hi[0] - J.lo[0]) / 2) * 0.88;
      J.ang = st.flexAmt * (mid + amp * Math.sin(st.flexT * 2.1 - J.depth * 0.9));
    }
  }

  // take over from free bodies: the root body defines the assembly pose
  function adoptBodies(dur) {
    const R = st.bodies[st.root];
    st.q.copy(R.q);
    st.p.copy(R.o).applyQuaternion(st.q).negate().add(R.p);
    for (const B of st.bodies) { B.from.p.copy(B.p); B.from.q.copy(B.q); }
    st.blend = st.bodies.length > 1 ? { t: 0, dur } : null;
  }

  function syncBodies() {
    for (const B of st.bodies) {
      B.group.position.copy(B.p);
      B.group.quaternion.copy(B.q);
      B.group.updateMatrixWorld(true);
    }
  }

  // ------------------------------------------------------------------ public: start / reset
  function start(mesh, tp, info, artic) {
    reset();
    st.tp = tp; st.info = info; st.srcMesh = mesh;
    build(tp, artic);
    st.active = true; st.mode = 'enter'; st.t = 0;
    st.gravity = false; st.grab = null; st.drag = null; st.sleeping = false; st.popped = false; st.landed = false;
    st.resetT = -1; st.blend = null; st.flex = false; st.flexAmt = 0; st.flexT = 0;
    for (const J of st.joints) J.ang = 0;

    U.uPrinted.value = 1e12;
    U.uMask.value = MASK_ALL;
    mesh.visible = false;
    // the skirt is a separate loop that stays behind on the bed
    skirtMaterial.color.copy(beadMaterial.color);
    skirtMaterial.metalness = beadMaterial.metalness;
    skirtMaterial.roughness = beadMaterial.roughness;
    skirtMaterial.userData.uniforms.uColorMode.value = U.uColorMode.value;
    st.skirtMesh = new THREE.Mesh(tp.geometry, skirtMaterial);
    st.skirtMesh.frustumCulled = false;
    printer.printSpace.add(st.skirtMesh);

    printer.printSpace.updateMatrixWorld(true);
    st.bedPos.copy(st.com).applyMatrix4(printer.printSpace.matrixWorld);
    st.p0.copy(st.bedPos);
    st.p.copy(st.bedPos);
    st.q.identity(); st.q0.identity();
    st.w.set(0, 0, 0);
    compose();
    syncBodies();
    st.focus.copy(st.p);
    st.viewR = st.radius;

    st.hold.copy(PAD).add(v3(0, Math.max(120, st.radius * 1.4 + 70), 0));
    st.qRest.setFromEuler(new THREE.Euler(0.32, -0.55, 0));

    document.body.classList.toggle('articulated', st.joints.length > 0);
    $('i-joints').checked = false;
    setJointMarkers(false);
    resetControls();
    $('i-layers').max = st.nLayers;
    $('i-layers').value = st.nLayers;
    setLayerLimit(st.nLayers);
    document.body.classList.add('inspecting');
    onCaption('Step 6 · Hands-on', 'Unlocking the part — the flexible <b>PEI sheet</b> is bent slightly so the cooled plastic pops right off…');
  }

  function cleanupUniforms() {
    U.uMask.value = 63;
    U.uExplode.value = 0;
    U.uMaxLayer.value = 1e9;
    U.uCut.value = 0;
    cutPlane.set(new THREE.Vector3(0, 1, 0), 1e9);
  }

  // hard reset (new model / new print)
  function reset() {
    if (st.srcMesh) { st.srcMesh.visible = true; st.srcMesh = null; }
    if (st.skirtMesh) { st.skirtMesh.removeFromParent(); st.skirtMesh = null; }
    if (!st.active && !st.bodies.length) return;
    disposeBodies();
    st.active = false; st.mode = 'off'; st.drag = null; st.grab = null;
    cleanupUniforms();
    document.body.classList.remove('inspecting', 'articulated');
    S.renderer.domElement.style.cursor = '';
  }

  function finishExit() {
    reset();
    onExit();
  }

  // ------------------------------------------------------------------ controls
  function resetControls() {
    st.cut = 'off'; st.cutPos = 0.5; st.explode = 0; st.hideWalls = false;
    $('i-cut').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.a === 'off'));
    $('i-cutpos').value = 500; $('i-cutpos').disabled = true;
    $('i-explode').value = 0;
    $('i-walls').checked = false;
    $('i-feat').checked = U.uColorMode.value > 0.5;
    U.uMask.value = MASK_ALL;
    U.uExplode.value = 0;
    U.uCut.value = 0;
    setFlex(false, true);
    setGravity(false, true);
  }

  function setFlex(on, silent) {
    st.flex = on;
    $('i-flex').classList.toggle('on', on);
    $('i-flex').innerHTML = on ? '■ Stop' : '〰 Flex';
    if (on && !silent) {
      const hinges = st.joints.filter((J) => J.kind === 'hinge');
      const spans = st.joints.map((J) => (J.hi[0] - J.lo[0]) * DEG);
      const sl = st.joints.filter((J) => J.sliding);
      if (sl.length > st.joints.length / 2) {
        const sc = sl.filter((J) => J.kind === 'screw');
        const travel = Math.max(...sl.map((J) => (J.hi[0] - J.lo[0]) * Math.abs(J.lin)));
        onCaption(
          'Range of motion',
          sc.length
            ? `These parts don't pivot — they <b>slide along twisted dovetail rails</b>. Each part can travel up to <b>${Math.round(travel)} mm</b> along its neighbour, turning <b>${Math.round(Math.max(...sc.map((J) => (J.hi[0] - J.lo[0]) * DEG)))}°</b> as it goes, like a nut on a very steep screw. ` +
                (st.coax ? `All ${sl.length} rails share <b>one central axis</b>, so the slats ripple round it in a wave. ` : '') + 'Every range was <b>measured from the model itself</b> by sliding the parts virtually until they collided.'
            : `These parts don't pivot — they <b>slide along straight rails</b>, up to <b>${Math.round(travel)} mm</b>, measured from the model itself by sliding the parts until they collided.`,
        );
        return;
      }
      onCaption(
        'Range of motion',
        `Every joint now swings through the range <b>measured from the model itself</b> — the parts were rotated virtually until they collided. ` +
          `${hinges.length} of ${st.joints.length} joints behave like <b>hinges</b>, swinging up to <b>${Math.round(Math.max(...spans))}°</b>. Turn on <b>Show joints</b> to see each pivot and its limits.`,
      );
    }
  }

  function setGravity(on, silent) {
    const was = st.gravity;
    st.gravity = on;
    $('i-grav').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.g === (on ? '1' : '0')));
    const art = st.joints.length > 0;
    $('i-hint').textContent = on
      ? art ? 'Grab any part — the rest hangs from the joints · let go to drop · flick to throw' : 'Grab the part to pick it up · let go to drop it · flick to throw it'
      : 'Drag the part to turn it · drag empty space to orbit · scroll to zoom';
    $('i-explode').disabled = on;
    $('i-flex').disabled = on;
    if (on) {
      st.explode = 0; U.uExplode.value = 0; $('i-explode').value = 0;
      if (st.mode === 'float') {
        st.mode = 'physics'; st.sleeping = false; st.landed = false; st.blend = null;
        for (const B of st.bodies) {
          B.v.crossVectors(st.w, kb.copy(B.p).sub(st.p));
          B.w.copy(st.w);
        }
      }
      if (!silent) {
        onCaption('Gravity on', art
          ? `Each of the <b>${st.bodies.length} parts</b> is now its own rigid body with its real mass, held together only by the printed ${st.slides ? 'dovetails' : 'pins'}. ` + (st.slides
            ? '<b>Grab one part</b> and watch the others slip and twist along their rails until they hit their stops.'
            : '<b>Grab one part</b> and watch the others dangle, swing and stop at their joint limits.')
          : 'It is a real <b>rigid body</b> now: mass, centre of gravity and inertia are computed from the printed paths. <b>Grab it by any point</b> and watch how it hangs and swings — then let go, or flick it to throw.');
      }
    } else {
      if (was && (st.mode === 'physics' || st.mode === 'grab')) {
        st.mode = 'float';
        adoptBodies(0.9);
        st.w.set(0, 0, 0);
      }
      st.grab = null;
      if (!silent) onCaption('Floating', 'Back in your hands. <b>Drag</b> the part to spin it and look at it from every angle — you can see each individual layer line.');
    }
  }

  function setLayerLimit(n) {
    st.maxLayer = n;
    U.uMaxLayer.value = n - 1;
    $('i-layer-out').textContent = `${n} / ${st.nLayers}`;
  }

  $('i-grav').addEventListener('click', (e) => { if (e.target.dataset.g && st.active && st.mode !== 'enter' && st.mode !== 'exit') setGravity(e.target.dataset.g === '1'); });
  $('i-flex').onclick = () => { if (st.active && !st.gravity) setFlex(!st.flex); };
  $('i-joints').onchange = (e) => {
    setJointMarkers(e.target.checked);
    if (e.target.checked && st.joints.length) {
      const gaps = st.joints.map((J) => J.gap);
      onCaption(
        `${st.joints.length} joints`,
        (st.slides
          ? 'Each purple <b>rail</b> is the track one part rides along its neighbour — a helix when the dovetail is twisted — and the white bead shows where it is now. '
          : 'Each glowing marker is a <b>pivot</b>: the rod is the rotation axis, the arc is how far the part can turn and the white needle shows where it is now. ') +
          `There is only <b>${Math.min(...gaps).toFixed(2)}–${Math.max(...gaps).toFixed(2)} mm</b> of air between the parts — small enough to hold together, big enough not to fuse while printing.`,
      );
    }
  };
  $('i-cut').addEventListener('click', (e) => {
    const a = e.target.dataset.a;
    if (!a || !st.active) return;
    st.cut = a;
    $('i-cut').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.a === a));
    $('i-cutpos').disabled = a === 'off';
    U.uCut.value = a === 'off' ? 0 : 1;
    if (a !== 'off') {
      const i = st.info;
      onCaption(
        `Cross-section · ${a.toUpperCase()} axis`,
        `You are cutting through the real extrusion paths. Each blob is one <b>${i.lineWidth} mm</b> wide bead of plastic: <b>${i.walls} walls</b> outside, a <b>${Math.round(i.infill * 100)}% grid</b> inside and solid skins top and bottom. A printed part is mostly <b>air</b>!` +
          (st.joints.length ? (st.slides ? ' Slide the cut through the part to see the <b>dovetail tongues locking each part to the next</b>.' : ' Slide the cut through a joint to see the <b>pin captured inside its socket</b>.') : ''),
      );
    }
  });
  $('i-cutpos').oninput = (e) => { st.cutPos = e.target.value / 1000; };
  $('i-explode').oninput = (e) => {
    const s = e.target.value / 1000;
    st.explode = s;
    const H = st.bbox.max.z - st.bbox.min.z;
    U.uExplode.value = (s * s * 1.4 * H) / Math.max(st.nLayers, 1);
    if (s > 0.02 && !st._explodeTold) {
      st._explodeTold = true;
      onCaption(
        'Layer by layer',
        `The part is just <b>${st.nLayers} layers</b> of ${st.info.layerHeight} mm stacked up. Each one fused to the one below while hot — that bond is the <b>weakest direction</b>, so prints break between layers far more easily than along them.`,
      );
    }
  };
  $('i-layers').oninput = (e) => {
    const n = +e.target.value;
    setLayerLimit(n);
    onCaption(`Layer ${n} of ${st.nLayers}`, `This is what the part looked like <b>${Math.round((n / st.nLayers) * 100)}%</b> of the way through the print — notice the infill pattern alternating direction from layer to layer.`);
  };
  $('i-walls').onchange = (e) => {
    st.hideWalls = e.target.checked;
    U.uMask.value = st.hideWalls ? MASK_NO_WALLS : MASK_ALL;
    if (st.hideWalls) onCaption('Inside the part', 'With the walls hidden you see the hidden skeleton: the <b>sparse infill lattice</b> holding everything up, and the <b>solid skins</b> that close the top and bottom.');
  };
  $('i-feat').onchange = (e) => {
    U.uColorMode.value = e.target.checked ? 1 : 0;
    skirtMaterial.userData.uniforms.uColorMode.value = U.uColorMode.value;
    const f = $('feat');
    if (f) f.checked = e.target.checked;
  };
  $('i-reset').onclick = () => {
    if (!st.active || st.mode === 'enter' || st.mode === 'exit') return;
    resetControls();
    setLayerLimit(st.nLayers);
    $('i-layers').value = st.nLayers;
    st.mode = 'float';
    st.w.set(0, 0, 0);
    st.resetT = 0;
    st.q0.copy(st.q);
  };
  $('i-back').onclick = () => {
    if (!st.active || st.mode === 'exit' || st.mode === 'enter') return;
    st.drag = null; st.grab = null;
    resetControls(); // drops gravity -> the assembly takes over from the free bodies
    if (!st.blend && st.bodies.length > 1) adoptBodies(1.2);
    st.flexAmt = 0;
    for (const J of st.joints) J.ang = 0;
    st.mode = 'exit'; st.t = 0;
    st.p0.copy(st.p); st.q0.copy(st.q);
    setLayerLimit(st.nLayers);
    onCaption('Back on the bed', 'Putting the part back where it was printed.');
  };

  // ------------------------------------------------------------------ picking
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const ro = v3(), rd = v3(), qi = new THREE.Quaternion();

  // ray vs every body's convex support polytope (in its own frame)
  function pick(e) {
    if (!st.bodies.length) return null;
    const r = S.renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, S.camera);
    const ext = U.uExplode.value * st.nLayers;
    let best = null;
    st.bodies.forEach((B, b) => {
      qi.copy(B.q).invert();
      ro.copy(raycaster.ray.origin).sub(B.p).applyQuaternion(qi);
      rd.copy(raycaster.ray.direction).applyQuaternion(qi);
      let t0 = 0, t1 = Infinity;
      for (let k = 0; k < DIRS.length; k++) {
        const n = DIRS[k];
        const h = B.h[k] + 1.2 + Math.max(0, n.y) * ext;
        const den = n.dot(rd), dist = h - n.dot(ro);
        if (Math.abs(den) < 1e-9) { if (dist < 0) return; continue; }
        const t = dist / den;
        if (den < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
        if (t0 > t1) return;
      }
      if (!best || t0 < best.t) best = { t: t0, b, local: ro.clone().addScaledVector(rd, t0) };
    });
    if (best) best.world = raycaster.ray.at(best.t, v3());
    return best;
  }
  const canGrab = () => st.active && (st.mode === 'float' || st.mode === 'physics');

  const camRight = v3(), camUp = v3(), camDir = v3();
  const dragPlane = new THREE.Plane();
  const viewport = S.renderer.domElement.parentElement;
  viewport.addEventListener('pointerdown', (e) => {
    if (!canGrab() || e.button !== 0) return;
    const hit = pick(e);
    if (!hit) return;
    e.stopPropagation();
    e.preventDefault();
    st.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    if (st.gravity) {
      S.camera.getWorldDirection(camDir);
      dragPlane.setFromNormalAndCoplanarPoint(camDir, hit.world);
      st.grab = { b: hit.b, r: hit.local, target: hit.world.clone() };
      st.mode = 'grab';
      st.sleeping = false;
    } else {
      st.w.set(0, 0, 0);
    }
    S.renderer.domElement.style.cursor = 'grabbing';
  }, { capture: true });

  window.addEventListener('pointermove', (e) => {
    if (!st.active) return;
    if (!st.drag) {
      if (e.target === S.renderer.domElement && canGrab()) S.renderer.domElement.style.cursor = pick(e) ? 'grab' : '';
      return;
    }
    if (e.pointerId !== st.drag.id) return;
    const now = performance.now();
    const dt = Math.max((now - st.drag.t) / 1000, 1 / 240);
    const dx = e.clientX - st.drag.x, dy = e.clientY - st.drag.y;
    st.drag.x = e.clientX; st.drag.y = e.clientY; st.drag.t = now;
    st.lastMove = now;
    if (st.mode === 'grab' && st.grab) {
      const r = S.renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      raycaster.setFromCamera(ndc, S.camera);
      const t = v3();
      if (raycaster.ray.intersectPlane(dragPlane, t)) {
        t.y = Math.max(t.y, FLOOR_Y + 2);
        st.grab.target.copy(t);
      }
    } else if (st.mode === 'float') {
      const len = Math.hypot(dx, dy);
      if (len < 0.01) return;
      camRight.setFromMatrixColumn(S.camera.matrixWorld, 0);
      camUp.setFromMatrixColumn(S.camera.matrixWorld, 1);
      const axis = camUp.multiplyScalar(dx).addScaledVector(camRight, dy).normalize();
      const angle = len * 0.009;
      st.q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, angle));
      const w = axis.multiplyScalar(Math.min(angle / dt, 14));
      st.w.lerp(w, 0.6);
      st.resetT = -1;
    }
  });
  const endDrag = (e) => {
    if (!st.drag || e.pointerId !== st.drag.id) return;
    st.drag = null;
    if (st.mode === 'grab') {
      st.mode = 'physics';
      st.grab = null;
      for (const B of st.bodies) B.v.clampLength(0, 3500);
    } else if (performance.now() - st.lastMove > 90) {
      st.w.set(0, 0, 0); // released while holding still -> no fling
    }
    S.renderer.domElement.style.cursor = '';
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ------------------------------------------------------------------ XPBD physics
  const tC = v3(), tD = v3(), tN = v3(), tP = v3(), tR = v3(), tR2 = v3(), tX = v3(), tV = v3();
  const qInv = new THREE.Quaternion(), qRel = new THREE.Quaternion();
  const contacts = [];
  const cPool = [];

  // world-space inverse inertia applied to x
  function invIw(B, x, out) {
    qInv.copy(B.q).invert();
    return out.copy(x).applyQuaternion(qInv).applyMatrix3(B.invIb).applyQuaternion(B.q);
  }
  // q += s · ½ [dw, 0] q
  function addRot(B, dw, s) {
    const q = B.q;
    const hx = dw.x * 0.5 * s, hy = dw.y * 0.5 * s, hz = dw.z * 0.5 * s;
    const { x, y, z, w } = q;
    q.set(x + hx * w + hy * z - hz * y, y + hy * w + hz * x - hx * z, z + hz * w + hx * y - hy * x, w - hx * x - hy * y - hz * z).normalize();
  }
  function genW(B, r, n) {
    tC.crossVectors(r, n);
    invIw(B, tC, tD);
    return B.invM + tC.dot(tD);
  }
  function posImpulse(B, r, imp, s) {
    B.p.addScaledVector(imp, s * B.invM);
    tC.crossVectors(r, imp);
    invIw(B, tC, tD);
    addRot(B, tD, s);
  }
  // move attachment points so that dx = a1 - a2 vanishes (b2 null = static world)
  function solvePos(b1, r1, b2, r2, dx, alpha) {
    const c = dx.length();
    if (c < 1e-9) return 0;
    tN.copy(dx).divideScalar(c);
    const w = genW(b1, r1, tN) + (b2 ? genW(b2, r2, tN) : 0);
    const lam = -c / (w + alpha);
    tP.copy(tN).multiplyScalar(lam);
    posImpulse(b1, r1, tP, 1);
    if (b2) posImpulse(b2, r2, tP, -1);
    return lam;
  }
  function velImpulse(B, r, dv) {
    const l = dv.length();
    if (l < 1e-9) return;
    tN.copy(dv).divideScalar(l);
    const w = genW(B, r, tN);
    tP.copy(dv).divideScalar(w);
    B.v.addScaledVector(tP, B.invM);
    tC.crossVectors(r, tP);
    invIw(B, tC, tD);
    B.w.add(tD);
  }
  // relative rotation of B w.r.t. A as a rotation vector (A frame)
  function relRot(A, B, out) {
    qRel.copy(A.q).invert().multiply(B.q);
    if (qRel.w < 0) { qRel.x = -qRel.x; qRel.y = -qRel.y; qRel.z = -qRel.z; qRel.w = -qRel.w; }
    const s = Math.hypot(qRel.x, qRel.y, qRel.z);
    const k = s < 1e-9 ? 2 : (2 * Math.atan2(s, qRel.w)) / s;
    return out.set(qRel.x * k, qRel.y * k, qRel.z * k);
  }

  // screw / straight slide: B's pivot stays on A's axis line; along it, the travel is either
  // tied to the twist (screw: travel = pitch · angle) or limited to the measured range (slide)
  const sU = v3(), sD = v3(), sGA = v3(), sGB = v3(), sArm = v3();
  function solveSlide(J, A, B) {
    sU.copy(J.axes[0]).applyQuaternion(A.q);
    sD.copy(B.p).add(tR2).sub(A.p).sub(tR); // pivot B − pivot A
    let a = sD.dot(sU);
    // 1. stay on the axis line (arm on A = the point of A's axis next to B's pivot)
    tX.copy(sU).multiplyScalar(a).sub(sD);
    sArm.copy(tR).addScaledVector(sU, a);
    solvePos(A, sArm, B, tR2, tX, 0);
    tR.copy(J.rA).applyQuaternion(A.q);
    tR2.copy(J.rB).applyQuaternion(B.q);
    sU.copy(J.axes[0]).applyQuaternion(A.q);
    a = sD.copy(B.p).add(tR2).sub(A.p).sub(tR).dot(sU);
    if (!J.rot) {
      // 2a. straight slide: travel limits
      const t = Math.min(Math.max(a, J.lo[0]), J.hi[0]);
      if (t === a) return;
      tX.copy(sU).multiplyScalar(t - a);
      sArm.copy(tR).addScaledVector(sU, t);
      solvePos(A, sArm, B, tR2, tX, 0);
      return;
    }
    // 2b. screw: C = travel − pitch·angle, with angle = B's turn about the axis relative to A
    relRot(A, B, tV);
    const C = a - J.lin * tV.dot(J.axes[0]);
    if (Math.abs(C) < 1e-7) return;
    sGB.crossVectors(tR2, sU).addScaledVector(sU, -J.lin);
    sGA.crossVectors(sU, tR).addScaledVector(sU, J.lin);
    const w = A.invM + B.invM + invIw(A, sGA, tD).dot(sGA) + invIw(B, sGB, tD).dot(sGB);
    const lam = -C / w;
    B.p.addScaledVector(sU, lam * B.invM);
    addRot(B, invIw(B, sGB, tD), lam);
    A.p.addScaledVector(sU, -lam * A.invM);
    addRot(A, invIw(A, sGA, tD), lam);
  }

  function physicsStep(h) {
    const { bodies, joints } = st;
    const h2 = h * h;
    for (const B of bodies) {
      B.v.y += GRAVITY * h;
      B.v.multiplyScalar(Math.exp(-h * 0.15));
      B.w.multiplyScalar(Math.exp(-h * (B.contact ? 1.5 : 0.3)));
      B.pp.copy(B.p);
      B.pq.copy(B.q);
      B.p.addScaledVector(B.v, h);
      addRot(B, B.w, h);
      B.contact = false;
    }

    // grab: soft spring to the cursor
    if (st.grab) {
      const B = bodies[st.grab.b];
      tR.copy(st.grab.r).applyQuaternion(B.q);
      tX.copy(B.p).add(tR).sub(st.grab.target);
      solvePos(B, tR, null, null, tX, 1 / (GRAB_K * st.mass) / h2);
    }

    // joints: shared pivot + angular limits (two passes so the chain stays tight under the grab)
    // sliding joints couple turn and travel, so they get a couple of extra passes
    const nIt = st.slides ? 4 : 2;
    for (let it = 0; it < nIt; it++) for (const J of joints) {
      const A = bodies[J.A], B = bodies[J.B];
      tR.copy(J.rA).applyQuaternion(A.q);
      tR2.copy(J.rB).applyQuaternion(B.q);
      if (J.sliding) solveSlide(J, A, B);
      else {
        tX.copy(A.p).add(tR).sub(B.p).sub(tR2);
        solvePos(A, tR, B, tR2, tX, 0);
      }

      relRot(A, B, tV);
      tX.set(0, 0, 0);
      for (let k = 0; k < 3; k++) {
        const ax = J.axes[k], c = tV.dot(ax);
        const cl = Math.min(Math.max(c, J.rlo[k]), J.rhi[k]);
        if (cl !== c) tX.addScaledVector(ax, cl - c);
      }
      const l = tX.length();
      if (l > 1e-7) {
        tX.applyQuaternion(A.q).divideScalar(l);
        const wA = invIw(A, tX, tD).dot(tX), wB = invIw(B, tX, tD).dot(tX);
        tP.copy(tX).multiplyScalar(l / (wA + wB));
        addRot(B, invIw(B, tP, tD), 1);
        addRot(A, invIw(A, tP, tD), -1);
      }
    }

    // floor contacts on the support points
    contacts.length = 0;
    for (const B of bodies) {
      for (const hp of B.hull) {
        tR.copy(hp).applyQuaternion(B.q);
        const y = B.p.y + tR.y;
        if (y >= FLOOR_Y) continue;
        // approach speed before the solve (for restitution)
        tV.copy(hp).applyQuaternion(B.pq);
        const vnPrev = (y - (B.pp.y + tV.y)) / h;
        tX.set(0, y - FLOOR_Y, 0);
        const lamN = solvePos(B, tR, null, null, tX, 0);
        // static friction: undo sliding of the contact point
        tR.copy(hp).applyQuaternion(B.q);
        tV.copy(hp).applyQuaternion(B.pq).add(B.pp);
        tX.copy(B.p).add(tR).sub(tV);
        tX.y = 0;
        const dl = tX.length();
        if (dl > 1e-9 && dl / genW(B, tR, tN.copy(tX).divideScalar(dl)) < MU_S * Math.abs(lamN)) solvePos(B, tR, null, null, tX, 0);
        const c = cPool[contacts.length] || (cPool[contacts.length] = { B: null, hp: null, lamN: 0, vnPrev: 0 });
        c.B = B; c.hp = hp; c.lamN = lamN; c.vnPrev = vnPrev;
        contacts.push(c);
        B.contact = true;
      }
    }

    // velocities from positions
    for (const B of bodies) {
      B.v.copy(B.p).sub(B.pp).divideScalar(h);
      qRel.copy(B.q).multiply(qInv.copy(B.pq).invert());
      const s = qRel.w < 0 ? -2 / h : 2 / h;
      B.w.set(qRel.x * s, qRel.y * s, qRel.z * s);
    }

    // velocity pass: restitution + dynamic friction, joint & grab damping
    let impact = 0;
    for (const c of contacts) {
      const B = c.B;
      tR.copy(c.hp).applyQuaternion(B.q);
      tV.crossVectors(B.w, tR).add(B.v);
      const vn = tV.y;
      tX.set(tV.x, 0, tV.z);
      const vt = tX.length();
      if (vt > 1e-6) tX.multiplyScalar(-Math.min((h * MU_D * Math.abs(c.lamN)) / h2, vt) / vt);
      else tX.set(0, 0, 0);
      const e = c.vnPrev < -350 ? RESTITUTION : 0;
      tX.y = -vn + Math.max(-e * c.vnPrev, 0);
      velImpulse(B, tR, tX);
      impact = Math.max(impact, -c.vnPrev);
    }
    for (const J of joints) {
      const A = bodies[J.A], B = bodies[J.B];
      tX.copy(B.w).sub(A.w);
      const l = tX.length();
      if (l < 1e-6) continue;
      tX.divideScalar(l);
      const wA = invIw(A, tX, tD).dot(tX), wB = invIw(B, tX, tD).dot(tX);
      tP.copy(tX).multiplyScalar((l * Math.min(h * JOINT_DAMP, 1)) / (wA + wB));
      A.w.add(invIw(A, tP, tD));
      B.w.sub(invIw(B, tP, tD));
    }
    if (st.grab) {
      const B = bodies[st.grab.b];
      tR.copy(st.grab.r).applyQuaternion(B.q);
      tV.crossVectors(B.w, tR).add(B.v);
      velImpulse(B, tR, tX.copy(tV).multiplyScalar(-Math.min(h * GRAB_DAMP, 1)));
    }

    if (impact > 180 && performance.now() - st.lastImpact > 70) {
      st.lastImpact = performance.now();
      sound.clack(Math.min(impact / 1800, 1));
      if (!st.landed && !st.grab) {
        st.landed = true;
        const i = st.info;
        onCaption('Clack!', st.joints.length
          ? `About <b>${i.grams.toFixed(1)} g</b> of PLA in <b>${st.bodies.length} pieces</b>. Each piece lands on its own and the joints let the whole thing <b>${st.slides ? 'twist and slide' : 'flop and fold'}</b> — exactly what a print-in-place toy does in your hand.`
          : `About <b>${i.grams.toFixed(1)} g</b> of PLA. It lands and settles on its widest, most stable face — and since the walls and infill are rigid plastic, it bounces like a hard toy, not a solid block.`);
      }
    }

    // keep everything inside the arena
    const c = centerOfMass(tX);
    const dx = c.x - PAD.x, dz = c.z - PAD.z;
    const d = Math.hypot(dx, dz);
    if (d > ARENA_R) {
      const nx = dx / d, nz = dz / d, push = d - ARENA_R;
      for (const B of bodies) {
        B.p.x -= nx * push; B.p.z -= nz * push;
        const vr = B.v.x * nx + B.v.z * nz;
        if (vr > 0) { B.v.x -= 1.5 * vr * nx; B.v.z -= 1.5 * vr * nz; }
      }
    }
    for (const B of bodies) if (B.p.y > 900) { B.p.y = 900; B.v.y = Math.min(B.v.y, 0); }

    // sleep when resting
    const still = contacts.length && !st.grab && bodies.every((B) => B.v.length() < 8 && B.w.length() < 0.3);
    if (still) {
      st.sleepT += h;
      if (st.sleepT > 0.5) { st.sleeping = true; for (const B of bodies) { B.v.set(0, 0, 0); B.w.set(0, 0, 0); } }
    } else st.sleepT = 0;
  }

  function centerOfMass(out) {
    out.set(0, 0, 0);
    for (const B of st.bodies) out.addScaledVector(B.p, B.m);
    return out.divideScalar(st.mass);
  }

  // ------------------------------------------------------------------ per frame
  const bez = (a, b, c, d, t, out) => {
    const u = 1 - t;
    return out.set(0, 0, 0).addScaledVector(a, u * u * u).addScaledVector(b, 3 * u * u * t).addScaledVector(c, 3 * u * t * t).addScaledVector(d, t * t * t);
  };
  const qTmp = new THREE.Quaternion();
  const prevFocus = v3();
  const tmp = v3(), tmp2 = v3();
  const floatBody = { q: st.q };

  function update(dt, time, cam) {
    if (!st.active) {
      st.padFade = Math.max(0, st.padFade - dt * 1.5);
    } else {
      st.t += dt;
      st.padFade = Math.min(1, st.padFade + dt * 0.8);
      if (st.blend) { st.blend.t += dt; if (st.blend.t >= st.blend.dur) st.blend = null; }
      if (st.mode === 'grab' || st.mode === 'physics') st.sleeping = st.sleeping && !st.grab;
      const held = st.mode !== 'physics' && st.mode !== 'grab';
      if (st.mode === 'enter') {
        const T = st.t;
        if (T < 0.9) {
          // pop off the plate
          const k = T / 0.9;
          st.p.copy(st.p0).y += Math.sin(k * Math.PI * 0.5) * 3;
          qTmp.setFromAxisAngle(camRight.set(1, 0, 0), Math.sin(T * 34) * 0.05 * (1 - k));
          st.q.copy(qTmp);
          if (T > 0.45 && !st.popped) { st.popped = true; sound.clack(0.5); }
        } else {
          const u = ease(Math.min((T - 0.9) / 1.8, 1));
          const a = tmp.copy(st.p0); a.y += 3;
          bez(a, tmp2.copy(a).add(v3(0, 170, 0)), v3(st.hold.x, st.hold.y + 140, st.hold.z - 160), st.hold, u, st.p);
          st.q.slerpQuaternions(st.q0, st.qRest, u);
          if (T > 2.7) {
            st.mode = 'float';
            st.w.set(0, 0.5, 0);
            if (st.joints.length) {
              const gaps = st.joints.map((J) => J.gap);
              onCaption(
                'Step 6 · Print-in-place!',
                `This model came off the bed as <b>${st.bodies.length} separate parts</b>, already linked by <b>${st.joints.length} joints</b> — the slicer kept a ${Math.min(...gaps).toFixed(2)} mm air gap so nothing fused together. ` +
                  (st.slides
                    ? `Hit <b>Flex</b> to see the parts slide, <b>Show joints</b> to reveal the rails they ride on, or switch on <b>Gravity</b> and grab one.`
                    : `Hit <b>Flex</b> to see how each joint moves, <b>Show joints</b> to reveal the pivots, or switch on <b>Gravity</b> and grab a limb.`),
              );
            } else {
              onCaption('Step 6 · It\'s in your hands', 'This is the real toolpath geometry the printer laid down. <b>Drag the part</b> to turn it, then try <b>Cut</b> to see inside, <b>Explode</b> to pull the layers apart, or switch on <b>Gravity</b> and drop it.');
            }
          }
        }
      } else if (st.mode === 'exit') {
        const u = ease(Math.min(st.t / 1.6, 1));
        bez(st.p0, tmp2.copy(st.p0).add(v3(0, 160, 0)), v3(st.bedPos.x, st.bedPos.y + 180, st.bedPos.z), st.bedPos, u, st.p);
        st.q.slerpQuaternions(st.q0, qTmp.identity(), u);
        if (st.t >= 1.6) { finishExit(); return; }
      } else if (st.mode === 'float') {
        const target = tmp.copy(st.hold);
        target.y += Math.sin(time * 1.2) * 3;
        st.p.lerp(target, 1 - Math.exp(-dt * 3.5));
        if (st.resetT >= 0) {
          st.resetT += dt;
          st.q.slerpQuaternions(st.q0, st.qRest, ease(Math.min(st.resetT / 0.9, 1)));
          if (st.resetT > 0.9) st.resetT = -1;
        } else if (!st.drag) {
          addRot(floatBody, st.w, dt);
          st.w.multiplyScalar(Math.exp(-dt * 0.9));
        }
      } else if (!st.sleeping) {
        const n = Math.min(Math.ceil(dt / SUBSTEP - 1e-6), 50);
        for (let i = 0; i < n; i++) physicsStep(dt / n);
      }
      if (held) { setFlexAngles(dt); compose(); }
      syncBodies();

      // clip plane in the root part's frame
      const rootMesh = st.bodies[st.root].mesh;
      rootMesh.updateWorldMatrix(true, false);
      if (st.cut !== 'off') {
        const b = st.bbox;
        const ext = U.uExplode.value * st.nLayers;
        const axis = st.cut === 'x' ? 0 : st.cut === 'y' ? 1 : 2;
        const lo = b.min.getComponent(axis), hi = b.max.getComponent(axis) + (axis === 2 ? ext : 0);
        const c = lo - 0.5 + (hi - lo + 1) * st.cutPos;
        localCut.set(v3().setComponent(axis, -1), c);
        cutPlane.copy(localCut).applyMatrix4(rootMesh.matrixWorld);
      } else cutPlane.set(v3(0, 1, 0), 1e9);

      // follow the part with the camera
      prevFocus.copy(st.focus);
      const ext = U.uExplode.value * st.nLayers;
      const goal = held ? tmp.copy(st.p) : centerOfMass(tmp);
      if (ext > 0) goal.add(tmp2.set(0, 0, 1).transformDirection(rootMesh.matrixWorld).multiplyScalar(ext * 0.5));
      goal.y = Math.max(goal.y, st.radius + 10);
      const k = 1 - Math.exp(-dt * 3);
      st.focus.lerp(goal, k);
      st.viewR += (st.radius + ext * 0.5 - st.viewR) * k;
      if (cam === 'orbit') {
        const d = tmp2.copy(st.focus).sub(prevFocus);
        S.camera.position.add(d);
        S.controls.target.add(d);
      }
    }

    padGlow.material.opacity = st.padFade * 0.9;
    padRings.forEach((r, i) => {
      r.material.opacity = st.padFade * (0.35 - i * 0.09) * (0.75 + 0.25 * Math.sin(time * 2 - i));
    });
    pad.rotation.y = time * 0.08;
    pad.visible = st.padFade > 0.001;
  }

  function cameraGoal(t, camPos, camTarget) {
    const a = 0.42 + Math.sin(t * 0.07) * 0.3;
    const R0 = st.viewR * 5.4 + 110;
    camTarget.copy(st.focus);
    camTarget.y -= R0 * 0.13;
    camPos.set(st.focus.x + Math.sin(a) * R0, st.focus.y + R0 * 0.32, st.focus.z + Math.cos(a) * R0);
  }

  return {
    start, reset, update, cameraGoal,
    depthMaterial,
    get active() { return st.active; },
    get mode() { return st.mode; },
    _st: st,
  };
}
