"use client";
// Keep the props type. Full-screen look-around of the REAL interior (its 3D scan's cube faces) + HQ's question.
// One small caption top-left; the question along the bottom; the director draws the radio subtitles above it.

import type { PanoFace } from "../types";
import { InsidePano } from "./InsidePano";
import { InsideWalk, type WalkProps } from "./InsideWalk";
import { cap, plain, suiteName } from "./copy";
import { Keycap, footStyles as styles, splitKeyHint } from "./ui";

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

const swatchOf = (label: string) => (/concrete/i.test(label) ? "concrete" : /brick|masonry/i.test(label) ? "brick" : "unknown");
/** "suite 1100" -> "suite 1100" ("suite 301302" -> "suites 301–302"). */
const suiteWhere = (w: string) => w.replace(/^suite\s+(\S+)$/i, (_, s: string) => suiteName(s));

// A bar along the bottom: the walls the question is about stay in view above it.
function Question({ q, onChoose, exit }: { q: InsideQuestion; onChoose(i: number): void; exit: string | null }) {
  const materials = q.choices.some((c) => swatchOf(c) !== "unknown");
  return (
    <div className={styles.question}>
      <div className={styles.qText}>
        <span className={styles.qAsk}>HQ asks</span>
        <h3>{plain(q.prompt)}</h3>
        <div className={styles.qFoot}>
          <p className={styles.status}>{q.status}</p>
          {exit && <ExitHint hint={exit} inline />}
        </div>
      </div>
      <div className={styles.answerRow}>
        {q.choices.map((c, i) => {
          // a texture sample only when the answer is a material (concrete, brick): it helps you match what you see
          const state = q.chosen === null ? "open" : q.chosen === i ? "chosen" : "dim";
          const m = swatchOf(c);
          return (
            <button key={c} type="button" className={styles.answer} data-state={state} disabled={q.chosen !== null} onClick={() => onChoose(i)}>
              {state === "chosen" && <span className={styles.chosenTag}>Your report</span>}
              {materials && <span className={styles.swatch} data-m={m} />}
              <span className={styles.answerTop}>
                <Keycap k={String(i + 1)} tone={state === "chosen" ? "amber" : undefined} />
                <strong>{c}</strong>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExitHint({ hint, inline = false }: { hint: string; inline?: boolean }) {
  const cls = inline ? `${styles.exit} ${styles.exitInline}` : styles.exit;
  const k = splitKeyHint(hint);
  if (k) {
    return (
      <div className={cls} data-kind="go">
        <Keycap k={k.key} size="lg" />
        <span>{cap(k.rest)}</span>
      </div>
    );
  }
  const locked = /^answer/i.test(hint);
  return (
    <div className={cls} data-kind={locked ? "locked" : "wait"}>
      <span>{locked ? hint : hint.replace(/(\.\.\.|…)\s*$/, "")}</span>
      {!locked && (
        <span className={styles.thinking}>
          <i />
          <i />
          <i />
        </span>
      )}
    </div>
  );
}

export function InsideView({ faces, title, mode, question, note, exitHint, onChoose, walk }: InsideProps & { walk?: Omit<WalkProps, "className"> | null }) {
  const barricade = mode === "barricade";
  const real = !!note && /real interior/i.test(note);
  const [name, where] = title.split(" · ");
  return (
    <div className={`${styles.root} ${styles.inside}`} role="dialog" aria-label={title}>
      <div className={barricade ? styles.barricade : undefined} style={{ position: "absolute", inset: 0 }}>
        {faces.length ? (
          walk && walk.hops.length > 1 ? <InsideWalk {...walk} className={styles.panoBox} /> : <InsidePano faces={faces} drift={!barricade} className={styles.panoBox} />
        ) : (
          <div className={styles.emptyRoom}>
            <p>No 3D scan of this interior on file</p>
          </div>
        )}
        <div className={styles.insideShade} />
        {barricade && (
          <>
            <div className={styles.vignette} />
            <div className={styles.planks}>
              <span className={styles.plank} />
              <span className={styles.plank} />
              <span className={styles.plank} />
            </div>
            <div className={styles.bang} aria-hidden>
              BANG
            </div>
          </>
        )}
      </div>

      {/* One small caption: where you are, and that the room is a real scan. */}
      <div className={styles.insideTop}>
        <div className={styles.insideTitle}>
          <h2>
            {barricade ? "Barricaded in " : "Inside "}
            {name}
            {where && where !== "inside" ? `, ${suiteWhere(where)}` : ""}
            {real && <span> · real 3D scan</span>}
          </h2>
          {faces.length > 0 && !barricade && !walk && <p className={styles.note}>Drag to look around</p>}
          {note && !real && !barricade && <p className={styles.note}>{plain(note).replace(/\.$/, "")}</p>}
        </div>
      </div>

      {barricade && note && (
        <div className={styles.holdCard}>
          <h3>Hold the door</h3>
          <p>{note}</p>
        </div>
      )}

      {/* The exit prompt rides in the question bar: the lower-third band above it is HQ's (moments cards). */}
      {question && <Question q={question} onChoose={onChoose} exit={exitHint} />}
      {exitHint && !question && <ExitHint hint={exitHint} />}
    </div>
  );
}
