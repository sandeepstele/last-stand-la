// OWNER: builder G (audio). Procedural one-shot sounds: oscillators, pre-made noise buffers, filters and gains only.
// Every sound is a handful of short-lived nodes under one "voice" gain that is disconnected when the sound ends.
// Works on any BaseAudioContext, so the dev probe can render a sound offline and measure it.

export type Noise = { white: AudioBuffer; brown: AudioBuffer; crackle: AudioBuffer };

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/** Made once per AudioContext (a few seconds of mono noise each). */
export function makeNoise(ac: BaseAudioContext): Noise {
  const sr = ac.sampleRate;
  const white = ac.createBuffer(1, Math.floor(sr * 2), sr);
  const w = white.getChannelData(0);
  for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;

  // Brown noise with a seamless loop: generate past the end and cross-fade the overshoot into the start.
  const n = Math.floor(sr * 4);
  const fadeN = Math.floor(sr * 0.25);
  const gen = new Float32Array(n + fadeN);
  let last = 0;
  for (let i = 0; i < gen.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    gen[i] = last * 3.5;
  }
  const brown = ac.createBuffer(1, n, sr);
  const b = brown.getChannelData(0);
  for (let i = 0; i < n; i++) b[i] = gen[i];
  for (let i = 0; i < fadeN; i++) {
    const t = i / fadeN;
    b[i] = gen[i] * t + gen[n + i] * (1 - t);
  }

  // Radio crackle: thin hiss plus sparse pops.
  const crackle = ac.createBuffer(1, Math.floor(sr * 2), sr);
  const c = crackle.getChannelData(0);
  for (let i = 0; i < c.length; i++) c[i] = (Math.random() * 2 - 1) * 0.22;
  for (let k = 0; k < 110; k++) {
    const len = 16 + Math.floor(Math.random() * 220);
    const at = Math.floor(Math.random() * (c.length - len - 1));
    const amp = 0.3 + Math.random() * 0.7;
    for (let j = 0; j < len; j++) c[at + j] += (Math.random() * 2 - 1) * amp * (1 - j / len);
  }
  return { white, brown, crackle };
}

export type Sfx = ReturnType<typeof createSfx>;

