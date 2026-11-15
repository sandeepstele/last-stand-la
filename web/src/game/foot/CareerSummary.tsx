"use client";
// The career so far (every finished day), and the summary after the last day: people kept safe in total, tags right,
// and the Agent vs Bob record. All numbers come from each day's shift report (simulated outcomes). OWNER: coding lead.

import type { CareerDay } from "./days";

const TAG: Record<string, string> = { green: "#4cc38a", yellow: "#f5c524", red: "#e5484d" };
const chip = (t: string | null) => (t ? <b style={{ color: TAG[t] ?? "#e7e2d6" }}>{t.toUpperCase()}</b> : <b style={{ color: "#94a3b8" }}>none</b>);

export function CareerSummary({ log, nDays, final }: { log: CareerDay[]; nDays: number; final: boolean }) {
  if (!log.length) return null;
  const sum = (f: (d: CareerDay) => number) => log.reduce((a, d) => a + (f(d) || 0), 0);
  const safe = sum((d) => d.people_safe), stake = sum((d) => d.people_at_stake), hurt = sum((d) => d.people_hurt);
  const right = sum((d) => d.tags_right), tags = sum((d) => d.tags), fixed = sum((d) => d.records_fixed);
  const rescued = sum((d) => d.rescued), rescueOf = sum((d) => d.rescue_of), points = sum((d) => d.points);
  const graded = log.filter((d) => d.right_tag);
  const agentRight = graded.filter((d) => d.agent_tag === d.right_tag).length;
  const overrides = graded.filter((d) => d.bob_tag !== d.agent_tag);
  const overridesRight = overrides.filter((d) => d.bob_tag === d.right_tag).length;
  return (
    <section style={{ margin: "0 0 12px", padding: "10px 14px", borderRadius: 3, background: final ? "rgba(245,165,36,.12)" : "rgba(10,12,18,.72)", boxShadow: final ? "inset 0 0 0 1px #f5a524" : undefined, color: "#e7e2d6", font: "14px/1.45 var(--font-ui, system-ui), sans-serif" }} aria-label="Career">
      <h2 style={{ margin: "0 0 6px", font: "600 16px/1.2 var(--font-ui, system-ui), sans-serif" }}>
        {final ? `Career summary: ${log.length} day${log.length === 1 ? "" : "s"}` : `Your career so far: day ${log.length} of ${nDays}`}
      </h2>
      <div>
        <b>{safe.toLocaleString("en-US")}</b> of {stake.toLocaleString("en-US")} people kept safe{log.some((d) => d.graded_by === "screening") ? " (Day 1 by the simulated aftershock; later days expected)" : ""}{hurt ? ` · ${Math.round(hurt)} hurt` : ""} · tags right <b>{right} of {tags}</b>{log.some((d) => d.graded_by === "screening") ? " (later days: matching the code's suggestion)" : ""} · records fixed <b>{fixed}</b>
        {rescueOf ? <> · rescued <b>{rescued} of {rescueOf}</b></> : null} · <b>{points.toLocaleString("en-US")}</b> points
      </div>
      {graded.length > 0 && (
        <div style={{ color: "#a8a293", marginTop: 2 }}>
          Agent vs Bob: the agent&apos;s proposals right {agentRight} of {graded.length}
          {overrides.length ? ` · Bob's overrides right ${overridesRight} of ${overrides.length}` : " · Bob never overrode it"}.
        </div>
      )}
      <ol style={{ margin: "6px 0 0", paddingLeft: 18, color: "#cbd5e1", fontSize: 13 }}>
        {log.map((d) => (
          <li key={d.day}>
            Day {d.day}, {d.hero}: agent {chip(d.agent_tag)} · Bob {chip(d.bob_tag)} · {d.graded_by === "screening" ? "no aftershock (graded by the screening)" : <>right {chip(d.right_tag)}</>} · {d.people_safe} of {d.people_at_stake} {d.graded_by === "screening" ? "expected safe" : "safe"}
          </li>
        ))}
      </ol>
      <div style={{ color: "#8a8478", fontSize: 12, marginTop: 4 }}>Simulated quakes and placards: game outcomes, not engineering assessments.</div>
    </section>
  );
}
