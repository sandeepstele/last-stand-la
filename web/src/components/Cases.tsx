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
  property_id: string; case: string; suite?: string | null; posterior: Record<string, number>;
  verdict: { hypothesis: string; claim: string; confidence: number; label: string; text?: string };
  next_check: string | null; correction_draft: string | null;
};
type QueueRow = { id?: string; case: string; property_id: string; suite?: string; address?: string; year_built?: number; material?: string; past_due?: boolean; label?: string };
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
  interior_geometry: "Measured the interior (3D scan)",
  compare_captures: "Compared captures over time",
  listing_timeline: "Listing and tenancy dates",
  lease_terms: "Lease terms",
  tenancy_trail: "Where the company went",
  lot_activity: "Cars on the lot over time",
  suite_tour: "Looked inside the suite",
};

/** The verdict as a lead to check, never as a finding of fact (we never say a record or a person is wrong). */
const verdictText = (v: Weighed["verdict"]) =>
  v.text ?? (v.label === "unresolved" ? "Unresolved: the evidence doesn't settle it yet" : `Worth a look: the evidence ${v.label === "likely" ? "points to" : "leans toward"} "${v.claim}"`);

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
        if (!c.status && !out.some((o) => o.check === c.check)) out.unshift(c);
      } catch {
        /* a malformed result is skipped, not fatal */
      }
    }
  }
  return out;
}

/** Messages after the newest open_case, so a verdict from an earlier case is never shown for this one. */
export function afterOpenCase(messages: readonly unknown[]): readonly unknown[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Msg;
    if (kind(m) === "tool" && m.name === "open_case") return messages.slice(i + 1);
  }
  return [];
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

