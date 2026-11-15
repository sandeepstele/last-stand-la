"use client";
// "Same building?" (side mission, stale entry): the city's retrofit list names this address, but the property record
// looks newer. Read the clues, stamp what they support. The answer is code-weighed from records + permits + the
// aerial's facts.

import { evidenceUrl } from "../Pano";
import { cap, fmtDates, plain } from "./copy";
import { Keycap, footStyles as styles } from "./ui";

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
    <section className={`${styles.root} ${styles.side}`} aria-label="Optional: same building?">
      <div className={styles.sweepHead}>
        <span>
          <b>Optional</b> · same building?
        </span>
        <span>Case #{c.n}</span>
      </div>
      <h3>{c.label}</h3>
      {c.image && (
        // eslint-disable-next-line @next/next/no-img-element -- a local evidence image, not an optimizable asset
        <img className={styles.sideImg} src={evidenceUrl(c.image)} alt="Aerial of this address (for display only)" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
      )}
      <ul className={styles.clues}>
        <li><span>City list: </span>{cap(plain(fmtDates(c.city_says)))}</li>
        <li><span>Property record: </span>{cap(plain(fmtDates(c.costar_says)))}</li>
        {c.clues.slice(0, 3).map((k) => <li key={k.check}>{cap(plain(fmtDates(k.finding)))}</li>)}
      </ul>
      <div className={styles.stamps} data-n={STAMPS.length}>
        {STAMPS.map((s) => (
          <button key={s.key} type="button" className={styles.stamp} data-mine={stamped === s.key} disabled={!!stamped} onClick={() => onStamp(s.key)}>
            {s.label}
          </button>
        ))}
      </div>
      <p className={styles.verdictLine}>
        {stamped ? `${right ? "The records support that." : "The records point the other way."} ${plain(c.headline ?? "")}` : "Stamp what the records support."}
      </p>
      <nav className={styles.sweepNav}>
        <span>{c.image ? "The image is for display only." : ""}</span>
        <button type="button" onClick={onClose}>
          <Keycap k="C" size="sm" /> Close
        </button>
      </nav>
    </section>
  );
}
