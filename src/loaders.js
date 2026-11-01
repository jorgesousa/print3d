import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { unzipSync, strFromU8 } from 'fflate';
import { fixWinding, mergePositions } from './models.js';

export async function loadModelFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const buf = await file.arrayBuffer();
  let pos;
  if (ext === 'stl') pos = parseSTL(buf);
  else if (ext === '3mf') pos = parse3MF(buf);
  else if (ext === 'obj') pos = parseOBJ(buf);
  else throw new Error(`Unsupported file type ".${ext}". Use STL, 3MF or OBJ.`);
  if (!pos || pos.length < 9) throw new Error('No printable geometry found in this file.');
  const colours = pos.colours;
  pos = fixWinding(pos); // keeps the triangle order, so colours still line up
  pos.colours = colours;
  return pos;
}

function parseSTL(buf) {
  const g = new STLLoader().parse(buf);
  const ng = g.index ? g.toNonIndexed() : g;
  return new Float32Array(ng.attributes.position.array);
}

function parseOBJ(buf) {
  const group = new OBJLoader().parse(new TextDecoder().decode(buf));
  group.updateMatrixWorld(true);
  const parts = [];
  group.traverse((o) => {
    if (!o.isMesh) return;
    let g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    if (g.index) g = g.toNonIndexed();
    g.rotateX(Math.PI / 2); // OBJ is usually Y-up
    parts.push(new Float32Array(g.attributes.position.array));
  });
  return mergePositions(parts);
}

