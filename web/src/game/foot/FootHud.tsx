"use client";
// OWNER: builder D. Keep the props type (the director fills it every frame it changes).
// Presentation only: every number shown here comes from props (the director, the agent's tool results).

import { useState } from "react";
import type { DossierState } from "../useGame";
import { SECTOR_NAME, type RadioLine } from "../radio";
import type { ScoreKey, Sector } from "../types";
import { FEED_RECTS, SECTOR_DEG } from "./engine";
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

// ------------------------------------------------------------------ top-left: objective + fortress card
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
              </div>
              <div className={styles.barSub}>
                <span />
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
  const shown = lines.slice(-6);
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

// ------------------------------------------------------------------ the HUD
export function FootHud(p: HudProps) {
  const low = p.health < 30;
  const hints = p.decision ? p.hints.filter((h) => !["H", "R", "N"].includes(h.key)) : p.hints;
  // The door prompt is the one thing to do right now: show it big, in the middle of the screen.
  const interact = hints.find((h) => h.key === "E" && !h.disabled) ?? null;
  return (
    <div className={`${styles.root} ${styles.hud}`}>
      <div className={styles.leftCol}>
        <section className={`${styles.panel} ${styles.objective}`} key={p.objective}>
          <Icon name="target" size={22} />
          <div>
            <span className={styles.tag}>Objective</span> <Badges stub={p.badges.stub} replay={p.badges.replay} />
            <p>{p.objective}</p>
          </div>
        </section>
        <FortressMini dossier={p.dossier} heroLabel={p.heroLabel} wallsNote={p.wallsNote} />
      </div>

      <Compass compass={p.compass} threat={p.threat} />
      <Radio lines={p.radio} busy={p.busy} />
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
      </section>

      {interact && (
        <div className={styles.interact} key={interact.label}>
          <Keycap k={interact.key} size="lg" tone="amber" />
          <span>{interact.label}</span>
        </div>
      )}

      {hints.length > 0 && (
        <div className={styles.hints}>
          {hints.filter((h) => h !== interact).map((h) => (
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
