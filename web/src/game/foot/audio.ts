// OWNER: builder G (audio). Procedural WebAudio (no asset files) and the spoken radio (local speechSynthesis voices).
// Starts only after the first user gesture (headless runs stay silent). [V] toggles mute. LISTENS to the bus only:
// never emits, never touches agent inputs or timing. update(dt) only moves gains and schedules short one-shots.
//
// Graph:  ambience + zombies -> outside (low-pass when indoors) ┐
//         sfx, radio squelch, crackle ─────────────────────────┴-> master (0.7 / 0) -> compressor -> muffle -> out

import { SECTOR_DEG, dirOf, type FootCtx, type System } from "./engine";
import { createRadio, sayable } from "./audioRadio";
import { createSfx, makeNoise, type Noise, type Sfx } from "./audioSynth";

const MASTER = 0.7;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

type Graph = {
  ac: AudioContext;
  noise: Noise;
  sfx: Sfx;
  master: GainNode;
  muffle: BiquadFilterNode;
  outsideLP: BiquadFilterNode;
  amb: GainNode; // ambience bus (ducked under the radio)
  zom: GainNode; // zombie bus (lightly ducked)
  fx: GainNode; // one-shots
  hum: GainNode;
  wind: GainNode;
  windBP: BiquadFilterNode;
  whistle: GainNode;
  pad: GainNode;
  tension: GainNode;
  crackle: GainNode;
  stop(): void;
};

function buildGraph(ac: AudioContext): Graph {
  const noise = makeNoise(ac);
  const sfx = createSfx(ac, noise);
  const t = ac.currentTime;
  const sources: AudioScheduledSourceNode[] = [];
  const g = (v: number, out: AudioNode | AudioParam) => {
    const n = ac.createGain();
    n.gain.value = v;
    if (out instanceof AudioNode) n.connect(out);
    else n.connect(out);
    return n;
  };
  const f = (type: BiquadFilterType, freq: number, q: number, out: AudioNode) => {
    const b = ac.createBiquadFilter();
    b.type = type;
    b.frequency.value = freq;
    b.Q.value = q;
    b.connect(out);
    return b;
  };
  const loop = (buf: AudioBuffer, out: AudioNode, rate = 1) => {
    const s = ac.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.connect(out);
    s.start(t, Math.random() * buf.duration);
    sources.push(s);
  };
  const tone = (type: OscillatorType, freq: number, out: AudioNode | AudioParam) => {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (out instanceof AudioNode) o.connect(out);
    else o.connect(out);
    o.start(t);
    sources.push(o);
    return o;
  };

  const muffle = ac.createBiquadFilter();
  muffle.type = "lowpass";
  muffle.frequency.value = 20000;
  muffle.Q.value = 0.7;
  muffle.connect(ac.destination);
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;
  comp.connect(muffle);
  const master = g(MASTER, comp);

  const outsideLP = f("lowpass", 18000, 0.7, master);
  const amb = g(0, outsideLP); // fades in after unlock
  const zom = g(1, outsideLP);
  const fx = g(1, master);

  // City hum: distant low rumble plus faint mains hum.
  const hum = g(0, amb);
  loop(noise.brown, f("lowpass", 170, 0.7, g(1.1, hum)), 0.6);
  tone("sine", 60, g(0.05, hum));
  tone("sine", 120, g(0.025, hum));

  // Wind: band-passed noise, its band and level drifting on slow LFOs; a thin whistle on top at night.
  const wind = g(0, amb);
  const windLfoGain = g(1, wind);
  tone("sine", 0.11, g(0.4, windLfoGain.gain));
  const windBP = f("bandpass", 650, 1.1, windLfoGain);
  tone("sine", 0.07, g(260, windBP.frequency));
  loop(noise.white, windBP);
  const whistle = g(0, amb);
  const whBP = f("bandpass", 1350, 9, whistle);
  tone("sine", 0.05, g(320, whBP.frequency));
  loop(noise.white, whBP, 0.9);

  // Dawn pad: a soft G major chord.
  const pad = g(0, amb);
  const padLP = f("lowpass", 1300, 0.7, pad);
  [196, 246.94, 293.66, 392].forEach((hz, i) => {
    tone(i % 2 ? "sine" : "triangle", hz * (1 + (i - 1.5) * 0.0015), g(0.25, padLP));
  });
  tone("sine", 0.09, g(0.004, pad.gain)); // a slow shimmer

  // Tension drone under chases, waves and the defence: detuned saws (A2/E3, audible on laptop speakers), slow tremolo.
  const tension = g(0, amb);
  const tenTrem = g(1, tension);
  tone("sine", 0.23, g(0.35, tenTrem.gain));
  const tenLP = f("lowpass", 520, 1.2, tenTrem);
  tone("sine", 0.06, g(180, tenLP.frequency));
  [110, 110.7, 164.8, 82.4].forEach((hz) => tone("sawtooth", hz, g(0.22, tenLP)));

  // Radio crackle bed (not ducked, not muffled indoors).
  const crackle = g(0, master);
  loop(noise.crackle, f("bandpass", 2300, 0.7, crackle));

  return {
    ac, noise, sfx, master, muffle, outsideLP, amb, zom, fx, hum, wind, windBP, whistle, pad, tension, crackle,
    stop() {
      sources.forEach((s) => {
        try {
          s.stop();
        } catch {
          /* already stopped */
        }
      });
    },
  };
}

