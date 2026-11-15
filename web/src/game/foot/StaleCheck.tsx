"use client";
// "Same building?" (side mission, stale entry): the city's retrofit list names this address, but CoStar's record looks
// newer. Read the clues, stamp what they support. The answer is code-weighed from records + permits + the aerial's facts.
// OWNER: coding lead (style: design pass).

import { evidenceUrl } from "../Pano";

export type StaleCase = {
  pid: string; n: number; label: string; x: number; z: number; in_bounds?: boolean;
  city_says: string; costar_says: string; clues: { check: string; finding: string; why?: string }[];
  image?: string | null; answer: "same_building" | "replaced" | "cant_tell"; headline?: string;
};

const STAMPS: { key: StaleCase["answer"]; label: string }[] = [
  { key: "same_building", label: "Same building" },
  { key: "replaced", label: "Replaced" },
  { key: "cant_tell", label: "Can't tell" },
];

export function StaleCheck({ c, stamped, onStamp, onClose }: { c: StaleCase; stamped: StaleCase["answer"] | null; onStamp(a: StaleCase["answer"]): void; onClose(): void }) {
  const right = stamped && stamped === c.answer;
  return (
    <div style={{ position: "absolute", right: 16, top: "26%", width: 380, zIndex: 45, background: "rgba(5,7,13,.9)", border: "1px solid rgba(229,72,77,.6)", padding: 14, color: "#e2e8f0", font: "14px/1.45 system-ui, sans-serif", pointerEvents: "auto" }}>
      <div style={{ color: "#f87171", fontWeight: 700 }}>Same building? · {c.label}</div>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local evidence image, not an optimizable asset */}
      {c.image && <img src={evidenceUrl(c.image)} alt="" style={{ width: "100%", marginTop: 8, display: "block" }} onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />}
      <div style={{ marginTop: 8 }}><b>City list:</b> {c.city_says}</div>
      <div><b>CoStar:</b> {c.costar_says}</div>
      <ul style={{ margin: "6px 0 8px", paddingLeft: 18, color: "#cbd5e1" }}>{c.clues.slice(0, 3).map((k) => <li key={k.check}>{k.finding}</li>)}</ul>
      <div style={{ display: "flex", gap: 6 }}>
        {STAMPS.map((s) => (
          <button key={s.key} type="button" disabled={!!stamped} onClick={() => onStamp(s.key)}
            style={{ flex: 1, padding: "7px 6px", border: "1px solid #64748b", background: stamped === s.key ? "#f87171" : "transparent", color: stamped === s.key ? "#111" : "#e2e8f0", cursor: stamped ? "default" : "pointer" }}>
            {s.label}
          </button>
        ))}
      </div>
      {stamped && <div style={{ marginTop: 8, color: right ? "#4cc38a" : "#f5a524" }}>{right ? "The records support that." : "The records point the other way."} {c.headline ?? ""}</div>}
      <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8" }}>
        <span>Case #{c.n} from CoStar&apos;s queue. Image for display only.</span>
        <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }}>[C] close</button>
      </div>
    </div>
  );
}
