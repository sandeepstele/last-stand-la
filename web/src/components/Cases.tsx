"use client";

import { useEffect, useState } from "react";
import { latestTool } from "@/components/Panels";
import styles from "@/app/page.module.css";

// ---------------------------------------------------------------- shapes (mirror app/evidence.py)

type Effect = { hypothesis: string; delta: number };
type Hypothesis = { key: string; claim: string; prior: number };
type OpenCase = { property_id: string; suite?: string; tenant?: string; ghost_suites?: string[]; cases: { case: string; question: string; hypotheses: Hypothesis[] }[] };
type Check = {
  property_id: string; case: string; check: string; looks_at?: string; finding: string; why: string;
  effects: Effect[]; images?: string[]; callout?: string; status?: string;
};
type Weighed = {
  property_id: string; case: string; posterior: Record<string, number>;
  verdict: { hypothesis: string; claim: string; confidence: number; label: string };
  next_check: string | null; correction_draft: string | null;
};
type QueueRow = { case: string; property_id: string; suite?: string; address?: string; year_built?: number; material?: string; past_due?: boolean; label?: string };
type Queue = { counts: Record<string, number>; total: number; top: QueueRow[] };

export const CASE_LABEL: Record<string, string> = {
  material_conflict: "Material disagrees with the city",
  stale_entry: "Listed building looks replaced",
  ghost_tenant: "Tenant on record, suite listed for lease",
};
const CHECK_LABEL: Record<string, string> = {
  human_report: "Human report",
  compliance_filings: "City retrofit filings",
  permit_text: "Permit wording",
  replacement_permits: "Demolition / new-building permits",
  era_and_height: "Era and floor height",
  site_structures: "Structures on the parcel",
  look_from_above: "Looked at the building",
  compare_captures: "Compared captures over time",
};

const imageUrl = (path: string) => `/api/backend/evidence/image/${path.split("/").pop()}`;

type Msg = { type?: string; name?: string; content?: unknown; getType?: () => string };
const kind = (m: Msg) => m.type ?? m.getType?.() ?? "";
const asText = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p as { text?: string }).text ?? "").join("") : "");

/** check_evidence results after the newest open_case, in arrival order. */
export function caseChecks(messages: readonly unknown[]): Check[] {
  const out: Check[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Msg;
    if (kind(m) !== "tool") continue;
    if (m.name === "open_case") break;
    if (m.name === "check_evidence") {
      try {
        const c = JSON.parse(asText(m.content)) as Check;
        if (!c.status) out.unshift(c);
      } catch {
        /* a malformed result is skipped, not fatal */
      }
    }
  }
  return out;
}

/** Live confidence: priors plus the shifts seen so far, normalized like app/evidence.py weigh_case. */
export function liveConfidence(hypotheses: Hypothesis[], checks: Check[]): Record<string, number> {
  const p: Record<string, number> = Object.fromEntries(hypotheses.map((h) => [h.key, h.prior]));
  for (const c of checks) for (const e of c.effects) if (e.hypothesis in p) p[e.hypothesis] += e.delta;
  for (const k of Object.keys(p)) p[k] = Math.max(p[k], 0.02);
  const total = Object.values(p).reduce((a, b) => a + b, 0) || 1;
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v / total]));
}

// ---------------------------------------------------------------- left: the overnight queue

