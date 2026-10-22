# Copilot instructions: PRINT3D

PRINT3D is a browser 3D-print simulator built with Vite, three.js, a Clipper-based slicer in a Web Worker, and an XPBD physics Inspect mode. It is part of Sousa Lab (portal: `jorgesousa/sousa-lab`, game: `jorgesousa/faultline`). It was Francisco Sousa's idea, and kids are a main audience.

**Read [`docs/DESIGN.md`](../docs/DESIGN.md) before changing the slicer, `inspect.js` or `articulate.js`.**

## Rules

- **Do not change the Flex behaviour** in `inspect.js` (`setFlex`, `setFlexAngles`, the coaxial ripple, or their amplitudes and timings) unless the owner explicitly asks. It is considered finished.
- Keep both **Float** and **Gravity** in Inspect.
- Keep the **Sousa "S" badge** on the part-cooling fan (`brandBadgeTexture()` in `src/printer.js`).
- Fixes must be **generic**. Never special-case a particular model. Anything learned from one file has to work for every upload.
- Keep 3D-printing jargon in **English**, even in Portuguese text (slicer, layer, nozzle, bed, infill, walls, skirt, G-code, PEI, print-in-place, Flex...).
- Models stay local: never upload user files anywhere.
- Captions are explanations for kids: short, accurate, friendly.
- Keep the build working under a sub-path. `vite.config.js` uses `base: './'`, and HTML must use relative paths (`./src/...`).
- Keep the slicer and articulation workers fed with the same scaled positions, because their part numbering must match.

## Commands

```bash
npm install
npm run dev       # dev server
npm run build     # must pass before pushing; main auto-deploys to GitHub Pages
npm run preview   # check the production build
```

There is no test suite. Check changes by hand using the checklist in `docs/DESIGN.md` ("Checking changes"). In dev, `window.__app` and `window.__inspector` are available for debugging.

## Style

- Plain ES modules, no framework, no TypeScript. Keep the existing style: small helpers, `const`, early returns, short comments only where the maths or physics needs explaining.
- Units are millimetres, and print space is Z-up (see the conventions in `docs/DESIGN.md`).
- Update `README.md` and `docs/DESIGN.md` when behaviour or structure changes.
