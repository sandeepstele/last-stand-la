"use client";
// The ghost-suite sweep (side mission): the other suites in this building that are on record as occupied while they're
// listed for lease. Read three record clues (listing, lease, the tenant's moves), stamp what the records support.
// The answer is code-computed from the records alone (no model): most come out "can't tell yet: needs a visit", which is
// the right call when the records don't settle it. Data: GET /game/suites/{pid}.

import { useEffect, useState } from "react";
import { SHORT, cap, fmtDates, plain, suiteName } from "./copy";
import { footStyles as styles } from "./ui";

type Clue = { check: string; finding: string; why: string };
type Answer = { group: "there" | "gone" | "sublet" | "cant_tell"; label?: string; hypothesis?: string; confidence?: number; text?: string };
type Suite = { n: number; suite: string; who: string; tonight?: boolean; clues: Clue[]; answer: Answer };
type Sweep = { pid: string; label: string; suites: Suite[] };

const STAMPS: { key: Answer["group"]; label: string }[] = [
  { key: "there", label: "Still there" },
  { key: "gone", label: "Gone" },
  { key: "sublet", label: "Subleasing" },
  { key: "cant_tell", label: "Can't tell" },
];
const CHECK: Record<string, string> = { listing_timeline: "Listing", lease_terms: "Lease", tenancy_trail: "Tenant's moves" };

export type SweepScore = { stamped: number; right: number };

/** What the records support, in one sentence; the % is the code's own confidence for its leading explanation. */
function verdictLine(a: Answer, right: boolean): string {
  const pct = typeof a.confidence === "number" ? Math.round(a.confidence * 100) : null;
  const best = a.hypothesis && SHORT[a.hypothesis] ? `${SHORT[a.hypothesis]}${pct != null ? `, ${pct}%` : ""}` : pct != null ? `${pct}%` : "";
  if (a.group === "cant_tell") {
    const tail = best ? ` Best guess: ${best}. It needs a visit.` : " It needs a visit.";
    return `${right ? "Right: the records alone" : "The records alone"} don't settle this one.${tail}`;
  }
  const what = STAMPS.find((s) => s.key === a.group)?.label.toLowerCase() ?? "another answer";
  return right ? `Right: the records point to ${what}${pct != null ? ` (${pct}%)` : ""}.` : `The records point to ${what}${pct != null ? ` (${pct}%)` : ""}, not that.`;
}

/** "Suite 1100" / "1100" / "STE 1100" → "1100", so tonight's suite is skipped however the record spells it. */
const suiteKey = (x: unknown) => String(x ?? "").replace(/^\s*(suite|ste\.?|#)\s*/i, "").trim().toLowerCase();

export function SuiteSweep({ pid, skip, onScore }: { pid: string; skip?: string | null; onScore(s: SweepScore): void }) {
  const [data, setData] = useState<Sweep | null>(null);
  const [i, setI] = useState(0);
  const [stamps, setStamps] = useState<Record<string, Answer["group"]>>({});

  useEffect(() => {
    let alive = true;
    fetch(`/api/game/suites/${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Sweep | null) => alive && d?.suites?.length && setData({
        ...d,
        // tonight's case is worked by HQ and your visit, never stamped from the records alone here
        suites: d.suites.filter((s) => !s.tonight && !(skip && suiteKey(s.suite) === suiteKey(skip))),
      }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pid, skip]);

  if (!data || !data.suites.length) return null;
  const n = data.suites.length;
  const at = Math.min(i, n - 1);
  const s = data.suites[at];
  const mine = stamps[s.suite];
  const stamp = (g: Answer["group"]) => {
    if (mine) return;
    const next = { ...stamps, [s.suite]: g };
    setStamps(next);
    const vals = data.suites.filter((x) => next[x.suite]);
    onScore({ stamped: vals.length, right: vals.filter((x) => next[x.suite] === x.answer.group).length });
  };

  return (
    <section className={`${styles.root} ${styles.sweep}`} aria-label="Optional: sweep the suites on record">
      <div className={styles.sweepHead}>
        <span>
          <b>Optional</b> · sweep the suites
        </span>
        <span>{Object.keys(stamps).length} of {n} stamped</span>
      </div>
      <h3>
        Case #{s.n} · {cap(suiteName(s.suite))}
      </h3>
      <p className={styles.sweepWhy}>On record: {plain(s.who)}. It is also listed for lease.</p>
      <ul className={styles.clues}>
        {s.clues.slice(0, 3).map((c) => (
          <li key={c.check}>
            <span>{CHECK[c.check] ?? cap(c.check.replace(/_/g, " "))}: </span>
            {cap(plain(fmtDates(c.finding)))}
          </li>
        ))}
      </ul>
      <div className={styles.stamps}>
        {STAMPS.map((t) => (
          <button key={t.key} type="button" className={styles.stamp} data-mine={mine === t.key} disabled={!!mine} onClick={() => stamp(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <p className={styles.verdictLine}>{mine ? verdictLine(s.answer, mine === s.answer.group) : "Stamp only what the records support."}</p>
      <nav className={styles.sweepNav}>
        <button type="button" onClick={() => setI((x) => (x - 1 + n) % n)}>‹ Previous</button>
        <span>
          {at + 1} of {n}
        </span>
        <button type="button" onClick={() => setI((x) => (x + 1) % n)}>Next ›</button>
      </nav>
    </section>
  );
}
