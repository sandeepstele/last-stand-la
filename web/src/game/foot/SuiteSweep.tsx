"use client";
// The ghost-suite sweep (side mission): the other suites in this building that CoStar records as occupied while they're
// listed for lease. Read three record clues (listing timeline, lease terms, tenancy trail), stamp what the records support.
// The answer is code-computed from the records alone (no model): most come out "can't tell yet: needs a visit", which is
// the right call when the records don't settle it. Data: GET /game/suites/{pid}. OWNER: coding lead.

import { useEffect, useState } from "react";

type Clue = { check: string; finding: string; why: string };
type Answer = { group: "there" | "gone" | "sublet" | "cant_tell"; label?: string; hypothesis?: string; confidence?: number; text?: string };
type Suite = { n: number; suite: string; who: string; tonight?: boolean; clues: Clue[]; answer: Answer };
type Sweep = { pid: string; label: string; suites: Suite[] };

const STAMPS: { key: Answer["group"]; label: string }[] = [
  { key: "there", label: "Still there" },
  { key: "gone", label: "Gone" },
  { key: "sublet", label: "Subleasing" },
  { key: "cant_tell", label: "Can't tell yet" },
];
const CHECK: Record<string, string> = { listing_timeline: "Listing timeline", lease_terms: "Lease terms", tenancy_trail: "Tenancy trail" };

export type SweepScore = { stamped: number; right: number };

export function SuiteSweep({ pid, onScore }: { pid: string; onScore(s: SweepScore): void }) {
  const [data, setData] = useState<Sweep | null>(null);
  const [i, setI] = useState(0);
  const [stamps, setStamps] = useState<Record<string, Answer["group"]>>({});

  useEffect(() => {
    let alive = true;
    fetch(`/api/game/suites/${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Sweep | null) => alive && d?.suites?.length && setData({ ...d, suites: d.suites.filter((s) => !s.tonight) }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pid]);

  if (!data || !data.suites.length) return null;
  const s = data.suites[Math.min(i, data.suites.length - 1)];
  const mine = stamps[s.suite];
  const stamp = (g: Answer["group"]) => {
    if (mine) return;
    const next = { ...stamps, [s.suite]: g };
    setStamps(next);
    const vals = data.suites.filter((x) => next[x.suite]);
    onScore({ stamped: vals.length, right: vals.filter((x) => next[x.suite] === x.answer.group).length });
  };
  const right = mine && mine === s.answer.group;

  return (
    <div style={{ position: "absolute", left: 16, top: 190, width: 380, zIndex: 37, background: "rgba(5,7,13,.86)", border: "1px solid rgba(45,212,191,.55)", padding: 12, color: "#e2e8f0", font: "13px/1.4 system-ui, sans-serif", pointerEvents: "auto" }}>
      <div style={{ font: "700 11px/1.3 ui-monospace, monospace", color: "#2dd4bf", letterSpacing: ".08em" }}>
        SIDE MISSION · SWEEP THE SUITES ON RECORD · {Object.keys(stamps).length}/{data.suites.length}
      </div>
      <div style={{ margin: "6px 0", fontWeight: 700 }}>
        Case #{s.n} · suite {s.suite} · CoStar records {s.who}; the suite is listed for lease
      </div>
      {s.clues.slice(0, 3).map((c) => (
        <div key={c.check} style={{ margin: "4px 0", padding: "4px 6px", background: "rgba(255,255,255,.05)" }}>
          <b>{CHECK[c.check] ?? c.check}:</b> {c.finding}
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
        {STAMPS.map((t) => (
          <button key={t.key} type="button" disabled={!!mine} onClick={() => stamp(t.key)}
            style={{ padding: "5px 8px", border: "1px solid #64748b", background: mine === t.key ? "#f5a524" : "transparent", color: mine === t.key ? "#111" : "#e2e8f0", cursor: mine ? "default" : "pointer" }}>
            {t.label}
          </button>
        ))}
      </div>
      {mine && (
        <div style={{ marginTop: 8, color: right ? "#4cc38a" : "#f5a524" }}>
          {right ? "The records support that." : "The records don't settle that."} {s.answer.text ?? ""}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, font: "12px ui-monospace, monospace" }}>
        <button type="button" onClick={() => setI((x) => (x - 1 + data.suites.length) % data.suites.length)} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }}>‹ prev</button>
        <span style={{ color: "#94a3b8" }}>records only · no model · stamp only what they support</span>
        <button type="button" onClick={() => setI((x) => (x + 1) % data.suites.length)} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }}>next ›</button>
      </div>
    </div>
  );
}
