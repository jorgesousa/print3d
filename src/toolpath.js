import * as THREE from 'three';

export const FEATURES = [
  { name: 'Skirt', color: '#9aa4b2', speed: 50, tip: 'The skirt primes the nozzle so plastic flows smoothly before the real part starts.' },
  { name: 'Outer wall', color: '#ff8c42', speed: 150, tip: 'Outer wall — the visible surface. Printed slower for a clean finish. Notice the seam aligned at the back.' },
  { name: 'Inner wall', color: '#ffd166', speed: 220, tip: 'Inner walls are printed first to give the outer wall something to lean on.' },
  { name: 'Sparse infill', color: '#c77dff', speed: 260, tip: 'Sparse infill — a 15% grid lattice inside. It saves plastic and time while keeping the part strong.' },
  { name: 'Solid infill', color: '#4cc9f0', speed: 200, tip: 'Solid infill — dense layers near the bottom and top so the surfaces have something to sit on.' },
  { name: 'Top surface', color: '#06d6a0', speed: 150, tip: 'Top surface — the final skin, laid down slowly in tight lines to close the part.' },
];
export const TRAVEL_SPEED = 400;
const FIRST_LAYER_SPEED = 45;

export function buildToolpath(result, settings) {
  const { layers } = result;
  const w = settings.lineWidth;

  // ---- count
  let nPts = 0, nSegs = 0, nMoves = 0;
  for (const l of layers) for (const p of l.paths) {
    const n = p.pts.length / 2;
    nPts += n; nSegs += n - 1; nMoves += n;
  }
  nMoves += layers.length;

  const position = new Float32Array(nPts * 4 * 3);
  const normal = new Float32Array(nPts * 4 * 3);
  const aDist = new Float32Array(nPts * 4);
  const aType = new Float32Array(nPts * 4);
  const aLayer = new Float32Array(nPts * 4);
  const index = new Uint32Array(nSegs * 24);
  const segPart = new Int16Array(nSegs); // shell id per segment (-1 = skirt)
  const segLen = new Float32Array(nSegs);

  const mv = {
    x0: new Float32Array(nMoves), y0: new Float32Array(nMoves), x1: new Float32Array(nMoves), y1: new Float32Array(nMoves),
    z: new Float32Array(nMoves), type: new Int8Array(nMoves), layer: new Int32Array(nMoves),
    t0: new Float64Array(nMoves), dur: new Float32Array(nMoves), geo: new Int32Array(nMoves), d0: new Float64Array(nMoves),
    count: 0,
  };
  const layerStartMove = new Int32Array(layers.length);
  const layerStartTime = new Float64Array(layers.length + 1);

  let v = 0, ii = 0, seg = 0, time = 0, dist = 0;
  let cx = 0, cy = -110;
  const addMove = (x0, y0, x1, y1, z, type, layer, dur, geo) => {
    const m = mv.count++;
    mv.x0[m] = x0; mv.y0[m] = y0; mv.x1[m] = x1; mv.y1[m] = y1; mv.z[m] = z;
    mv.type[m] = type; mv.layer[m] = layer; mv.t0[m] = time; mv.dur[m] = dur; mv.geo[m] = geo; mv.d0[m] = dist;
    time += dur;
  };

  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    const z = L.z, h = L.h;
    const zc = z - h / 2;
    layerStartMove[li] = mv.count;
    layerStartTime[li] = time;
    for (const p of L.paths) {
      const pts = p.pts;
      const n = pts.length / 2;
      // travel (includes the layer change on the first path)
      const tl = Math.hypot(pts[0] - cx, pts[1] - cy);
      if (tl > 0.01 || mv.count === layerStartMove[li]) {
        addMove(cx, cy, pts[0], pts[1], z, -1, li, tl / TRAVEL_SPEED + (mv.count === layerStartMove[li] ? 0.35 : 0.02), -1);
      }
      const speed = li === 0 ? FIRST_LAYER_SPEED : FEATURES[p.type].speed;
      const base = v;
      let pd = dist;
      for (let i = 0; i < n; i++) {
        const x = pts[i * 2], y = pts[i * 2 + 1];
        // tangent = average of adjacent segment directions
        let tx = 0, ty = 0, miter = 1;
        let ax = 0, ay = 0, bx = 0, by = 0;
        if (i > 0) { ax = x - pts[i * 2 - 2]; ay = y - pts[i * 2 - 1]; const l = Math.hypot(ax, ay) || 1; ax /= l; ay /= l; }
        if (i < n - 1) { bx = pts[i * 2 + 2] - x; by = pts[i * 2 + 3] - y; const l = Math.hypot(bx, by) || 1; bx /= l; by /= l; }
        tx = ax + bx; ty = ay + by;
        const tl2 = Math.hypot(tx, ty);
        if (tl2 < 1e-6) { tx = bx || ax; ty = by || ay; } else { tx /= tl2; ty /= tl2; }
        if (i > 0 && i < n - 1) miter = 1 / Math.max(0.55, tx * bx + ty * by);
        const sx = -ty * (w * 0.56) * miter, sy = tx * (w * 0.56) * miter;
        if (i > 0) pd += Math.hypot(x - pts[i * 2 - 2], y - pts[i * 2 - 1]);
        const ring = [
          [x, y, zc + h * 0.5, 0, 0, 1],
          [x + sx, y + sy, zc, -ty, tx, 0],
          [x, y, zc - h * 0.5, 0, 0, -1],
          [x - sx, y - sy, zc, ty, -tx, 0],
        ];
        for (const r of ring) {
          position[v * 3] = r[0]; position[v * 3 + 1] = r[1]; position[v * 3 + 2] = r[2];
          normal[v * 3] = r[3]; normal[v * 3 + 1] = r[4]; normal[v * 3 + 2] = r[5];
          aDist[v] = pd; aType[v] = p.type; aLayer[v] = li;
          v++;
        }
      }
      for (let i = 0; i < n - 1; i++) {
        const A = base + i * 4, B = A + 4;
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          // counter-clockwise seen from outside -> front faces point outwards
          index[ii++] = A + k; index[ii++] = B + k; index[ii++] = A + k2;
          index[ii++] = A + k2; index[ii++] = B + k; index[ii++] = B + k2;
        }
        const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3];
        const len = Math.hypot(x1 - x0, y1 - y0);
        addMove(x0, y0, x1, y1, z, p.type, li, Math.max(len / speed, 0.004), seg);
        segPart[seg] = p.part ?? 0;
        segLen[seg] = len;
        dist += len;
        seg++;
      }
      cx = pts[pts.length - 2]; cy = pts[pts.length - 1];
    }
  }
  layerStartTime[layers.length] = time;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('aDist', new THREE.BufferAttribute(aDist, 1));
  geometry.setAttribute('aType', new THREE.BufferAttribute(aType, 1));
  geometry.setAttribute('aLayer', new THREE.BufferAttribute(aLayer, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.setDrawRange(0, 0);
  geometry.computeBoundingSphere();

  const filamentArea = Math.PI * 0.875 * 0.875;
  return {
    geometry, segPart, segLen, moves: mv, layers, layerStartMove, layerStartTime,
    totalTime: time, totalExtrude: dist, segments: seg,
    filamentLength: (dist * w * settings.layerHeight) / filamentArea, // mm of 1.75 mm filament
  };
}

// Shared GLSL for the bead: explode (layer spacing), layer limit, feature mask.
const VERT_HEAD = `
attribute float aDist; attribute float aType; attribute float aLayer;
uniform float uExplode;
varying float vDist; varying float vType; varying float vLayer;`;
const VERT_BODY = `
vDist = aDist; vType = aType; vLayer = aLayer;
transformed.z += aLayer * uExplode;`;
const FRAG_HEAD = `
uniform float uMaxLayer; uniform float uMask;
varying float vDist; varying float vType; varying float vLayer;`;
const FRAG_DISCARD = `
if (vLayer > uMaxLayer + 0.5) discard;
if (((int(uMask + 0.5) >> int(vType + 0.5)) & 1) == 0) discard;`;

function beadUniforms() {
  return {
    uExplode: { value: 0 },
    uMaxLayer: { value: 1e9 },
    uMask: { value: 63 },
  };
}

export function createBeadMaterial() {
  const uniforms = {
    ...beadUniforms(),
    uPrinted: { value: 0 },
    uHeatLen: { value: 60 },
    uColorMode: { value: 0 },
    uCut: { value: 0 },
    uFeat: { value: FEATURES.map((f) => new THREE.Color(f.color)) },
  };
  const m = new THREE.MeshStandardMaterial({ color: 0xff6b1a, roughness: 0.5, metalness: 0, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + VERT_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>${FRAG_HEAD}
        uniform float uPrinted; uniform float uHeatLen; uniform float uColorMode; uniform float uCut; uniform vec3 uFeat[6];
        vec3 featColor(float t){ int i = int(t + 0.5); vec3 c = uFeat[0];
          if(i==1) c = uFeat[1]; else if(i==2) c = uFeat[2]; else if(i==3) c = uFeat[3]; else if(i==4) c = uFeat[4]; else if(i==5) c = uFeat[5];
          return c; }`,
      )
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + FRAG_DISCARD)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (uColorMode > 0.5) diffuseColor.rgb = featColor(vType);
        // inside of a cut bead -> render as a solid, flat cross-section cap
        if (uCut > 0.5 && !gl_FrontFacing) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), 0.18);`,
      )
      .replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nif (uCut > 0.5 && !gl_FrontFacing) normal = vec3(0.0, 0.0, 1.0);')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float age = max(uPrinted - vDist, 0.0);
        float heat = clamp(1.0 - age / uHeatLen, 0.0, 1.0);
        heat = heat * heat * heat;
        vec3 hot = mix(vec3(0.55, 0.06, 0.0), vec3(1.0, 0.42, 0.06), heat);
        hot = mix(hot, vec3(1.0, 0.85, 0.55), heat * heat);
        totalEmissiveRadiance += hot * heat * 3.0;`,
      );
  };
  m.userData.uniforms = uniforms;
  return m;
}

// Shadow-pass material that follows the same explode / mask / layer-limit as the bead.
export function createBeadDepthMaterial(uniforms) {
  const m = new THREE.MeshDepthMaterial();
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uExplode = uniforms.uExplode;
    shader.uniforms.uMaxLayer = uniforms.uMaxLayer;
    shader.uniforms.uMask = uniforms.uMask;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>' + VERT_HEAD)
      .replace('#include <begin_vertex>', '#include <begin_vertex>' + VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>' + FRAG_HEAD)
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>' + FRAG_DISCARD);
  };
  return m;
}