export function createSfx(ac: BaseAudioContext, noise: Noise) {
  const MAX_VOICES = 56;
  let voices = 0;

  /** The output gain of one sound, optionally panned. Null when too many sounds are playing (skip it). */
  function voice(dest: AudioNode, end: number, pan = 0, priority = false): GainNode | null {
    if (!priority && voices >= MAX_VOICES) return null;
    const g = ac.createGain();
    g.gain.value = 0;
    if (pan && typeof ac.createStereoPanner === "function") {
      const p = ac.createStereoPanner();
      p.pan.value = clamp(pan, -0.9, 0.9);
      g.connect(p);
      p.connect(dest);
    } else g.connect(dest);
    voices++;
    setTimeout(() => {
      voices--;
      try {
        g.disconnect();
      } catch {
        /* already gone */
      }
    }, Math.max(0, end - ac.currentTime) * 1000 + 250);
    return g;
  }

  /** Envelope on a gain param: attack to peak, optional hold, exponential release. */
  function env(p: AudioParam, t: number, a: number, peak: number, hold: number, r: number, linearAttack = false) {
    const pk = Math.max(0.0002, peak);
    p.setValueAtTime(0.0001, t);
    if (linearAttack) p.linearRampToValueAtTime(pk, t + a);
    else p.exponentialRampToValueAtTime(pk, t + a);
    if (hold > 0) p.setValueAtTime(pk, t + a + hold);
    p.exponentialRampToValueAtTime(0.0001, t + a + hold + r);
  }

  function gain(v: number, out: AudioNode): GainNode {
    const g = ac.createGain();
    g.gain.value = v;
    g.connect(out);
    return g;
  }

  function filter(type: BiquadFilterType, f: number, q: number, out: AudioNode): BiquadFilterNode {
    const b = ac.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.connect(out);
    return b;
  }

  function noiseSrc(buf: AudioBuffer, t: number, dur: number, out: AudioNode, rate = 1): AudioBufferSourceNode {
    const s = ac.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.connect(out);
    s.start(t, Math.random() * buf.duration * 0.9);
    s.stop(t + dur);
    return s;
  }

  /** A modulation depth into a param (LFOs). */
  function mod(depth: number, p: AudioParam): GainNode {
    const g = ac.createGain();
    g.gain.value = depth;
    g.connect(p);
    return g;
  }

  function osc(type: OscillatorType, f: number, t: number, dur: number, out: AudioNode | null): OscillatorNode {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (out) o.connect(out);
    o.start(t);
    o.stop(t + dur);
    return o;
  }

  /** A sine/triangle "thump" with a pitch drop. */
  function thump(out: AudioNode, t: number, f0: number, f1: number, dur: number, level: number, type: OscillatorType = "sine") {
    const g = gain(0, out);
    env(g.gain, t, 0.004, level, 0, dur);
    const o = osc(type, f0, t, dur + 0.05, g);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  }

  /** A short filtered noise burst. */
  function burst(out: AudioNode, t: number, dur: number, level: number, type: BiquadFilterType, f: number, q = 1, buf = noise.white) {
    const g = gain(0, out);
    env(g.gain, t, 0.002, level, 0, dur);
    noiseSrc(buf, t, dur + 0.03, filter(type, f, q, g));
  }

  const now = () => ac.currentTime + 0.015;

  return {
    get voices() {
      return voices;
    },

    // ---------------------------------------------------------------- zombies
    /** One groan: a formant-filtered sawtooth with vibrato jitter plus breathy band-passed noise. */
    groan(dest: AudioNode, level: number, pan = 0, pitch = 1) {
      const t = now();
      const dur = rnd(0.7, 1.5);
      const v = voice(dest, t + dur, pan);
      if (!v) return;
      env(v.gain, t, rnd(0.12, 0.3), level, dur * 0.35, dur * 0.5, true);
      const f = rnd(68, 118) * pitch;
      const o = osc("sawtooth", f * rnd(1.05, 1.2), t, dur + 0.1, null);
      o.frequency.linearRampToValueAtTime(f * rnd(0.7, 0.9), t + dur);
      osc("sine", rnd(4, 11), t, dur + 0.1, mod(f * rnd(0.03, 0.09), o.frequency));
      const lp = filter("lowpass", 1700, 0.7, v);
      o.connect(filter("bandpass", rnd(380, 650), 5, gain(3.2, lp)));
      o.connect(filter("bandpass", rnd(850, 1250), 7, gain(1.6, lp)));
      noiseSrc(noise.white, t, dur + 0.1, filter("bandpass", rnd(450, 800), 1.4, gain(0.6, lp)));
    },

    /** A distant horde swelling in: low layered voices and rumble. */
    horde(dest: AudioNode, level: number, pan = 0, dur = 3.6) {
      const t = now();
      const v = voice(dest, t + dur, pan, true);
      if (!v) return;
      env(v.gain, t, dur * 0.4, level, dur * 0.2, dur * 0.4, true);
      const lp = filter("lowpass", 720, 0.7, v);
      noiseSrc(noise.brown, t, dur + 0.1, filter("bandpass", 260, 0.9, gain(1.4, lp)));
      for (let i = 0; i < 6; i++) {
        const f = rnd(58, 115);
        const o = osc("sawtooth", f, t, dur + 0.1, filter("bandpass", rnd(380, 620), 3, gain(0.3, lp)));
        o.frequency.linearRampToValueAtTime(f * rnd(0.8, 1.05), t + dur);
        osc("sine", rnd(3, 8), t, dur + 0.1, mod(f * 0.06, o.frequency));
      }
    },

    // ---------------------------------------------------------------- player
    step(dest: AudioNode, level: number, pan = 0, sprint = false) {
      const t = now();
      const dur = sprint ? 0.07 : 0.09;
      const v = voice(dest, t + dur + 0.05, pan);
      if (!v) return;
      v.gain.value = level;
      burst(v, t, dur, 0.9, "lowpass", rnd(450, 900), 0.8);
      burst(v, t, 0.03, 0.15, "highpass", 3200, 0.7);
      thump(v, t, rnd(90, 115), 50, 0.07, 0.6);
    },

    heartbeat(dest: AudioNode, level: number) {
      const t = now();
      const v = voice(dest, t + 0.45, 0, true);
      if (!v) return;
      v.gain.value = level;
      const lp = filter("lowpass", 320, 0.7, v);
      thump(lp, t, 62, 40, 0.14, 0.8);
      thump(lp, t, 120, 70, 0.1, 0.7, "triangle");
      thump(lp, t + 0.17, 56, 38, 0.16, 0.55);
      thump(lp, t + 0.17, 108, 64, 0.11, 0.5, "triangle");
    },

    /** One breath (in or out) when out of stamina. */
    breath(dest: AudioNode, level: number, out: boolean) {
      const t = now();
      const dur = out ? 0.42 : 0.34;
      const v = voice(dest, t + dur);
      if (!v) return;
      env(v.gain, t, dur * 0.45, level, 0, dur * 0.55, true);
      noiseSrc(noise.white, t, dur + 0.05, filter("bandpass", out ? 900 : 1500, 0.9, filter("lowpass", 3000, 0.7, gain(2.2, v))));
    },

    whoosh(dest: AudioNode, level: number) {
      const t = now();
      const dur = 0.34;
      const v = voice(dest, t + dur, 0, true);
      if (!v) return;
      env(v.gain, t, 0.07, level, 0, dur - 0.07, true);
      const bp = filter("bandpass", 350, 1.1, gain(2.5, v));
      bp.frequency.setValueAtTime(350, t);
      bp.frequency.exponentialRampToValueAtTime(2300, t + 0.12);
      bp.frequency.exponentialRampToValueAtTime(500, t + dur);
      noiseSrc(noise.white, t, dur + 0.05, bp);
    },

    hit(dest: AudioNode, level: number, pan = 0) {
      const t = now();
      const v = voice(dest, t + 0.4, pan * 0.4, true);
      if (!v) return;
      v.gain.value = level;
      thump(v, t, 115, 38, 0.24, 1);
      burst(v, t, 0.1, 0.6, "lowpass", 900, 0.7);
      // A short grunt: a falling sawtooth through two vowel formants.
      const g = gain(0, v);
      env(g.gain, t + 0.02, 0.02, 0.5, 0.06, 0.14);
      const o = osc("sawtooth", 160, t + 0.02, 0.26, null);
      o.frequency.exponentialRampToValueAtTime(100, t + 0.24);
      o.connect(filter("bandpass", 640, 3, g));
      o.connect(filter("bandpass", 1120, 5, gain(0.6, g)));
    },

    downed(dest: AudioNode, level: number) {
      const t = now();
      const dur = 2.2;
      const v = voice(dest, t + dur, 0, true);
      if (!v) return;
      env(v.gain, t, 0.05, level, 0.6, dur - 0.65);
      const lp = filter("lowpass", 1500, 1.2, v);
      lp.frequency.setValueAtTime(1500, t);
      lp.frequency.exponentialRampToValueAtTime(90, t + dur);
      noiseSrc(noise.brown, t, dur + 0.05, gain(1.2, lp));
      const o = osc("sawtooth", 82, t, dur + 0.05, gain(0.5, lp));
      o.frequency.exponentialRampToValueAtTime(38, t + dur);
    },

    // ---------------------------------------------------------------- world events
    siren(dest: AudioNode, level: number, pan = 0) {
      const t = now();
      const dur = 2;
      const v = voice(dest, t + dur + 1, pan, true);
      if (!v) return;
      env(v.gain, t, 0.25, level, 1.15, 0.6, true);
      const lp = filter("lowpass", 2200, 0.7, v);
      // Distance: a short echo.
      const dl = ac.createDelay(1);
      dl.delayTime.value = 0.23;
      const fb = gain(0.32, dl);
      dl.connect(fb);
      dl.connect(gain(0.5, v));
      const bp = filter("bandpass", 900, 0.6, lp);
      bp.connect(dl);
      for (const det of [1, 1.006]) {
        const o = osc("triangle", 520 * det, t, dur + 0.05, bp);
        o.frequency.linearRampToValueAtTime(900 * det, t + 0.95);
        o.frequency.linearRampToValueAtTime(560 * det, t + dur);
      }
    },

    crash(dest: AudioNode, level: number, pan = 0) {
      const t = now();
      const v = voice(dest, t + 1, pan * 0.5, true);
      if (!v) return;
      v.gain.value = level;
      const lp = filter("lowpass", 5000, 0.7, v);
      lp.frequency.setValueAtTime(5000, t);
      lp.frequency.exponentialRampToValueAtTime(380, t + 0.8);
      const g = gain(0, lp);
      env(g.gain, t, 0.003, 0.9, 0.05, 0.75);
      noiseSrc(noise.white, t, 0.9, g);
      thump(v, t, 72, 28, 0.5, 1);
      for (let i = 0; i < 7; i++) burst(v, t + rnd(0.02, 0.4), rnd(0.02, 0.05), rnd(0.2, 0.5), "bandpass", rnd(1800, 5000), 4);
    },

    /** Hammer knocks (boards going up). */
    knocks(dest: AudioNode, level: number, n = 3) {
      const t0 = now();
      const v = voice(dest, t0 + n * 0.3 + 0.2, 0, true);
      if (!v) return;
      v.gain.value = level;
      let t = t0;
      for (let i = 0; i < n; i++) {
        burst(v, t, 0.035, 1, "bandpass", rnd(1500, 1900), 3);
        thump(v, t, rnd(240, 280), 150, 0.07, 0.7, "triangle");
        t += rnd(0.19, 0.28);
      }
    },

    /** Zombies hammering on the barricaded door. */
    bang(dest: AudioNode, level: number, pan = 0) {
      const t = now();
      const v = voice(dest, t + 0.45, pan);
      if (!v) return;
      v.gain.value = level;
      thump(v, t, rnd(80, 95), 44, 0.28, 1);
      burst(v, t, 0.18, 0.8, "lowpass", 620, 0.8);
      burst(v, t + 0.03, 0.12, 0.3, "bandpass", rnd(1000, 1400), 6);
    },

    splinter(dest: AudioNode, level: number) {
      const t = now();
      const v = voice(dest, t + 0.9, 0, true);
      if (!v) return;
      v.gain.value = level;
      burst(v, t, 0.04, 1, "highpass", 1600, 0.8);
      thump(v, t, 95, 35, 0.35, 0.8);
      for (let i = 0; i < 11; i++) burst(v, t + rnd(0.02, 0.55), rnd(0.008, 0.03), rnd(0.25, 0.7), "bandpass", rnd(1500, 5200), rnd(3, 9));
    },

    /** Aftershock rumble: brown noise and sub tones with a rolling tremor. amp ~0.1 .. 0.6. */
    rumble(dest: AudioNode, amp: number, secs: number) {
      const t = now();
      const dur = clamp(secs, 0.8, 12);
      const level = clamp(0.3 + amp * 1.1, 0.3, 0.95);
      const v = voice(dest, t + dur + 0.1, 0, true);
      if (!v) return;
      const rel = Math.max(0.8, dur * 0.35);
      env(v.gain, t, 0.35, level, Math.max(0, dur - 0.35 - rel), rel, true);
      const trem = gain(1, v);
      osc("sine", rnd(3.5, 5.5), t, dur + 0.1, mod(0.35, trem.gain));
      const lp = filter("lowpass", 160, 0.8, trem);
      noiseSrc(noise.brown, t, dur + 0.1, gain(0.8, lp), 0.7);
      osc("sine", 34, t, dur + 0.1, gain(0.25, lp));
      osc("sine", 47, t, dur + 0.1, gain(0.2, lp));
      noiseSrc(noise.brown, t, dur + 0.1, filter("bandpass", 240, 0.9, gain(0.9, trem)));
      noiseSrc(noise.white, t, dur + 0.1, filter("bandpass", rnd(500, 700), 1.2, gain(0.07, trem)));
    },

    crack(dest: AudioNode, level: number) {
      const t = now();
      const v = voice(dest, t + 0.8, 0, true);
      if (!v) return;
      v.gain.value = level;
      burst(v, t, 0.03, 1, "highpass", 1800, 0.7);
      burst(v, t + 0.07, 0.025, 0.5, "highpass", 2400, 0.7);
      thump(v, t, 90, 32, 0.38, 0.7);
      burst(v, t + 0.05, 0.6, 0.12, "bandpass", 3000, 1.2);
    },

    /** Falling debris: knocks and rattles scattered across the stereo field. */
    clatter(dest: AudioNode, level: number, secs = 2.5) {
      const t0 = now();
      const n = 18;
      for (let i = 0; i < n; i++) {
        const t = t0 + Math.pow(Math.random(), 1.4) * secs;
        const v = voice(dest, t + 0.1, rnd(-0.8, 0.8));
        if (!v) return;
        v.gain.value = level * rnd(0.3, 1);
        burst(v, t, rnd(0.02, 0.06), 1, "bandpass", rnd(700, 4200), rnd(3, 10));
        if (Math.random() < 0.35) thump(v, t, rnd(120, 200), 60, 0.08, 0.6);
      }
    },

    // ---------------------------------------------------------------- missions
    chime(dest: AudioNode, level: number, notes: number[], gap = 0.09, decay = 0.4) {
      const t0 = now();
      const v = voice(dest, t0 + notes.length * gap + decay + 0.1, 0, true);
      if (!v) return;
      v.gain.value = level;
      notes.forEach((f, i) => {
        const t = t0 + i * gap;
        const g = gain(0, v);
        env(g.gain, t, 0.006, 1, 0, decay);
        osc("sine", f, t, decay + 0.05, g);
        osc("sine", f * 2, t, decay + 0.05, gain(0.18, g));
      });
    },

    blip(dest: AudioNode, level: number) {
      const t = now();
      const v = voice(dest, t + 0.25, 0, true);
      if (!v) return;
      v.gain.value = level;
      const lp = filter("lowpass", 2800, 0.7, v);
      [700, 1050].forEach((f, i) => {
        const g = gain(0, lp);
        env(g.gain, t + i * 0.08, 0.004, 0.6, 0.03, 0.05);
        const o = osc("square", f, t + i * 0.08, 0.1, g);
        o.frequency.exponentialRampToValueAtTime(f * 1.3, t + i * 0.08 + 0.07);
      });
    },

    lowTone(dest: AudioNode, level: number) {
      const t = now();
      const v = voice(dest, t + 1.1, 0, true);
      if (!v) return;
      env(v.gain, t, 0.03, level, 0.2, 0.8);
      const o = osc("triangle", 220, t, 1.1, filter("lowpass", 900, 0.7, v));
      o.frequency.exponentialRampToValueAtTime(110, t + 1);
    },

    /** Dawn: a gentle rising chord through an opening filter. */
    sting(dest: AudioNode, level: number) {
      const t0 = now();
      const notes = [196, 293.66, 392, 493.88, 587.33];
      const end = t0 + notes.length * 0.16 + 4.2;
      const v = voice(dest, end, 0, true);
      if (!v) return;
      v.gain.value = level;
      const lp = filter("lowpass", 500, 0.8, v);
      lp.frequency.setValueAtTime(500, t0);
      lp.frequency.exponentialRampToValueAtTime(3400, t0 + 2.2);
      notes.forEach((f, i) => {
        const t = t0 + i * 0.16;
        const g = gain(0, lp);
        env(g.gain, t, 0.4, 0.22, 1.2 - i * 0.12, 2.6, true);
        osc("triangle", f, t, 4.4, g);
        osc("sine", f * 1.003, t, 4.4, gain(0.6, g));
      });
    },

    // ---------------------------------------------------------------- radio
    squelch(dest: AudioNode, level: number, open: boolean) {
      const t = now();
      const dur = open ? 0.09 : 0.13;
      const v = voice(dest, t + dur + 0.1, 0, true);
      if (!v) return;
      v.gain.value = level;
      burst(filter("highpass", 600, 0.7, v), t, dur, 1.4, "bandpass", 1800, 0.9);
      if (!open) {
        const g = gain(0, v);
        env(g.gain, t, 0.003, 0.25, 0.04, 0.02);
        osc("sine", 1250, t, 0.08, g);
      }
    },

    /** An alert two-tone ahead of a warning line. */
    alert(dest: AudioNode, level: number) {
      const t = now();
      const v = voice(dest, t + 0.4, 0, true);
      if (!v) return;
      v.gain.value = level;
      [988, 784].forEach((f, i) => {
        const g = gain(0, filter("lowpass", 3000, 0.7, v));
        env(g.gain, t + i * 0.13, 0.005, 0.5, 0.07, 0.04);
        osc("square", f, t + i * 0.13, 0.13, g);
      });
    },

    // ---------------------------------------------------------------- dawn
    bird(dest: AudioNode, level: number, pan = 0) {
      const t0 = now();
      const n = 2 + Math.floor(Math.random() * 3);
      const v = voice(dest, t0 + n * 0.1 + 0.1, pan);
      if (!v) return;
      v.gain.value = level;
      const base = rnd(2400, 3600);
      for (let i = 0; i < n; i++) {
        const t = t0 + i * rnd(0.08, 0.11);
        const g = gain(0, v);
        env(g.gain, t, 0.008, 1, 0.02, 0.04);
        const o = osc("sine", base, t, 0.08, g);
        o.frequency.exponentialRampToValueAtTime(base * rnd(1.25, 1.45), t + 0.035);
        o.frequency.exponentialRampToValueAtTime(base * rnd(0.9, 1.05), t + 0.07);
      }
    },
  };
}
