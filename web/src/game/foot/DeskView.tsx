"use client";
// Bob's desk (the building office, 9 am to 5 pm): the inbox of real cases, a live card per building that fills in as each
// squad's data lands (every line names its source), the city map coloured as the agent works, the calculation sheet
// (the evidence maths, front and centre) and the squad radio. Built from the agent log (GET /game/log/{thread}), so
// every number on it is the code's. OWNER: coding lead.

import { useEffect, useMemo, useState } from "react";
import { MathTable, useAgentLog, type LogMath, type LogStep } from "./AgentLog";
import type { City, CityBuilding } from "./cityMap";
import { SHORT, plain } from "./copy";
import { parse, kind, radioLines, type Msg } from "../radio";

/** building_card (the desk contract): one building's data, by source, with the conflicts between sources. */
export type DeskCard = {
  pid: string; label?: string;
  sources?: { key: string; source: string; status: "ok" | "missing" | "conflict"; lines?: string[] }[];
  conflicts?: { field: string; a: { source: string; value: unknown }; b: { source: string; value: unknown } }[];
  /** at_5pm (contract v1.1): the people inside at the quake hour, when the server sends it. */
  people?: { day?: number; night?: number; at_stake?: number; low?: number; high?: number; at_5pm?: number; basis?: string };
  screening?: { score?: number; fema_type?: string; suggest?: string };
};
type Triage = {
  buildings?: { pid: string; label?: string; x?: number; z?: number; people?: number; p_damage?: number; at_risk?: number; suggest?: string; score?: number; rank?: number }[];
  basis?: string; counts?: Record<string, number>; people_at_stake?: number; expected_at_risk?: number;
};

/** The newest building_card result per pid in the thread. */
function streamCards(messages: readonly unknown[]): Map<string, DeskCard> {
  const out = new Map<string, DeskCard>();
  for (const raw of messages) {
    const m = raw as Msg;
    if (kind(m) !== "tool" || m.name !== "building_card") continue;
    const c = parse<DeskCard>(m);
    if (c?.pid) out.set(String(c.pid), c);
  }
  return out;
}


export type DeskCase = { n: number; case: string; property_id: string; suite: string | null; label: string; question?: string; stakes?: string };
export type Tag = "green" | "yellow" | "red";
export const TAG_COLOR: Record<Tag, string> = { green: "#4cc38a", yellow: "#f5c524", red: "#e5484d" };

type CardLine = { n: number; actor: string; source: string; text: string };
type Card = { pid: string; label: string | null; lines: CardLine[]; math: LogMath | null; busy: boolean };

const CASE_WORDS: Record<string, string> = {
  ghost_tenant: "Tenant on record, suite listed for lease",
  material_conflict: "Material disagrees with the city",
  stale_entry: "Listed building looks replaced",
};

function pidOf(a: Record<string, unknown> | undefined): string | null {
  const v = a?.property_id ?? a?.pid ?? a?.from_pid;
  return v == null ? null : String(v);
}