/** Stereo pan (-1 left .. 1 right) of a world point as heard by the player. */
/** Groans start when the nearest zombie is this close (m); the horde swell and breach groans need one within HORDE_EAR_M. */
const GROAN_M = 15;
const HORDE_EAR_M = 40;

function panOf(ctx: FootCtx, x: number, z: number): number {
  const p = ctx.player;
  const dx = x - p.x;
  const dz = z - p.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.5) return 0;
  // Right of the facing (yaw clockwise from north): (cos yaw, sin yaw).
  return clamp((dx * Math.cos(p.yaw) + dz * Math.sin(p.yaw)) / d, -0.85, 0.85);
}

// ---------------------------------------------------------------- dev probe: render a sound offline and measure it
const PROBES: Record<string, (s: Sfx, d: AudioNode) => void> = {
  groan: (s, d) => s.groan(d, 0.4, 0.3),
  horde: (s, d) => s.horde(d, 0.4, -0.5, 3.8),
  step: (s, d) => s.step(d, 0.22),
  heartbeat: (s, d) => s.heartbeat(d, 0.6),
  whoosh: (s, d) => s.whoosh(d, 0.32),
  breath: (s, d) => s.breath(d, 0.12, true),
  hit: (s, d) => s.hit(d, 0.55, 0.5),
  downed: (s, d) => s.downed(d, 0.55),
  siren: (s, d) => s.siren(d, 0.09),
  crash: (s, d) => s.crash(d, 0.6),
  knocks: (s, d) => s.knocks(d, 0.45),
  bang: (s, d) => s.bang(d, 0.5),
  splinter: (s, d) => s.splinter(d, 0.7),
  rumble: (s, d) => s.rumble(d, 0.4, 3),
  crack: (s, d) => s.crack(d, 0.8),
  clatter: (s, d) => s.clatter(d, 0.4, 3),
  chime: (s, d) => s.chime(d, 0.22, [880, 1318.5]),
  blip: (s, d) => s.blip(d, 0.2),
  lowTone: (s, d) => s.lowTone(d, 0.3),
  sting: (s, d) => s.sting(d, 0.35),
  squelch: (s, d) => s.squelch(d, 0.32, true),
  alert: (s, d) => s.alert(d, 0.16),
  bird: (s, d) => s.bird(d, 0.1),
};

