"use client";
// /play/log: the deep agent's log in big type, for a second screen facing the judges. ?thread=<id> pins one run;
// without it, the page follows the game's current night (and the auditor run filed from it) in this browser.

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { AgentLogView, LOG_THREAD_KEY, useAgentLog } from "@/game/foot/AgentLog";

export default function LogPage() {
  return (
    <Suspense fallback={null}>
      <Log />
    </Suspense>
  );
}

function readStored(): string | null {
  try {
    return localStorage.getItem(LOG_THREAD_KEY);
  } catch {
    return null;
  }
}

function Log() {
  const pinned = useSearchParams().get("thread");
  const [followed, setFollowed] = useState<string | null>(null);
  useEffect(() => {
    if (pinned) return;
    const sync = () => setFollowed(readStored());
    sync();
    const id = setInterval(sync, 2000); // the storage event also fires across tabs; the poll covers same-tab writes
    window.addEventListener("storage", sync);
    return () => {
      clearInterval(id);
      window.removeEventListener("storage", sync);
    };
  }, [pinned]);
  const thread = pinned ?? followed;
  const { steps, error } = useAgentLog(thread, true);
  return (
    <main style={{ minHeight: "100vh", background: "#05070d", color: "#e2e8f0", padding: "28px 36px", boxSizing: "border-box" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 12, marginBottom: 16 }}>
        <h1 style={{ margin: 0, font: "700 30px/1.1 system-ui, sans-serif" }}>The deep agent, step by step</h1>
        <span style={{ color: "#94a3b8", font: "16px system-ui, sans-serif" }}>
          {steps.length} steps · the model chooses, code computes every number · {pinned ? "pinned run" : "following the live night"}
        </span>
      </header>
      {thread ? <AgentLogView steps={steps} error={error} big /> : <p style={{ font: "18px system-ui", color: "#94a3b8" }}>Start a night in the game (same browser) and its log appears here.</p>}
    </main>
  );
}
