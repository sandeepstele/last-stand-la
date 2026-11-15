// The words on screen, in one place: short, plain, data-true. Pure helpers for the on-foot UI (design pass).
// Nothing here computes a number: percentages and counts pass through from the tools' results unchanged.
// Nothing here changes what is sent to the agent (radio.ts and the director keep their exact strings).

import type { RadioLine } from "../radio";

export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const stop = (s: string) => (/[.!?…]$/.test(s) ? s : `${s}.`);

/** Company names off the screen; the records are still the records. */
export function plain(s: string): string {
  return s
    .replace(/\bthe material CoStar records\b/gi, "the recorded material")
    .replace(/\bfor a CoStar researcher\b/gi, "for a researcher")
    .replace(/\bCoStar's (?:real )?(?:open[- ]case )?queue\b/gi, "the open-case queue")
    .replace(/\bCoStar records\b/g, "the records list")
    .replace(/\bCoStar\b/g, "the property records")
    .replace(/\s*\((?:Vexcel|Matterport)[^)]*\)/g, "")
    .replace(/\bVexcel\b/g, "aerial")
    .replace(/\bMatterport\b/g, "3D scan");
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2023-11-29" -> "Nov 2023" (the month is the point; the day is noise). */
export const fmtDates = (s: string) => s.replace(/\b(\d{4})-(\d{2})-\d{2}\b/g, (m, y: string, mo: string) => (MONTHS[Number(mo) - 1] ? `${MONTHS[Number(mo) - 1]} ${y}` : m));

/** "301302" (two suites on one record) -> "suites 301–302"; anything else -> "suite 1100". */
export function suiteName(suite: string): string {
  const m = suite.match(/^(\d{3})(\d{3})$/);
  if (m && Number(m[2]) === Number(m[1]) + 1) return `suites ${m[1]}–${m[2]}`;
  return `suite ${suite}`;
}

/** One name per place: "suite 1100, 122 7th St, suite 1100" -> "122 7th St, suite 1100" (no repeats, the suite last). */
export function placeName(where: string): string {
  const dot = where.lastIndexOf(" · ");
  if (dot >= 0) return `${where.slice(0, dot)} · ${placeName(where.slice(dot + 3))}`; // "Case #7 · <place>"
  const parts = where.split(/,\s*/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set<string>();
  const uniq = parts.filter((p) => !seen.has(p.toLowerCase()) && !!seen.add(p.toLowerCase()));
  const isSuite = (p: string) => /^suites?\s/i.test(p);
  return [...uniq.filter((p) => !isSuite(p)), ...uniq.filter(isSuite).map((p) => p.replace(/^suite\s+(\S+)$/i, (_, s: string) => suiteName(s)))].join(", ");
}

/** A hypothesis in a word or two (the key comes from the tools; never shown raw). */
export const SHORT: Record<string, string> = {
  city_list_current: "concrete",
  costar_current: "the recorded material",
  different_structure: "a different structure",
  replaced: "replaced",
  year_is_renovation: "renovated",
  still_there: "still there",
  gone_dark: "gone",
  subleasing: "subleasing",
  moved_within: "moved suites",
  listing_stale: "listing out of date",
};
/** What a case is about, from one of its hypothesis keys. */
export function subjectOf(key: string): string {
  if (["city_list_current", "costar_current", "different_structure"].includes(key)) return "Walls";
  if (["still_there", "gone_dark", "subleasing", "moved_within", "listing_stale"].includes(key)) return "Office";
  if (["replaced", "year_is_renovation"].includes(key)) return "Building";
  return "Case";
}

/** The verdict label in words: likely / leaning / unresolved -> how sure, hedged. */
export function sureWords(label: string | undefined): string {
  return label === "likely" ? "likely" : label === "leaning" ? "probably" : "not settled";
}

/** "Walls: concrete, 54%" (+ how sure, when it isn't settled). */
export function oddsLine(key: string, pct: number, label?: string): string {
  const what = SHORT[key] ?? "the leading answer";
  return `${subjectOf(key)}: ${what}, ${pct}%${label === "unresolved" ? " · not settled" : ""}`;
}

/** "+12" style moves in words: "up 12 after your report". */
export function moveWords(pts: number, why: string): string {
  return `${pts > 0 ? "up" : "down"} ${Math.abs(pts)} ${why}`;
}

// ---------------------------------------------------------------- the radio, as game subtitles

const SQUAD_SHORT: Record<string, string> = { "Records squad": "records", "Air recon": "aerial", "City desk": "city lists", "Inside team": "interior", "HQ analyst": "analyst" };
const eta = (s: string) =>
  s.replace(/^<\s*(\d+)\s*s$/, "under $1 s").replace(/^>\s*(\d+)\s*s$/, "over $1 s").replace(/^(\d+)\s*-\s*(\d+)\s*s$/, "$1–$2 s");
/** "It is concrete: the city's list is right…" -> "concrete". */
const claimShort = (claim: string) => claim.split(/[:;,(]/)[0].replace(/^\s*it(?:'s| is| was)\s+/i, "").trim();

/**
 * A radio line as a subtitle: { who, text } in plain words, or null when it isn't speech worth showing
 * (the orders the game sends for you, e.g. "scout tonight's fortress", are not something you said).
 */
export function subtitle(l: RadioLine): { who: string; text: string } | null {
  const t = l.text.trim();
  if (!t) return null;
  if (l.who === "You") {
    const r = t.match(/^reported:\s*(.*)$/i);
    return r ? { who: "You", text: stop(cap(r[1])) } : null;
  }
  if (l.who === "Lookout") {
    const h = t.match(/^horde from the (\w+), (\w+), ETA (.+)$/i);
    return { who: "Lookout", text: h ? `${cap(h[2])} horde from the ${h[1]}, ${eta(h[3])} out.` : stop(cap(plain(t))) };
  }
  if (l.who === "Intel") {
    const d = t.match(/^dossier on (.+) is in$/i);
    return { who: "Intel", text: d ? `The file on ${d[1]} is in.` : stop(cap(plain(t))) };
  }
  if (l.who !== "HQ") return { who: l.who, text: stop(cap(plain(t))) };
  let m: RegExpMatchArray | null;
  if ((m = t.match(/^opening the case on suite (\S+): (.*)$/i))) return { who: "HQ", text: `Opening ${suiteName(m[1])}: ${m[2]}` };
  if ((m = t.match(/^mission plan set \((\d+) objectives?\)$/i))) return { who: "HQ", text: `Plan set: ${m[1]} steps.` };
  if ((m = t.match(/^(.+) moving out$/i))) {
    const names = m[1].split(/,\s*/).map((s) => SQUAD_SHORT[s] ?? s.toLowerCase());
    return { who: "HQ", text: `Sending squads: ${names.join(", ")}.` };
  }
  if ((m = t.match(/^records disagree\.\s*(.*)$/i))) return { who: "HQ", text: `The records disagree. ${plain(m[1])}` };
  if ((m = t.match(/^walls (likely|leaning|unresolved) (\d+)%(?: \((.*)\))?$/i))) {
    const what = m[3] ? claimShort(m[3]) : "";
    return {
      who: "HQ",
      text: m[1] === "unresolved" || !what ? `Walls: still unclear. Leading answer at ${m[2]}%.` : `Walls: ${sureWords(m[1])} ${plain(what)}, ${m[2]}%.`,
    };
  }
  if ((m = t.match(/^fallback (.+?)(?: \((.+)\))?$/i))) return { who: "HQ", text: `Fallback: ${m[1]}${m[2] ? `, ${m[2]} away` : ""}.` };
  if ((m = t.match(/^proposing (?:RUN to (.+)|HOLD)\. Your call\.$/i))) return { who: "HQ", text: m[1] ? `Proposing a run to ${m[1]}. Your call.` : "Proposing we hold. Your call." };
  if (/^tip logged$/i.test(t)) return { who: "HQ", text: "Report logged." };
  if (/^the walls (held|gave way)$/i.test(t)) return { who: "HQ", text: stop(cap(t)) };
  return { who: "HQ", text: stop(cap(plain(t))) };
}
