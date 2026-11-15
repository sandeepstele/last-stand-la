"use client";
// The dawn debrief: the draft corrections HQ writes for tonight's cases, one card each: what it asks for, how sure
// the evidence is (its own %), the evidence it chose and, when you gave one, your report. Drafts only: a person
// reviews each one. <HqDrafts messages busy /> renders nothing until "Debrief the night shift" is on the thread
// (or a draft exists), so it can be mounted unconditionally (the dawn screen); the HQ panel uses <DraftList variant="panel" />.

import { useMemo } from "react";
import { CASE_WORDS, draftsModel, type DraftView, type DraftsView } from "./hqModel";
import { cap, placeName, plain, sureWords } from "./copy";
import styles from "./hq.module.css";

export type HqDraftsProps = {
  messages: readonly unknown[]; // the laststand thread
  busy: boolean; // a run is in progress (the debrief is being drafted)
  variant?: "dawn" | "panel"; // dawn: wide, two columns (default); panel: fits the HQ panel
};

export function HqDrafts({ messages, busy, variant = "dawn", error = null }: HqDraftsProps & { error?: string | null }) {
  const view = useMemo(() => draftsModel(messages, busy), [messages, busy]);
  return <DraftList view={view} variant={variant} error={error} />;
}

/** The evidence names, said plainly. */
const EVIDENCE_WORDS: Record<string, string> = {
  "Vision: looked at the aerial": "The aerial photo, read by HQ",
  "Vision: old vs new aerial": "Old and new aerials, compared by HQ",
  "Vision: looked inside the suite": "The suite's 3D scan, read by HQ",
};

/** What the draft asks a researcher to do: its own "Please …" sentence, else the case's question. */
function askOf(d: DraftView): string {
  const please = d.text.match(/\bPlease ([^.]+)\./);
  if (please) return `Asks a researcher to ${please[1].trim()}.`;
  if (d.type === CASE_WORDS.material_conflict) return "Asks a researcher to review the construction type.";
  if (d.type === CASE_WORDS.ghost_tenant) return "Asks a researcher to check whether the tenant on record is still there.";
  if (d.type === CASE_WORDS.stale_entry) return "Asks a researcher to check whether the building was replaced.";
  return "Asks a researcher to review this record.";
}

/** "Probably concrete, as the city lists it (54%)" — the verdict and its % from the draft. */
function verdictOf(v: NonNullable<DraftView["verdict"]>): string {
  const words = plain(v.words);
  return v.label === "unresolved" ? `Not settled yet. Best guess: ${words} (${v.pct}%)` : `${cap(sureWords(v.label))} ${words} (${v.pct}%)`;
}

/** The server swaps an unsafe critic reason (numbers, ids) for this stock phrase, which only makes sense on a flag. */
const STOCK_WHY = /evidence trail may not support this verdict/i;

function criticLine(c: NonNullable<DraftView["critic"]>): string {
  if (!c.reviewed) return "No second review on this one.";
  if (c.follows === false) return `A second agent flagged it: ${c.why ?? "the evidence doesn't settle it."}`;
  return c.why && !STOCK_WHY.test(c.why) ? `A second agent checked it and agrees: ${c.why}` : "A second agent checked it and agrees with the evidence.";
}

export function DraftList({ view, variant, error = null }: { view: DraftsView; variant: "dawn" | "panel"; error?: string | null }) {
  if (!view.requested && !view.drafts.length) return null;
  const pending = view.drafting ? Math.max(0, (view.expected ?? 0) - view.done) : 0;
  const count = view.drafting ? (view.expected ? `${view.done} of ${view.expected}` : "") : String(view.done);
  return (
    <section className={styles.drafts} data-variant={variant} data-busy={view.drafting} aria-label="Tonight's draft corrections, written by HQ">
      <header className={styles.draftsHead}>
        {view.drafting && <span className={styles.spin} aria-hidden />}
        <strong>{view.drafting ? "HQ is drafting tonight's corrections" : "Drafts for a researcher"}</strong>
        {count && <em aria-live="polite">{count}</em>}
      </header>
      {view.drafts.length > 0 || pending > 0 ? (
        <ol className={styles.draftCards}>
          {view.drafts.map((d) => (
            <li key={d.id} className={styles.draft}>
              <div className={styles.draftTop}>
                <b>{d.n != null ? `Case #${d.n} · ` : ""}{placeName(plain(d.where))}</b>
                <span>{d.yourReport ? "Your report + HQ" : "HQ, from the records"}</span>
              </div>
              {d.verdict && <p className={styles.draftVerdict}>{verdictOf(d.verdict)}</p>}
              {d.critic && (
                <p className={styles.draftVerdict} style={{ opacity: 0.85 }}>
                  {criticLine(d.critic)}
                </p>
              )}
              <p className={styles.draftText} title={plain(d.text)}>{askOf(d)}</p>
              {d.evidence.length > 0 && (
                <ul className={styles.draftEvidence} aria-label="Evidence">
                  {d.evidence.map((e) => <li key={e}>{EVIDENCE_WORDS[e] ?? plain(e)}</li>)}
                </ul>
              )}
              {d.yourReport && (
                <p className={styles.yourReport}>
                  <span>Your report</span>&ldquo;{d.yourReport}&rdquo;
                </p>
              )}
            </li>
          ))}
          {Array.from({ length: pending }, (_, i) => (
            <li key={`pending-${i}`} className={styles.draft} data-pending>
              <div className={styles.draftTop}>
                <b>Drafting…</b>
              </div>
              <span className={styles.skeleton} />
              <span className={styles.skeleton} style={{ width: "70%" }} />
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.muted}>{view.drafting ? "HQ is reading back through the night…" : error ? "HQ couldn't finish the drafts this time (the recorded demo had no answer for this step). Press Play again for a fresh shift." : "No drafts this time."}</p>
      )}
      <p className={styles.draftFoot}>Drafts only. A person reviews each one before anything changes; nothing is sent.</p>
    </section>
  );
}
