// Synthesised stepper-motor "music" and fan noise.
export function createSound() {
  let ctx, osc, osc2, filt, gain, noiseGain;
  let enabled = false;

  function init() {
    ctx = new AudioContext();
    gain = ctx.createGain();
    gain.gain.value = 0;
    filt = ctx.createBiquadFilter();
    filt.type = 'bandpass';
    filt.Q.value = 3;
    osc = ctx.createOscillator();
    osc.type = 'square';
    osc2 = ctx.createOscillator();
    osc2.type = 'sawtooth';
    osc.connect(filt);
    osc2.connect(filt);
    filt.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc2.start();

    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'lowpass';
    nf.frequency.value = 700;
    noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;
    noise.connect(nf);
    nf.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.start();
  }

  let lastClack = 0;
  return {
    // short bright noise burst ~ plastic part hitting a hard surface
    clack(strength = 1) {
      if (!ctx || !enabled) return;
      const now = ctx.currentTime;
      if (now - lastClack < 0.05) return;
      lastClack = now;
      const len = 0.09;
      const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * len), ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.012));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1800 + Math.random() * 900;
      bp.Q.value = 2.2;
      const g = ctx.createGain();
      g.gain.value = Math.min(1, strength) * 0.5;
      src.connect(bp); bp.connect(g); g.connect(ctx.destination);
      src.start(now);
    },
    setEnabled(on) {
      enabled = on;
      if (on && !ctx) init();
      if (ctx) on ? ctx.resume() : ctx.suspend();
    },
    update(speed, fan) {
      if (!ctx || !enabled) return;
      const now = ctx.currentTime;
      const f = 70 + speed * 2.6;
      osc.frequency.setTargetAtTime(f, now, 0.015);
      osc2.frequency.setTargetAtTime(f * 1.498, now, 0.015);
      filt.frequency.setTargetAtTime(300 + speed * 5, now, 0.04);
      gain.gain.setTargetAtTime(speed > 1 ? 0.03 : 0, now, 0.03);
      noiseGain.gain.setTargetAtTime(0.008 + fan * 0.04, now, 0.25);
    },
  };
}
