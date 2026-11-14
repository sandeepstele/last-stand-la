"use client";
// OWNER: builder D (intro, inside, HUD). The director flies the camera over the real district while this shows;
// onStart hands control to the player. Title card, then three briefing cards (auto-advance, click or arrow keys to skip).
// Enter starts the game (the director listens for it); the Start button starts it from a real click (pointer lock).

import { useEffect, useState, type ReactNode } from "react";
import { DISCLAIMER } from "../types";
import { Badges, Icon, Keycap, footStyles as styles } from "./ui";

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

// Four controls up front; G, Q, Space and V are taught in play by the hint chips.
const CONTROLS: { keys: string[]; what: string }[] = [
  { keys: ["W", "A", "S", "D"], what: "move" },
  { keys: ["Shift"], what: "sprint" },
  { keys: ["E"], what: "go inside" },
  { keys: ["H", "R"], what: "hold or run" },
];

const SOURCES: { icon: "record" | "city" | "aerial" | "tour"; name: string; what: string }[] = [
  { icon: "record", name: "CoStar record", what: "material, floors, people" },
  { icon: "city", name: "City retrofit orders", what: "seismic retrofit lists" },
  { icon: "aerial", name: "Vexcel aerials", what: "roofs from above" },
  { icon: "tour", name: "Matterport 3D tours", what: "the real interiors" },
];

// Card 1 carries the point (judges press Enter early): the AI agent is the commander.
function Card({ n, heroLabel }: { n: number; heroLabel: string }) {
  let body: ReactNode;
  if (n === 1) {
    body = (
      <>
        <h2>Your commander is <em>an AI agent.</em></h2>
        <p>
          It reads CoStar&apos;s real case queue, picks tonight&apos;s cases, checks the evidence and looks at the aerials itself.{" "}
          <b>It proposes. You decide.</b>
        </p>
        <div className={styles.flow}>
          <div className={styles.flowNode}>
            <strong>Case queue</strong>real open cases
          </div>
          <span className={styles.flowArrow}>&rarr;</span>
          <div className={styles.flowNode} data-tone="hq">
            <strong>HQ agent</strong>checks the evidence
          </div>
          <span className={styles.flowArrow}>&rarr;</span>
          <div className={styles.flowNode}>
            <strong>Proposal</strong>HOLD or RUN
          </div>
          <span className={styles.flowArrow}>&rarr;</span>
          <div className={styles.flowNode} data-tone="you">
            <strong>You</strong>the final call
          </div>
        </div>
      </>
    );
  } else if (n === 2) {
    body = (
      <>
        <h2>Downtown Los Angeles. <em>Every building is real.</em></h2>
        <p>Up to four real sources describe each one. Where they disagree, nobody knows yet.</p>
        <div className={styles.sources}>
          {SOURCES.map((s) => (
            <div key={s.name} className={styles.source}>
              <Icon name={s.icon} size={24} />
              <span>
                <strong>{s.name}</strong>
                <small>{s.what}</small>
              </span>
            </div>
          ))}
        </div>
      </>
    );
  } else {
    body = (
      <>
        <h2>
          Settle tonight&apos;s cases <em>and make it to dawn.</em>
        </h2>
        <p>
          First stop: <b>{heroLabel || "the beacon building"}</b>. The records disagree about its walls. Go inside and look.
        </p>
        <ul className={styles.ctrlGrid}>
          {CONTROLS.map((c) => (
            <li key={c.what}>
              <span className={styles.ctrlKeys}>
                {c.keys.map((k) => (
                  <Keycap key={k} k={k} size="lg" />
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
        <span>BRIEFING {n} / {CARDS}</span>
        <span>{n === 1 ? "THE COMMANDER" : n === 2 ? "THE CITY" : "YOUR NIGHT"}</span>
      </div>
      {body}
    </section>
  );
}

export function IntroOverlay({ heroLabel, ready, stub, replay, attribution, onStart }: IntroProps) {
  // 0 = the title card alone; 1..3 = briefing cards.
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
        <span className={styles.rec}>DOWNTOWN LOS ANGELES · DUSK</span>
        <Badges stub={stub} replay={replay} />
      </div>

      <div className={styles.stage}>
        <header className={styles.titleBlock} data-big={idx === 0}>
          <div className={styles.kicker}>One night · Real buildings · An AI commander</div>
          <h1 className={styles.title}>
            Last Stand <span>LA</span>
          </h1>
          <p className={styles.tagline}>
            Settle tonight&apos;s cases <b>and make it to dawn.</b>
          </p>
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
          <span className={styles.skipHint}>
            Click for the next briefing · <Keycap k="Enter" size="sm" /> to start now
          </span>
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
