"use client";

import { useEffect, useState } from "react";

/** The agent server can be restarted into replay mid-demo; a replayed run must never show without its badge. */
export function useReplayMode(enabled: boolean, refreshKey: unknown): string | null {
  const [replay, setReplay] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const check = () =>
      fetch("/api/backend/healthz")
        .then((r) => r.json())
        .then((h: { replay?: string | null }) => alive && setReplay(h.replay ?? null))
        .catch(() => {});
    check();
    const id = setInterval(check, 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled, refreshKey]);
  return enabled ? replay : null;
}

