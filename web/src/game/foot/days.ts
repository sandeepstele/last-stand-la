// Multi-day Bob's Desk: the day list (GET /desk/days, from the backend) and the career kept in this browser across days.
// Day 1 is the recorded stage shift; ?demo=1 plays Day 1 only. "Next day" keeps the history (no server reset);
// "New game" resets the server and the career. OWNER: coding lead.

import { useEffect, useState, useSyncExternalStore } from "react";

export type DayCfg = { day: number; hero_pid: string; hero_label?: string; office_pid?: string | null; suite?: string | null };
export type CareerDay = {
  day: number; hero: string; people_safe: number; people_at_stake: number; people_hurt: number; tags_right: number; tags: number;
  records_fixed: number; rescued: number; rescue_of: number; agent_tag: string | null; bob_tag: string | null; right_tag: string | null; points: number;
  /** Days 2+ have no aftershock: people_safe is the expected value, and tags_right counts tags matching the code's suggestion. */
  graded_by?: "aftershock" | "screening";
};
export type Career = { day: number; log: CareerDay[] };

const KEY = "laststand.career.v1";
const EVT = "laststand:career";
const FRESH: Career = { day: 1, log: [] };

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}
function parse(raw: string | null): Career {
  try {
    const c = raw ? (JSON.parse(raw) as Career) : null;
    return c && typeof c.day === "number" && Array.isArray(c.log) ? c : FRESH;
  } catch {
    return FRESH;
  }
}
function write(c: Career) {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
    window.dispatchEvent(new Event(EVT));
  } catch {}
}
const subscribe = (f: () => void) => {
  window.addEventListener("storage", f);
  window.addEventListener(EVT, f);
  return () => {
    window.removeEventListener("storage", f);
    window.removeEventListener(EVT, f);
  };
};

/** The career in this browser (survives a reload). */
export function useCareer(): Career {
  return parse(useSyncExternalStore(subscribe, read, () => null));
}
export const careerNow = (): Career => parse(read());
export function setCareerDay(day: number) {
  write({ ...careerNow(), day });
}
/** Record (or replace) one day's result. */
export function recordDay(entry: CareerDay) {
  const c = careerNow();
  write({ ...c, log: [...c.log.filter((d) => d.day !== entry.day), entry].sort((a, b) => a.day - b.day) });
}
export function resetCareer() {
  write(FRESH);
}

/** The backend's day list; null when the route isn't there (then every day replays Day 1's cases). */
export function useDays(enabled: boolean): DayCfg[] | null {
  const [days, setDays] = useState<DayCfg[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch("/api/game/days")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { days?: DayCfg[] } | null) => alive && Array.isArray(d?.days) && d.days.length > 0 && setDays(d.days.map((x) => ({ ...x, hero_pid: String(x.hero_pid), office_pid: x.office_pid != null ? String(x.office_pid) : null, suite: x.suite != null ? String(x.suite) : null }))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled]);
  return days;
}

/** The shift's opening message: Day 1 is the recorded stage string. Later days always name the day: the plain string
 *  re-seeds the shift log under replay, which would wipe the history the next morning should cite. */
export function startMessage(day: number): string {
  return day > 1 ? `Start Bob's shift, day ${day}` : "Start Bob's shift";
}

export const FALLBACK_DAYS = 3;
