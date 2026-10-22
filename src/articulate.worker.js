import { analyseArticulation } from './articulate.js';

self.onmessage = (e) => {
  try {
    let last = 0;
    const r = analyseArticulation(e.data.positions, (p, stage) => {
      const now = performance.now();
      if (now - last > 120) { last = now; self.postMessage({ type: 'progress', p, stage }); }
    });
    self.postMessage({ type: 'done', result: r }, [r.comp.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err && err.stack || err) });
  }
};
