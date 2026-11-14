"use client";
// OWNER: builder D. PLACEHOLDER from the coding lead. Keep the props type (the director fills it every frame it changes).

import type { DossierState } from "../useGame";
import type { RadioLine } from "../radio";
import type { Sector } from "../types";

export type Hint = { key: string; label: string; disabled?: boolean };
export type Banner = { title: string; sub?: string; tone?: "info" | "warn" | "good" | "bad" };
export type FeedView = { caption: string; photo: { src: string; caption: string } | null };
export type DecisionView = {
  prompt: string; // "HQ proposes: RUN to 755 Spring St."
  proposed: "hold" | "run" | null;
  runLabel: string | null; // null = no fallback yet (R disabled)
  sent: string | null; // "Orders sent: RUN" once decided
  error: string | null;
};
export type HudProps = {
  objective: string;
  banner: Banner | null;
  hints: Hint[];
  health: number; // 0..100
  stamina: number; // 0..1
  radio: RadioLine[];
  busy: boolean; // the agent is running
  dossier: DossierState | null; // the hero's fortress card (walls/quake/roof/people/space)
  wallsNote: string | null; // the agent's latest verdict on the walls, e.g. "likely concrete, as the city lists it (0.72)" (from weigh_case)
  heroLabel: string;
  decision: DecisionView | null;
  compass: { yawDeg: number; waveSector: Sector | null; target: { label: string; bearingDeg: number; dist: number } | null };
  threat: number; // 0..3
  feeds: { drone: FeedView; cctv: FeedView };
  badges: { stub: boolean; replay: string | null };
  disclaimer: string;
  attribution: string | null; // "© OpenStreetMap contributors" when OSM outlines are on screen: show it in the footer
};

export function FootHud(p: HudProps) {
  return (
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", color: "#fff", font: "14px system-ui" }}>
      <div style={{ position: "absolute", top: 12, left: 12 }}>{p.objective}</div>
      {p.banner && <div style={{ position: "absolute", top: "30%", width: "100%", textAlign: "center", fontSize: 28 }}>{p.banner.title}<div style={{ fontSize: 16 }}>{p.banner.sub}</div></div>}
      <div style={{ position: "absolute", bottom: 12, left: 12 }}>HP {Math.round(p.health)} · {p.hints.map((h) => `[${h.key}] ${h.label}`).join("  ")}</div>
      {p.decision && <div style={{ position: "absolute", bottom: 60, left: "35%" }}>{p.decision.prompt} {p.decision.sent}</div>}
      <div style={{ position: "absolute", top: 12, right: 12, width: 320 }}>{p.radio.slice(-6).map((l) => <div key={l.id}>{l.who}: {l.text}</div>)}</div>
      <div style={{ position: "absolute", bottom: 4, width: "100%", textAlign: "center", opacity: 0.7 }}>{p.disclaimer}</div>
    </div>
  );
}
