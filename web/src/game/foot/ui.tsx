"use client";
// Small presentational pieces shared by the intro, HUD, inside view, pause menu and dawn screen.

import type { ReactNode } from "react";
import styles from "./foot.module.css";

export { styles as footStyles };

/** A key prompt: the key's name in a thin outlined square. */
export function Keycap({ k, size, tone }: { k: ReactNode; size?: "sm" | "lg"; tone?: "amber" }) {
  return (
    <kbd className={styles.keycap} data-size={size} data-tone={tone}>
      {k}
    </kbd>
  );
}

/** "Synthetic data" when the data is the stub; "Replay" when the agent server is replaying a recorded run. Small, grey. */
export function Badges({ stub, replay }: { stub: boolean; replay: string | null }) {
  const replaying = !!replay && !replay.startsWith("recording");
  if (!stub && !replaying) return null;
  return (
    <span className={styles.badges}>
      {stub && <span className={styles.badge} title="Synthetic data: not a real building">Synthetic data</span>}
      {replaying && <span className={styles.badge} title="The agent server is replaying a recorded run">Replay</span>}
    </span>
  );
}

/** "[E] step outside" -> { key: "E", rest: "step outside" }; anything else -> null. */
export function splitKeyHint(s: string): { key: string; rest: string } | null {
  const m = s.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
  return m ? { key: m[1], rest: m[2] } : null;
}
