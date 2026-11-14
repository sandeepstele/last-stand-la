// Stream messages -> radio lines. Pure: (messages) -> lines, from fixed templates.
// The numbers in a line come from tool results (computed server-side), never from here.

import type { Fallback, HordeStatus, ResolveResult, Sector } from "./types";

export type RadioLine = { id: string; who: string; text: string; tone?: "hq" | "warn" | "good" | "you" };

type ToolCall = { id?: string; name?: string; args?: Record<string, unknown> };
export type Msg = { type?: string; name?: string; content?: unknown; tool_calls?: ToolCall[]; tool_call_id?: string; id?: string; getType?: () => string };

export const kind = (m: Msg): string => m.type ?? m.getType?.() ?? "";

/** Message text: a string, or an array of content blocks (only type "text" blocks are read). */
export function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        const b = p as { type?: string; text?: unknown };
        return (!b.type || b.type === "text") && typeof b.text === "string" ? b.text : "";
      })
      .join("");
  }
  return "";
}

const SUMMARY_KEYS = ["summary", "headline", "finding", "note", "result", "text", "answer", "message"];

/** A squad report: plain text, or a JSON object summarized from its first few plain fields. */
export function report(content: unknown): string {
  const t = text(content).trim();
  if (!t.startsWith("{")) return firstSentence(t);
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    for (const k of SUMMARY_KEYS) if (typeof o[k] === "string" && o[k]) return firstSentence(o[k] as string);
    const parts = Object.entries(o)
      .filter(([k, v]) => (typeof v === "string" || typeof v === "number" || typeof v === "boolean") && v !== "" && !/(^|_)(id|pid)$/.test(k))
      .slice(0, 3)
      .map(([k, v]) => `${k.split("_").join(" ")} ${String(v)}`);
    return parts.length ? firstSentence(parts.join(" · ")) : "report in";
  } catch {
    return firstSentence(t);
  }
}

