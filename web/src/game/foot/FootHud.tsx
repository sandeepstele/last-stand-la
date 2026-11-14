"use client";
// OWNER: builder D. Keep the props type (the director fills it every frame it changes).
// Presentation only: every number shown here comes from props (the director, the agent's tool results).

import { useState, type ReactNode } from "react";
import type { DossierState } from "../useGame";
import { SECTOR_NAME, type RadioLine } from "../radio";
import type { ScoreKey, Sector } from "../types";
import { FEED_RECTS, SECTOR_DEG, type SurvivorState } from "./engine";
import { Badges, Icon, Keycap, footStyles as styles } from "./ui";

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
/** One line of the mission list. main = the story (★), side = optional (◇). */
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
  attribution: string | null; // "© OpenStreetMap contributors" when OSM outlines are on screen: show it in the footer
  // ---- missions (v2)
  objectives: Objective[]; // replaces the single objective line as the main top-left element (keep `objective` as the current hint under it)
  timer: { label: string; secs: number; urgent: boolean } | null; // "Nightfall" countdown; urgent = under 30 s or night has fallen
  supplies: { boards: number; medkits: number; flares?: number }; // carried; [Q] uses a medkit; [G] throws a flare
  survivors: { name: string; state: SurvivorState }[];
  barricade: { hp: number; max: number } | null; // shown big, bottom-centre, during HOLD
  hq: ReactNode; // the HQ panel (the agent at work), rendered by the director; place it in the right column under the radio
};

