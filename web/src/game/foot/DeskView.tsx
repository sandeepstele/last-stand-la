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
  people?: { day?: number; night?: number; at_stake?: number; low?: number; high?: number; basis?: string };
  screening?: { score?: number; fema_type?: string; suggest?: string };
};
type Triage = { buildings?: { pid: string; label?: string; people?: number; p_damage?: number; at_risk?: number; suggest?: string; rank?: number }[]; basis?: string };

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
      c.lines.push({ n: s.n, actor: call.actor.replace(/\s*\(.*\)\s*$/, ""), source: call.source, text: s.summary });
    }
  }
  return [...cards.values()].filter((c) => c.lines.length || c.busy);
}

function verdictLine(m: LogMath | null): string | null {
  if (!m?.leader) return null;
  return `${m.label ?? "leaning"} ${SHORT[m.leader] ?? plain(m.leader)}, ${Math.round((m.confidence ?? 0) * 100)}%`;
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
  if (!city || !box) return <p style={{ color: "#94a3b8" }}>Loading the city…</p>;
  const span = Math.max(box.x1 - box.x0, box.z1 - box.z0);
  const unit = span / 260; // dot sizes scale with the map, so they read at any zoom
  const pad = unit * 8;
  const colour = (b: CityBuilding) => {
    const t = tags[b.pid];
    if (t) return TAG_COLOR[t];
    const c = worked.get(b.pid);
    const r = risk.get(b.pid);
    if (r?.suggest === "red" || r?.suggest === "yellow" || r?.suggest === "green") return TAG_COLOR[r.suggest as Tag];
    if (c?.math) return "#f5a524";
    if (c) return "#38bdf8";
    return b.case ? "#94a3b8" : "#334155";
  };
  return (
    <svg viewBox={`${box.x0 - pad} ${box.z0 - pad} ${box.x1 - box.x0 + 2 * pad} ${box.z1 - box.z0 + 2 * pad}`} style={{ width: "100%", height: "100%", background: "#0b1220" }} preserveAspectRatio="xMidYMid meet" aria-label="LA city map, coloured as the agent works">
      {city.buildings.map((b) => {
        const tri = risk.get(b.pid);
        const hot = !!tags[b.pid] || worked.has(b.pid) || !!tri;
        const r = unit * (tags[b.pid] || worked.has(b.pid) ? 5 : tri ? 2 + 4 * Math.sqrt((tri.people ?? 0) / maxPeople) : b.case ? 2.6 : 1.2);
        return (
          <circle key={b.pid} cx={b.x} cy={b.z} r={r} fill={colour(b)} opacity={hot ? 1 : b.case ? 0.8 : 0.5}
            stroke={b.pid === selected ? "#fff" : hot ? "#0b1220" : "none"} strokeWidth={unit * (b.pid === selected ? 1.6 : 0.6)}
            style={{ cursor: hot || b.case ? "pointer" : "default" }} onClick={() => (hot || b.case) && onSelect(b.pid)}>
            <title>{`${tri?.label ?? b.pid}${b.case ? ` · ${CASE_WORDS[b.case] ?? b.case}` : ""}${tri ? ` · ${tri.people ?? "?"} people · damage ${Math.round((tri.p_damage ?? 0) * 100)}% · suggests ${tri.suggest ?? "?"}` : ""}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

const pane: React.CSSProperties = { background: "rgba(10,14,24,.94)", border: "1px solid #1e293b", padding: "10px 12px", overflow: "auto", minHeight: 0 };
const head: React.CSSProperties = { margin: "0 0 8px", font: "600 13px/1.2 system-ui, sans-serif", letterSpacing: ".06em", textTransform: "uppercase", color: "#94a3b8" };

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
    fetch("/api/game/triage").then((r) => (r.ok ? r.json() : null)).then((d: Triage | null) => alive && d && setTriage(d)).catch(() => {});
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
  const deskCards = useMemo(() => ({ ...fetched, ...Object.fromEntries(live) }) as Record<string, DeskCard>, [fetched, live]);
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
  const sheetPid = selected && cards.find((c) => c.pid === selected)?.math ? selected : null;
  const radio = useMemo(() => radioLines(messages).slice(-7), [messages]);
  const all = useMemo(() => {
    const byPid = new Map(cards.map((c) => [c.pid, c]));
    for (const pid of Object.keys(deskCards)) if (!byPid.has(pid)) byPid.set(pid, { pid, label: deskCards[pid].label ?? null, lines: [], math: null, busy: false });
    return [...byPid.values()];
  }, [cards, deskCards]);
  const shown = selected ? [...all].sort((a, b) => (a.pid === selected ? -1 : b.pid === selected ? 1 : 0)) : [...all].reverse();

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 50, display: "grid", gridTemplateColumns: "300px 1fr 420px", gridTemplateRows: "auto 1fr 250px", gap: 8, padding: 10, background: "rgba(3,6,12,.82)", color: "#e2e8f0", font: "14px/1.45 system-ui, sans-serif", pointerEvents: "auto" }}>
      <header style={{ gridColumn: "1 / -1", display: "flex", alignItems: "baseline", gap: 14, padding: "4px 4px 0" }}>
        <b style={{ font: "700 22px/1 system-ui, sans-serif" }}>LA Building Office · Bob&apos;s desk</b>
        <span style={{ color: "#f5a524", fontWeight: 600 }}>{clock}</span>
        <span style={{ color: "#94a3b8" }}>Retrofit-deadline day. The agent is your analyst: it pulls the data; code does every number.</span>
        <span style={{ flex: 1 }} />
        {busy && <span style={{ color: "#38bdf8" }}>● the agent is working</span>}
        <button type="button" onClick={onClose} style={{ padding: "6px 12px", border: "1px solid #475569", background: "transparent", color: "#e2e8f0", cursor: "pointer" }}>[Tab] back to the street</button>
      </header>

      <section style={{ ...pane, gridRow: "2 / 4" }} aria-label="Inbox">
        <h3 style={head}>Inbox · real open cases</h3>
        {!cases.length && <p style={{ color: "#94a3b8" }}>{busy ? "The agent is reading the queue…" : "No cases yet."}</p>}
        {cases.map((c) => {
          const t = tags[c.property_id];
          return (
            <article key={`${c.property_id}-${c.suite ?? ""}`} style={{ padding: "8px 0", borderBottom: "1px solid #1e293b", cursor: "pointer" }} onClick={() => setSelected(c.property_id)}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <b>#{c.n}</b>
                <span style={{ flex: 1 }}>{c.label}{c.suite ? `, suite ${c.suite}` : ""}</span>
                {t && <span title="Simulated: game outcome, not an engineering assessment" style={{ background: TAG_COLOR[t], color: "#111", padding: "0 6px", fontWeight: 700, fontSize: 12 }}>{t.toUpperCase()} · sim</span>}
              </div>
              <div style={{ color: "#94a3b8", fontSize: 13 }}>{CASE_WORDS[c.case] ?? plain(c.case)}{c.stakes ? ` · ${c.stakes}` : ""}</div>
              {c.question && <div style={{ color: "#cbd5e1", fontSize: 13 }}>{c.question}</div>}
              <button type="button" onClick={(e) => { e.stopPropagation(); onVisit(c); }} style={{ marginTop: 6, padding: "4px 10px", border: "none", background: "#f5a524", color: "#111", fontWeight: 700, cursor: "pointer" }}>Site visit →</button>
            </article>
          );
        })}
      </section>

      <section style={{ ...pane, gridRow: "2 / 3" }} aria-label="Building cards">
        <h3 style={head}>Building cards · filling in as each squad reports</h3>
        {!cards.length && <p style={{ color: "#94a3b8" }}>Cards appear as the agent pulls each building&apos;s data.</p>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 8 }}>
          {shown.map((c) => (
            <article key={c.pid} onClick={() => setSelected(c.pid)} style={{ border: `1px solid ${c.pid === selected ? "#f5a524" : "#1e293b"}`, padding: 8, background: "#0b1220", cursor: "pointer" }}>
              <div style={{ display: "flex", gap: 6, alignItems: "baseline" }}>
                <b style={{ flex: 1 }}>{labels.get(c.pid) ?? deskCards[c.pid]?.label ?? c.label ?? `Building ${c.pid}`}</b>
                {deskCards[c.pid]?.screening?.suggest && !tags[c.pid] && <span style={{ border: `1px solid ${TAG_COLOR[deskCards[c.pid].screening!.suggest as Tag] ?? "#475569"}`, color: TAG_COLOR[deskCards[c.pid].screening!.suggest as Tag] ?? "#cbd5e1", padding: "0 6px", fontSize: 12 }}>screens {deskCards[c.pid].screening!.suggest}</span>}
                {tags[c.pid] && <span title="Simulated: game outcome, not an engineering assessment" style={{ background: TAG_COLOR[tags[c.pid]], color: "#111", padding: "0 6px", fontWeight: 700, fontSize: 12 }}>{tags[c.pid].toUpperCase()} · sim</span>}
                {c.busy && <span style={{ color: "#38bdf8", fontSize: 12 }}>pulling…</span>}
              </div>
              {verdictLine(c.math) && <div style={{ color: "#f5a524", fontWeight: 600 }}>{verdictLine(c.math)}</div>}
              {deskCards[c.pid] && <SourceBlock card={deskCards[c.pid]} />}
              {onPrecall && !tags[c.pid] && (() => {
                const scanned = (deskCards[c.pid]?.sources ?? []).some((x) => x.key === "matterport" && x.status === "ok") && live.has(c.pid);
                const mine = precalls[c.pid];
                if (scanned && !mine) return null;
                return (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, fontSize: 12 }} onClick={(e) => e.stopPropagation()}>
                    <span style={{ color: "#94a3b8" }}>{mine ? "Your call from outside:" : "Call it from outside:"}</span>
                    {(["green", "yellow", "red"] as Tag[]).map((t) => (
                      <button key={t} type="button" disabled={!!mine} onClick={() => onPrecall(c.pid, t)}
                        style={{ padding: "2px 8px", border: `1px solid ${TAG_COLOR[t]}`, background: mine === t ? TAG_COLOR[t] : "transparent", color: mine === t ? "#111" : TAG_COLOR[t], fontWeight: 700, cursor: mine ? "default" : "pointer", opacity: mine && mine !== t ? 0.35 : 1 }}>
                        {t}
                      </button>
                    ))}
                  </div>
                );
              })()}
              <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0, fontSize: 12.5 }}>
                {c.lines.slice(-6).map((l) => (
                  <li key={l.n} style={{ padding: "3px 0", borderTop: "1px solid #111827" }}>
                    <span style={{ color: "#a5b4fc" }}>{l.source || l.actor}</span>
                    <div style={{ color: "#cbd5e1" }}>{l.text.slice(0, 220)}</div>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section style={{ ...pane, padding: 0, gridColumn: "3", gridRow: "2 / 3", display: "grid", gridTemplateRows: "1fr auto" }} aria-label="City map">
        <CityPane city={city} cards={cards} tags={tags} triage={triage} selected={selected} onSelect={setSelected} />
        <div style={{ display: "flex", gap: 10, padding: "6px 10px", fontSize: 12, color: "#94a3b8", flexWrap: "wrap" }}>
          <span><i style={{ color: "#38bdf8" }}>●</i> being worked</span>
          <span><i style={{ color: "#f5a524" }}>●</i> weighed</span>
          <span><i style={{ color: TAG_COLOR.green }}>●</i> green</span>
          <span><i style={{ color: TAG_COLOR.yellow }}>●</i> yellow</span>
          <span><i style={{ color: TAG_COLOR.red }}>●</i> red</span>
          <span><i style={{ color: "#94a3b8" }}>●</i> open case</span>
          <span style={{ flexBasis: "100%", color: "#64748b" }}>Tags are simulated: game outcome, not an engineering assessment.</span>
        </div>
      </section>

      <section style={{ ...pane, gridColumn: "2", gridRow: "3 / 4" }} aria-label="Squad radio">
        <h3 style={head}>Squad radio</h3>
        {radio.map((l) => (
          <div key={l.id} style={{ fontSize: 13 }}>
            <b style={{ color: l.tone === "you" ? "#38bdf8" : l.tone === "warn" ? "#f87171" : "#f5a524" }}>{l.who}</b> {l.text}
          </div>
        ))}
      </section>

      <section style={{ ...pane, gridColumn: "3", gridRow: "3 / 4" }} aria-label="Calculation sheet">
        <h3 style={head}>Calculation sheet{sheetPid ? ` · ${labels.get(sheetPid) ?? sheetPid}` : " · latest"}</h3>
        {sheet ? <MathTable m={sheet} big={false} /> : <p style={{ color: "#94a3b8", fontSize: 13 }}>The maths appears when the agent weighs a case.</p>}
      </section>
    </div>
  );
}

const STATUS_COLOR = { ok: "#4cc38a", missing: "#475569", conflict: "#f5a524" } as const;

/** The card's data, source by source; conflicts between sources glow amber; people as an estimated range. */
function SourceBlock({ card }: { card: DeskCard }) {
  const ppl = card.people;
  return (
    <div style={{ marginTop: 4, fontSize: 12.5 }}>
      {ppl && (ppl.low != null || ppl.day != null) && (
        <div style={{ color: "#cbd5e1" }}>
          Inside by day: {ppl.low != null && ppl.high != null ? `${ppl.low}–${ppl.high}` : ppl.day} <span style={{ color: "#64748b" }}>(an estimate{ppl.basis ? `: ${ppl.basis}` : ""})</span>
          {ppl.night != null && <> · by night {ppl.night}</>}
        </div>
      )}
      {card.screening?.score != null && (
        <div style={{ color: "#cbd5e1" }}>Screening score {card.screening.score}{card.screening.fema_type ? ` · ${card.screening.fema_type}` : ""}</div>
      )}
      {(card.conflicts ?? []).map((k, i) => (
        <div key={i} style={{ margin: "4px 0", padding: "4px 6px", border: "1px solid #f5a524", boxShadow: "0 0 10px rgba(245,165,36,.35)", color: "#fde68a" }}>
          {plain(k.field)}: {k.a.source} says <b>{String(k.a.value)}</b> · {k.b.source} says <b>{String(k.b.value)}</b>
        </div>
      ))}
      <ul style={{ listStyle: "none", margin: "4px 0 0", padding: 0 }}>
        {(card.sources ?? []).map((src) => (
          <li key={src.key} style={{ padding: "2px 0", borderTop: "1px solid #111827" }}>
            <span style={{ color: STATUS_COLOR[src.status] ?? "#94a3b8" }}>●</span> <span style={{ color: "#a5b4fc" }}>{src.source}</span>
            {src.status === "missing" && <span style={{ color: "#64748b" }}> · not on file</span>}
            {(src.lines ?? []).slice(0, 2).map((l, i) => <div key={i} style={{ color: "#cbd5e1", paddingLeft: 12 }}>{l}</div>)}
          </li>
        ))}
      </ul>
    </div>
  );
}
