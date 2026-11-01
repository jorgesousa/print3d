// Multi-colour printing, the way an AMS does it: one nozzle, several spools, one colour at a time.
export const SLOT_NAMES = ['A', 'B', 'C', 'D'];
export const SWAP_TIME = 60; // seconds of real print time for one filament swap
export const PURGE_MM3 = 300; // plastic flushed through the nozzle per swap
const SAMPLE_MM = 1.5; // colour is checked this often along a path

// each stage covers a slice [from, to] of the swap move
export const SWAP_STAGES = [
  { to: 0.2, title: 'Cut', text: 'The toolhead parks over the <b>purge chute</b> and a small blade <b>cuts</b> the filament. There is only one nozzle, so one colour has to leave before the next can come in.' },
  { to: 0.4, title: 'Pull back', text: 'The AMS <b>pulls the old filament back</b> through the PTFE tube and winds it onto its spool. Nothing is wasted yet.' },
  { to: 0.6, title: 'Load', text: 'The AMS pushes the <b>next colour</b> all the way along the tube to the hotend.' },
  { to: 0.88, title: 'Purge', text: 'Old plastic is still melted inside the hotend, so the printer <b>flushes it out</b> until the colour runs clean. This waste drops down the chute. Printers call it "poop"!' },
  { to: 1, title: 'Back to work', text: 'The nozzle is wiped and the toolhead returns to exactly where it stopped.' },
];

const PATTERNS = {
  // whole layers change colour: few swaps
  stripes: { slots: 4, at: (x, y, L, maxZ) => Math.floor((L.z / maxZ) * 7.999) % 4 },
  // two colours in the same layer: at least one swap on every layer
  sides: { slots: 2, at: (x) => (x < 0 ? 0 : 1) },
};

// Tags every path with a slot, cutting paths where the colour changes. Each layer starts with
// the colour already loaded, then does one colour at a time, because slicers avoid needless swaps.
export function assignSlots(result, pattern) {
  const { at, slots, layer, freeInfill } = PATTERNS[pattern] ?? pattern;
  let loaded = -1;
  for (const L of result.layers) {
    const bySlot = Array.from({ length: slots }, () => []);
    const skirt = [], free = [];
    layer?.(L);
    for (const p of L.paths) {
      if (p.type === 0) skirt.push(p);
      else if (freeInfill && p.type === 3) free.push(p);
      else for (const piece of splitBySlot(p, (x, y) => at(x, y, L, result.maxZ))) bySlot[piece.slot].push(piece);
    }
    const order = bySlot.map((_, i) => i).filter((i) => bySlot[i].length);
    if (order.includes(loaded)) order.sort((a, b) => (b === loaded) - (a === loaded));
    const first = order[0] ?? Math.max(loaded, 0);
    loaded = order.length ? order[order.length - 1] : first;
    for (const p of [...skirt, ...free]) p.slot = first;
    L.paths = [...skirt, ...free, ...order.flatMap((i) => bySlot[i])];
  }
}

// Colours painted on the mesh: each path point takes the colour of the nearest surface in its layer.
// Sparse infill is hidden, so it stays in the loaded colour and costs no swap.
export function meshPattern(pos, triSlots, slots) {
  const nTri = pos.length / 9;
  const zMin = new Float32Array(nTri), zMax = new Float32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const a = pos[t * 9 + 2], b = pos[t * 9 + 5], c = pos[t * 9 + 8];
    zMin[t] = Math.min(a, b, c);
    zMax[t] = Math.max(a, b, c);
  }
  const byZ = Array.from({ length: nTri }, (_, t) => t).sort((a, b) => zMin[a] - zMin[b]);
  let nextTri = 0, active = [], grid = new Map();
  const CELL = 4;
  const key = (cx, cy) => cx * 100000 + cy;
  const addSample = (x, y, slot) => {
    const k = key(Math.floor(x / CELL), Math.floor(y / CELL));
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(x, y, slot);
  };
  return {
    slots,
    freeInfill: true,
    layer(L) {
      const z = L.z - L.h / 2;
      while (nextTri < nTri && zMin[byZ[nextTri]] <= z) active.push(byZ[nextTri++]);
      active = active.filter((t) => zMax[t] >= z);
      grid = new Map();
      for (const t of active) {
        const hit = [];
        for (let e = 0; e < 3; e++) {
          const a = t * 9 + e * 3, b = t * 9 + ((e + 1) % 3) * 3, za = pos[a + 2], zb = pos[b + 2];
          if ((za > z) === (zb > z)) continue;
          const k = (z - za) / (zb - za);
          hit.push(pos[a] + (pos[b] - pos[a]) * k, pos[a + 1] + (pos[b + 1] - pos[a + 1]) * k);
        }
        if (hit.length !== 4) continue;
        const n = Math.ceil(Math.hypot(hit[2] - hit[0], hit[3] - hit[1]) / SAMPLE_MM);
        for (let i = 0; i <= n; i++) addSample(hit[0] + ((hit[2] - hit[0]) * i) / n, hit[1] + ((hit[3] - hit[1]) * i) / n, triSlots[t]);
      }
    },
    at(x, y) {
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      let best = Infinity, slot = 0;
      for (let r = 0; r < 60; r++) {
        for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          const s = grid.get(key(cx + i, cy + j));
          if (!s) continue;
          for (let k = 0; k < s.length; k += 3) {
            const d = (s[k] - x) ** 2 + (s[k + 1] - y) ** 2;
            if (d < best) { best = d; slot = s[k + 2]; }
          }
        }
        // anything in a further ring is at least r cells away
        if (best < (r * CELL) ** 2) break;
      }
      return slot;
    },
  };
}

function splitBySlot(p, slotAt) {
  const { pts } = p;
  const pieces = [];
  let cur = [pts[0], pts[1]], slot = slotAt(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) {
    const px = pts[i - 2], py = pts[i - 1], x = pts[i], y = pts[i + 1];
    const steps = Math.ceil(Math.hypot(x - px, y - py) / SAMPLE_MM);
    for (let k = 1; k <= steps; k++) {
      let a = (k - 1) / steps, b = k / steps;
      const next = slotAt(px + (x - px) * b, py + (y - py) * b);
      if (next === slot) continue;
      // bisect, so both pieces meet where the colour really changes
      for (let n = 0; n < 6; n++) {
        const m = (a + b) / 2;
        if (slotAt(px + (x - px) * m, py + (y - py) * m) === slot) a = m; else b = m;
      }
      const mx = px + (x - px) * b, my = py + (y - py) * b;
      cur.push(mx, my);
      pieces.push({ ...p, pts: Float32Array.from(cur), slot });
      cur = [mx, my];
      slot = next;
    }
    cur.push(x, y);
  }
  pieces.push({ ...p, pts: Float32Array.from(cur), slot });
  return pieces;
}