export function parse<T>(m: Msg): T | null {
  try {
    const v = JSON.parse(text(m.content)) as unknown;
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

/** Index of the newest human message, or -1. */
export function lastHumanIndex(messages: readonly unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (kind(messages[i] as Msg) === "human") return i;
  return -1;
}

/** The newest result of a tool at or after index `from`, parsed as JSON. */
export function latestResult<T>(messages: readonly unknown[], name: string, from = 0): T | null {
  for (let i = messages.length - 1; i >= Math.max(0, from); i--) {
    const m = messages[i] as Msg;
    if (kind(m) === "tool" && m.name === name) return parse<T>(m);
  }
  return null;
}

/** Names of check_evidence checks seen in the stream for a building (unique, in order). */
export function checksFor(messages: readonly unknown[], pid: string): string[] {
  const out: string[] = [];
  for (const raw of messages) {
    const m = raw as Msg;
    if (kind(m) !== "tool" || m.name !== "check_evidence") continue;
    const c = parse<{ property_id?: string; check?: string; status?: string }>(m);
    if (c?.check && !c.status && String(c.property_id) === pid && !out.includes(c.check)) out.push(c.check);
  }
  return out;
}

export const SECTOR_NAME: Record<Sector, string> = {
  N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest",
};

const SQUAD: Record<string, string> = {
  records: "Records squad",
  aerial: "Air recon",
  interior: "Inside team",
  civic: "City desk",
  "general-purpose": "HQ analyst",
};
const squad = (name: string) => SQUAD[name] ?? `${name.charAt(0).toUpperCase()}${name.slice(1)} squad`;

/** First sentence, markdown stripped, capped. */
export function firstSentence(s: string, max = 150): string {
  // Underscores become spaces ("non_ductile_concrete" -> "non ductile concrete"), not deletions.
  const clean = s.replace(/[#*`>]+/g, "").replace(/_+/g, " ").replace(/\s+/g, " ").trim();
  const m = clean.match(/^(.+?[.!?])(\s|$)/);
  const one = m ? m[1] : clean;
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}

export function radioLines(messages: readonly unknown[]): RadioLine[] {
  const lines: RadioLine[] = [];
  const taskOf = new Map<string, string>();
  const labels = new Map<string, string>(); // pid -> label, from tool results (never show a raw pid)
  messages.forEach((raw, i) => {
    const m = raw as Msg;
    const k = kind(m);
    const id = m.id ?? `m${i}`;
    if (k === "human") {
      const raw = text(m.content).trim();
      const wave = raw.match(/^Wave (\d+) is coming from the (\w+)/);
      const suite = raw.match(/^Check suite (\S+) at building /);
      if (suite) {
        lines.push({ id, who: "HQ", text: `opening the case on suite ${suite[1]}: is the office on record still there?`, tone: "hq" });
        return;
      }
      const t = /^Scout property /.test(raw) ? "scout tonight's fortress"
        : /^Brief the night shift/.test(raw) ? "brief me on tonight's cases"
        : /^Debrief the night shift/.test(raw) ? "debrief: draft tonight's corrections"
        : wave ? `wave ${wave[1]} incoming from the ${SECTOR_NAME[wave[2] as Sector] ?? wave[2]}`
          : firstSentence(raw, 120);
      if (t) lines.push({ id, who: "You", text: t, tone: "you" });
      return;
    }
    if (k === "ai") {
      const calls = m.tool_calls ?? [];
      // The agent's own words first (it speaks in addresses and plain words), then what its tool calls mean.
      const said = firstSentence(text(m.content), 180);
      if (said) lines.push({ id, who: "HQ", text: said, tone: "hq" });
      const squads: string[] = [];
      calls.forEach((c, j) => {
        const cid = `${id}-${c.id ?? j}`;
        const a = c.args ?? {};
        if (c.name === "write_todos") {
          const n = Array.isArray(a.todos) ? a.todos.length : 0;
          if (n) lines.push({ id: cid, who: "HQ", text: `mission plan set (${n} objective${n === 1 ? "" : "s"})`, tone: "hq" });
        } else if (c.name === "task") {
          const sub = String(a.subagent_type ?? "scout");
          if (c.id) taskOf.set(c.id, sub);
          squads.push(squad(sub));
        } else if (c.name === "commit_plan") {
          const run = a.action === "run";
          const to = a.to_pid ? labels.get(String(a.to_pid)) ?? "the fallback" : "the fallback";
          lines.push({ id: cid, who: "HQ", text: `proposing ${run ? `RUN to ${to}` : "HOLD"}. Your call.`, tone: "warn" });
        }
      });
      if (squads.length) lines.push({ id: `${id}-squads`, who: "HQ", text: `${squads.join(", ")} moving out` });
      return;
    }
    if (k !== "tool") return;
    switch (m.name) {
      case "task": {
        const sub = taskOf.get(m.tool_call_id ?? "") ?? "scout";
        const t = report(m.content);
        if (t) lines.push({ id, who: squad(sub), text: t });
        break;
      }
      case "fortress_dossier": {
        const d = parse<{ pid?: string; label?: string }>(m);
        if (d?.pid && d.label) labels.set(String(d.pid), d.label);
        if (d?.label) lines.push({ id, who: "Intel", text: `dossier on ${d.label} is in` });
        break;
      }
      case "open_case": {
        const c = parse<{ cases?: { question?: string }[] }>(m);
        const q = c?.cases?.[0]?.question;
        if (q) lines.push({ id, who: "HQ", text: `records disagree. ${firstSentence(q, 140)}`, tone: "warn" });
        break;
      }
      case "check_evidence": {
        const c = parse<{ finding?: string; status?: string }>(m);
        if (c?.finding && !c.status) lines.push({ id, who: "Recon", text: firstSentence(c.finding, 160) });
        break;
      }
      case "weigh_case": {
        const w = parse<{ verdict?: { label?: string; confidence?: number; claim?: string } }>(m);
        if (w?.verdict) {
          const pct = Math.round((w.verdict.confidence ?? 0) * 100);
          const lean = w.verdict.label === "unresolved" ? "" : ` (${w.verdict.claim ?? ""})`;
          lines.push({ id, who: "HQ", text: `walls ${w.verdict.label ?? "unresolved"} ${pct}%${lean}`, tone: "hq" });
        }
        break;
      }
      case "horde_status": {
        const h = parse<HordeStatus>(m);
        if (h?.sector) lines.push({ id, who: "Lookout", text: `horde from the ${SECTOR_NAME[h.sector] ?? h.sector}, ${h.size_band}, ETA ${h.eta_band}`, tone: "warn" });
        break;
      }
      case "find_fallback": {
        const f = parse<Fallback>(m);
        if (f?.to_pid && f.to_label) labels.set(String(f.to_pid), f.to_label);
        if (f?.to_label) lines.push({ id, who: "HQ", text: `fallback ${f.to_label}${f.distance_band ? ` (${f.distance_band})` : ""}`, tone: "hq" });
        break;
      }
      case "record_note":
        lines.push({ id, who: "HQ", text: "tip logged", tone: "hq" });
        break;
      case "commit_plan": {
        const r = parse<ResolveResult>(m);
        if (r && typeof r.held === "boolean") {
          lines.push({ id, who: "HQ", text: r.held ? "the walls held" : "the walls gave way", tone: r.held ? "good" : "warn" });
        } else {
          const t = firstSentence(text(m.content), 120);
          if (t) lines.push({ id, who: "HQ", text: t });
        }
        break;
      }
    }
  });
  return lines;
}
