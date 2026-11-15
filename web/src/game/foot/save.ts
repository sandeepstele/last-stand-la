// Save / load for one night: written at quiet checkpoints, read on the intro screen ("Continue"). Continue reattaches the
// same agent thread (its history reloads from the server) and never re-sends a message: strict replay and record_note
// would double. OWNER: coding lead.
//   suite  your suite report is in      -> resume walking to the fortress
//   walls  your walls report is in      -> resume inside the fortress, ready to step out into the night
//   dawn   the debrief drafts are done  -> resume on the dawn screen (file the reports)

import { useSyncExternalStore } from "react";

export type Checkpoint = "suite" | "walls" | "dawn";
export type SaveV1 = {
  v: 1;
  threadId: string;
  checkpoint: Checkpoint;
  at: number; // Date.now()
  suiteChoice: number | null;
  tipChoice: number | null;
  prog: { reached: boolean; checked: boolean; survived: boolean; filed: boolean };
  staleStamps: Record<string, string>;
  solarStamps: Record<string, string>;
  sweep: { stamped: number; right: number };
  score?: unknown; // the dawn screen's score (dawn checkpoint only)
};

const KEY = "laststand.save.v1";
const EVT = "laststand:save";

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function writeSave(s: SaveV1) {
  try {
    const raw = JSON.stringify(s);
    if (read() === raw) return;
    localStorage.setItem(KEY, raw);
    window.dispatchEvent(new Event(EVT));
  } catch {}
}

export function clearSave() {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(EVT));
  } catch {}
}

function parse(raw: string | null): SaveV1 | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as SaveV1;
    return s?.v === 1 && typeof s.threadId === "string" && ["suite", "walls", "dawn"].includes(s.checkpoint) ? s : null;
  } catch {
    return null;
  }
}

const subscribe = (f: () => void) => {
  window.addEventListener("storage", f);
  window.addEventListener(EVT, f);
  return () => {
    window.removeEventListener("storage", f);
    window.removeEventListener(EVT, f);
  };
};

/** The saved night, if any (null on the server render). */
export function useSave(): SaveV1 | null {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  return parse(raw);
}

export const CHECKPOINT_WORDS: Record<Checkpoint, string> = {
  suite: "after your suite report: head for the fortress",
  walls: "inside the fortress, your report filed: step out into the night",
  dawn: "dawn: the drafts are ready to file",
};

/** Does the thread still exist on the agent server? (A restarted dev server forgets its threads.) */
export async function threadAlive(threadId: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/game/log/${encodeURIComponent(threadId)}`);
    return r.ok;
  } catch {
    return false;
  }
}
