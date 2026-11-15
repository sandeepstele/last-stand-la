"use client";
// The director flies the camera over the real district while this shows; onStart hands control to the player.
// Title, then three short briefing cards (auto-advance; click or arrow keys to skip). Enter starts the game (the director
// listens for it); the Start button starts it from a real click (pointer lock).

import { useEffect, useState, type ReactNode } from "react";
import { DISCLAIMER } from "../types";
import { Badges, Keycap, footStyles as styles } from "./ui";

export type IntroProps = {
  heroLabel: string;
  ready: boolean; // district loaded
  stub: boolean;
  replay: string | null;
  attribution: string | null; // show in the intro credits when present
  onStart(): void; // must be called from a user gesture (click or Enter) so pointer lock can engage
};

const TITLE_MS = 3200;
const CARD_MS = 5000;
const CARDS = 3;

// Five controls up front; the rest are in the pause menu (P).
const CONTROLS: { keys: string[]; what: string }[] = [
  { keys: ["W", "A", "S", "D"], what: "Move" },
  { keys: ["Shift"], what: "Sprint" },
  { keys: ["Tab"], what: "Your desk" },
  { keys: ["E"], what: "Go inside (site visit)" },
  { keys: ["1", "2", "3"], what: "Tag after the quake" },
  { keys: ["P"], what: "Menu and all controls" },
];

// The pitch frame (user decision): a deep-agent game, real CoStar data, real feedback enforcement. Card 1 first: the AI agent.
function Card({ n, heroLabel }: { n: number; heroLabel: string }) {
  let body: ReactNode;
  if (n === 1) {
    body = (
      <>
        <h2>
          A <em>deep-agent</em> game
        </h2>
        <p>
          You&apos;re Bob, at LA&apos;s building office. Your analyst is an AI agent: it plans the day, sends four squads for the data, picks its own evidence, and <b>waits for your call.</b>
        </p>
        <p className={styles.flowLine}>HQ is a LangChain deep agent.</p>
      </>
    );
  } else if (n === 2) {
    body = (
      <>
        <h2>
          Real <em>CoStar</em> data
        </h2>
        <p>
          Every building and case is real: <b>1,581 LA buildings, 156 open cases</b> where the records disagree.
        </p>
      </>
    );
  } else {
    body = (
      <>
        <h2>
          Real <em>feedback</em> enforcement
        </h2>
        <p>
          What you see on a site visit counts. It moves the odds, shapes the tag you post after the 5 pm quake, and reaches the real record. <b>Code enforces the limits.</b>
        </p>
        <p className={styles.flowLine}>
          First stop: <b>{heroLabel || "the lit building"}</b>
        </p>
        <ul className={styles.ctrlGrid}>
          {CONTROLS.map((c) => (
            <li key={c.what}>
              <span className={styles.ctrlKeys}>
                {c.keys.map((k) => (
                  <Keycap key={k} k={k} />
                ))}
              </span>
              <span>{c.what}</span>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <section className={styles.brief} key={n}>
      <div className={styles.briefHead}>
        {n} of {CARDS}
      </div>
      {body}
    </section>
  );
}

export function IntroOverlay({ heroLabel, ready, stub, replay, attribution, onStart }: IntroProps) {
  // 0 = the title alone; 1..3 = briefing cards.
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (idx >= CARDS) return;
    const t = setTimeout(() => setIdx((i) => Math.min(CARDS, i + 1)), idx === 0 ? TITLE_MS : CARD_MS);
    return () => clearTimeout(t);
  }, [idx]);

  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.code === "ArrowRight" || e.code === "Space") setIdx((i) => Math.min(CARDS, i + 1));
      else if (e.code === "ArrowLeft") setIdx((i) => Math.max(1, i - 1));
    };
    window.addEventListener("keydown", kd);
    return () => window.removeEventListener("keydown", kd);
  }, []);

  const next = () => setIdx((i) => Math.min(CARDS, i + 1));
  const card = Math.max(1, idx);

  return (
    <div className={`${styles.root} ${styles.intro}`} onClick={next} role="dialog" aria-label="Last Stand LA briefing">
      <div className={styles.letterbox}>
        <span className={styles.rec}>Downtown Los Angeles, dusk</span>
        <Badges stub={stub} replay={replay} />
      </div>

      <div className={styles.stage}>
        <header className={styles.titleBlock} data-big={idx === 0}>
          <h1 className={styles.title}>
            Last Stand <span>LA</span>
          </h1>
          <p className={styles.tagline}>A deep-agent game on real CoStar data, where your feedback is enforced.</p>
        </header>

        <div className={styles.briefRow} data-show={idx > 0}>
          <Card n={card} heroLabel={heroLabel} />
        </div>

        <div className={styles.startRow} data-show={idx > 0}>
          <button
            type="button"
            className={styles.start}
            disabled={!ready}
            onClick={(e) => {
              e.stopPropagation();
              onStart();
            }}
          >
            {ready ? "Start" : "Loading the district"} <Keycap k="Enter" />
          </button>
          <div className={styles.dots}>
            {Array.from({ length: CARDS }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                aria-label={`Briefing ${n}`}
                className={styles.dot}
                data-state={n < card ? "done" : n === card && idx > 0 ? "now" : "todo"}
                style={{ ["--dur" as string]: `${CARD_MS}ms` }}
                onClick={(e) => {
                  e.stopPropagation();
                  setIdx(n);
                }}
              />
            ))}
          </div>
          <span className={styles.skipHint}>Click for the next card · Enter to start</span>
        </div>
      </div>

      <div className={styles.letterbox} data-pos="bottom">
        <span className={styles.credits}>
          <span>{DISCLAIMER}</span>
          {attribution && <span>{attribution}</span>}
        </span>
        <span>HackPrinceton · Retrofit Radar</span>
      </div>
    </div>
  );
}