// ------------------------------------------------------------------ top-left: missions, clock, survivors, fortress card
const clock = (secs: number) => {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

function Missions({ objectives, now, timer, survivors, badges }: { objectives: Objective[]; now: string; timer: HudProps["timer"]; survivors: HudProps["survivors"]; badges: HudProps["badges"] }) {
  return (
    <section className={`${styles.panel} ${styles.missions}`}>
      <div className={styles.missionHead}>
        <span className={styles.tag}>Missions</span>
        <Badges stub={badges.stub} replay={badges.replay} />
      </div>
      {timer && (
        <div className={styles.timer} data-urgent={timer.urgent}>
          <span>{timer.label}</span>
          {timer.secs > 0 && <b>{clock(timer.secs)}</b>}
        </div>
      )}
      <ul className={styles.objList}>
        {objectives.map((o) => (
          <li key={o.id} data-kind={o.kind} data-done={o.done}>
            <span className={styles.objMark}>{o.done ? <ObjIcon name="check" /> : <ObjIcon name={o.kind === "main" ? "star" : "diamond"} />}</span>
            <span className={styles.objText}>{o.text}</span>
            {o.progress && <b className={styles.objProg}>{o.progress}</b>}
          </li>
        ))}
      </ul>
      {survivors.length > 0 && (
        <div className={styles.survivors}>
          {survivors.map((v, i) => (
            <span key={`${v.name}-${i}`} className={styles.survivor} data-state={v.state}>
              {v.state === "safe" && <ObjIcon name="check" size={11} />}
              {v.name}
            </span>
          ))}
        </div>
      )}
      {now && (
        <p className={styles.now} key={now}>
          <Icon name="target" size={15} />
          {now}
        </p>
      )}
    </section>
  );
}

function ObjIcon({ name, size = 14 }: { name: "star" | "diamond" | "check" | "plank" | "cross"; size?: number }) {
  const p = { width: size, height: size, viewBox: "0 0 24 24", "aria-hidden": true } as const;
  if (name === "star") return <svg {...p}><path fill="currentColor" d="M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z" /></svg>;
  if (name === "diamond") return <svg {...p}><path fill="none" stroke="currentColor" strokeWidth="2.4" d="M12 3l9 9-9 9-9-9z" /></svg>;
  if (name === "check") return <svg {...p}><path fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" d="M4 12.5l5 5L20 6.5" /></svg>;
  if (name === "plank") return <svg {...p}><rect x="2" y="8" width="20" height="8" rx="1.5" fill="#8a5a32" stroke="#c9915a" strokeWidth="1.2" /><circle cx="6" cy="12" r="1.2" fill="#222" /><circle cx="18" cy="12" r="1.2" fill="#222" /></svg>;
  return <svg {...p}><rect x="2.5" y="2.5" width="19" height="19" rx="4" fill="#f4f4f5" /><path fill="#e5484d" d="M10 6h4v4h4v4h-4v4h-4v-4H6v-4h4z" /></svg>;
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
  const low = f < 0.3;
  return (
    <div className={styles.barricadeWrap}>
      <div className={styles.barricade} data-low={low} key={hits} data-hit={hits > 0}>
        <div className={styles.barricadeHead}>
          <strong>Barricade</strong>
          <b>{Math.round(b.hp)} / {Math.round(b.max)}</b>
        </div>
        <span className={styles.barricadeTrack}>
          <span style={{ width: `${f * 100}%` }} />
        </span>
      </div>
      {nail && (
        <span className={styles.hint} data-disabled={!!nail.disabled}>
          <Keycap k={nail.key} />
          {nail.label}
        </span>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ the fortress card
const BARS: { key: ScoreKey; name: string }[] = [
  { key: "walls", name: "Walls" },
  { key: "quake", name: "Quake" },
  { key: "roof", name: "Roof" },
];

function FortressMini({ dossier, heroLabel, wallsNote }: { dossier: DossierState | null; heroLabel: string; wallsNote: string | null }) {
  if (!dossier || dossier === "error") return null;
  if (dossier === "loading") {
    return (
      <section className={`${styles.panel} ${styles.fortress}`}>
        <span className={styles.tag}>Tonight&apos;s fortress</span>
        <h2>{heroLabel}</h2>
        <p className={styles.quiet}>Pulling the records…</p>
      </section>
    );
  }
  const d = dossier;
  return (
    <section className={`${styles.panel} ${styles.fortress}`}>
      <div className={styles.fortressHead}>
        <span className={styles.tag}>Tonight&apos;s fortress</span>
      </div>
      <h2>{d.label || heroLabel}</h2>
      {d.case && !wallsNote && <p className={styles.disagree}>The records disagree about its walls.</p>}
      <ul className={styles.bars}>
        {BARS.map(({ key, name }) => {
          const s = d.scores?.[key];
          if (!s) return null;
          const v = Math.max(0, Math.min(100, Math.round(s.value)));
          return (
            <li key={key}>
              <div className={styles.barTop}>
                <strong>{name.toUpperCase()}</strong>
                <span className={styles.track}>
                  <span className={styles.fill} data-label={s.label} style={{ width: `${v}%` }} />
                </span>
                <b>{v}</b>
                <span className={styles.label} data-label={s.label}>{s.label}</span>
              </div>
              {key === "walls" && wallsNote && (
                <p className={styles.wallsNote} key={wallsNote}>
                  <b>HQ</b>
                  {wallsNote}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
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
        <span className={styles.tick} style={{ left: `${pct(delta)}%`, height: name ? 10 : 6 }} />
        {name && (
          <span className={styles.tickLabel} style={{ left: `${pct(delta)}%` }} data-major={d % 90 === 0} data-n={d === 0}>
            {name}
          </span>
        )}
      </span>,
    );
  }
  let wave = null;
  if (waveSector) {
    const delta = wrap180(SECTOR_DEG[waveSector] - yawDeg);
    if (Math.abs(delta) <= FOV / 2 + 22.5) {
      const l = Math.max(0, pct(delta - 22.5));
      const r = Math.min(100, pct(delta + 22.5));
      wave = <span className={styles.waveBand} style={{ left: `${l}%`, width: `${r - l}%` }} />;
    } else {
      wave = (
        <span className={`${styles.edge} ${styles.waveInfo}`} style={delta < 0 ? { left: 6 } : { right: 6 }}>
          {delta < 0 ? "« HORDE" : "HORDE »"}
        </span>
      );
    }
  }
  let mark = null;
  let turn: string | null = null;
  if (target) {
    const delta = wrap180(target.bearingDeg - yawDeg);
    const edge = Math.abs(delta) > FOV / 2 - 4;
    const at = edge ? (delta < 0 ? 3 : 97) : pct(delta);
    mark = <span className={styles.targetMark} data-edge={edge} style={{ left: `${at}%` }} />;
    if (Math.abs(delta) > 35) turn = delta < 0 ? "«" : "»";
  }
  return (
    <div className={styles.compassWrap}>
      <div className={styles.compass} aria-label={`heading ${Math.round(yawDeg)} degrees`}>
        {wave}
        {ticks}
        {mark}
      </div>
      {target && (
        <div className={styles.targetInfo}>
          {turn === "«" && <span className={styles.turn}>«</span>}
          <Icon name="target" size={15} />
          <span>{target.label}</span>
          <b>{Math.round(target.dist)} m</b>
          {turn === "»" && <span className={styles.turn}>»</span>}
        </div>
      )}
      {(threat > 0 || waveSector) && (
        <div className={styles.threat} data-level={threat}>
          <span className={styles.tag}>Threat</span>
          {[1, 2, 3].map((i) => (
            <span key={i} className={styles.pip} data-on={i <= threat} />
          ))}
          {waveSector && <span className={styles.waveInfo}>&nbsp;Horde from the {SECTOR_NAME[waveSector]}</span>}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ top-right: the radio
function Radio({ lines, busy }: { lines: RadioLine[]; busy: boolean }) {
  const shown = lines.slice(-5);
  return (
    <section className={`${styles.panel} ${styles.radio}`} data-busy={busy}>
      <div className={styles.radioHead}>
        <span className={styles.tag}>HQ radio · AI commander</span>
        {busy ? <span className={styles.busy}>THINKING</span> : <span className={styles.idle}>STANDING BY</span>}
      </div>
      {shown.length ? (
        <ol className={styles.lines}>
          {shown.map((l) => (
            <li key={l.id} data-tone={l.tone}>
              <span className={styles.who}>{l.who}</span>
              {l.text}
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.quiet}>Quiet on the radio.</p>
      )}
    </section>
  );
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
      <h1>{shown.title}</h1>
      {shown.sub && <p>{shown.sub}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ bottom-centre: HOLD / RUN orders
function Decision({ d, busy }: { d: DecisionView; busy: boolean }) {
  const sentAction = d.sent ? (/\bRUN\b/.test(d.sent) ? "run" : "hold") : null;
  const order = (which: "hold" | "run", key: string, text: string, disabled = false) => (
    <div
      className={styles.order}
      data-proposed={d.proposed === which && !sentAction}
      data-disabled={disabled}
      data-sent={sentAction === which}
      data-faded={!!sentAction && sentAction !== which}
    >
      {d.proposed === which && <span className={styles.hqCall}>HQ&apos;S CALL</span>}
      <Keycap k={key} size="lg" tone={d.proposed === which ? "amber" : undefined} />
      <span>{text}</span>
    </div>
  );
  return (
    <section className={`${styles.panel} ${styles.decision}`}>
      <span className={styles.tag}>Orders · HQ proposes, you decide</span>
      <h3>
        {d.prompt}
        {busy && !d.proposed && !d.sent && (
          <span className={styles.thinking}>
            <i />
            <i />
            <i />
          </span>
        )}
      </h3>
      <div className={styles.choices}>
        {order("hold", "H", "Hold")}
        {order("run", "R", d.runLabel ? `Run to ${d.runLabel}` : "Run (no fallback yet)", !d.runLabel)}
      </div>
      {d.sent ? <p className={styles.sent}>{d.sent}</p> : <p className={styles.decNote}>HQ&apos;s call is a proposal. Yours is final.</p>}
      {d.error && <p className={styles.error}>{d.error}</p>}
    </section>
  );
}

// ------------------------------------------------------------------ bottom-right: live feeds (drawn in WebGL at FEED_RECTS)
function FeedFrame({ slot, feed }: { slot: "drone" | "cctv"; feed: FeedView }) {
  const r = FEED_RECTS[slot];
  const label = slot === "drone" ? "DRONE" : "CCTV";
  const cap = feed.caption.trim();
  const caption = cap.toUpperCase().startsWith(label) ? cap.slice(label.length).replace(/^[\s·:-]+/, "") : cap;
  return (
    <div className={styles.feed} data-photo={!!feed.photo} style={{ right: r.right, bottom: r.bottom, width: r.w, height: r.h }}>
      <div className={styles.feedHead}>
        <span className={styles.feedLabel}>REC {label}</span>
        <span className={styles.feedCaption}>{feed.photo ? "HQ's own look" : caption}</span>
      </div>
      {feed.photo && (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={feed.photo.src} src={feed.photo.src} alt={feed.photo.caption} />
          <span className={styles.scan} />
          <div className={styles.photoCap}>
            <b>AGENT VISION</b>
            {feed.photo.caption}
          </div>
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

// ------------------------------------------------------------------ the HUD
export function FootHud(p: HudProps) {
  const low = p.health < 30;
  const hints = p.decision ? p.hints.filter((h) => !["H", "R", "N"].includes(h.key)) : p.hints;
  // During HOLD the [E] hint (nail boards) sits by the barricade bar; otherwise the door prompt is the one thing
  // to do right now: show it big, in the middle of the screen.
  const nail = p.barricade ? hints.find((h) => h.key === "E") ?? null : null;
  const interact = p.barricade ? null : hints.find((h) => h.key === "E" && !h.disabled) ?? null;
  return (
    <div className={`${styles.root} ${styles.hud}`}>
      <Hurt health={p.health} />
      <div className={styles.leftCol}>
        <Missions objectives={p.objectives} now={p.objective} timer={p.timer} survivors={p.survivors} badges={p.badges} />
        <FortressMini dossier={p.dossier} heroLabel={p.heroLabel} wallsNote={p.wallsNote} />
      </div>

      <Compass compass={p.compass} threat={p.threat} />
      <div className={styles.rightCol}>
        <Radio lines={p.radio} busy={p.busy} />
        {p.hq && <div className={styles.hqSlot}>{p.hq}</div>}
      </div>
      {p.barricade && <BarricadeBar b={p.barricade} nail={nail} />}
      <BannerView banner={p.banner} />

      {p.decision && <Decision d={p.decision} busy={p.busy} />}

      <section className={`${styles.panel} ${styles.vitals}`}>
        <div className={styles.vitalRow}>
          <span className={styles.tag}>Health</span>
          <span className={styles.hp} data-low={low}>
            <span style={{ width: `${Math.max(0, Math.min(100, p.health))}%` }} />
          </span>
          <b style={low ? { color: "var(--red)" } : undefined}>{Math.round(Math.max(0, p.health))}</b>
        </div>
        <div className={styles.vitalRow}>
          <span className={styles.tag}>Stamina</span>
          <span className={styles.st} data-low={p.stamina < 0.25}>
            <span style={{ width: `${Math.max(0, Math.min(1, p.stamina)) * 100}%` }} />
          </span>
          <span />
        </div>
        <div className={styles.supplies}>
          <span data-empty={p.supplies.boards === 0} title="Boards">
            <ObjIcon name="plank" size={18} />
            <b>{p.supplies.boards}</b> boards
          </span>
          <span data-empty={p.supplies.medkits === 0} title="Medkits">
            <ObjIcon name="cross" size={16} />
            <b>{p.supplies.medkits}</b> medkits
          </span>
        </div>
      </section>

      {interact && (
        <div className={styles.interact} key={interact.label}>
          <Keycap k={interact.key} size="lg" tone="amber" />
          <span>{interact.label}</span>
        </div>
      )}

      {hints.length > 0 && (
        <div className={styles.hints}>
          {hints.filter((h) => h !== interact && h !== nail).map((h) => (
            <span key={`${h.key}-${h.label}`} className={styles.hint} data-disabled={!!h.disabled} data-key={h.key}>
              <Keycap k={h.key} />
              {h.label}
            </span>
          ))}
        </div>
      )}

      <FeedFrame slot="cctv" feed={p.feeds.cctv} />
      <FeedFrame slot="drone" feed={p.feeds.drone} />

      <footer className={styles.footer}>
        <span>{p.disclaimer}</span>
        {p.attribution && <span>{p.attribution}</span>}
      </footer>
    </div>
  );
}
