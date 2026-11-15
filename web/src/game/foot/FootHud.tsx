"use client";
// Keep the props type (the director fills it every frame it changes).
// Presentation only: every number shown here comes from props (the director, the agent's tool results).
// Layout: top-left the current objective and how far; top-centre the compass; right HQ (the agent, always on);
// bottom-centre the radio as subtitles and the one thing to press; bottom-left health and supplies.

import { useState, type ReactNode } from "react";
import type { DossierState } from "../useGame";
import { SECTOR_NAME, type RadioLine } from "../radio";
import type { Sector } from "../types";
import { FEED_RECTS, SECTOR_DEG, type SurvivorState } from "./engine";
import { cap, plain, subtitle } from "./copy";
import { Badges, Keycap, footStyles as styles } from "./ui";

export type Hint = { key: string; label: string; disabled?: boolean };
export type Banner = { title: string; sub?: string; tone?: "info" | "warn" | "good" | "bad" };
export type FeedView = { caption: string; photo: { src: string; caption: string } | null };
/** The desk shift's tag buttons (replace HOLD/RUN when present). */
export type TagChoice = { key: string; label: string; color: string; proposed: boolean; sent: boolean };
export type DecisionView = {
  choices?: TagChoice[];
  prompt: string; // "HQ proposes: RUN to 755 Spring St."
  why?: string | null; // code's stay-vs-run comparison and suggestion (the proposal itself has no text)
  proposed: "hold" | "run" | null;
  runLabel: string | null; // null = no fallback yet (R disabled)
  sent: string | null; // "Orders sent: RUN" once decided
  error: string | null;
};
/** One line of the mission list. main = the story, side = optional. */
export type Objective = { id: string; text: string; kind: "main" | "side"; done: boolean; progress?: string };
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
  attribution: string | null; // "© OpenStreetMap contributors" when OSM outlines are on screen: show it in a corner
  // ---- missions (v2)
  objectives: Objective[]; // the current main objective (the director passes at most one); the full list is in the pause menu
  timer: { label: string; secs: number; urgent: boolean } | null; // "Nightfall" countdown; urgent = under 30 s or night has fallen
  supplies: { boards: number; medkits: number; flares?: number }; // carried; [Q] uses a medkit; [G] throws a flare
  survivors: { name: string; state: SurvivorState }[];
  barricade: { hp: number; max: number } | null; // shown bottom-centre during HOLD
  hq: ReactNode; // the HQ panel (the agent at work), rendered by the director; the right column
  /** Where the nearest chaser is, relative to the view: degrees, 0 = ahead, 90 = right, ±180 = behind. null = nobody close. */
  threatDir?: number | null;
};

