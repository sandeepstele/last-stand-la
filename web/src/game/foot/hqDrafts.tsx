"use client";
// OWNER: builder F (HQ panel). The dawn debrief: the draft corrections HQ writes for tonight's cases, one card each,
// citing the evidence it chose and, when you gave one, your own report. Drafts only: a person reviews each one.
// <HqDrafts messages busy /> renders nothing until "Debrief the night shift" is on the thread (or a draft exists),
// so it can be mounted unconditionally (the dawn screen); the HQ panel uses <DraftList variant="panel" />.

import { useMemo } from "react";
import { draftsModel, type DraftsView } from "./hqModel";
import styles from "./hq.module.css";

export type HqDraftsProps = {
  messages: readonly unknown[]; // the laststand thread
  busy: boolean; // a run is in progress (the debrief is being drafted)
  variant?: "dawn" | "panel"; // dawn: wide, two columns, larger type (default); panel: fits the 360 px HQ panel
};

export function HqDrafts({ messages, busy, variant = "dawn" }: HqDraftsProps) {
  const view = useMemo(() => draftsModel(messages, busy), [messages, busy]);
  return <DraftList view={view} variant={variant} />;
}

export function DraftList({ view, variant }: { view: DraftsView; variant: "dawn" | "panel" }) {
  if (!view.requested && !view.drafts.length) return null;
  const pending = view.drafting ? Math.max(0, (view.expected ?? 0) - view.done) : 0;
  const count = view.drafting
    ? view.expected ? `${view.done} of ${view.expected} drafted` : "reading the night's cases"
    : `${view.done} draft${view.done === 1 ? "" : "s"}`;
  return (
    <section className={styles.drafts} data-variant={variant} data-busy={view.drafting} aria-label="Tonight's draft corrections, written by HQ">
      <header className={styles.draftsHead}>
        {view.drafting ? <span className={styles.spin} aria-hidden /> : <span className={styles.doneDot} aria-hidden />}
        <strong>{view.drafting ? "HQ is drafting tonight's corrections" : "Tonight's corrections, drafted by HQ"}</strong>
        <em aria-live="polite">{count}</em>
      </header>
      {view.drafts.length > 0 || pending > 0 ? (
        <ol className={styles.draftCards}>
          {view.drafts.map((d) => (
            <li key={d.id} className={styles.draft}>
              <div className={styles.draftTop}>
                <b>{d.n != null ? `Case #${d.n} · ` : ""}{d.where}</b>
                {d.verdict && <span className={styles.label} data-label={d.verdict.label}>{d.verdict.label}</span>}
              </div>
              {d.verdict && (
                <div className={styles.draftVerdict}>
                  <span>{d.verdict.label === "unresolved" ? "not settled yet" : d.verdict.words}</span>
                  <strong>{d.verdict.pct}%</strong>
                </div>
              )}
              <p className={styles.draftText}>
                <span className={styles.draftBadge}>DRAFT</span> {d.text}
              </p>
              {d.evidence.length > 0 && (
                <p className={styles.draftEvidence}>
                  <span>Evidence:</span> {d.evidence.join(" · ")}
                </p>
              )}
              {d.yourReport && (
                <p className={styles.yourReport}>
                  <span>Your report:</span> &ldquo;{d.yourReport}&rdquo;
                </p>
              )}
            </li>
          ))}
          {Array.from({ length: pending }, (_, i) => (
            <li key={`pending-${i}`} className={styles.draft} data-pending>
              <div className={styles.draftTop}>
                <span className={styles.spin} aria-hidden />
                <b>Drafting…</b>
              </div>
              <span className={styles.skeleton} />
              <span className={styles.skeleton} style={{ width: "70%" }} />
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.muted}>{view.drafting ? "HQ is reading back through the night…" : "No drafts this time."}</p>
      )}
      <p className={styles.draftFoot}>Drafts only: a person reviews each one before anything changes. Nothing is sent.</p>
    </section>
  );
}