export function CaseQueue({ onOpen, busy }: { onOpen: (propertyId: string, suite?: string) => void; busy: boolean }) {
  const [q, setQ] = useState<Queue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/backend/cases/queue")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setQ)
      .catch((e: unknown) => setErr(String(e)));
  }, []);
  return (
    <section className={styles.card}>
      <h2>Overnight case queue</h2>
      {err && <p className={styles.muted}>Queue unavailable ({err}).</p>}
      {q && (
        <>
          <p className={styles.big}>{q.total} records disagree with another source</p>
          <ul className={styles.hypotheses}>
            {Object.entries(q.counts).map(([k, n]) => <li key={k}><strong>{n}</strong> · {CASE_LABEL[k] ?? k}</li>)}
          </ul>
          <p className={styles.muted}>Order: imagery gathered first, then by stakes</p>
          <ol className={styles.queue}>
            {q.top.slice(0, 12).map((c) => (
              <li key={`${c.case}-${c.property_id}-${c.suite ?? ""}`}>
                <button type="button" disabled={busy} onClick={() => onOpen(c.property_id, c.suite)}>
                  <strong>{c.address ?? c.property_id}</strong>
                  <span className={styles.muted}>{CASE_LABEL[c.case] ?? c.case}{c.label ? ` · ${c.label}` : ""}{c.past_due ? " · past a deadline" : ""}</span>
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the inbox (case of the day)

type Inbox = { inbox: { kind: string; text: string; at: string }[]; decisions: { property_id: string; suite?: string; case: string; decision: string; at: string }[] };

export function InboxCard({ refreshKey }: { refreshKey: unknown }) {
  const [box, setBox] = useState<Inbox | null>(null);
  useEffect(() => {
    fetch("/api/backend/cases/inbox").then((r) => (r.ok ? r.json() : null)).then(setBox).catch(() => setBox(null));
  }, [refreshKey]);
  const latest = box?.inbox.find((i) => i.kind === "notify_me");
  if (!latest && !box?.decisions.length) return null;
  return (
    <section className={styles.card}>
      <h2>Inbox</h2>
      {latest && <p><strong>{latest.text}</strong> <span className={styles.muted}>({latest.at?.slice(0, 16).replace("T", " ")})</span></p>}
      {!!box?.decisions.length && (
        <ul className={styles.hypotheses}>
          {box.decisions.slice(0, 3).map((d, i) => (
            <li key={i}>{d.decision === "approve" ? "Approved" : "Rejected"} · {CASE_LABEL[d.case] ?? d.case} · {d.property_id}{d.suite ? ` suite ${d.suite}` : ""}</li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- right: the case file

export function CaseFile({ messages, loading }: { messages: readonly unknown[]; loading: boolean }) {
  const opened = latestTool<OpenCase>(messages, "open_case");
  const weighed = latestTool<Weighed>(messages, "weigh_case");
  const checks = caseChecks(messages);
  const [decision, setDecision] = useState<string | null>(null);
  const c = opened?.cases?.[0];
  const pid = opened?.property_id;
  useEffect(() => setDecision(null), [pid, weighed?.correction_draft]);
  if (!opened) return null;
  if (!c) return <section className={styles.card}><h2>Case file</h2><p className={styles.muted}>No contradiction to investigate for {pid}: the sources agree.</p></section>;
  const final = weighed && weighed.case === c.case && weighed.property_id === pid;
  const conf = final ? weighed.posterior : liveConfidence(c.hypotheses, checks);
  const decide = async (d: "approve" | "reject") => {
    const r = await fetch("/api/backend/cases/decision", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ property_id: pid, suite: opened.suite, case: c.case, decision: d, draft: weighed?.correction_draft }),
    }).catch(() => null);
    setDecision(r?.ok ? (d === "approve" ? "Approved: recorded for a researcher (nothing was sent)." : "Rejected: nothing recorded as a correction.") : "Could not record the decision.");
  };
  return (
    <section className={styles.card} data-verdict={final && weighed.verdict.label !== "unresolved" ? "worth_a_look" : undefined}>
      <h2>Case file · {CASE_LABEL[c.case] ?? c.case}</h2>
      {opened.suite && <p className={styles.big}>Suite {opened.suite}{opened.tenant ? ` · ${opened.tenant} on record` : ""}</p>}
      <p className={styles.muted}>{c.question}</p>
      <ul className={styles.bars}>
        {c.hypotheses.map((h) => (
          <li key={h.key}>
            <span>{h.claim}</span>
            <span className={styles.bar}><span style={{ width: `${Math.round((conf[h.key] ?? 0) * 100)}%` }} /></span>
            <strong>{Math.round((conf[h.key] ?? 0) * 100)}%</strong>
          </li>
        ))}
      </ul>
      <ol className={styles.evidence}>
        {checks.map((k, i) => (
          <li key={`${k.check}-${i}`}>
            <strong>{CHECK_LABEL[k.check] ?? k.check}</strong>: {k.finding}
            {!!k.effects.length && (
              <span className={styles.chips}>
                {k.effects.map((e) => (
                  <span key={e.hypothesis} data-sign={e.delta >= 0 ? "up" : "down"}>
                    {e.delta >= 0 ? "+" : ""}{Math.round(e.delta * 100)} {c.hypotheses.find((h) => h.key === e.hypothesis)?.key.replaceAll("_", " ")}
                  </span>
                ))}
              </span>
            )}
            <div className={styles.muted}>{k.why}</div>
            {!!k.images?.length && (
              <figure className={styles.evidenceImg}>
                {k.images.slice(0, 2).map((src) => <img key={src} src={imageUrl(src)} alt={`${CHECK_LABEL[k.check] ?? k.check} for ${pid}`} />)}
                {k.callout && <figcaption>{k.callout}</figcaption>}
              </figure>
            )}
          </li>
        ))}
        {loading && !final && <li className={styles.muted}>Investigating…</li>}
      </ol>
      {final && (
        <>
          <p className={styles.big}>
            Verdict: {weighed.verdict.label} · {weighed.verdict.claim} ({Math.round(weighed.verdict.confidence * 100)}%)
          </p>
          {weighed.next_check && <p className={styles.muted}>Next check: {CHECK_LABEL[weighed.next_check] ?? weighed.next_check}</p>}
          {weighed.correction_draft && (
            <div className={styles.draft}>
              <p><span className={styles.badge}>DRAFT</span> {weighed.correction_draft}</p>
              {decision ? <p className={styles.muted}>{decision}</p> : (
                <div className={styles.approval}>
                  <button type="button" onClick={() => void decide("approve")}>Approve</button>
                  <button type="button" onClick={() => void decide("reject")}>Reject</button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