async function probe(name: string) {
  const sr = 44100;
  const off = new OfflineAudioContext(2, sr * 5, sr);
  if (name === "night" || name === "dawn") {
    const a = buildGraph(off as unknown as AudioContext);
    const dawn = name === "dawn";
    a.amb.gain.value = 1;
    a.hum.gain.value = dawn ? 0.05 : 0.1;
    a.wind.gain.value = dawn ? 0.025 : 0.11;
    a.whistle.gain.value = dawn ? 0 : 0.03;
    a.pad.gain.value = dawn ? 0.06 : 0;
    if (name === "night") a.tension.gain.value = 0.05;
  } else {
    const f = PROBES[name];
    if (!f) return { error: `unknown; try ${Object.keys(PROBES).join(", ")}, night, dawn` };
    f(createSfx(off, makeNoise(off)), off.destination);
  }
  const buf = await off.startRendering();
  let peak = 0, sum = 0, n = 0, nan = false, last = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      if (!Number.isFinite(v)) nan = true;
      const av = Math.abs(v);
      if (av > peak) peak = av;
      if (av > 0.001) last = Math.max(last, i / sr);
      sum += v * v;
      n++;
    }
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { name, peak: r3(peak), rms: r3(Math.sqrt(sum / n)), audibleUntil: r3(last), nan };
}

