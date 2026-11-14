"use client";
// The pause menu (P / Esc / the ❚❚ button): Resume · How to play · Missions · Restart night. The game sim is frozen while
// it's open (horde, clock, player); agent runs already in flight keep streaming. OWNER: coding lead (style: design pass).

import { useState } from "react";
import type { Objective } from "./FootHud";

type Tab = "how" | "missions";

const CONTROLS: [string, string][] = [
  ["W A S D", "move"],
  ["Mouse / drag", "look"],
  ["Shift", "sprint"],
  ["Space", "shove"],
  ["G", "throw a flare (lures zombies)"],
  ["Hold your light", "on a zombie to stun it"],
  ["E", "enter a lit door · nail boards"],
  ["1 / 2 / 3", "answer HQ's question inside"],
  ["H / R", "hold or run when HQ asks"],
  ["Q", "medkit"],
  ["V", "sound on / off"],
  ["P / Esc", "this menu"],
];

const FLOW = [
  "HQ, an AI agent, picks tonight's cases from CoStar's real queue.",
  "Walk into the real buildings and look. Your report is evidence.",
  "When the horde comes, HQ proposes HOLD or RUN. You decide.",
  "Code rolls the walls against the evidence and the 1994 quake data.",
  "At dawn, HQ drafts the corrections. File them.",
];

export function PauseMenu({ objectives, onResume, onRestart }: { objectives: Objective[]; onResume(): void; onRestart(): void }) {
  const [tab, setTab] = useState<Tab>("missions");
  const main = objectives.filter((o) => o.kind === "main");
  const side = objectives.filter((o) => o.kind === "side");
  const btn = (on: boolean) => ({
    padding: "8px 14px", border: "none", borderBottom: on ? "2px solid #f5a524" : "2px solid transparent",
    background: "transparent", color: on ? "#fff" : "#94a3b8", font: "600 15px/1 system-ui, sans-serif", cursor: "pointer",
  });
  const row = (o: Objective) => (
    <li key={o.id} style={{ display: "flex", gap: 10, padding: "6px 0", color: o.done ? "#64748b" : "#e2e8f0", textDecoration: o.done ? "line-through" : "none" }}>
      <span style={{ width: 16, color: o.done ? "#4cc38a" : "#f5a524" }}>{o.done ? "✓" : "•"}</span>
      <span style={{ flex: 1 }}>{o.text}</span>
      {o.progress && <span style={{ color: "#94a3b8" }}>{o.progress}</span>}
    </li>
  );
  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 60, display: "grid", placeItems: "center", background: "rgba(3,5,10,.72)", backdropFilter: "blur(3px)" }}>
      <div style={{ width: "min(640px, 92vw)", maxHeight: "86vh", overflow: "auto", background: "rgba(10,14,24,.96)", padding: "22px 26px", color: "#e2e8f0", font: "15px/1.45 system-ui, sans-serif" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
          <h2 style={{ margin: 0, font: "700 24px/1.1 system-ui, sans-serif", letterSpacing: ".02em" }}>Paused</h2>
          <span style={{ color: "#94a3b8", fontSize: 13 }}>Settle tonight&apos;s cases and make it to dawn.</span>
        </div>
        <div style={{ display: "flex", gap: 4, margin: "14px 0 10px", borderBottom: "1px solid #1e293b" }}>
          <button type="button" style={btn(tab === "missions")} onClick={() => setTab("missions")}>Missions</button>
          <button type="button" style={btn(tab === "how")} onClick={() => setTab("how")}>How to play</button>
        </div>
        {tab === "missions" ? (
          <>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{main.map(row)}</ul>
            {!!side.length && (
              <>
                <div style={{ margin: "12px 0 2px", color: "#94a3b8", fontSize: 13 }}>Side missions</div>
                <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>{side.map(row)}</ul>
              </>
            )}
          </>
        ) : (
          <>
            <ol style={{ margin: "4px 0 12px", paddingLeft: 20 }}>{FLOW.map((f) => <li key={f} style={{ padding: "2px 0" }}>{f}</li>)}</ol>
            <table style={{ borderCollapse: "collapse", width: "100%" }}>
              <tbody>
                {CONTROLS.map(([k, v]) => (
                  <tr key={k}>
                    <td style={{ padding: "3px 12px 3px 0", whiteSpace: "nowrap", color: "#f5a524", fontWeight: 600 }}>{k}</td>
                    <td style={{ padding: "3px 0" }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
          <button type="button" onClick={onResume} style={{ padding: "10px 18px", border: "none", background: "#f5a524", color: "#111", font: "700 15px/1 system-ui, sans-serif", cursor: "pointer" }}>Resume</button>
          <button type="button" onClick={onRestart} style={{ padding: "10px 18px", border: "1px solid #334155", background: "transparent", color: "#e2e8f0", font: "600 15px/1 system-ui, sans-serif", cursor: "pointer" }}>Restart night</button>
        </div>
      </div>
    </div>
  );
}
