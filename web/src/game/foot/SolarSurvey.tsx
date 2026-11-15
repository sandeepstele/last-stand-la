"use client";
// Solar-roof survey (side mission): walk up to a building with a screened roof, [C] to survey it. The numbers are a code
// screen (the property record + the aerial roof + LA's solar resource), not an engineering design. Stamp what the
// screen supports.

import { plain } from "./copy";
import { Keycap, footStyles as styles } from "./ui";

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
  const fmt = (n: number | null | undefined, d = 0) => (typeof n === "number" ? n.toLocaleString("en-US", { maximumFractionDigits: d }) : "—");
  return (
    <section className={`${styles.root} ${styles.side}`} aria-label="Optional: solar roof survey">
      <div className={styles.sweepHead}>
        <span>
          <b>Optional</b> · solar roof
        </span>
      </div>
      <h3>{roof.label}</h3>
      <dl className={styles.facts}>
        <div><dt>Size</dt><dd>{fmt(roof.kw)} kW · {fmt(roof.panels)} panels</dd></div>
        <div><dt>Power</dt><dd>{fmt(roof.mwh_per_year)} MWh a year</dd></div>
        {roof.load_offset_pct != null && <div><dt>Covers</dt><dd>{fmt(roof.load_offset_pct)}% of its use</dd></div>}
        {roof.co2_t_per_year != null && <div><dt>Saves</dt><dd>{fmt(roof.co2_t_per_year)} t CO₂ a year</dd></div>}
        {/* There is no roof-age data: the screen uses the building's age, so its "inspect first" is that assumption, not a roof finding. */}
        <div><dt>Roof</dt><dd>Roof age unknown (we used the building&apos;s age) → inspect first</dd></div>
      </dl>
      {!!roof.readiness_reasons?.length && (
        <ul className={styles.clues}>
          {roof.readiness_reasons.slice(0, 3).map((r) => <li key={r}>{plain(r)}</li>)}
        </ul>
      )}
      <div className={styles.stamps} data-n={STAMPS.length}>
        {STAMPS.map((s) => (
          <button key={s.key} type="button" className={styles.stamp} data-mine={stamped === s.key} disabled={!!stamped} onClick={() => onStamp(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <p className={styles.verdictLine}>
        {stamped ? `${right ? "The screen supports that." : "The screen says otherwise."} ${plain(roof.headline ?? "")}` : "Stamp what the screen supports."}
      </p>
      <nav className={styles.sweepNav}>
        <span>A screen, not an engineering design.</span>
        <button type="button" onClick={onClose}>
          <Keycap k="C" size="sm" /> Close
        </button>
      </nav>
    </section>
  );
}
