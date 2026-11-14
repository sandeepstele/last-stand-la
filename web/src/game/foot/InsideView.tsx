"use client";
// OWNER: builder D. PLACEHOLDER from the coding lead. Keep the props type.
// Full-screen look-around of the REAL interior (Matterport cube faces) + the walls question.

import type { PanoFace } from "../types";

export type InsideMode = "look" | "barricade" | "safe";
export type InsideQuestion = {
  prompt: string; // "What are the walls made of?"
  choices: string[]; // three labels; keys 1/2/3 pick them (the director listens for the keys)
  chosen: number | null;
  status: string; // "Your report goes to HQ when the radio is clear." / "Sent. HQ is weighing it."
};
export type InsideProps = {
  faces: PanoFace[]; // [] = no scan: show a dark room with "no scan of this interior"
  title: string; // "Building A · inside"
  mode: InsideMode;
  question: InsideQuestion | null;
  note: string | null; // e.g. "Real interior: the building's own 3D tour" or the barricade status
  exitHint: string | null; // "[E] step outside" when allowed
  onChoose(i: number): void;
};

export function InsideView({ title, mode, question, note, exitHint, onChoose }: InsideProps) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#05070d", color: "#fff", padding: 24 }}>
      <h2>{title} {mode !== "look" ? `(${mode})` : ""}</h2>
      {note && <p>{note}</p>}
      {question && (
        <div>
          <p>{question.prompt}</p>
          {question.choices.map((c, i) => (
            <button key={c} type="button" disabled={question.chosen !== null} onClick={() => onChoose(i)}>
              [{i + 1}] {c}
            </button>
          ))}
          <p>{question.status}</p>
        </div>
      )}
      {exitHint && <p>{exitHint}</p>}
    </div>
  );
}
