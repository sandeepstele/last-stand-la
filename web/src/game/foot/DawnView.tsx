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
};

export function DawnView({ title, lines, messages, loading, onPlayAgain }: DawnProps) {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto", background: "rgba(5,7,13,.85)", color: "#fff", padding: 24 }}>
      <h2>{title}</h2>
      {lines.map((l) => <p key={l}>{l}</p>)}
      <CaseFile messages={messages} loading={loading} />
      <button type="button" onClick={onPlayAgain}>Play again (Enter)</button>
    </div>
  );
}
