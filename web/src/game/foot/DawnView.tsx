"use client";
// OWNER: builder D. Keep the props type.
// Dawn: the night's results card, the final objective (file the report), what happened tonight and the REAL case file
// (the agent's evidence and the draft correction). Every number here comes from props.

import { CaseFile } from "@/components/Cases";
import { kind, type Msg } from "../radio";
import { DISCLAIMER } from "../types";
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

export function DawnView({ title, lines, messages, loading, onPlayAgain, score, reportFiled, onFileReport }: DawnProps) {
  const hasCase = messages.some((m) => kind(m as Msg) === "tool" && (m as Msg).name === "open_case");
  const stats: { label: string; value: string }[] = [
    { label: "Survivors saved", value: `${score.saved}/${score.total}` },
    { label: "Crates found", value: String(score.found) },
    { label: "Health", value: String(Math.round(score.health)) },
    { label: "Time", value: clock(score.secs) },
  ];
  return (
    <div className={`${styles.root} ${styles.dawn}`} role="dialog" aria-label={title}>
      <div className={styles.sun} />
      <div className={styles.dawnCol}>
        <div className={styles.dawnKicker}>SUNRISE · DOWNTOWN LOS ANGELES</div>
        <h1 className={styles.dawnTitle}>{title}</h1>

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

        {lines.length > 0 && (
          <ul className={styles.outcome}>
            {lines.map((l, i) => (
              <li key={`${i}-${l}`} style={{ animationDelay: `${0.8 + i * 0.25}s` }}>
                {l}
              </li>
            ))}
          </ul>
        )}

        <section className={styles.fileCard} data-filed={reportFiled}>
          <span className={styles.dawnKicker} style={{ textAlign: "left" }}>
            FINAL OBJECTIVE
          </span>
          <button type="button" className={styles.fileBtn} disabled={reportFiled} onClick={onFileReport}>
            {reportFiled ? "Report filed for human review" : "File the report"}
          </button>
          <p>The draft correction goes to a human researcher for review. Nothing is sent automatically.</p>
        </section>

        <section className={styles.found}>
          <span className={styles.dawnKicker} style={{ textAlign: "left" }}>
            THE NIGHT&apos;S REAL WORK
          </span>
          <h2>What the agent found</h2>
          {hasCase ? (
            <>
              <p>
                The records disagreed about these walls. Here is what HQ checked, how it weighed your report, and the draft correction it leaves for a person
                to approve.
              </p>
              <div className={styles.caseWrap}>
                <CaseFile messages={messages} loading={loading} />
              </div>
            </>
          ) : (
            <p className={styles.outcomeEmpty}>{loading ? "HQ is writing up the case file…" : "No case file was opened tonight."}</p>
          )}
        </section>

        <button type="button" className={styles.again} onClick={onPlayAgain}>
          Play again <Keycap k="Enter" />
        </button>
        <p className={styles.dawnFoot}>{DISCLAIMER}</p>
      </div>
    </div>
  );
}
