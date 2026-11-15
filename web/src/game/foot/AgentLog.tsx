"use client";
// The deep agent's log, for judges: who acted (the commander or a squad), which data it pulled, and the arithmetic behind
// each verdict. Built server-side from the thread's own messages (GET /game/log/{thread_id}); read-only, no model calls.
// Three homes: the L side panel in play, the pause menu's "Agent log" tab, and /play/log (a second screen that follows the
// live night). OWNER: coding lead.

import { useEffect, useRef, useState } from "react";
import { SHORT, plain } from "./copy";

type Math = {
  start: Record<string, number>; shifts: { check: string; hypothesis: string; shift: number }[];
  sum: Record<string, number>; floor: number; total: number; result: Record<string, number>;
  leader?: string; confidence?: number; label?: string; rule: string;
};
export type LogStep =
  | { n: number; kind: "player"; text: string }
  | { n: number; kind: "call"; actor: string; tool: string; source?: string; args?: Record<string, unknown> }
  | { n: number; kind: "result"; tool: string; summary: string; math?: Math }
  | { n: number; kind: "say"; actor: string; text: string };

/** The thread the game is playing (the second screen follows it). */
export const LOG_THREAD_KEY = "laststand.log.thread";
const THREAD = /^[0-9a-f-]{8,64}$/i;

export function rememberLogThread(id: string | null | undefined) {
  if (!id || !THREAD.test(id)) return;
  try {
    if (localStorage.getItem(LOG_THREAD_KEY) !== id) localStorage.setItem(LOG_THREAD_KEY, id);
  } catch {}
}

/** Polls the log while `live`; one fetch otherwise. */
export function useAgentLog(threadId: string | null | undefined, live: boolean): { steps: LogStep[]; error: string | null } {
  const [state, setState] = useState<{ id: string | null; steps: LogStep[]; error: string | null }>({ id: null, steps: [], error: null });
  useEffect(() => {
    if (!threadId || !THREAD.test(threadId)) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pull = async () => {
      try {
        const r = await fetch(`/api/game/log/${encodeURIComponent(threadId)}`);
        const d = r.ok ? ((await r.json()) as { steps?: LogStep[] }) : null;
        if (alive) setState({ id: threadId, steps: d?.steps ?? [], error: r.ok ? null : r.status === 404 ? "No log for this run yet." : `HTTP ${r.status}` });
      } catch {
        if (alive) setState((s) => ({ ...s, error: "The agent server isn't reachable." }));
      }
      if (alive && live) timer = setTimeout(pull, 2500);
    };
    void pull();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [threadId, live]);
  return state.id === threadId ? { steps: state.steps, error: state.error } : { steps: [], error: null };
}

const word = (k: string) => SHORT[k] ?? plain(k);
const pct = (x: number | undefined) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "—");
const sign = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;

