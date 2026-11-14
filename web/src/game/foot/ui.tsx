"use client";
// OWNER: builder D. Small presentational pieces shared by the intro, HUD, inside view and dawn screen.

import type { ReactNode } from "react";
import styles from "./foot.module.css";

export { styles as footStyles };

export function Keycap({ k, size, tone }: { k: ReactNode; size?: "sm" | "lg"; tone?: "amber" }) {
  return (
    <kbd className={styles.keycap} data-size={size} data-tone={tone}>
      {k}
    </kbd>
  );
}

/** SYNTHETIC when the data is the stub; REPLAY when the agent server is replaying a recorded run. */
export function Badges({ stub, replay }: { stub: boolean; replay: string | null }) {
  const replaying = !!replay && !replay.startsWith("recording");
  if (!stub && !replaying) return null;
  return (
    <span className={styles.badges}>
      {stub && <span className={styles.badge} data-kind="stub" title="Synthetic data: not a real building">SYNTHETIC</span>}
      {replaying && <span className={styles.badge} data-kind="replay" title="The agent server is replaying a recorded run">REPLAY</span>}
    </span>
  );
}

/** "[E] step outside" -> { key: "E", rest: "step outside" }; anything else -> null. */
export function splitKeyHint(s: string): { key: string; rest: string } | null {
  const m = s.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
  return m ? { key: m[1], rest: m[2] } : null;
}

const I = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" } as const;

export function Icon({ name, size = 20 }: { name: "record" | "city" | "aerial" | "tour" | "target"; size?: number }) {
  const p = { ...I, width: size, height: size, "aria-hidden": true };
  switch (name) {
    case "record":
      return (
        <svg {...p}>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M15 3v4h4M9 11h7M9 15h7M9 19h4" />
        </svg>
      );
    case "city":
      return (
        <svg {...p}>
          <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
          <path d="M8.5 12l2.5 2.5 4.5-5" />
        </svg>
      );
    case "aerial":
      return (
        <svg {...p}>
          <rect x="9" y="9" width="6" height="6" rx="1" />
          <path d="M9 9L5 5M15 9l4-4M9 15l-4 4M15 15l4 4" />
          <circle cx="4" cy="4" r="2" />
          <circle cx="20" cy="4" r="2" />
          <circle cx="4" cy="20" r="2" />
          <circle cx="20" cy="20" r="2" />
        </svg>
      );
    case "tour":
      return (
        <svg {...p}>
          <path d="M12 2l9 5v10l-9 5-9-5V7z" />
          <path d="M3 7l9 5 9-5M12 12v10" />
        </svg>
      );
    case "target":
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="3.5" />
          <path d="M12 1v4M12 19v4M1 12h4M19 12h4" />
        </svg>
      );
  }
}