/** One card per building the agent touched: each call's result, labelled with the data source the call named. */
export function cardsFrom(steps: LogStep[]): Card[] {
  const cards = new Map<string, Card>();
  const pending = new Map<string, { pid: string; actor: string; source: string }[]>(); // tool -> calls awaiting a result (FIFO)
  const card = (pid: string) => {
    let c = cards.get(pid);
    if (!c) cards.set(pid, (c = { pid, label: null, lines: [], math: null, busy: false }));
    return c;
  };
  for (const s of steps) {
    if (s.kind === "call") {
      const pid = pidOf(s.args);
      if (!pid) continue;
      const q = pending.get(s.tool) ?? [];
      q.push({ pid, actor: s.actor, source: s.source ?? "" });
      pending.set(s.tool, q);
      card(pid).busy = true;
    } else if (s.kind === "result") {
      const call = pending.get(s.tool)?.shift();
      if (!call) continue;
      const c = card(call.pid);
      c.busy = (pending.get(s.tool)?.some((x) => x.pid === call.pid)) ?? false;
      if (s.math) c.math = s.math;
      const label = /^([^:;]{3,60}?)(?::|;| —| - )/.exec(s.summary)?.[1];
      if (!c.label && label && /\d/.test(label)) c.label = label.trim();
      // building_card / screen_building land in the source block; raw JSON summaries never reach the card
      if (s.tool !== "building_card" && s.tool !== "screen_building" && !/^\s*[{[]/.test(s.summary))
        c.lines.push({ n: s.n, actor: call.actor.replace(/\s*\(.*\)\s*$/, ""), source: call.source, text: s.summary });
    }
  }
  return [...cards.values()].filter((c) => c.lines.length || c.busy);
}

// The desk's look: the game's one typeface, flat near-black panels, warm ink, amber for the agent's live state.
const UI = 'var(--font-ui), "IBM Plex Sans Condensed", "Arial Narrow", sans-serif';
const INK = "#f4f1ea";
const MUTED = "rgba(244,241,234,.68)";
const FAINT = "rgba(244,241,234,.46)";
const HAIR = "rgba(244,241,234,.1)";
const AMBER = "#f5a524";
const SKY = "#38bdf8";
const SIM = "Simulated: game outcome, not an engineering assessment";

/** The agent's verdict, split for display: "likely" · "concrete" · "73%". */
function verdictOf(m: LogMath | null): { label: string; what: string; pct: string } | null {
  if (!m?.leader) return null;
  return { label: m.label ?? "leaning", what: SHORT[m.leader] ?? plain(m.leader), pct: `${Math.round((m.confidence ?? 0) * 100)}%` };
}

const clamp = (lines: number): React.CSSProperties => ({ display: "-webkit-box", WebkitLineClamp: lines, WebkitBoxOrient: "vertical", overflow: "hidden" });
const n = (x: number) => x.toLocaleString("en-US");

function TagChip({ t }: { t: Tag }) {
  return <span title={SIM} style={{ flex: "none", background: TAG_COLOR[t], color: "#111", padding: "1px 7px", borderRadius: 2, fontWeight: 700, fontSize: 12, letterSpacing: ".02em" }}>{t.toUpperCase()} · sim</span>;
}
function ScreensChip({ s }: { s: string }) {
  const c = TAG_COLOR[s as Tag] ?? "#94a3b8";
  return <span title="What the code's screening suggests from the records alone" style={{ flex: "none", border: `1px solid ${c}`, color: c, padding: "0 6px", borderRadius: 2, fontSize: 12, fontWeight: 600 }}>screens {s}</span>;
}

/** The district map: every LA kit building as a dot; case buildings ringed; colour = tag, else the agent's progress. */
function CityPane({ city, cards, tags, triage, selected, onSelect }: { city: City | null; cards: Card[]; tags: Record<string, Tag>; triage: Triage | null; selected: string | null; onSelect(pid: string): void }) {
  const risk = useMemo(() => new Map((triage?.buildings ?? []).map((b) => [b.pid, b])), [triage]);
  const maxPeople = useMemo(() => Math.max(1, ...(triage?.buildings ?? []).map((b) => b.people ?? 0)), [triage]);
  const box = useMemo(() => {
    const bs = city?.buildings ?? [];
    if (!bs.length) return null;
    const xs = bs.map((b) => b.x), zs = bs.map((b) => b.z);
    return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  }, [city]);
  const worked = useMemo(() => new Map(cards.map((c) => [c.pid, c])), [cards]);
  if (!city || !box) return <p style={{ color: MUTED, padding: 12, margin: 0 }}>Loading the city…</p>;
  const span = Math.max(box.x1 - box.x0, box.z1 - box.z0);
  const unit = span / 260; // dot sizes scale with the map, so they read at any zoom
  const pad = unit * 8;
  const colour = (b: CityBuilding) => {
    const t = tags[b.pid];
    if (t) return TAG_COLOR[t];
    const c = worked.get(b.pid);
    const r = risk.get(b.pid);
    if (r?.suggest === "red" || r?.suggest === "yellow" || r?.suggest === "green") return TAG_COLOR[r.suggest as Tag];
    if (c?.math) return AMBER;
    if (c) return SKY;
    return b.case ? "#94a3b8" : "#334155";
  };
  // the buildings Bob is working draw last, so they sit on top of the city
  const order = [...city.buildings].sort((a, b) => Number(!!tags[a.pid] || worked.has(a.pid) || a.pid === selected) - Number(!!tags[b.pid] || worked.has(b.pid) || b.pid === selected));
  return (
    <svg viewBox={`${box.x0 - pad} ${box.z0 - pad} ${box.x1 - box.x0 + 2 * pad} ${box.z1 - box.z0 + 2 * pad}`} style={{ display: "block", width: "100%", height: "100%", minHeight: 0 }} preserveAspectRatio="xMidYMid meet" aria-label="LA city map, coloured by the code's screening and the agent's work">
      {order.map((b) => {
        const tri = risk.get(b.pid);
        const hot = !!tags[b.pid] || worked.has(b.pid);
        const r = unit * (hot ? 5 : tri ? 1 + 3.5 * Math.sqrt((tri.people ?? 0) / maxPeople) : b.case ? 2.6 : 1.2);
        return (
          <circle key={b.pid} cx={b.x} cy={b.z} r={r} fill={colour(b)} opacity={hot ? 1 : b.case ? 0.85 : 0.55}
            stroke={b.pid === selected ? "#fff" : hot ? "#0b0b0c" : "none"} strokeWidth={unit * (b.pid === selected ? 1.6 : 0.6)}
            style={{ cursor: "pointer" }} onClick={() => onSelect(b.pid)}>
            <title>{`${tri?.label ?? b.pid}${b.case ? ` · ${CASE_WORDS[b.case] ?? b.case}` : ""}${tri ? ` · ${tri.people ?? "?"} people · damage ${Math.round((tri.p_damage ?? 0) * 100)}% · suggests ${tri.suggest ?? "?"}` : ""}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

const pane: React.CSSProperties = { background: "rgba(17,17,19,.94)", borderRadius: 3, padding: "10px 12px", overflow: "auto", minHeight: 0, minWidth: 0 };
const head: React.CSSProperties = { margin: "0 0 8px", font: `600 12px/1.2 ${UI}`, letterSpacing: ".08em", textTransform: "uppercase", color: FAINT, display: "flex", alignItems: "baseline", gap: 8 };

export function DeskView({ messages, threadId, cases, tags = {}, precalls = {}, onPrecall, clock, busy, onVisit, onClose }: {
  messages: readonly unknown[]; threadId: string | null; cases: DeskCase[]; tags?: Record<string, Tag>; clock: string; busy: boolean;
  /** Bob's own call from the card and the aerial, made before the scan squad reports; graded against the final tag at dawn. */
  precalls?: Record<string, Tag>; onPrecall?(pid: string, t: Tag): void;
  onVisit(c: DeskCase): void; onClose(): void;
}) {
  const { steps } = useAgentLog(threadId, true);
  const cards = useMemo(() => cardsFrom(steps), [steps]);
  const [city, setCity] = useState<City | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [triage, setTriage] = useState<Triage | null>(null);
  const [fetched, setFetched] = useState<Record<string, DeskCard>>({});
  const live = useMemo(() => streamCards(messages), [messages]);
  const tagCount = Object.keys(tags).length;
  useEffect(() => {
    let alive = true;
    fetch("/api/game/triage?scope=city").then((r) => (r.ok ? r.json() : null)).then((d: Triage | null) => alive && d && setTriage(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [tagCount]);
  const casePids = cases.map((c) => c.property_id).join(",");
  useEffect(() => {
    let alive = true;
    for (const pid of casePids ? casePids.split(",") : []) {
      fetch(`/api/game/card/${encodeURIComponent(pid)}`).then((r) => (r.ok ? r.json() : null)).then((d: DeskCard | null) => alive && d?.pid && setFetched((m) => ({ ...m, [pid]: d }))).catch(() => {});
    }
    return () => {
      alive = false;
    };
  }, [casePids]);
  // A tag colour appears only once the agent screens the building after the quake (screen_building); before that the
  // card shows the score alone, so no placard colour is implied ahead of the simulated quake.
  const screened = useMemo(() => {
    const out = new Set<string>();
    for (const raw of messages) {
      const m = raw as Msg;
      if (kind(m) === "tool" && m.name === "screen_building") {
        const r = parse<{ pid?: string }>(m);
        if (r?.pid) out.add(String(r.pid));
      }
    }
    return out;
  }, [messages]);
  const deskCards = useMemo(() => {
    const all = { ...fetched, ...Object.fromEntries(live) } as Record<string, DeskCard>;
    for (const [pid, c] of Object.entries(all)) {
      if (!screened.has(pid) && c.screening?.suggest) all[pid] = { ...c, screening: { ...c.screening, suggest: undefined } };
    }
    return all;
  }, [fetched, live, screened]);
  const [pulling, setPulling] = useState<string | null>(null);
  const pick = (pid: string) => {
    setSelected(pid);
    if (deskCards[pid]) return;
    setPulling(pid);
    fetch(`/api/game/card/${encodeURIComponent(pid)}?live=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: DeskCard | null) => d?.pid && setFetched((m) => ({ ...m, [pid]: d })))
      .catch(() => {})
      .finally(() => setPulling((x) => (x === pid ? null : x)));
  };
  useEffect(() => {
    let alive = true;
    fetch("/api/game/city").then((r) => (r.ok ? r.json() : null)).then((d: City | null) => alive && d && setCity(d)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  const labels = useMemo(() => new Map(cases.map((c) => [c.property_id, c.label])), [cases]);
  const sheet = useMemo(() => {
    const own = selected ? cards.find((c) => c.pid === selected)?.math : null;
    const last = [...steps].reverse().find((s) => s.kind === "result" && s.math) as Extract<LogStep, { kind: "result" }> | undefined;
    return own ?? last?.math ?? null;
  }, [selected, cards, steps]);
  // the building the sheet's maths belongs to (each card keeps its newest weigh, so the newest maths is one card's own)
  const sheetPid = sheet ? cards.find((c) => c.math === sheet)?.pid ?? null : null;
  const radio = useMemo(() => radioLines(messages).slice(-10), [messages]);
  const all = useMemo(() => {
    const byPid = new Map(cards.map((c) => [c.pid, c]));
    for (const pid of Object.keys(deskCards)) if (!byPid.has(pid)) byPid.set(pid, { pid, label: deskCards[pid].label ?? null, lines: [], math: null, busy: false });
    return [...byPid.values()];
  }, [cards, deskCards]);
  const shown = selected ? [...all].sort((a, b) => (a.pid === selected ? -1 : b.pid === selected ? 1 : 0)) : [...all].reverse();
  const nameOf = (pid: string, c?: Card) => labels.get(pid) ?? deskCards[pid]?.label ?? c?.label ?? `Building ${pid}`;

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "grid", gridTemplateColumns: "clamp(220px, 17vw, 268px) minmax(0, 1fr) clamp(330px, 29vw, 440px)", gridTemplateRows: "auto minmax(0, 1fr) auto", gap: 8, padding: 10, background: "rgba(5,5,7,.88)", color: INK, font: `14px/1.4 ${UI}`, pointerEvents: "auto", overflow: "hidden", boxSizing: "border-box" }}>
      <header style={{ gridColumn: "1 / -1", display: "flex", alignItems: "baseline", gap: 14, padding: "2px 4px 0", minWidth: 0 }}>
        <b style={{ flex: "none", font: `700 22px/1 ${UI}` }}>LA Building Office · Bob&apos;s desk</b>
        <span style={{ flex: "none", color: AMBER, fontWeight: 700, fontSize: 18, fontVariantNumeric: "tabular-nums" }}>{clock}</span>
        <span style={{ minWidth: 0, color: MUTED, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Retrofit-deadline day. The agent is your analyst: it pulls the data; code does every number.</span>
        <span style={{ flex: 1 }} />
        {busy && <span style={{ flex: "none", color: SKY, fontWeight: 600 }}>● the agent is working</span>}
        <button type="button" onClick={onClose} style={{ flex: "none", padding: "5px 12px", border: `1px solid ${FAINT}`, borderRadius: 2, background: "transparent", color: INK, font: `500 13px ${UI}`, cursor: "pointer" }}>[Tab] back to the street</button>
      </header>

      <section style={{ ...pane, gridColumn: "1", gridRow: "2" }} aria-label="Inbox">
        <h3 style={head}>Inbox <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· real open cases</span></h3>
        {!cases.length && <p style={{ color: MUTED, margin: 0 }}>{busy ? "The agent is reading the queue…" : "No cases yet."}</p>}
        {cases.map((c) => {
          const t = tags[c.property_id];
          const on = c.property_id === selected;
          return (
            <article key={`${c.property_id}-${c.suite ?? ""}`} onClick={() => setSelected(c.property_id)}
              style={{ padding: "7px 8px", margin: "0 -8px 4px", borderRadius: 2, borderLeft: `2px solid ${on ? AMBER : "transparent"}`, background: on ? "rgba(245,165,36,.07)" : "transparent", cursor: "pointer" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
                <b style={{ flex: "none", color: FAINT }}>#{c.n}</b>
                <b style={{ flex: 1, minWidth: 0, fontWeight: 600 }}>{c.label}{c.suite && !c.label.includes(`suite ${c.suite}`) ? `, suite ${c.suite}` : ""}</b>
                {t && <TagChip t={t} />}
              </div>
              <div style={{ color: AMBER, fontSize: 13, fontWeight: 500 }}>{CASE_WORDS[c.case] ?? plain(c.case)}</div>
              {c.question && <div title={c.question} style={{ color: MUTED, fontSize: 13, ...clamp(3) }}>{c.question}</div>}
              {c.stakes && <div title={c.stakes} style={{ color: FAINT, fontSize: 12, ...clamp(2) }}>{c.stakes}</div>}
              <button type="button" onClick={(e) => { e.stopPropagation(); onVisit(c); }} style={{ marginTop: 5, padding: "3px 10px", border: "none", borderRadius: 2, background: AMBER, color: "#111", font: `700 13px ${UI}`, cursor: "pointer" }}>Site visit →</button>
            </article>
          );
        })}
      </section>

      <section style={{ ...pane, gridColumn: "2", gridRow: "2" }} aria-label="Building cards">
        <h3 style={head}>Building cards <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· filling in as each squad reports; every line names its source</span></h3>
        {!all.length && <p style={{ color: MUTED, margin: 0 }}>Cards appear as the agent pulls each building&apos;s data.</p>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 340px), 1fr))", gap: 8, alignItems: "start" }}>
          {shown.map((c) => {
            const card = deskCards[c.pid];
            const v = verdictOf(c.math);
            const on = c.pid === selected;
            // Bob's call from outside: kept near the top of the card, above the source list, so it is always in view
            const precall = onPrecall && !tags[c.pid] && (() => {
              const scanned = (card?.sources ?? []).some((x) => x.key === "matterport" && x.status === "ok") && live.has(c.pid);
              const mine = precalls[c.pid];
              if (scanned && !mine) return null;
              return (
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8, fontSize: 13, flexWrap: "wrap" }} onClick={(e) => e.stopPropagation()}>
                  <span style={{ color: MUTED }}>{mine ? "Your call from outside:" : "Call it from outside:"}</span>
                  {(["green", "yellow", "red"] as Tag[]).map((t) => (
                    <button key={t} type="button" disabled={!!mine} onClick={() => onPrecall(c.pid, t)}
                      style={{ padding: "2px 10px", border: `1px solid ${TAG_COLOR[t]}`, borderRadius: 2, background: mine === t ? TAG_COLOR[t] : "transparent", color: mine === t ? "#111" : TAG_COLOR[t], font: `700 13px ${UI}`, cursor: mine ? "default" : "pointer", opacity: mine && mine !== t ? 0.35 : 1 }}>
                      {t}
                    </button>
                  ))}
                </div>
              );
            })();
            return (
              <article key={c.pid} onClick={() => setSelected(c.pid)} style={{ borderRadius: 3, padding: "9px 11px 10px", background: on ? "rgba(245,165,36,.06)" : "rgba(255,255,255,.035)", boxShadow: on ? `inset 0 0 0 1px ${AMBER}` : `inset 0 0 0 1px ${HAIR}`, cursor: "pointer", minWidth: 0 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                  <b style={{ flex: "1 1 auto", minWidth: 0, font: `700 17px/1.2 ${UI}` }}>{nameOf(c.pid, c)}</b>
                  {c.busy && <span style={{ color: SKY, fontSize: 12, fontWeight: 600 }}>pulling…</span>}
                  {card?.screening?.suggest && <ScreensChip s={card.screening.suggest} />}
                  {tags[c.pid] && <TagChip t={tags[c.pid]} />}
                </div>
                {v && (
                  <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }} title="The agent's verdict; the odds are computed in code (see the calculation sheet)">
                    <span style={{ color: AMBER, font: `700 22px/1.1 ${UI}`, fontVariantNumeric: "tabular-nums" }}>{v.pct}</span>
                    <span style={{ color: AMBER, fontWeight: 600 }}>{v.label} {v.what}</span>
                  </div>
                )}
                {card ? <SourceBlock card={card} slot={precall} /> : precall}
                {c.lines.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <div style={{ color: FAINT, fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase" }}>Squad reports</div>
                    <ul style={{ listStyle: "none", margin: "2px 0 0", padding: 0, fontSize: 12.5 }}>
                      {c.lines.slice(-4).map((l) => (
                        <li key={l.n} style={{ padding: "3px 0", borderTop: `1px solid ${HAIR}` }}>
                          <span style={{ color: "#a5b4fc" }}>{l.source || l.actor}</span>
                          <div title={l.text} style={{ color: MUTED, ...clamp(2) }}>{l.text}</div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>

      <section style={{ ...pane, padding: 0, gridColumn: "3", gridRow: "2", display: "grid", gridTemplateRows: "auto minmax(0, 1fr) auto", overflow: "hidden" }} aria-label="City map">
        <h3 style={{ ...head, margin: 0, padding: "10px 12px 0" }}>City map <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· click any building for its card</span></h3>
        <div style={{ minHeight: 0, background: "#08090c", margin: "6px 8px 0", borderRadius: 2 }}>
          <CityPane city={city} cards={cards} tags={tags} triage={triage} selected={selected} onSelect={pick} />
        </div>
        <div style={{ display: "flex", gap: "2px 10px", padding: "6px 12px 8px", fontSize: 12, color: MUTED, flexWrap: "wrap" }}>
          {triage?.counts && (
            <span style={{ flexBasis: "100%", color: INK, fontSize: 13 }}>
              All LA, {(triage.buildings ?? []).length.toLocaleString("en-US")} buildings screened in code: <b style={{ color: TAG_COLOR.green }}>{n(triage.counts.green ?? 0)}</b> green · <b style={{ color: TAG_COLOR.yellow }}>{n(triage.counts.yellow ?? 0)}</b> yellow · <b style={{ color: TAG_COLOR.red }}>{n(triage.counts.red ?? 0)}</b> red
              {triage.people_at_stake ? <span style={{ color: MUTED }}> · about {Math.round(triage.people_at_stake / 1000)}k people inside by day</span> : null}
            </span>
          )}
          {pulling && <span style={{ flexBasis: "100%", color: SKY }}>Pulling building {pulling}&apos;s card (live from the sources)…</span>}
          <span><i style={{ color: SKY, fontStyle: "normal" }}>●</i> being worked</span>
          <span><i style={{ color: AMBER, fontStyle: "normal" }}>●</i> weighed</span>
          <span><i style={{ color: TAG_COLOR.green, fontStyle: "normal" }}>●</i> green</span>
          <span><i style={{ color: TAG_COLOR.yellow, fontStyle: "normal" }}>●</i> yellow</span>
          <span><i style={{ color: TAG_COLOR.red, fontStyle: "normal" }}>●</i> red</span>
          <span><i style={{ color: "#94a3b8", fontStyle: "normal" }}>●</i> open case</span>
          <span style={{ flexBasis: "100%", color: FAINT }}>Map colours: a records-only screening, before any evidence · simulated · game outcome, not an engineering assessment.</span>
        </div>
      </section>

      <section style={{ ...pane, gridColumn: "1", gridRow: "3", contain: "size", display: "flex", flexDirection: "column", overflow: "hidden" }} aria-label="Squad radio">
        <h3 style={head}>Squad radio</h3>
        {/* column-reverse keeps the newest line in view; the inner block reads top to bottom */}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column-reverse" }}>
          <div>
            {radio.map((l) => (
              <div key={l.id} style={{ fontSize: 13, padding: "2px 0", color: MUTED }}>
                <b style={{ color: l.tone === "you" ? SKY : l.tone === "warn" ? "#f87171" : AMBER }}>{l.who}</b> {l.text}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section style={{ ...pane, gridColumn: "2 / 4", gridRow: "3", maxHeight: "min(400px, 46vh)", minHeight: 170, padding: "12px 16px", background: "rgba(16,14,10,.94)", boxShadow: `inset 0 2px 0 ${AMBER}` }} aria-label="Calculation sheet">
        <h3 style={{ ...head, color: AMBER }}>Calculation sheet <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: MUTED }}>· the evidence maths, done in code (no model): start → each check&apos;s shift → sum → ÷ total → %</span></h3>
        {sheet ? <Sheet m={sheet} name={sheetPid ? nameOf(sheetPid) : null} card={sheetPid ? deskCards[sheetPid] : undefined} tag={sheetPid ? tags[sheetPid] : undefined} following={!!selected && sheetPid !== selected} /> : <p style={{ color: MUTED, margin: 0 }}>The maths appears when the agent weighs a case.</p>}
      </section>
    </div>
  );
}

/** The sheet, front and centre: the building and the verdict at a glance, then the arithmetic that gets there. */
function Sheet({ m, name, card, tag, following }: { m: LogMath; name: string | null; card?: DeskCard; tag?: Tag; following: boolean }) {
  const v = verdictOf(m);
  const ppl = card?.people;
  return (
    <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "0 1 270px", minWidth: 220 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <b style={{ font: `700 19px/1.2 ${UI}` }}>{name ?? "The latest case"}</b>
          {card?.screening?.suggest && <ScreensChip s={card.screening.suggest} />}
          {tag && <TagChip t={tag} />}
        </div>
        {following && <div style={{ color: FAINT, fontSize: 12 }}>(the latest weighed case; the selected building has no maths yet)</div>}
        {v && (
          <div style={{ marginTop: 4 }}>
            <div style={{ color: AMBER, font: `700 46px/1 ${UI}`, fontVariantNumeric: "tabular-nums" }}>{v.pct}</div>
            <div style={{ color: AMBER, font: `600 16px/1.25 ${UI}` }}>{v.label} {v.what}</div>
          </div>
        )}
        {ppl && (ppl.low != null || ppl.day != null) && (
          <div style={{ marginTop: 8, color: INK }}>
            <b style={{ fontSize: 17 }}>{ppl.low != null && ppl.high != null ? `${n(ppl.low)}–${n(ppl.high)}` : n(ppl.day ?? 0)}</b> <span style={{ color: MUTED }}>people inside by day (an estimate)</span>
            {ppl.at_5pm != null && <div><b>{n(ppl.at_5pm)}</b> <span style={{ color: MUTED }}>inside at 5 pm</span></div>}
          </div>
        )}
        {(card?.conflicts ?? []).map((k, i) => <Conflict key={i} k={k} />)}
      </div>
      <div className="desk-sheet-table" style={{ flex: "1 1 420px", minWidth: 0 }}>
        <style>{".desk-sheet-table{zoom:.88}@media (min-width:1400px){.desk-sheet-table{zoom:1}}"}</style>
        <MathTable m={m} big />
      </div>
    </div>
  );
}

function Conflict({ k }: { k: NonNullable<DeskCard["conflicts"]>[number] }) {
  return (
    <div style={{ margin: "8px 0 2px", padding: "6px 9px", borderRadius: 2, border: `1px solid ${AMBER}`, background: "rgba(245,165,36,.1)", boxShadow: "0 0 12px rgba(245,165,36,.3)", color: "#fde68a", fontSize: 13 }}>
      <div style={{ color: AMBER, fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase" }}>Sources disagree · {plain(k.field)}</div>
      {k.a.source} says <b style={{ color: "#fff" }}>{String(k.a.value)}</b> · {k.b.source} says <b style={{ color: "#fff" }}>{String(k.b.value)}</b>
    </div>
  );
}

const STATUS_COLOR = { ok: "#4cc38a", missing: "#64748b", conflict: AMBER } as const;
const STATUS_WORD = { ok: "", missing: "not on file", conflict: "disagrees" } as const;

/** The card's data, source by source; conflicts between sources glow amber; people as an estimated range. */
function SourceBlock({ card, slot }: { card: DeskCard; slot?: React.ReactNode }) {
  const ppl = card.people;
  return (
    <div style={{ marginTop: 6, fontSize: 13 }}>
      {ppl && (ppl.low != null || ppl.day != null) && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: "0 10px" }}>
          <span><b style={{ fontSize: 16 }}>{ppl.low != null && ppl.high != null ? `${n(ppl.low)}–${n(ppl.high)}` : n(ppl.day ?? 0)}</b> <span style={{ color: MUTED }}>people inside by day</span></span>
          {ppl.at_5pm != null && <span><b style={{ fontSize: 16 }}>{n(ppl.at_5pm)}</b> <span style={{ color: MUTED }}>inside at 5 pm</span></span>}
          {ppl.night != null && <span style={{ color: MUTED }}>by night {n(ppl.night)}</span>}
        </div>
      )}
      {ppl?.basis && <div title={ppl.basis} style={{ color: FAINT, fontSize: 12, ...clamp(1) }}>An estimate: {ppl.basis}</div>}
      {card.screening?.score != null && (
        <div style={{ color: MUTED, fontSize: 12 }}>Screening score {card.screening.score}{card.screening.fema_type ? ` · ${card.screening.fema_type}` : ""}</div>
      )}
      {(card.conflicts ?? []).map((k, i) => <Conflict key={i} k={k} />)}
      {slot}
      <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
        {(card.sources ?? []).map((src) => (
          <li key={src.key} style={{ padding: "4px 0", borderTop: `1px solid ${HAIR}`, display: "grid", gridTemplateColumns: "10px minmax(0, 1fr)", columnGap: 6 }}>
            <span style={{ color: STATUS_COLOR[src.status] ?? "#94a3b8", fontSize: 10, lineHeight: "18px" }}>●</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                <span style={{ color: "#c7d2fe", fontWeight: 600 }}>{src.source}</span>
                {STATUS_WORD[src.status] && <span style={{ marginLeft: "auto", color: STATUS_COLOR[src.status], fontSize: 12 }}>{STATUS_WORD[src.status]}</span>}
              </div>
              {(src.lines ?? []).slice(0, 2).map((l, i) => <div key={i} style={{ color: MUTED, fontSize: 12.5 }}>{l}</div>)}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