export function createAudio(ctx: FootCtx): System {
  let A: Graph | null = null;
  let muted = false;
  let unlockedFor = 0; // seconds since unlock (ambience fade-in)
  let paramT = 0;
  let stepT = 0.3;
  let stepSide = 1;
  let heartT = 0;
  let groanT = 1.5;
  let bangT = 0.8;
  let birdT = 1;
  let breathT = 0;
  let breathOut = false;
  let lastWave = -99;
  let defending = false;
  let ducked = false;
  let downedUntil = 0;
  let lastHit = { at: -99, pan: 0 };
  let lastShake = -99;
  let lastHammer = -99;
  let lastSting = -99;
  let resetAt = -99;
  let lastX = ctx.player.x;
  let lastZ = ctx.player.z;
  const disposers: (() => void)[] = [];

  // ---------------------------------------------------------------- toast ("SOUND ON / MUTED (V)")
  let toast: HTMLDivElement | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function showToast(text: string) {
    const host = ctx.renderer.domElement.parentElement;
    if (!host) return;
    if (!toast) {
      toast = document.createElement("div");
      Object.assign(toast.style, {
        position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)", padding: "3px 9px",
        borderRadius: "3px", background: "rgba(12,12,13,.6)", color: "rgba(244,241,234,.85)", font: "500 13px/1.5 var(--font-ui), \"IBM Plex Sans Condensed\", sans-serif",
        pointerEvents: "none", zIndex: "40", opacity: "0", transition: "opacity .3s",
      } satisfies Partial<CSSStyleDeclaration>);
      toast.setAttribute("aria-live", "polite");
      host.appendChild(toast);
    }
    toast.textContent = text;
    toast.style.opacity = "1";
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (toast) toast.style.opacity = "0";
    }, 1700);
  }

  // ---------------------------------------------------------------- radio
  const radio = createRadio({
    open(it) {
      if (!A || muted) return;
      const t = A.ac.currentTime;
      if (it.tone === "warn") A.sfx.alert(A.fx, 0.16);
      A.sfx.squelch(A.fx, 0.32, true);
      A.crackle.gain.setTargetAtTime(0.045, t + 0.05, 0.05);
      ducked = true;
      applyDuck(t);
    },
    close() {
      if (!A) return;
      const t = A.ac.currentTime;
      if (!muted) A.sfx.squelch(A.fx, 0.26, false);
      A.crackle.gain.setTargetAtTime(0, t + 0.08, 0.06);
      ducked = false;
      applyDuck(t);
    },
  });

  function applyDuck(t: number) {
    if (!A) return;
    A.amb.gain.setTargetAtTime((ducked ? 0.45 : 1) * Math.min(1, unlockedFor / 3), t, 0.12);
    A.zom.gain.setTargetAtTime(ducked ? 0.8 : 1, t, 0.12);
  }

  // ---------------------------------------------------------------- unlock + mute
  function unlock() {
    if (A) {
      if (A.ac.state === "suspended" && !muted) A.ac.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      const ac = new AC({ latencyHint: "interactive" });
      A = buildGraph(ac);
      ac.resume().catch(() => {});
      showToast("Sound on · V to mute");
    } catch (e) {
      console.warn("[foot] audio unavailable", e);
      A = null;
    }
  }

  function setMuted(m: boolean) {
    muted = m;
    if (A) A.master.gain.setTargetAtTime(m ? 0 : MASTER, A.ac.currentTime, 0.04);
    if (m) radio.cancel();
    showToast(m ? "Sound off · V to turn on" : "Sound on · V to mute");
  }

  const typing = (t: EventTarget | null) => {
    const el = t as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  };
  const onKey = (e: KeyboardEvent) => {
    unlock();
    if (e.code === "KeyV" && !e.repeat && !typing(e.target)) setMuted(!muted);
  };
  const onPointer = () => unlock();
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("mousedown", onPointer, true);
  disposers.push(() => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("mousedown", onPointer, true);
  });

  // ---------------------------------------------------------------- bus (listen only)
  /** Run f with the graph when sound is on; otherwise skip. */
  const live = (f: (a: Graph) => void) => {
    if (A && !muted && A.ac.state === "running") f(A);
  };
  const on = disposers.push.bind(disposers);
  const bus = ctx.bus;

  on(bus.on("player:shove", () => live((a) => a.sfx.whoosh(a.fx, 0.32))));
  on(bus.on("player:hit", (e) => {
    const pan = panOf(ctx, e.fromX, e.fromZ);
    lastHit = { at: ctx.time, pan };
    live((a) => {
      a.sfx.hit(a.fx, clamp(0.45 + e.damage * 0.02, 0.45, 0.75), pan);
      a.sfx.groan(a.zom, 0.3, pan, 1.15);
    });
  }));
  on(bus.on("player:downed", () => live((a) => {
    a.sfx.downed(a.fx, 0.55);
    const t = a.ac.currentTime;
    const m = a.muffle.frequency;
    m.cancelScheduledValues(t);
    m.setValueAtTime(Math.max(300, m.value), t);
    m.exponentialRampToValueAtTime(320, t + 0.6);
    m.setValueAtTime(320, t + 2.4);
    m.exponentialRampToValueAtTime(20000, t + 3.6);
    downedUntil = ctx.time + 3.7;
  })));
  on(bus.on("wave:start", () => (lastWave = ctx.time)));
  on(bus.on("wave:start", (e) => live((a) => {
    const d = dirOf(SECTOR_DEG[e.sector] ?? 0);
    const pan = panOf(ctx, ctx.player.x + d[0] * 100, ctx.player.z + d[1] * 100);
    // the horde swell only when zombies are actually close; the siren is the wave's cue from anywhere
    if (Number.isFinite(ctx.horde.nearest) && ctx.horde.nearest < HORDE_EAR_M) a.sfx.horde(a.zom, clamp(0.3 + (e.size || 0) / 400, 0.3, 0.55), pan, 3.8);
    a.sfx.siren(a.fx, 0.09, pan * 0.5);
  })));
  on(bus.on("wave:breach", (e) => live((a) => {
    const pan = panOf(ctx, e.x, e.z);
    a.sfx.crash(a.fx, 0.6, pan);
    if (Math.hypot(e.x - ctx.player.x, e.z - ctx.player.z) > HORDE_EAR_M) return; // groans only from a breach you're near
    for (let i = 0; i < 3; i++) setTimeout(() => live((b) => b.sfx.groan(b.zom, 0.35, pan + rnd(-0.3, 0.3), rnd(0.9, 1.2))), 150 + i * 220);
  })));
  const hammer = () => {
    if (ctx.time - lastHammer < 0.8) return;
    lastHammer = ctx.time;
    live((a) => a.sfx.knocks(a.fx, 0.45, 3 + Math.floor(Math.random() * 2)));
  };
  on(bus.on("world:barricade", (e) => {
    if (e.pid) hammer();
  }));
  on(bus.on("mission:defend", () => {
    defending = true;
    bangT = 2;
    hammer();
  }));
  on(bus.on("mission:defend-end", () => (defending = false)));
  on(bus.on("mission:barricade-broken", () => live((a) => a.sfx.splinter(a.fx, 0.7))));
  on(bus.on("fx:shake", (e) => {
    lastShake = ctx.time;
    live((a) => a.sfx.rumble(a.fx, Number(e.amp) || 0.2, Number(e.secs) || 2));
  }));
  on(bus.on("fx:crack", () => live((a) => a.sfx.crack(a.fx, 0.8))));
  on(bus.on("mission:debris", (e) => live((a) => {
    const secs = clamp(Number(e.secs) || 3, 1.5, 4);
    if (ctx.time - lastShake > 1) a.sfx.rumble(a.fx, 0.18, 1.6);
    a.sfx.clatter(a.fx, 0.4, secs);
  })));
  on(bus.on("mission:pickup", (e) => live((a) => {
    a.sfx.chime(a.fx, 0.22, e.kind === "medkit" ? [1046.5, 1568] : [880, 1318.5]);
  })));
  on(bus.on("mission:survivor", (e) => live((a) => {
    if (e.state === "following") a.sfx.blip(a.fx, 0.2);
    else if (e.state === "safe") a.sfx.chime(a.fx, 0.16, [523.25, 659.25, 783.99], 0.11, 0.5);
    else if (e.state === "lost") a.sfx.lowTone(a.fx, 0.3);
  })));
  on(bus.on("mission:medkit", () => live((a) => a.sfx.chime(a.fx, 0.14, [523.25, 659.25, 783.99, 1046.5], 0.12, 0.7))));
  on(bus.on("mission:reset", () => {
    // Play again: a fresh night, and last night's radio stops talking.
    resetAt = ctx.time;
    defending = false;
    lastWave = -99;
    radio.cancel();
  }));
  on(bus.on("horde:clear", () => {
    // Also fired by "play again" (right after mission:reset) and possibly on consecutive frames: one sting per dawn.
    if (ctx.time - resetAt < 0.5 || ctx.time - lastSting < 10) return;
    lastSting = ctx.time;
    live((a) => a.sfx.sting(a.fx, 0.35));
  }));
  on(bus.on("radio:line", (e) => {
    if (!A || muted || A.ac.state !== "running") return; // nothing before the first gesture or while muted
    radio.push(e);
  }));

  // ---------------------------------------------------------------- per-frame: gains + short schedules
  function layers(a: Graph) {
    const t = a.ac.currentTime;
    const p = ctx.player;
    const dawn = clamp(ctx.dawn, 0, 1);
    const night = 1 - dawn;
    const tension = Math.min(1, ctx.horde.chasing / 8);
    const fade = Math.min(1, unlockedFor / 3);
    a.hum.gain.setTargetAtTime(fade * (0.05 + 0.05 * night + 0.05 * tension), t, 0.6);
    a.wind.gain.setTargetAtTime(fade * (0.025 + 0.085 * night), t, 0.8);
    a.windBP.frequency.setTargetAtTime(480 + 380 * night, t, 1);
    a.whistle.gain.setTargetAtTime(fade * 0.03 * night * night, t, 0.8);
    a.pad.gain.setTargetAtTime(0.06 * Math.pow(dawn, 1.5), t, 0.6);
    const danger = Math.max(Math.min(1, ctx.horde.chasing / 6), defending ? 0.8 : 0, ctx.time - lastWave < 20 ? 0.6 : 0);
    a.tension.gain.setTargetAtTime(fade * 0.05 * danger * night, t, danger > 0.3 ? 1.2 : 2.5);
    a.outsideLP.frequency.setTargetAtTime(p.hidden ? 650 : 18000, t, 0.25);
    applyDuck(t);
    if (ctx.time > downedUntil) a.muffle.frequency.setTargetAtTime(p.health > 0 && p.health < 20 ? 2600 : 20000, t, 0.3);
  }

  if (process.env.NODE_ENV !== "production") {
    (window as unknown as { __footAudio?: unknown }).__footAudio = {
      state: () => A?.ac.state ?? "locked",
      muted: () => muted,
      queue: () => radio.length,
      busy: () => radio.busy,
      voices: () => radio.voices(),
      playing: () => A?.sfx.voices ?? 0,
      sayable,
      probe,
    };
  }

  return {
    update(rawDt) {
      const a = A;
      const p = ctx.player;
      const dt = clamp(Number(rawDt) || 0, 0, 0.1);
      // Speed: the player system's value, else measured from the position (teleports ignored).
      const moved = Math.hypot(p.x - lastX, p.z - lastZ);
      lastX = p.x;
      lastZ = p.z;
      if (!a || a.ac.state !== "running") return;
      unlockedFor += dt;
      paramT -= dt;
      if (paramT <= 0) {
        paramT = 0.1;
        layers(a);
      }
      if (muted || dt === 0) return;
      const h = ctx.horde;

      // Footsteps.
      const measured = moved / dt;
      const speed = Math.max(p.speed || 0, measured < 12 ? measured : 0);
      if (!p.frozen && !p.hidden && speed > 0.6) {
        const sprint = p.sprinting || speed > 6;
        stepT += dt;
        if (stepT >= (sprint ? 0.32 : 0.55)) {
          stepT = 0;
          stepSide = -stepSide;
          a.sfx.step(a.fx, sprint ? 0.3 : 0.22, stepSide * 0.08, sprint);
        }
      } else stepT = 0.4;

      // Breathing when out of stamina.
      if (!p.frozen && !p.hidden && p.stamina < 0.3) {
        breathT -= dt;
        if (breathT <= 0) {
          breathOut = !breathOut;
          a.sfx.breath(a.fx, 0.09 * (1 - p.stamina / 0.3) + 0.03, breathOut);
          breathT = breathOut ? 0.5 : 0.42;
        }
      } else breathT = 0;

      // Heartbeat under 40% health, faster under 20% (not once dawn is up).
      if (p.health > 0 && p.health < 40 && ctx.dawn < 0.5) {
        heartT -= dt;
        if (heartT <= 0) {
          const low = p.health < 20;
          heartT = low ? 0.52 : 0.85;
          a.sfx.heartbeat(a.fx, low ? 0.75 : 0.55);
        }
      } else heartT = 0;

      // Zombie groans: only when one is near you (within GROAN_M), louder as it closes, from its direction.
      const near = h.alive > 0 && Number.isFinite(h.nearest) ? clamp(1 - h.nearest / GROAN_M, 0, 1) : 0;
      if (near > 0) {
        groanT -= dt;
        if (groanT <= 0) {
          const close = h.nearest < 10;
          const crowd = Math.min(1, (h.chasing + 1) / 8);
          const level = close ? 0.32 + 0.25 * (1 - h.nearest / 10) : 0.08 + 0.2 * near + 0.04 * crowd;
          const toward = Number.isFinite(h.nearestX) && Number.isFinite(h.nearestZ) ? panOf(ctx, h.nearestX, h.nearestZ) : null;
          const pan = () => (toward != null ? clamp(toward + rnd(-0.12, 0.12), -1, 1) : ctx.time - lastHit.at < 4 ? lastHit.pan * 0.7 + rnd(-0.3, 0.3) : rnd(-0.7, 0.7));
          a.sfx.groan(a.zom, level, pan(), rnd(0.85, 1.15));
          if (close && h.chasing > 3 && Math.random() < 0.45) a.sfx.groan(a.zom, level * 0.7, pan(), rnd(0.8, 1.2));
          const base = close ? rnd(0.45, 1.1) : 2.6 - 1.6 * near - 0.5 * crowd;
          groanT = Math.max(0.35, base * rnd(0.6, 1.4));
        }
      } else groanT = Math.min(groanT, 1.2);

      // Door bangs while defending, scaled by how many zombies press on it.
      if ((defending || ctx.mission.barricade.active) && h.pressing > 0) {
        bangT -= dt;
        if (bangT <= 0) {
          a.sfx.bang(a.fx, Math.min(0.65, 0.22 + 0.05 * h.pressing), rnd(-0.2, 0.2));
          bangT = Math.max(0.35, 2.4 - 0.25 * h.pressing) * rnd(0.7, 1.3);
        }
      }

      // Birds as dawn comes up.
      if (ctx.dawn > 0.25) {
        birdT -= dt;
        if (birdT <= 0) {
          a.sfx.bird(a.amb, 0.1 * ctx.dawn, rnd(-0.8, 0.8));
          birdT = rnd(0.5, 2.6);
        }
      }
    },
    dispose() {
      disposers.forEach((f) => f());
      radio.dispose();
      if (toastTimer) clearTimeout(toastTimer);
      toast?.remove();
      toast = null;
      if (A) {
        A.stop();
        A.ac.close().catch(() => {});
        A = null;
      }
      if (process.env.NODE_ENV !== "production") delete (window as unknown as { __footAudio?: unknown }).__footAudio;
    },
  };
}
