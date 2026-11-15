"use client";
// Keep the props type.
// Dawn: what the night settled (the cases worked, from the drafts themselves), HQ's drafts, the final objective (file
// the reports), the score, how the night was decided and the REAL case file. Every number here comes from props or
// from the agent's tool results.

import { useMemo } from "react";
import { CaseFile } from "@/components/Cases";
import { kind, latestResult, type Msg } from "../radio";
import { DISCLAIMER } from "../types";
import { placeName, plain } from "./copy";
import { draftsModel } from "./hqModel";
import { HqDrafts } from "./hqDrafts";
import { Keycap, footStyles as styles } from "./ui";

export type DawnProps = {
  title: string; // "Dawn. You made it." / "Dawn."
  lines: string[]; // outcome lines from the server's `why` (code-computed), never invented
  messages: readonly unknown[];
  loading: boolean;
  onPlayAgain(): void;
  // ---- missions (v2)
  score: { saved: number; total: number; found: number; health: number; secs: number; points: number; rank: string };
  /** Final objective: "File the report" = the draft correction goes to a human researcher for review (local; nothing is sent). */
  reportFiled: boolean;
  onFileReport(): void;
};

const clock = (secs: number) => {
  const s = Math.max(0, Math.round(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** How a director line reads on the debrief: the records line is the night's main result. */
const toneOf = (l: string) =>
  /^(Records checked tonight|\d+ (open )?cases? (checked|worked) tonight)/i.test(l) ? "records" : /^Case #\d+/.test(l) ? "hq" : /went down/i.test(l) ? "down" : undefined;

export function DawnView({ title, lines, messages, loading, onPlayAgain, score, reportFiled, onFileReport }: DawnProps) {
  const hasCase = messages.some((m) => kind(m as Msg) === "tool" && (m as Msg).name === "open_case");
  // The headline counts what is shown below it: the cases HQ drafted tonight (and who worked each).
  const drafts = useMemo(() => draftsModel(messages, loading).drafts, [messages, loading]);
  const queue = useMemo(() => latestResult<{ total?: number }>(messages, "night_cases")?.total ?? null, [messages]);
  const records = lines.filter((l) => toneOf(l) === "records");
  const rest = lines.filter((l) => toneOf(l) !== "records" && !(drafts.length && toneOf(l) === "hq"));
  const stats: { label: string; value: string }[] = [
    ...(score.total > 0 ? [{ label: "Survivors saved", value: `${score.saved}/${score.total}` }] : []),
    { label: "Crates", value: String(score.found) },
    { label: "Health", value: String(Math.round(score.health)) },
    { label: "Time", value: clock(score.secs) },
  ];
  return (
    <div className={`${styles.root} ${styles.dawn}`} role="dialog" aria-label={title}>
      <div className={styles.sun} />
      <div className={styles.dawnCol}>
        <div className={styles.dawnKicker}>Sunrise, downtown Los Angeles</div>
        <h1 className={styles.dawnTitle}>{title}</h1>

        {drafts.length > 0 ? (
          <section className={styles.dawnBlock}>
            <h2>
              {drafts.length} case{drafts.length === 1 ? "" : "s"} worked tonight
              {queue != null && <small>of {queue.toLocaleString("en-US")} open in the queue</small>}
            </h2>
            <ul className={styles.caseRows}>
              {drafts.map((d) => (
                <li key={d.id}>
                  {d.n != null ? `Case #${d.n} · ` : ""}
                  {placeName(plain(d.where))}
                  <span>{d.yourReport ? "your report + HQ" : "HQ, from the records"}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          records.map((l) => (
            <section key={l} className={styles.dawnBlock}>
              <h2>{plain(l)}</h2>
            </section>
          ))
        )}

        {loading && !drafts.length && (
          <p className={styles.drafting}>
            HQ is drafting tonight&apos;s corrections
            <span className={styles.thinking}>
              <i />
              <i />
              <i />
            </span>
          </p>
        )}
        <HqDrafts messages={messages} busy={loading} />

        <section className={styles.fileCard}>
          <button type="button" className={styles.fileBtn} disabled={reportFiled} onClick={onFileReport}>
            {reportFiled ? "Filed for review" : "File the reports"}
          </button>
          <p>Opens the auditor, where a person reviews each draft. Nothing is sent automatically.</p>
        </section>

        <section className={styles.results}>
          <div className={styles.rank}>
            <span>Rank</span>
            <strong>{score.rank}</strong>
          </div>
          <div className={styles.resultsBody}>
            <div className={styles.points}>
              <strong>{score.points.toLocaleString("en-US")}</strong>
              <span>points</span>
            </div>
            <dl className={styles.stats}>
              {stats.map((s) => (
                <div key={s.label}>
                  <dt>{s.label}</dt>
                  <dd>{s.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {rest.length > 0 && (
          <section className={styles.found}>
            <h2>How the night was decided</h2>
            <ul className={styles.outcome}>
              {rest.map((l, i) => (
                <li key={`${i}-${l}`} data-tone={toneOf(l)} style={{ animationDelay: `${0.8 + i * 0.2}s` }}>
                  {plain(l)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {hasCase ? (
          <details className={styles.caseFile}>
            <summary>
              The full case file <span>What HQ checked, how it weighed your report, and the draft it leaves for a person</span>
            </summary>
            <div className={styles.caseWrap}>
              <CaseFile messages={messages} loading={loading} />
            </div>
          </details>
        ) : (
          <p className={styles.outcomeEmpty}>{loading ? "HQ is still writing up the case file." : "No case file was opened tonight."}</p>
        )}

        <button type="button" className={styles.again} onClick={onPlayAgain}>
          Play again <Keycap k="Enter" />
        </button>
        <p className={styles.dawnFoot}>{DISCLAIMER}</p>
      </div>
    </div>
  );
}
