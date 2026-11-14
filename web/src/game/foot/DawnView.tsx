"use client";
// OWNER: builder D. Keep the props type.
// Dawn: what happened tonight + the REAL case file (the agent's evidence and the draft correction).

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
};

export function DawnView({ title, lines, messages, loading, onPlayAgain }: DawnProps) {
  const hasCase = messages.some((m) => kind(m as Msg) === "tool" && (m as Msg).name === "open_case");
  return (
    <div className={`${styles.root} ${styles.dawn}`} role="dialog" aria-label={title}>
      <div className={styles.sun} />
      <div className={styles.dawnCol}>
        <div className={styles.dawnKicker}>SUNRISE · DOWNTOWN LOS ANGELES</div>
        <h1 className={styles.dawnTitle}>{title}</h1>

        {lines.length > 0 && (
          <ul className={styles.outcome}>
            {lines.map((l, i) => (
              <li key={`${i}-${l}`} style={{ animationDelay: `${0.8 + i * 0.25}s` }}>
                {l}
              </li>
            ))}
          </ul>
        )}

        <section className={styles.found}>
          <span className={styles.dawnKicker} style={{ textAlign: "left" }}>
            THE NIGHT&apos;S REAL WORK
          </span>
          <h2>What the agent found</h2>
          {hasCase ? (
            <>
              <p>
                The records disagreed about these walls. Here is what HQ checked, how it weighed your report, and the draft correction it leaves for a person
                to approve. Nothing changes until someone does.
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
