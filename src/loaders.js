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
  return fixWinding(pos);
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

  const out = [];
  const emit = (path, id, matrix, depth) => {
    if (depth > 16) return;
    const obj = objectsOf(path)[id];
    if (!obj) return;
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
      }
      out.push(arr);
    }
    for (const comp of obj.getElementsByTagNameNS('*', 'component')) {
      const m = matrix.clone().multiply(parseTransform(comp.getAttribute('transform')));
      emit(pathAttr(comp) || path, comp.getAttribute('objectid'), m, depth + 1);
    }
  };

  const items = [...docs[rootPath].getElementsByTagNameNS('*', 'item')];
  let used = items.filter((it) => it.getAttribute('printable') !== '0' && (!allowed || allowed.has(it.getAttribute('objectid'))));
  if (!used.length) used = items;
  for (const it of used) emit(pathAttr(it) || rootPath, it.getAttribute('objectid'), parseTransform(it.getAttribute('transform')), 0);
  return mergePositions(out);
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
