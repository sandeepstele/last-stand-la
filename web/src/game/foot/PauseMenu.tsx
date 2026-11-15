"use client";
// The pause menu (P / Esc / the pause button): Resume · Missions · How to play · Restart night. The game sim is frozen
// while it's open (horde, clock, player); agent runs already in flight keep streaming.

import { useState } from "react";
import type { Objective } from "./FootHud";
import { cap, plain } from "./copy";
import { footStyles as styles } from "./ui";

type Tab = "how" | "missions";

const CONTROLS: [string, string][] = [
  ["W A S D", "Move"],
  ["Mouse or drag", "Look"],
  ["Shift", "Sprint"],
  ["Space", "Shove"],
  ["G", "Throw a flare (draws zombies away)"],
  ["Hold your light on a zombie", "Stun it"],
  ["E", "Go through a lit door · nail boards"],
  ["C", "Check a nearby case: a solar roof, or “same building?”"],
  ["W / S inside", "Walk between the real scan spots"],
  ["1 / 2 / 3", "Answer HQ's question inside"],
  ["H / R", "Hold or run, when HQ asks"],
  ["Q", "Use a medkit"],
  ["V", "Sound on or off"],
  ["P / Esc", "This menu"],
];

const FLOW = [
  "HQ, an AI agent, picks tonight's cases from the real open-case queue.",
  "Walk into the real buildings and look. Your report is evidence.",
  "When the horde comes, HQ proposes hold or run. You decide.",
  "A dice roll, weighted by the evidence and 1994 quake data, decides the walls.",
  "At dawn, HQ drafts the corrections. You file them for review.",
];

export function PauseMenu({ objectives, onResume, onRestart }: { objectives: Objective[]; onResume(): void; onRestart(): void }) {
  const [tab, setTab] = useState<Tab>("missions");
  const main = objectives.filter((o) => o.kind === "main");
  const side = objectives.filter((o) => o.kind === "side");
  const row = (o: Objective) => {
    const m = o.text.match(/^(Case #\d+)(?: of [\d,]+)?\s*:\s*(.*)$/);
    return (
      <li key={o.id} data-done={o.done}>
        <span className={styles.mMark} aria-hidden>{o.done ? "✓" : "·"}</span>
        <span>
          {m ? `${m[1]}: ` : ""}
          {cap(plain(m ? m[2] : o.text))}
        </span>
        {o.progress && <b>{o.progress}</b>}
      </li>
    );
  };
  return (
    <div className={`${styles.root} ${styles.pause}`}>
      <div className={styles.pauseCard} role="dialog" aria-label="Paused">
        <div className={styles.pauseHead}>
          <h2>Paused</h2>
          <span>Settle tonight&apos;s cases. Make it to dawn.</span>
        </div>
        <div className={styles.tabs}>
          <button type="button" className={styles.tab} data-on={tab === "missions"} onClick={() => setTab("missions")}>Missions</button>
          <button type="button" className={styles.tab} data-on={tab === "how"} onClick={() => setTab("how")}>How to play</button>
        </div>
        {tab === "missions" ? (
          <>
            <ul className={styles.mList}>{main.map(row)}</ul>
            {!!side.length && (
              <>
                <div className={styles.mSub}>Optional</div>
                <ul className={styles.mList}>{side.map(row)}</ul>
              </>
            )}
          </>
        ) : (
          <>
            <ol className={styles.flow}>{FLOW.map((f) => <li key={f}>{f}</li>)}</ol>
            <table className={styles.ctrlTable}>
              <tbody>
                {CONTROLS.map(([k, v]) => (
                  <tr key={k}>
                    <td>{k}</td>
                    <td>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div className={styles.pauseBtns}>
          <button type="button" className={styles.btnMain} onClick={onResume}>Resume</button>
          <button type="button" className={styles.btnQuiet} onClick={onRestart}>Restart night</button>
        </div>
      </div>
    </div>
  );
}
