"use client";
// Solar-roof survey (side mission): walk up to a building with a screened roof, [C] to survey it. The numbers are a code
// screen (CoStar + Vexcel roof + LA solar resource), not an engineering design. Stamp what the screen supports. OWNER: lead.

export type SolarRoof = {
  pid: string; label: string; x: number; z: number; kw: number; panels: number; mwh_per_year: number;
  usable_roof_sqft?: number; load_offset_pct?: number | null; co2_t_per_year?: number; readiness?: string;
  readiness_reasons?: string[]; deal_fit?: string; headline?: string; answer: "go_solar" | "inspect_first" | "reroof_first";
};

const STAMPS: { key: SolarRoof["answer"]; label: string }[] = [
  { key: "go_solar", label: "Go solar" },
  { key: "inspect_first", label: "Inspect first" },
  { key: "reroof_first", label: "Re-roof first" },
];

export function SolarSurvey({ roof, stamped, onStamp, onClose }: { roof: SolarRoof; stamped: SolarRoof["answer"] | null; onStamp(a: SolarRoof["answer"]): void; onClose(): void }) {
  const right = stamped && stamped === roof.answer;
  const fmt = (n: number | null | undefined, d = 0) => (typeof n === "number" ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "—");
  return (
    <div style={{ position: "absolute", right: 16, top: "30%", width: 360, zIndex: 45, background: "rgba(5,7,13,.9)", border: "1px solid rgba(250,204,21,.6)", padding: 14, color: "#e2e8f0", font: "14px/1.45 system-ui, sans-serif", pointerEvents: "auto" }}>
      <div style={{ color: "#facc15", fontWeight: 700 }}>Solar roof survey · {roof.label}</div>
      <div style={{ margin: "8px 0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4 }}>
        <span>{fmt(roof.kw)} kW · {fmt(roof.panels)} panels</span>
        <span>{fmt(roof.mwh_per_year)} MWh / year</span>
        {roof.load_offset_pct != null && <span>{fmt(roof.load_offset_pct)}% of its power</span>}
        {roof.co2_t_per_year != null && <span>{fmt(roof.co2_t_per_year)} t CO₂ / year</span>}
      </div>
      {!!roof.readiness_reasons?.length && (
        <ul style={{ margin: "4px 0 8px", paddingLeft: 18, color: "#cbd5e1" }}>{roof.readiness_reasons.slice(0, 3).map((r) => <li key={r}>{r}</li>)}</ul>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        {STAMPS.map((s) => (
          <button key={s.key} type="button" disabled={!!stamped} onClick={() => onStamp(s.key)}
            style={{ flex: 1, padding: "7px 6px", border: "1px solid #64748b", background: stamped === s.key ? "#facc15" : "transparent", color: stamped === s.key ? "#111" : "#e2e8f0", cursor: stamped ? "default" : "pointer" }}>
            {s.label}
          </button>
        ))}
      </div>
      {stamped && <div style={{ marginTop: 8, color: right ? "#4cc38a" : "#f5a524" }}>{right ? "The screen supports that." : "The screen says otherwise."} {roof.headline ?? ""}</div>}
      <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", fontSize: 12, color: "#94a3b8" }}>
        <span>A screen, not an engineering design.</span>
        <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }}>[C] close</button>
      </div>
    </div>
  );
}
