"use client";
// Agent vs Bob, at dawn: for each placard, what the agent proposed, what Bob posted, and what the simulated aftershock
// says was right. This is the human-feedback loop made visible: Bob's override, graded by the outcome, goes into the
// agent's shift log, which it reads the next morning. A running record across shifts is kept in this browser.
// Honest framing: in-context learning from human corrections; no model is trained. OWNER: coding lead.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { kind, parse, type Msg } from "../radio";
import type { ShiftReport, Tag } from "../useGame";

type TagRow = { pid: string; label: string; agent: Tag | null; bob: Tag | null; right: Tag | null };
type Track = { key: string; rows: { agent: Tag | null; bob: Tag | null; right: Tag | null }[] };

const KEY = "laststand.track.v1";
const EVT = "laststand:track";
const COLOR: Record<Tag, string> = { green: "#4cc38a", yellow: "#f5c524", red: "#e5484d" };

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
const subscribe = (f: () => void) => {
  window.addEventListener("storage", f);
  window.addEventListener(EVT, f);
  return () => {
    window.removeEventListener("storage", f);
    window.removeEventListener(EVT, f);
  };
};
function tracks(raw: string | null): Track[] {
  try {
    const t = raw ? (JSON.parse(raw) as Track[]) : [];
    return Array.isArray(t) ? t : [];
  } catch {
    return [];
  }
}

/** Each posted placard this shift: the agent's suggestion and Bob's tag (tag_building), and the right tag (shift_report). */
export function tagRows(messages: readonly unknown[], report: ShiftReport | null | undefined): TagRow[] {
  const out = new Map<string, TagRow>();
  for (const raw of messages) {
    const m = raw as Msg;
    if (kind(m) !== "tool" || m.name !== "tag_building") continue;
    const r = parse<{ pid?: string; label?: string; tag?: Tag | null; suggested?: Tag }>(m);
    if (!r?.pid) continue;
    out.set(String(r.pid), { pid: String(r.pid), label: r.label ?? String(r.pid), agent: r.suggested ?? null, bob: r.tag ?? null, right: null });
  }
  for (const b of report?.buildings ?? []) {
    const row = out.get(String(b.pid));
    const right = (b as { right_tag?: Tag }).right_tag ?? null;
    if (row) row.right = right;
  }
  return [...out.values()];
}

const chip = (t: Tag | null) =>
  t ? <b style={{ color: COLOR[t] }}>{t.toUpperCase()}</b> : <b style={{ color: "#94a3b8" }}>no tag</b>;

export function AgentScoreboard({ messages, report }: { messages: readonly unknown[]; report: ShiftReport | null | undefined }) {
  const rows = useMemo(() => tagRows(messages, report), [messages, report]);
  const graded = rows.length > 0 && rows.every((r) => r.right);
  const shiftKey = String((messages[0] as Msg | undefined)?.id ?? "");
  // Add this shift to the running record once it is graded (one entry per shift).
  useEffect(() => {
    if (!graded || !shiftKey) return;
    const all = tracks(read());
    if (all.some((t) => t.key === shiftKey)) return;
    try {
      localStorage.setItem(KEY, JSON.stringify([...all, { key: shiftKey, rows: rows.map(({ agent, bob, right }) => ({ agent, bob, right })) }].slice(-20)));
      window.dispatchEvent(new Event(EVT));
    } catch {}
  }, [graded, shiftKey, rows]);
  const record = tracks(useSyncExternalStore(subscribe, read, () => null));
  const flat = record.flatMap((t) => t.rows).filter((r) => r.right);
  const agentRight = flat.filter((r) => r.agent === r.right).length;
  const overrides = flat.filter((r) => r.bob !== r.agent);
  const overridesRight = overrides.filter((r) => r.bob === r.right).length;

  if (!rows.length) return null;
  return (
    <section style={{ margin: "0 0 12px", padding: "10px 14px", borderRadius: 3, background: "rgba(10,12,18,.72)", color: "#e7e2d6", font: "14px/1.45 var(--font-ui, system-ui), sans-serif" }} aria-label="Agent vs Bob">
      <h2 style={{ margin: "0 0 6px", font: "600 16px/1.2 var(--font-ui, system-ui), sans-serif" }}>Agent vs Bob</h2>
      {rows.map((r) => {
        const override = r.bob !== r.agent;
        const noShock = (report as { aftershock?: boolean } | null | undefined)?.aftershock === false;
        const verdict = noShock ? (override ? "No aftershock today: Bob's tag differs from the code's suggestion, graded by the screening" : "No aftershock today: Bob's tag matches the code's suggestion")
          : !r.right ? "waiting for the aftershock" : override
          ? r.bob === r.right ? "Bob was right; the agent was wrong" : r.agent === r.right ? "the agent was right; Bob's override was wrong" : "both were wrong"
          : r.agent === r.right ? "Bob agreed with the agent, and it was right" : "Bob agreed with the agent, and both were wrong";
        return (
          <div key={r.pid} style={{ padding: "4px 0" }}>
            <div>
              {r.label}: the agent proposed {chip(r.agent)} · Bob posted {chip(r.bob)}{override ? " (override)" : ""}{r.right ? <> · the aftershock says {chip(r.right)}</> : null}
            </div>
            <div style={{ color: "#a8a293" }}>
              {verdict}.{r.right && (override || r.agent !== r.right) ? " The outcome goes into the agent's shift log, and the next day opens with it (Day 1 always opens from a seeded previous shift)." : ""}
            </div>
          </div>
        );
      })}
      {flat.length > 0 && (
        <div style={{ marginTop: 6, color: "#a8a293", fontSize: 13 }}>
          Track record in this browser ({record.length} shift{record.length === 1 ? "" : "s"}): the agent&apos;s proposals right {agentRight} of {flat.length}
          {overrides.length ? ` · Bob's overrides right ${overridesRight} of ${overrides.length}` : ""}. Simulated outcomes; nothing is trained, the agent learns from its log.{" "}
          <button type="button" onClick={() => { try { localStorage.removeItem(KEY); window.dispatchEvent(new Event(EVT)); } catch {} }} style={{ background: "none", border: "none", padding: 0, color: "#a8a293", textDecoration: "underline", cursor: "pointer", font: "inherit" }}>Reset record</button>
        </div>
      )}
    </section>
  );
}
