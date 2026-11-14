"use client";
// OWNER: builder D. PLACEHOLDER from the coding lead. Keep the props type.
// Dawn: what happened tonight + the REAL case file (the agent's evidence and the draft correction).

import { CaseFile } from "@/components/Cases";

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

export function DawnView({ title, lines, messages, loading, onPlayAgain, score, reportFiled, onFileReport }: DawnProps) {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "rgba(5,7,13,.85)", color: "#fff", padding: 24 }}>
      <h2>{title}</h2>
      {lines.map((l) => <p key={l}>{l}</p>)}
      <p>Rank {score.rank} · {score.points} pts · survivors {score.saved}/{score.total} · crates {score.found} · health {Math.round(score.health)}</p>
      <button type="button" disabled={reportFiled} onClick={onFileReport}>{reportFiled ? "Report filed for human review" : "File the report"}</button>
      <CaseFile messages={messages} loading={loading} />
      <button type="button" onClick={onPlayAgain}>Play again (Enter)</button>
    </div>
  );
}