// 3MF with support for the production extension (components in separate files, as used by
// Bambu Studio / OrcaSlicer). When plate info exists, only the first plate is used.
function parse3MF(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const xml = new DOMParser();
  const docs = {};
  for (const name of Object.keys(files)) {
    if (name.toLowerCase().endsWith('.model')) {
      docs['/' + name.replace(/^\//, '')] = xml.parseFromString(strFromU8(files[name]), 'application/xml');
    }
  }
  let rootPath = '/3D/3dmodel.model';
  const rels = files['_rels/.rels'];
  if (rels) {
    const m = strFromU8(rels).match(/Target="([^"]+\.model)"/i);
    if (m) rootPath = '/' + m[1].replace(/^\//, '');
  }
  if (!docs[rootPath]) rootPath = Object.keys(docs)[0];
  if (!rootPath) throw new Error('3MF contains no model.');

  const objCache = {};
  const objectsOf = (path) => {
    if (objCache[path]) return objCache[path];
    const map = {};
    const doc = docs[path];
    if (doc) for (const o of doc.getElementsByTagNameNS('*', 'object')) map[o.getAttribute('id')] = o;
    return (objCache[path] = map);
  };
  const pathAttr = (el) => {
    for (const a of el.attributes) if (a.localName === 'path') return '/' + a.value.replace(/^\//, '');
    return null;
  };

  let allowed = null;
  const settings = files['Metadata/model_settings.config'];
  if (settings) {
    const doc = xml.parseFromString(strFromU8(settings), 'application/xml');
    const plate = doc.getElementsByTagName('plate')[0];
    if (plate) {
      allowed = new Set();
      for (const inst of plate.getElementsByTagName('model_instance')) {
        for (const md of inst.getElementsByTagName('metadata')) {
          if (md.getAttribute('key') === 'object_id') allowed.add(md.getAttribute('value'));
        }
      }
      if (!allowed.size) allowed = null;
    }
  }

  const paint = readBambuColours(files, xml);
  const colourOf = (path) => {
    const map = {};
    for (const tag of ['base', 'color']) {
      const doc = docs[path];
      if (!doc) continue;
      for (const el of doc.getElementsByTagNameNS('*', tag)) {
        const group = el.parentNode.getAttribute('id');
        (map[group] ??= []).push((el.getAttribute('displaycolor') || el.getAttribute('color') || '').slice(0, 7));
      }
    }
    return map;
  };
  const colourCache = {};
  const triColours = []; // one '#rrggbb' or null per triangle

  const out = [];
  const emit = (path, id, matrix, depth, extruder) => {
    if (depth > 16) return;
    const obj = objectsOf(path)[id];
    if (!obj) return;
    const ownExtruder = paint.extruders[id] ?? extruder;
    const mats = (colourCache[path] ??= colourOf(path));
    const mesh = obj.getElementsByTagNameNS('*', 'mesh')[0];
    if (mesh && mesh.parentNode === obj) {
      const vs = mesh.getElementsByTagNameNS('*', 'vertex');
      const v = new Float32Array(vs.length * 3);
      const p = new THREE.Vector3();
      for (let i = 0; i < vs.length; i++) {
        p.set(+vs[i].getAttribute('x'), +vs[i].getAttribute('y'), +vs[i].getAttribute('z')).applyMatrix4(matrix);
        v[i * 3] = p.x; v[i * 3 + 1] = p.y; v[i * 3 + 2] = p.z;
      }
      const ts = mesh.getElementsByTagNameNS('*', 'triangle');
      const arr = new Float32Array(ts.length * 9);
      for (let i = 0; i < ts.length; i++) {
        const a = +ts[i].getAttribute('v1'), b = +ts[i].getAttribute('v2'), c = +ts[i].getAttribute('v3');
        arr.set([v[a * 3], v[a * 3 + 1], v[a * 3 + 2], v[b * 3], v[b * 3 + 1], v[b * 3 + 2], v[c * 3], v[c * 3 + 1], v[c * 3 + 2]], i * 9);
        const painted = paintedFilament(ts[i].getAttribute('paint_color') || ts[i].getAttribute('mmu_segmentation'));
        const pid = ts[i].getAttribute('pid') ?? obj.getAttribute('pid');
        const pidx = ts[i].getAttribute('p1') ?? obj.getAttribute('pindex') ?? 0;
        triColours.push(paint.filaments[(painted || ownExtruder) - 1] ?? mats[pid]?.[pidx] ?? null);
      }
      out.push(arr);
    }
    for (const comp of obj.getElementsByTagNameNS('*', 'component')) {
      const m = matrix.clone().multiply(parseTransform(comp.getAttribute('transform')));
      emit(pathAttr(comp) || path, comp.getAttribute('objectid'), m, depth + 1, ownExtruder);
    }
  };

  const items = [...docs[rootPath].getElementsByTagNameNS('*', 'item')];
  let used = items.filter((it) => it.getAttribute('printable') !== '0' && (!allowed || allowed.has(it.getAttribute('objectid'))));
  if (!used.length) used = items;
  for (const it of used) emit(pathAttr(it) || rootPath, it.getAttribute('objectid'), parseTransform(it.getAttribute('transform')), 0);
  const pos = mergePositions(out);
  pos.colours = buildPalette(triColours);
  return pos;
}

// Bambu Studio / OrcaSlicer keep the filament list and each object's filament in their own config files.
function readBambuColours(files, xml) {
  const extruders = {};
  let filaments = [];
  const project = files['Metadata/project_settings.config'];
  if (project) {
    try { filaments = JSON.parse(strFromU8(project)).filament_colour ?? []; } catch { /* not JSON: no filament list */ }
  }
  const settings = files['Metadata/model_settings.config'];
  if (settings) {
    const doc = xml.parseFromString(strFromU8(settings), 'application/xml');
    for (const el of [...doc.getElementsByTagName('object'), ...doc.getElementsByTagName('part')]) {
      const md = [...el.children].find((c) => c.tagName === 'metadata' && c.getAttribute('key') === 'extruder');
      if (md) extruders[el.getAttribute('id')] = +md.getAttribute('value');
    }
  }
  return { extruders, filaments: filaments.map((c) => c.slice(0, 7)) };
}

// Painted triangles store a hex tree of subdivisions, read from the end. Each triangle here
// takes the filament used by most of its leaves. Returns 0 when it is not painted.
function paintedFilament(code) {
  if (!code) return 0;
  const count = {};
  for (let i = code.length - 1; i >= 0; i--) {
    const n = parseInt(code[i], 16);
    if (n & 3) continue; // a split node, its children follow
    let state = n >> 2;
    if (state === 3) state = parseInt(code[--i] ?? '0', 16) + 3;
    count[state] = (count[state] || 0) + 1;
  }
  const painted = Object.keys(count).filter((s) => s !== '0').sort((a, b) => count[b] - count[a]);
  return painted.length && count[painted[0]] >= (count[0] || 0) ? +painted[0] : 0;
}

// An AMS has four slots: keep the four most used colours and send the others to the closest one.
function buildPalette(triColours) {
  const uses = new Map();
  for (const c of triColours) if (c) uses.set(c, (uses.get(c) || 0) + 1);
  const palette = [...uses.keys()].sort((a, b) => uses.get(b) - uses.get(a)).slice(0, 4);
  if (palette.length < 2) return null;
  const rgb = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const nearest = new Map();
  const slotOf = (c) => {
    if (!nearest.has(c)) {
      const a = rgb(c);
      const dist = (p) => rgb(p).reduce((s, v, i) => s + (v - a[i]) ** 2, 0);
      nearest.set(c, palette.reduce((best, p, i) => (dist(p) < dist(palette[best]) ? i : best), 0));
    }
    return nearest.get(c);
  };
  return { palette, merged: uses.size - palette.length, tri: Uint8Array.from(triColours, (c) => (c ? slotOf(c) : 0)) };
}

function parseTransform(str) {
  const m = new THREE.Matrix4();
  if (!str) return m;
  const v = str.trim().split(/\s+/).map(Number);
  if (v.length !== 12) return m;
  m.set(v[0], v[3], v[6], v[9], v[1], v[4], v[7], v[10], v[2], v[5], v[8], v[11], 0, 0, 0, 1);
  return m;
}

// Center on the bed, drop to z=0 and scale to a demo-friendly size.
export function normalizeModel(pos, maxSize = 70) {
  const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (let i = 0; i < pos.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (pos[i + k] < box.min[k]) box.min[k] = pos[i + k];
      if (pos[i + k] > box.max[k]) box.max[k] = pos[i + k];
    }
  }
  const size = box.max.map((v, k) => v - box.min[k]);
  const largest = Math.max(...size);
  const scale = largest > maxSize ? maxSize / largest : largest < 20 ? 30 / largest : 1;
  const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2, cz = box.min[2];
  const out = new Float32Array(pos.length);
  for (let i = 0; i < pos.length; i += 3) {
    out[i] = (pos[i] - cx) * scale;
    out[i + 1] = (pos[i + 1] - cy) * scale;
    out[i + 2] = (pos[i + 2] - cz) * scale;
  }
  return { positions: out, scale, size: size.map((s) => s * scale), triangles: pos.length / 9 };
}
