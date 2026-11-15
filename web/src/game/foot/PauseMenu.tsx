"use client";
// The pause menu (P / Esc / the pause button): Resume · Missions · How to play · Restart night. The game sim is frozen
// while it's open (horde, clock, player); agent runs already in flight keep streaming.

import { useState } from "react";
import type { Objective } from "./FootHud";
import { AgentLogView, useAgentLog } from "./AgentLog";
import { cap, plain } from "./copy";
import { footStyles as styles } from "./ui";

type Tab = "how" | "missions" | "log";

const CONTROLS: [string, string][] = [
  ["W A S D", "Move"],
  ["Mouse or drag", "Look"],
  ["Shift", "Sprint"],
  ["Tab", "Your desk: inbox, building cards, city map, calculation sheet"],
  ["E", "Go through a lit door (a site visit)"],
  ["C", "Check a nearby case: a solar roof, or “same building?”"],
  ["W / S inside", "Walk between the real scan spots"],
  ["1 / 2 / 3", "Answer HQ's question inside"],
  ["1 / 2 / 3 after the quake", "Post a GREEN, YELLOW or RED tag (N: no tag)"],
  ["V", "Sound on or off"],
  ["L", "The deep agent's live log"],
  ["P / Esc", "This menu"],
];

const FLOW = [
  "You're Bob, at LA's building office. The agent, your analyst, puts today's real open cases on your desk.",
  "Its squads pull each building's data: CoStar record, Vexcel aerials, the Matterport scan, city lists, permits, the 1994 ShakeMap.",
  "Drive out on site visits and look inside. Your report is evidence (capped: strong, never final).",
  "At 5:02 pm a quake hits (a game event). The agent screens each building and proposes a tag. You post it.",
  "At dawn the aftershock tests the tags. Score: people kept safe and records fixed. File the corrections for review.",
];

export function PauseMenu({ objectives, threadId = null, onResume, onRestart }: { objectives: Objective[]; threadId?: string | null; onResume(): void; onRestart(): void }) {
  const [tab, setTab] = useState<Tab>("missions");
  const log = useAgentLog(tab === "log" ? threadId : null, true);
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
          <span>Work today&apos;s cases. Tag the buildings after the quake.</span>
        </div>
        <div className={styles.tabs}>
          <button type="button" className={styles.tab} data-on={tab === "missions"} onClick={() => setTab("missions")}>Missions</button>
          <button type="button" className={styles.tab} data-on={tab === "how"} onClick={() => setTab("how")}>How to play</button>
          {threadId && <button type="button" className={styles.tab} data-on={tab === "log"} onClick={() => setTab("log")}>Agent log</button>}
        </div>
        {tab === "log" ? (
          <div style={{ maxHeight: "52vh", overflow: "auto" }}>
            <p style={{ margin: "0 0 8px", color: "#94a3b8", fontSize: 13 }}>
              Every step HQ took tonight: who acted, which data it pulled, and the arithmetic behind each verdict. The model chooses; code computes every number.{" "}
              {threadId && <a href={`/play/log?thread=${encodeURIComponent(threadId)}`} target="_blank" rel="noreferrer" style={{ color: "#f5a524" }}>Open on a second screen ↗</a>}
            </p>
            <AgentLogView steps={log.steps} error={log.error} follow={false} />
          </div>
        ) : tab === "missions" ? (
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