const clock = (secs: number) => {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const noStop = (s: string) => s.replace(/\s*[.…]+$/, "");

// ------------------------------------------------------------------ top-left: the objective, one line, and how far
function ObjectiveLine({ text, target, timer, survivors }: { text: string; target: HudProps["compass"]["target"]; timer: HudProps["timer"]; survivors: HudProps["survivors"] }) {
  // "Case #6 of 328: reach 737 Broadway" -> a small "Case #6 of 328" over "Reach 737 Broadway".
  const m = text.match(/^(Case #\d+(?: of [\d,]+)?)\s*:\s*(.*)$/);
  const main = noStop(cap(plain(m ? m[2] : text)));
  const withYou = survivors.filter((v) => v.state === "following").map((v) => v.name);
  const safe = survivors.filter((v) => v.state === "safe").length;
  const lost = survivors.filter((v) => v.state === "lost").length;
  const people = [withYou.length ? `${withYou.join(", ")} with you` : "", safe ? `${safe} safe` : "", lost ? `${lost} lost` : ""].filter(Boolean).join(" · ");
  return (
    <section className={styles.objective} key={main}>
      {m && <span className={styles.objCase}>{m[1]}</span>}
      <span className={styles.objMain}>{main}</span>
      {(target || timer) && (
        <div className={styles.objMeta}>
          {target && <b>{Math.round(target.dist)} m</b>}
          {timer && (timer.secs > 0 ? <span data-urgent={timer.urgent}>{timer.label} in {clock(timer.secs)}</span> : <span data-urgent>{timer.label}</span>)}
        </div>
      )}
      {people && <div className={styles.objPeople}>{people}</div>}
    </section>
  );
}

// ------------------------------------------------------------------ bottom-centre: the barricade during HOLD
function BarricadeBar({ b, nail }: { b: { hp: number; max: number }; nail: Hint | null }) {
  // A hit (hp drops) replays the shake: count hits with state adjusted during render, no effect.
  const [prev, setPrev] = useState(b.hp);
  const [hits, setHits] = useState(0);
  if (b.hp !== prev) {
    setPrev(b.hp);
    if (b.hp < prev) setHits((h) => h + 1);
  }
  const f = b.max > 0 ? Math.max(0, Math.min(1, b.hp / b.max)) : 0;
  return (
    <div className={styles.barBox} data-low={f < 0.3} key={hits} data-hit={hits > 0}>
      <div className={styles.barricadeHead}>
        <span>Barricade</span>
        <b>{Math.round(b.hp)} / {Math.round(b.max)}</b>
      </div>
      <span className={styles.barricadeTrack}>
        <span style={{ width: `${f * 100}%` }} />
      </span>
      {nail && (
        <span className={`${styles.hint} ${styles.barNail}`} data-disabled={!!nail.disabled}>
          <Keycap k={nail.key} tone={nail.disabled ? undefined : "amber"} />
          {cap(nail.label)}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ top-centre: compass strip
const FOV = 180; // degrees visible across the strip
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
const pct = (delta: number) => 50 + (delta / FOV) * 100;
const CARDINAL: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };

function Compass({ compass, threat }: { compass: HudProps["compass"]; threat: number }) {
  const { yawDeg, waveSector, target } = compass;
  const ticks = [];
  for (let d = 0; d < 360; d += 15) {
    const delta = wrap180(d - yawDeg);
    if (Math.abs(delta) > FOV / 2 - 2) continue;
    const name = CARDINAL[d];
    ticks.push(
      <span key={d}>
        <span className={styles.tick} style={{ left: `${pct(delta)}%`, height: name ? 7 : 4 }} />
        {name && (
          <span className={styles.tickLabel} style={{ left: `${pct(delta)}%` }} data-major={d % 90 === 0}>
            {name}
          </span>
        )}
      </span>,
    );
  }
  // The horde: a red band on the strip when it's in view, else words on the side to turn to.
  let waveBand = null;
  let waveEdge = null;
  if (waveSector) {
    const delta = wrap180(SECTOR_DEG[waveSector] - yawDeg);
    if (Math.abs(delta) <= FOV / 2 + 22.5) {
      const l = Math.max(0, pct(delta - 22.5));
      const r = Math.min(100, pct(delta + 22.5));
      waveBand = <span className={styles.waveBand} style={{ left: `${l}%`, width: `${r - l}%` }} />;
    } else {
      waveEdge = (
        <span className={styles.hordeEdge} style={delta < 0 ? { left: 0 } : { right: 0 }}>
          {delta < 0 ? "‹ horde" : "horde ›"}
        </span>
      );
    }
  }
  let mark = null;
  if (target) {
    const delta = wrap180(target.bearingDeg - yawDeg);
    const edge = Math.abs(delta) > FOV / 2 - 4;
    const at = edge ? (delta < 0 ? 3 : 97) : pct(delta);
    mark = <span className={styles.targetMark} data-edge={edge} style={{ left: `${at}%` }} />;
  }
  const near = threat >= 3 ? "close" : threat === 2 ? "near" : null;
  return (
    <div className={styles.compassWrap}>
      <div className={styles.compassBox}>
        <div className={styles.compass} aria-label={`heading ${Math.round(yawDeg)} degrees`}>
          {waveBand}
          {ticks}
          {mark}
        </div>
        {waveEdge}
      </div>
      {waveSector && (
        <div className={styles.hordeLine}>
          Horde from the {SECTOR_NAME[waveSector]}
          {near && <span> · {near}</span>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ bottom-centre: the radio, as subtitles
/** The newest radio line worth reading, as a game subtitle: speaker in amber, at most two lines, fades after 7 s. */
export function RadioSubs({ lines, layer = false }: { lines: RadioLine[]; layer?: boolean }) {
  let line: { who: string; text: string; id: string } | null = null;
  for (let i = lines.length - 1; i >= 0 && !line; i--) {
    const s = subtitle(lines[i]);
    if (s) line = { ...s, id: lines[i].id };
  }
  const body = line ? (
    <div className={styles.subs} aria-live="polite">
      <p className={styles.sub} key={line.id} data-who={line.who}>
        <b>{line.who}</b>
        {line.text}
      </p>
    </div>
  ) : null;
  if (!layer) return body;
  // Over the inside view: its own layer (fonts, colours), nothing at all when the radio is quiet.
  return body ? <div className={`${styles.root} ${styles.subsLayer}`}>{body}</div> : null;
}

// ------------------------------------------------------------------ centre: the banner, animating in and out
function BannerView({ banner }: { banner: Banner | null }) {
  // Keep the last banner on screen while it animates out (state adjusted during render, no effect).
  const [prev, setPrev] = useState<Banner | null>(banner);
  const [shown, setShown] = useState<Banner | null>(banner);
  if (banner !== prev) {
    setPrev(banner);
    if (banner) setShown(banner);
  }
  if (!shown) return null;
  const leaving = !banner;
  return (
    <div
      key={`${shown.title}|${shown.sub ?? ""}`}
      className={styles.banner}
      data-tone={shown.tone ?? "info"}
      data-phase={leaving ? "out" : "in"}
      onAnimationEnd={() => {
        if (leaving) setShown(null);
      }}
    >
      <h1>{plain(shown.title)}</h1>
      {shown.sub && <p>{plain(shown.sub)}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ bottom-centre: HOLD / RUN orders
function Decision({ d, busy }: { d: DecisionView; busy: boolean }) {
  const sentAction = d.sent ? (/\brun\b/i.test(d.sent) ? "run" : "hold") : null;
  const order = (which: "hold" | "run", key: string, text: string, disabled = false) => (
    <div
      className={styles.order}
      data-proposed={d.proposed === which && !sentAction}
      data-disabled={disabled}
      data-sent={sentAction === which}
      data-faded={!!sentAction && sentAction !== which}
    >
      <Keycap k={key} size="lg" tone={d.proposed === which && !sentAction ? "amber" : undefined} />
      <span className={styles.orderText}>{text}</span>
      {d.proposed === which && <span className={styles.hqCall}>HQ&apos;s call</span>}
    </div>
  );
  // HQ proposes, you decide: a slim strip at the bottom so the horde stays in view.
  return (
    <section className={styles.decision}>
      <div className={styles.decTop}>
        <h3>
          {d.sent ?? d.prompt}
          {busy && !d.proposed && !d.sent && (
            <span className={styles.thinking}>
              <i />
              <i />
              <i />
            </span>
          )}
        </h3>
        {!d.sent && d.proposed && <span className={styles.decSub}>Your call is final.</span>}
      </div>
      {d.why && !d.sent && <p className={styles.decSub} style={{ margin: "2px 0 6px" }}>{d.why}</p>}
      <div className={styles.choices}>
        {d.choices ? d.choices.map((c) => (
          <div key={c.key} className={styles.order} data-proposed={c.proposed && !d.sent} data-sent={c.sent} data-faded={!!d.sent && !c.sent}
            style={{ borderColor: c.proposed || c.sent ? c.color : undefined }}>
            <Keycap k={c.key} size="lg" tone={c.proposed && !d.sent ? "amber" : undefined} />
            <span className={styles.orderText} style={{ color: c.color }}>{c.label}</span>
            {c.proposed && <span className={styles.hqCall} style={{ position: "absolute", top: -8, right: 8, padding: "1px 5px", borderRadius: 2, background: "#17130d" }}>HQ&apos;s call</span>}
          </div>
        )) : order("hold", "H", "Hold")}
        {!d.choices && order("run", "R", d.runLabel ? `Run to ${d.runLabel}` : "Run (no fallback yet)", !d.runLabel)}
      </div>
      {d.error && <p className={styles.error}>{d.error}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ bottom-right: the camera views (drawn in WebGL at FEED_RECTS)
// Honesty: the live views are GAME camera renders, not real feeds. Only a `photo` (a real image on file) is real.
function FeedFrame({ slot, feed }: { slot: "drone" | "cctv"; feed: FeedView }) {
  const r = FEED_RECTS[slot];
  const photo = feed.photo;
  // "HQ looked from above: <what it saw>" / "Nearby aerial: 755 Spring St": the part before the colon labels the frame.
  const split = photo?.caption.match(/^([^:]{3,40}):\s*(.+)$/);
  const label = photo ? plain(split ? split[1] : "Real image") : slot === "drone" ? "Drone view" : "Street camera";
  const caption = photo ? plain(split ? split[2] : photo.caption) : null;
  // The live view's own caption ("DRONE 70 m above you · N up", "CCTV 737 Broadway · SW corner"), shortened.
  const live = feed.caption.trim().replace(/^(DRONE|CCTV)\b[\s·:-]*/i, "").replace(/\babove you\b/, "up").replace(/\bN up\b/, "north up");
  return (
    <div className={styles.feed} data-photo={!!photo} data-slot={slot} style={{ right: r.right, bottom: r.bottom, width: r.w, height: r.h }}>
      <div className={styles.feedHead}>
        <span className={styles.feedLabel}>{label}</span>
        <span className={styles.feedCaption}>{photo ? "real image" : live}</span>
      </div>
      {photo && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={photo.src} src={photo.src} alt={photo.caption} />
          {caption && <div className={styles.photoCap}>{caption}</div>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ damage feedback: a red flash on each hit, a pulsing edge when low
function Hurt({ health }: { health: number }) {
  const [prev, setPrev] = useState(health);
  const [hits, setHits] = useState(0);
  if (health !== prev) {
    setPrev(health);
    if (health < prev - 0.5) setHits((h) => h + 1);
  }
  return (
    <>
      {health < 30 && <div className={styles.lowEdge} />}
      {hits > 0 && <div className={styles.hitFlash} key={hits} />}
    </>
  );
}

// ------------------------------------------------------------------ the nearest chaser: a soft red glow on that screen edge
function ThreatGlow({ dir }: { dir: number | null }) {
  if (dir === null || !Number.isFinite(dir)) return null;
  const r = (dir * Math.PI) / 180;
  const dx = Math.sin(r);
  const dy = -Math.cos(r); // 0 = ahead = top edge; 180 = behind = bottom edge
  const k = 1 / Math.max(Math.abs(dx), Math.abs(dy), 1e-6);
  const x = 50 + dx * k * 50;
  const y = 50 + dy * k * 50;
  return (
    <div
      className={styles.threatGlow}
      style={{ background: `radial-gradient(ellipse 30% 42% at ${x}% ${y}%, rgba(229, 83, 75, 0.75) 0%, rgba(229, 83, 75, 0.32) 40%, rgba(229, 83, 75, 0) 72%)` }}
    />
  );
}

// ------------------------------------------------------------------ the HUD
export function FootHud(p: HudProps) {
  const low = p.health < 30;
  const hints = p.decision ? p.hints.filter((h) => !["H", "R", "N"].includes(h.key)) : p.hints;
  // During HOLD the [E] hint (nail boards) sits under the barricade bar; otherwise the door prompt is the one thing to do now.
  const nail = p.barricade ? hints.find((h) => h.key === "E") ?? null : null;
  const interact = p.barricade ? null : hints.find((h) => h.key === "E" && !h.disabled) ?? null;
  // Night, HOLD and escape: the director's line is the objective (it says what to do this second).
  const compact = !!p.decision || !!p.barricade || !!p.compass.waveSector || /^Run to /.test(p.objective);
  const rest = hints.filter((h) => h !== interact && h !== nail);
  const main = p.decision ? p.objectives[0]?.text ?? p.objective : compact ? p.objective : p.objectives[0]?.text ?? p.objective;
  // "Optional: look inside 750 Broadway" -> the word "Optional" stays quiet next to the action.
  const im = interact?.label.match(/^(Optional|Nearby):\s*(.*)$/i);
  const s = p.supplies;
  const supplies = [
    s.medkits > 0 ? `Medkits ${s.medkits}` : "", // the desk shift: no boards, no flares
  ].filter(Boolean);
  return (
    <div className={`${styles.root} ${styles.hud}`} data-compact={compact} data-deciding={!!p.decision} data-holding={!!p.barricade}>
      <Hurt health={p.health} />
      <ThreatGlow dir={p.threatDir ?? null} />
      {main && <ObjectiveLine text={main} target={p.compass.target} timer={p.timer} survivors={p.survivors} />}

      <Compass compass={p.compass} threat={p.threat} />
      {p.hq && (
        <div className={styles.rightCol}>
          <div className={styles.hqSlot}>{p.hq}</div>
        </div>
      )}
      <BannerView banner={p.banner} />

      {!p.decision?.choices && <RadioSubs lines={p.radio} />}
      {/* One action slot, bottom centre between the vitals and the camera views. */}
      <div className={styles.actionSlot}>
        {p.decision ? (
          <Decision d={p.decision} busy={p.busy} />
        ) : p.barricade ? (
          <BarricadeBar b={p.barricade} nail={nail} />
        ) : interact ? (
          <div className={styles.interact} key={interact.label}>
            <Keycap k={interact.key} size="lg" tone="amber" />
            {im ? (
              <span>
                <em>{cap(im[1])}: </em>
                {im[2]}
              </span>
            ) : (
              <span>{cap(interact.label)}</span>
            )}
          </div>
        ) : null}
      </div>

      <section className={styles.vitals} aria-label="Health and supplies">
        <span className={styles.hp} data-low={low} title={`Health ${Math.round(Math.max(0, p.health))}`}>
          <span style={{ width: `${Math.max(0, Math.min(100, p.health))}%` }} />
        </span>
        <span className={styles.st} data-low={p.stamina < 0.25} data-full={p.stamina > 0.985}>
          <span style={{ width: `${Math.max(0, Math.min(1, p.stamina)) * 100}%` }} />
        </span>
        <div className={styles.supplies}>{supplies.join(" · ")}</div>
      </section>
      <div className={styles.corner}>
        <Badges stub={p.badges.stub} replay={p.badges.replay} />
      </div>

      {rest.length > 0 && !p.decision && (
        <div className={styles.hints}>
          {rest.map((h) => (
            <span key={`${h.key}-${h.label}`} className={styles.hint} data-disabled={!!h.disabled}>
              <Keycap k={h.key} size="sm" />
              {cap(h.label)}
            </span>
          ))}
        </div>
      )}

      <FeedFrame slot="cctv" feed={p.feeds.cctv} />
      <FeedFrame slot="drone" feed={p.feeds.drone} />

      {p.attribution && <span className={styles.attrib}>{p.attribution}</span>}
    </div>
  );
}