export function CaseQueue({ onOpen, busy, refreshKey }: { onOpen: (propertyId: string, suite?: string) => void; busy: boolean; refreshKey?: unknown }) {
  const [q, setQ] = useState<Queue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fetch("/api/backend/cases/queue")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: Queue) => { if (live) { setQ(j); setErr(null); } })
      .catch((e: unknown) => { if (live) setErr(String(e)); });
    return () => { live = false; };
  }, [refreshKey, tick]);
  return (
    <section className={styles.card}>
      <h2>Overnight case queue</h2>
      {err && <p className={styles.muted}>Queue unavailable ({err}). <button type="button" onClick={() => setTick((t) => t + 1)}>Retry</button></p>}
      {q && (
        <>
          <p className={styles.big}>{q.total} records disagree with another source</p>
          <ul className={styles.hypotheses}>
            {Object.entries(q.counts).map(([k, n]) => <li key={k}><strong>{n}</strong> · {CASE_LABEL[k] ?? k}</li>)}
          </ul>
          <p className={styles.muted}>Order: imagery gathered first, then by stakes</p>
          <ol className={styles.queue}>
            {q.top.slice(0, 12).map((c) => (
              <li key={c.id ?? `${c.case}-${c.property_id}-${c.suite ?? ""}`}>
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

type Pending = { thread_id: string; actions: { name?: string; args: Record<string, unknown> }[] };

function describePending(a: { name?: string; args: Record<string, unknown> }): string {
  if (a.name === "file_correction") return `File this correction draft for a CoStar researcher: ${String(a.args.draft ?? "")}`;
  if (a.name === "send_outreach") return `Record a message to ${String(a.args.to ?? "someone")} (a draft; nothing is sent): ${String(a.args.text ?? "")}`;
  if (a.name === "watch_building") return `Start watching building ${String(a.args.property_id ?? "")}`;
  return a.name ?? "an action";
}

export function InboxCard({ refreshKey }: { refreshKey: unknown }) {
  const [box, setBox] = useState<Inbox | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [tick, setTick] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    fetch("/api/backend/cases/inbox").then((r) => (r.ok ? r.json() : null)).then((j) => live && setBox(j)).catch(() => live && setBox(null));
    fetch("/api/approvals").then((r) => r.json()).then((j: { pending?: Pending[] }) => live && setPending(j.pending ?? [])).catch(() => live && setPending([]));
    return () => { live = false; };
  }, [refreshKey, tick]);
  // The overnight sweep runs in the background, so poll for new cases of the day and approvals.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  const decide = async (thread_id: string, decision: "approve" | "reject") => {
    if (deciding.has(thread_id)) return; // one decision per paused run, even on a double click
    setDeciding((s) => new Set(s).add(thread_id));
    const r = await fetch("/api/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ thread_id, decision }) }).catch(() => null);
    if (r?.ok) setPending((ps) => ps.filter((p) => p.thread_id !== thread_id));
    setNote(r?.ok ? (decision === "approve" ? "Approved: the agent is recording it (nothing is sent)." : "Rejected: nothing recorded.")
      : r?.status === 409 ? "Already decided." : "Could not reach the agent.");
    setDeciding((s) => { const n = new Set(s); n.delete(thread_id); return n; });
    setTimeout(() => setTick((t) => t + 1), 4000);
  };
  const latest = box?.inbox.find((i) => i.kind === "notify_me");
  if (!latest && !box?.decisions.length && !pending.length) return null;
  return (
    <section className={styles.card}>
      <h2>Inbox</h2>
      {latest && <p><strong>{latest.text}</strong> <span className={styles.muted}>({latest.at?.slice(0, 16).replace("T", " ")})</span></p>}
      {pending.map((p) => (
        <div key={p.thread_id} className={styles.draft}>
          <p><span className={styles.badge}>WAITING FOR YOU</span> {p.actions.map(describePending).join("; ")}</p>
          <div className={styles.approval}>
            <button type="button" disabled={deciding.has(p.thread_id)} onClick={() => void decide(p.thread_id, "approve")}>Approve</button>
            <button type="button" disabled={deciding.has(p.thread_id)} onClick={() => void decide(p.thread_id, "reject")}>Reject</button>
          </div>
        </div>
      ))}
      {note && <p className={styles.muted}>{note}</p>}
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
  const weighed = latestTool<Weighed>(afterOpenCase(messages), "weigh_case");
  const checks = caseChecks(messages);
  // A decision belongs to one case and one draft; showing it is keyed, so switching cases clears it.
  const [decided, setDecided] = useState<{ key: string; text: string } | null>(null);
  const [posting, setPosting] = useState(false);
  const pid = opened?.property_id;
  // A building can have two cases; follow the one the agent is checking or weighing.
  const working = weighed?.case ?? checks[checks.length - 1]?.case;
  const c = opened?.cases?.find((x) => x.case === working) ?? opened?.cases?.[0];
  if (!opened) return null;
  if (!c) {
    const ghosts = opened.ghost_suites?.length ?? 0;
    return (
      <section className={styles.card}>
        <h2>Case file</h2>
        <p className={styles.muted}>
          {ghosts
            ? `${ghosts} suite${ghosts > 1 ? "s" : ""} here ${ghosts > 1 ? "are" : "is"} occupied on record but listed for lease (${opened.ghost_suites!.join(", ")}). Open one from the queue to investigate.`
            : `No contradiction to investigate for ${pid}: the sources agree.`}
        </p>
      </section>
    );
  }
  const final = weighed && weighed.case === c.case && weighed.property_id === pid
    && (weighed.suite == null || opened.suite == null || weighed.suite === opened.suite);
  const caseKey = `${c.case}|${pid}|${opened.suite ?? ""}|${final ? weighed.correction_draft ?? "" : ""}`;
  const decision = decided?.key === caseKey ? decided.text : null;
  const conf = final ? weighed.posterior : liveConfidence(c.hypotheses, checks);
  const decide = async (d: "approve" | "reject") => {
    if (posting) return;
    setPosting(true);
    const r = await fetch("/api/backend/cases/decision", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ property_id: pid, suite: opened.suite, case: c.case, decision: d, draft: weighed?.correction_draft }),
    }).catch(() => null);
    setDecided({ key: caseKey, text: r?.ok ? (d === "approve" ? "Approved: recorded for a researcher (nothing was sent)." : "Rejected: nothing recorded as a correction.") : "Could not record the decision." });
    setPosting(false);
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
            {verdictText(weighed.verdict)} ({Math.round(weighed.verdict.confidence * 100)}%)
          </p>
          {weighed.next_check && <p className={styles.muted}>Next check: {CHECK_LABEL[weighed.next_check] ?? weighed.next_check}</p>}
          {weighed.correction_draft && (
            <div className={styles.draft}>
              <p><span className={styles.badge}>DRAFT</span> {weighed.correction_draft}</p>
              {decision ? <p className={styles.muted}>{decision}</p> : (
                <div className={styles.approval}>
                  <button type="button" disabled={posting} onClick={() => void decide("approve")}>Approve</button>
                  <button type="button" disabled={posting} onClick={() => void decide("reject")}>Reject</button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
