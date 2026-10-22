# PRINT3D design notes

These notes record why PRINT3D works the way it does: the decisions, the constraints and the tuning that took the most work to get right. Read them before changing the slicer, Inspect mode or the articulation analysis.

## Purpose and audience

- The project started as Francisco Sousa's question: *what actually happens inside a 3D printer?* The main audience is curious kids and makers, so every caption should explain the process simply and accurately.
- **3D-printing terms stay in English**, including in Portuguese text: slicer, slice, layer, layer height, nozzle, hotend, bed, bed leveling, first layer, infill, walls, skirt, G-code, filament, PLA, PEI, print-in-place, Flex. Makers use these words as they are, so they are not translated.
- The goal is a "wow" experience, which means cinematic cameras, bloom, sound and physics, but never at the cost of being wrong about how printing works.

## Product decisions

| Decision | Why |
|---|---|
| Users upload their own files (STL, 3MF, OBJ), with no MakerWorld/Printables integration | Simple and private: models never leave the browser. Users download from MakerWorld and drop the file in. |
| Algorithms must be generic, never tuned for one model | Fixes found with a specific model (e.g. the twisty egg) must improve every uploaded file. |
| Models are scaled to fit 70 mm (`normalizeModel`) | Keeps the print time and the scene framing reasonable. Print-in-place clearances shrink or grow with the scale. |
| **Sousa "S" badge on the part-cooling fan** | Francisco's idea: the family brand on the printer. It is a fixed, glowing "S" in the centre of the fan while the blades spin around it (`brandBadgeTexture()` in `printer.js`). Keep it. |
| **Flex must not change** | The owner's explicit request ("don't change this Flex at all, it is very good"). Treat the Flex animation and its tuning in `inspect.js` as frozen unless the owner asks. |
| **Keep both Float and Gravity** in Inspect | Float lets you turn the part in your hands and Flex it. Gravity drops and throws it. Flex is disabled while Gravity is on. |

## Pipeline

```
file ─▶ loaders.js ─▶ normalizeModel (70 mm, Z-up, centred)
                         ├─▶ slicer.worker.js     ─▶ layers / paths ─▶ toolpath.js (bead geometry) ─▶ print animation
                         └─▶ articulate.worker.js ─▶ parts + joints ─────────────────────────────────▶ inspect.js
```

- Both workers receive **the same scaled positions** (`app.model.positions`). They both call `findComponents()` from `articulate.js`, so their part numbering matches. Keep it deterministic.
- The articulation analysis runs in parallel with slicing. The "Pick it up" button shows `⏳ Checking for joints… X%` until it finishes, then Inspect starts automatically.

## Conventions

- **Units and axes:** print space is millimetres, Z-up. `printer.printSpace` is rotated −90° about X under the bed, so print `(x, y, z)` maps to world `(x, z, −y)`.
- **Inspect body frame:** Y-up and centred on the centre of mass: `(x−cx, z−cz, −(y−cy))`. Each body is a `group (p, q) → orient (rotation.x = −π/2) → mesh`.
- **Feature ids:** 0 skirt, 1 outer wall, 2 inner wall, 3 sparse infill, 4 solid infill, 5 top surface. The masks in Inspect are `MASK_ALL = 62` (everything but the skirt, which stays on the bed) and `MASK_NO_WALLS`.
- **Toolpath geometry:** indexed, 4 vertices per point and 24 indices per segment. Attributes: `position`, `normal`, `aDist`, `aType`, `aLayer`, `aPart`. The draw range grows while printing.
- **Bloom:** the bloom threshold is 1.0. Keep printer materials (e.g. the fan's accent ring) below it so only the hot nozzle, the fresh plastic and the badge glow.

## Inspect mode and physics

- **Modes:** `enter` (pop off the PEI sheet and fly to the pad), `float` (trackball turning with inertia), `physics`/grab (Gravity) and `exit` ("Put it back").
- **Solver:** XPBD (Müller et al. 2020), with substep `1/1000 s` (at most 50 per frame) and gravity −9810 mm/s².
  - Contacts are made from support points in 160 Fibonacci directions. Static friction 0.6, dynamic friction 0.45, restitution 0.38.
  - The grab is a compliant spring (`GRAB_K = 900`, damping 22). It is solved **before** the joints, and the joints get 2 iterations per substep (4 when there are sliding joints). This keeps joint separation around 0.1 mm while shaking.
  - Implementation trap: `solvePos` overwrites the temp vector `tN`, so callers must use another temp (`sArm`) for arms.
- **Picking** casts a ray against each body's support polytope, so it works for every part of an articulated model.

## Print-in-place articulation (`articulate.js`)

1. Weld vertices and run union-find to get separate shells (parts).
2. Find pairs of parts that interlock across a small clearance gap. Typical gaps are 0.15–0.25 mm.
3. For each pair, fit the rigid motion that slides the contact surface along itself. This is a "kinematic surface" fit: each contact point and normal adds a row `[x×n, n]`, and the 6×6 least-squares eigenproblem is solved with IRLS. The result is a **hinge** (rotation), **screw** (helix), **slide** (straight) or, with secondary freedom, a **ball** joint.
4. Verify the fit by voxelising the first part and moving the second until they collide. That gives the range of motion. If no slide or screw fits, the code searches hinge axes directly.
5. Joints whose range is tiny, or that overlap at rest, are fused into one part.

A closed ring of joints that all share one screw axis (`findCoaxialLoop`) can't be flexed joint by joint. It is animated as a ripple wave around the axis, with the amplitude capped.

### Reference models

These models drove the design. They are not in the repo, so download them from MakerWorld to re-test:

- **Articulated sloth** (print-in-place): 13 parts and 12 joints, mostly hinges with pins in sockets. Analysis takes about 4.5 s.
- **[Slippery / twisty egg fidget](https://makerworld.com/en/models/2443178-slippery-egg-fidget)**: 15 slats in a ring, linked by dovetails that twist with height. That makes 15 coaxial **screw** joints (pitch ≈ 81 mm/rad at 70 mm). This model is why screw/slide joints exist. Analysis dropped from 46 s to 6 s.

## Checking changes

There is no automated test suite yet. Before you push, check by hand with `npm run dev`:

1. Every demo model slices and prints, and the Cinematic, Nozzle cam and Free cameras all work.
2. At the end of a print, "Pick it up" works, along with Float/Gravity, Cut X/Y/Z, Explode, Layers and Hide walls.
3. A print-in-place model (sloth, twisty egg) shows "N linked parts", Show joints draws markers, Flex moves, and under Gravity the parts stay connected.
4. `npm run build && npm run preview` works, because Pages serves the site from `/print3d/`.

Debug helpers:
- `window.__app` always exists, and `window.__inspector` exists in dev.
- Setting the scrub slider to its maximum (`#scrub` value 999–1000) jumps to the end of a print.

## Known warnings

three.js r186 logs two harmless deprecation warnings: `THREE.Clock` → `THREE.Timer`, and `PCFSoftShadowMap` → `PCFShadowMap`.