/** start → each shift → sum → ÷ total → %, one column per explanation. */
function MathTable({ m, big }: { m: Math; big: boolean }) {
  const keys = Object.keys(m.start);
  const cell: React.CSSProperties = { padding: big ? "4px 10px" : "2px 6px", textAlign: "right", whiteSpace: "nowrap" };
  const head: React.CSSProperties = { ...cell, textAlign: "left", color: "#94a3b8", fontWeight: 400 };
  return (
    <div style={{ margin: "6px 0 2px", overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", fontSize: big ? 17 : 12 }}>
        <thead>
          <tr>
            <th style={head} />
            {keys.map((k) => <th key={k} style={{ ...cell, color: k === m.leader ? "#f5a524" : "#cbd5e1" }}>{word(k)}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr><td style={head}>start (prior)</td>{keys.map((k) => <td key={k} style={cell}>{m.start[k]?.toFixed(2)}</td>)}</tr>
          {m.shifts.map((s, i) => (
            <tr key={i}>
              <td style={head}>{plain(s.check)}</td>
              {keys.map((k) => <td key={k} style={{ ...cell, color: k === s.hypothesis ? (s.shift >= 0 ? "#4cc38a" : "#f87171") : "#475569" }}>{k === s.hypothesis ? sign(s.shift) : "·"}</td>)}
            </tr>
          ))}
          <tr style={{ borderTop: "1px solid #334155" }}><td style={head}>sum</td>{keys.map((k) => <td key={k} style={cell}>{m.sum[k]?.toFixed(2)}</td>)}</tr>
          <tr><td style={head}>÷ total {m.total.toFixed(2)}</td>{keys.map((k) => <td key={k} style={{ ...cell, fontWeight: 700, color: k === m.leader ? "#f5a524" : "#e2e8f0" }}>{pct(m.result[k])}</td>)}</tr>
        </tbody>
      </table>
      <div style={{ color: "#64748b", fontSize: big ? 14 : 11, marginTop: 4 }}>{m.rule}</div>
    </div>
  );
}

function argsLine(a: Record<string, unknown> | undefined): string {
  if (!a) return "";
  return Object.entries(a)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `${plain(k)}: ${Array.isArray(v) ? v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join("; ") : typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ")
    .slice(0, 300);
}

export function AgentLogView({ steps, error, big = false, follow = true }: { steps: LogStep[]; error: string | null; big?: boolean; follow?: boolean }) {
  const end = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (follow) end.current?.scrollIntoView({ block: "end" });
  }, [steps.length, follow]);
  const fs = big ? 18 : 13;
  if (!steps.length) return <p style={{ color: "#94a3b8", fontSize: fs }}>{error ?? "Waiting for the agent's first step…"}</p>;
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0, font: `${fs}px/1.4 system-ui, sans-serif`, color: "#e2e8f0" }}>
      {steps.map((s) => (
        <li key={s.n} style={{ padding: big ? "8px 0" : "5px 0", borderBottom: "1px solid #1e293b", display: "flex", gap: 8 }}>
          <span style={{ color: "#475569", minWidth: big ? 34 : 24, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{s.n}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            {s.kind === "player" && <><b style={{ color: "#38bdf8" }}>You</b> {s.text}</>}
            {s.kind === "say" && <><b style={{ color: "#f5a524" }}>{s.actor}</b> &ldquo;{s.text}&rdquo;</>}
            {s.kind === "call" && (
              <>
                <b style={{ color: "#f5a524" }}>{s.actor}</b> <span style={{ color: "#94a3b8" }}>calls</span> <code style={{ color: "#fde68a" }}>{s.tool}</code>
                {s.source && <div style={{ color: "#a5b4fc" }}>Data: {s.source}</div>}
                {s.args && <div style={{ color: "#64748b", overflowWrap: "anywhere" }}>{argsLine(s.args)}</div>}
              </>
            )}
            {s.kind === "result" && (
              <>
                <span style={{ color: "#94a3b8" }}>→ <code style={{ color: "#cbd5e1" }}>{s.tool}</code></span> {s.summary}
                {s.math && <MathTable m={s.math} big={big} />}
              </>
            )}
          </div>
        </li>
      ))}
      <div ref={end} />
    </ol>
  );
}

/** The L side panel (and the pause tab): live while open. */
export function AgentLogPanel({ threadId, onClose }: { threadId: string | null; onClose?(): void }) {
  const { steps, error } = useAgentLog(threadId, true);
  return (
    <aside aria-label="The deep agent's log" style={{ position: "absolute", left: 12, top: 64, bottom: 240, width: "min(460px, 40vw)", zIndex: 44, overflow: "auto", background: "rgba(5,7,13,.9)", border: "1px solid #1e293b", padding: "10px 12px", pointerEvents: "auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6, font: "600 14px system-ui, sans-serif", color: "#e2e8f0" }}>
        <span>Agent log <span style={{ color: "#64748b", fontWeight: 400 }}>· {steps.length} steps · code does every number</span></span>
        <span style={{ display: "flex", gap: 10, fontSize: 12 }}>
          {threadId && <a href={`/play/log?thread=${encodeURIComponent(threadId)}`} target="_blank" rel="noreferrer" style={{ color: "#94a3b8" }}>second screen ↗</a>}
          {onClose && <button type="button" onClick={onClose} style={{ background: "none", border: "none", color: "#94a3b8", cursor: "pointer" }}>[L] close</button>}
        </span>
      </div>
      {threadId ? <AgentLogView steps={steps} error={error} /> : <p style={{ color: "#94a3b8", font: "13px system-ui" }}>The log starts when HQ&apos;s first run does.</p>}
    </aside>
  );
}
