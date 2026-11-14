// OWNER: builder G (audio). The spoken radio: a queue of short lines, read with the browser's local speech voices.
// Lines never overlap; the oldest is dropped past 3 waiting. "You" lines get the crackle only (never spoken).

export type RadioIn = { who: string; text: string; tone?: string };
type Item = { who: string; text: string; tone?: string; speak: boolean };

export type RadioHooks = {
  /** Transmission starts: squelch, crackle bed on, duck the ambience. */
  open(item: { who: string; tone?: string }): void;
  /** Transmission ends: closing squelch, crackle off, un-duck. */
  close(): void;
};

const MAX_QUEUE = 3;
const MAX_CHARS = 140;

/** First sentence (plus a second when the first is a fragment), cleaned for speech. Null = don't speak it. */
export function sayable(raw: string): string | null {
  let s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^[[{]/.test(s) || /"\w+"\s*:/.test(s)) return null; // JSON-like
  const dense = s.replace(/\s/g, "");
  const digits = (dense.match(/[\d.,:;%/\-+()]/g) ?? []).length;
  if (dense.length === 0 || digits / dense.length > 0.45) return null; // mostly digits
  s = s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/(?:\s+(?:at|on|for|of|parcel|pid))?\s*\b\d{3,}(?:[-–]\d{2,}){1,3}\b/gi, "") // parcel numbers like 5148-012-034
    .replace(/\b[a-z]{0,6}[_-]?(?=[0-9a-f]*\d)[0-9a-f]{8,}\b/gi, "") // ids and hashes (need a digit)
    .replace(/\s*(->|→|=>)\s*/g, " to ")
    .replace(/\(\s*0?\.(\d{1,3})\s*\)/g, (_, d: string) => `, ${Math.round(Number(`0.${d}`) * 100)} percent,`)
    .replace(/[`*_#>|[\]{}<]/g, "")
    .replace(/&/g, " and ")
    .replace(/~\s*/g, "about ")
    .replace(/\bURM\b/g, "unreinforced masonry")
    .replace(/\bw\/\s*/gi, "with ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,([.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.+?[.!?])(?:\s+|$)/;
  const m = s.match(sentence);
  let out = m ? m[1] : s;
  if (m && out.length < 32) {
    const rest = s.slice(m[0].length).trim();
    const m2 = rest.match(sentence);
    const second = m2 ? m2[1] : rest;
    if (second && out.length + 1 + second.length <= MAX_CHARS) out = `${out} ${second}`;
  }
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS);
    const sp = out.lastIndexOf(" ");
    if (sp > MAX_CHARS * 0.6) out = out.slice(0, sp);
    out = `${out.replace(/(?:[,;:\s]+|\s+(?:the|a|an|of|for|to|and|or|with|at|in|on|is|are|that|who))+$/i, "")}.`;
  }
  out = out.replace(/^[,\s]+/, "").trim();
  return /[a-z]{2}/i.test(out) ? out : null;
}

// Novelty and sound-effect voices on macOS; never pick them.
const NOVELTY = /Albert|Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Good News|Jester|Organ|Superstar|Trinoids|Whisper|Wobble|Zarvox|Junior|Ralph|Kathy|Grandma|Grandpa|Princess|Deranged|Hysterical|Fred/i;
const HQ_PREF = ["Daniel", "Aaron", "Arthur", "Alex", "Tom", "Reed", "Rishi", "Evan", "Nathan", "Oliver", "Gordon", "Lee", "Microsoft Guy", "Microsoft David", "Microsoft Mark", "Microsoft Ryan", "Microsoft Andrew", "Microsoft Christopher"];
const SQUAD_PREF = ["Samantha", "Karen", "Moira", "Tessa", "Serena", "Nicky", "Allison", "Ava", "Susan", "Victoria", "Fiona", "Microsoft Zira", "Microsoft Aria", "Microsoft Jenny", "Microsoft Hazel", "Microsoft Libby"];

export function createRadio(hooks: RadioHooks) {
  const synth: SpeechSynthesis | null = typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null;
  const q: Item[] = [];
  let busy = false;
  let alive = true;
  let gen = 0; // bumped by cancel(): a line waiting to start must not speak after a mute
  let current: SpeechSynthesisUtterance | null = null; // keep a reference: Chrome drops onend for collected utterances
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let hq: SpeechSynthesisVoice | null = null;
  let squad: SpeechSynthesisVoice | null = null;

  const later = (ms: number, f: () => void) => {
    const id = setTimeout(() => {
      timers.delete(id);
      if (alive) f();
    }, ms);
    timers.add(id);
    return id;
  };

  function pickVoices() {
    if (!synth) return;
    let all: SpeechSynthesisVoice[] = [];
    try {
      all = synth.getVoices();
    } catch {
      return;
    }
    const ok = all.filter((v) => /^en([-_]|$)/i.test(v.lang) && v.localService !== false && !NOVELTY.test(v.name));
    if (!ok.length) return;
    const find = (names: string[], not?: SpeechSynthesisVoice | null) => {
      for (const n of names) {
        const v = ok.find((x) => x !== not && (x.name === n || x.name.startsWith(`${n} `) || x.name.startsWith(n)));
        if (v) return v;
      }
      return null;
    };
    hq = find(HQ_PREF) ?? ok.find((v) => v.default) ?? ok[0];
    squad = find(SQUAD_PREF, hq) ?? ok.find((v) => v !== hq) ?? hq;
  }
  pickVoices();
  synth?.addEventListener?.("voiceschanged", pickVoices);

  function next() {
    const it = q.shift();
    if (!it) {
      busy = false;
      return;
    }
    busy = true;
    hooks.open(it);
    if (!it.speak || !synth) {
      later(it.speak ? 1300 : 650, finish);
      return;
    }
    const g = gen;
    later(200, () => {
      if (g !== gen) return finish();
      const isHq = /^hq$/i.test(it.who);
      const voice = isHq ? hq : squad;
      const u = new SpeechSynthesisUtterance(it.text);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      } else u.lang = "en-US";
      u.rate = isHq ? 1.05 : 1.12;
      u.pitch = isHq ? 0.9 : 1;
      u.volume = 1;
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        clearTimeout(wd);
        timers.delete(wd);
        if (current === u) current = null;
        finish();
      };
      // Watchdog: some engines never fire onend (no voices headless, a stuck queue).
      const wd = later(2500 + it.text.length * 90, () => {
        try {
          synth.cancel();
        } catch {
          /* ignore */
        }
        end();
      });
      u.onend = end;
      u.onerror = end;
      current = u;
      try {
        synth.resume();
        synth.speak(u);
      } catch {
        end();
      }
    });
  }

  function finish() {
    hooks.close();
    later(320, next);
  }

  return {
    push(l: RadioIn) {
      const text = sayable(l.text);
      if (!text) return;
      const who = String(l.who ?? "");
      q.push({ who, text, tone: l.tone, speak: !/^you$/i.test(who) });
      while (q.length > MAX_QUEUE) q.shift();
      if (!busy) next();
    },
    /** Mute / reset: drop the queue and stop speaking now. */
    cancel() {
      gen++;
      q.length = 0;
      try {
        synth?.cancel();
      } catch {
        /* ignore */
      }
    },
    get length() {
      return q.length;
    },
    get busy() {
      return busy;
    },
    voices() {
      return { hq: hq?.name ?? null, squad: squad?.name ?? null };
    },
    dispose() {
      alive = false;
      q.length = 0;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      synth?.removeEventListener?.("voiceschanged", pickVoices);
      try {
        synth?.cancel();
      } catch {
        /* ignore */
      }
      current = null;
    },
  };
}
