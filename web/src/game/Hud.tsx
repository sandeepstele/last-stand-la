"use client";

// The HUD: DOM over the WebGL canvas. Phase banner, fortress card, threat pips, radio log, picture-in-picture
// feeds, the action bar and the standing disclaimer. Presentation only; the state lives in useGame.

import { useState, type ReactNode } from "react";
import { evidenceUrl } from "./Pano";
import type { RadioLine } from "./radio";
import { DISCLAIMER, SCORE_KEYS, type Dossier, type ScoreKey } from "./types";
import type { DossierState } from "./useGame";
import styles from "./hud.module.css";

export { styles as hudStyles };

const SCORE_NAME: Record<ScoreKey, string> = { walls: "Walls", quake: "Quake", roof: "Roof", people: "People", space: "Space" };

export function PhaseBanner({ title, sub, badges }: { title: string; sub: string; badges?: ReactNode }) {
  return (
    <header className={styles.banner}>
      <h1 className={styles.head}>{title}{badges}</h1>
      <p>{sub}</p>
    </header>
  );
}

export function FortressCard({ dossier, label, onStepInside }: { dossier: DossierState | null; label?: string; onStepInside?: () => void }) {
  if (!dossier) {
    return (
      <section className={styles.card}>
        <h2 className={styles.head}>No fortress yet</h2>
        <p className={styles.muted}>Click a labelled building. Hover any building for its facts on record.</p>
      </section>
    );
  }
  if (dossier === "loading") {
    return <section className={styles.card}><h2 className={styles.head}>{label ?? "Fortress"}</h2><p className={styles.muted}>Pulling the dossier…</p></section>;
  }
  if (dossier === "error") {
    return (
      <section className={styles.card}>
        <h2 className={styles.head}>{label ?? "Fortress"}</h2>
        <p className={styles.muted}>No dossier for this building. Pick a labelled one.</p>
      </section>
    );
  }
  const d: Dossier = dossier;
  const pano = d.images?.pano ?? [];
  return (
    <section className={styles.card}>
      <h2 className={styles.head}>{d.label}</h2>
      {d.case && <p className={styles.warn}>Records disagree: {d.case.question}</p>}
      <ul className={styles.scores}>
        {SCORE_KEYS.map((k) => {
          const s = d.scores?.[k];
          if (!s) return null;
          const v = Math.max(0, Math.min(100, Math.round(s.value)));
          return (
            <li key={k}>
              <div className={styles.scoreTop}>
                <strong className={styles.head}>{SCORE_NAME[k]}</strong>
                <span className={styles.track}><span className={styles.fill} data-label={s.label} style={{ width: `${v}%` }} /></span>
                <strong>{v}</strong>
              </div>
              <p className={styles.why}>{s.why}<span className={styles.chip} data-label={s.label}>{s.label}</span></p>
              <p className={styles.source}>Source: {s.source}</p>
            </li>
          );
        })}
      </ul>
      {!!d.unknowns?.length && (
        <>
          <h3 className={styles.head}>Unknowns</h3>
          <ul className={styles.unknowns}>{d.unknowns.map((u, i) => <li key={i}>{u}</li>)}</ul>
        </>
      )}
      {pano.length > 0 && onStepInside && (
        <button type="button" className={`${styles.btn} ${styles.btnAlt} ${styles.stepInside}`} onClick={onStepInside}>Step inside</button>
      )}
    </section>
  );
}

export function ThreatPips({ level }: { level: number }) {
  return (
    <div className={styles.threat}>
      <span className={styles.head}>Threat</span>
      <span className={styles.pips} aria-label={`threat ${level} of 3`}>
        {[1, 2, 3].map((i) => <span key={i} className={styles.pip} data-on={i <= level} />)}
      </span>
    </div>
  );
}

export function RadioLog({ lines, busy }: { lines: RadioLine[]; busy: boolean }) {
  const shown = lines.slice(-8);
  return (
    <section className={styles.card}>
      <h2 className={styles.head}>Radio{busy && <span className={styles.badge}>LIVE</span>}</h2>
      {shown.length ? (
        <ol className={styles.radio}>
          {shown.map((l) => (
            <li key={l.id} data-tone={l.tone}><span className={styles.who}>{l.who}:</span>{l.text}</li>
          ))}
        </ol>
      ) : <p className={styles.muted}>Quiet on the radio.</p>}
    </section>
  );
}

function Pip({ tag, name }: { tag: string; name?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const ok = !!name && failed !== name;
  return (
    <div className={styles.pipBox}>
      <span className={styles.pipTag}>{tag}</span>
      {ok ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={evidenceUrl(name)} alt={`${tag} image`} onError={() => setFailed(name)} />
      ) : (
        <div className={styles.noSignal}>{name ? "NO SIGNAL" : "NO FEED"}</div>
      )}
    </div>
  );
}

export function PipFeeds({ dossier }: { dossier: DossierState | null }) {
  const d = dossier && typeof dossier === "object" ? dossier : null;
  if (!d) return null;
  return (
    <div className={styles.pipRow}>
      <Pip tag="DRONE FEED" name={d.images?.drone?.[0]} />
      <Pip tag="CCTV" name={d.images?.cctv?.[0]} />
    </div>
  );
}

export function Footer() {
  return <footer className={styles.footer}>{DISCLAIMER}</footer>;
}
