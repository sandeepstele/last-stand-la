"use client";

import { useState } from "react";

import type { AnyStream } from "@langchain/react";
import type { QuakeReplay, SeismicStatus, VerifyResult } from "@/lib/contracts";
import styles from "@/app/page.module.css";

type Msg = { type?: string; name?: string; content?: unknown; tool_calls?: unknown[]; getType?: () => string };

function kind(m: Msg): string {
  return m.type ?? m.getType?.() ?? "";
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : (p as { text?: string }).text ?? "")).join("");
  return "";
}

/** The newest result of a tool in the thread, parsed as JSON (null if absent or not JSON). */
export function latestTool<T>(messages: readonly unknown[], name: string): T | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Msg;
    if (kind(m) === "tool" && m.name === name) {
      try {
        return JSON.parse(text(m.content)) as T;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export const latestVerify = (messages: readonly unknown[]) => latestTool<VerifyResult>(messages, "verify_building");

export function finalAnswer(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Msg;
    if (kind(m) === "ai" && !(m.tool_calls && m.tool_calls.length)) return text(m.content);
  }
  return "";
}

export function PlanPanel({ stream }: { stream: AnyStream }) {
  const todos = ((stream.values as { todos?: { content: string; status: string }[] })?.todos ?? []);
  const subagents = Array.from(stream.subagents.values());
  return (
    <section className={styles.card}>
      <h2>Plan</h2>
      <ul className={styles.todos}>
        {todos.map((t, i) => (
          <li key={i} data-status={t.status}>{t.content}</li>
        ))}
      </ul>
      <h2>Specialists</h2>
      <div className={styles.cards}>
        {subagents.map((s) => (
          <div key={s.id} className={styles.subagent} data-status={s.status}>
            <strong>{s.name}</strong> <span>{s.status}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

const VERDICT_LABEL: Record<VerifyResult["verdict"], string> = {
  consistent: "Consistent",
  verified_inside_and_out: "Verified inside and out",
  explained: "Explained",
  likely_explained: "Likely explained",
  worth_a_look: "Worth a look",
  check_link: "Different structure",
};

export function VerifierCard({ result }: { result: VerifyResult | null }) {
  if (!result) return <section className={styles.card}><h2>Measured building</h2><p className={styles.muted}>Waiting for the verifier…</p></section>;
  const i = result.initial;
  if (!i) {
    // check_link and other early stops carry only a headline (no comparison was made)
    return (
      <section className={styles.card} data-verdict={result.verdict}>
        <h2>Measured building · {VERDICT_LABEL[result.verdict] ?? result.verdict}</h2>
        <p className={styles.muted}>{result.headline}</p>
      </section>
    );
  }
  return (
    <section className={styles.card} data-verdict={result.verdict}>
      <h2>
        Measured building · {VERDICT_LABEL[result.verdict] ?? result.verdict} <small>({result.confidence})</small>
        {result.synthetic_data && <span className={styles.badge}>illustrative data</span>}
      </h2>
      <p className={styles.big}>
        Listed {i.listed_sqft.toLocaleString()} sq ft · expected {i.expected_low_sqft.toLocaleString()}–{i.expected_high_sqft.toLocaleString()}
        {i.gap_pct !== 0 && <> · {i.gap_pct > 0 ? "+" : ""}{i.gap_pct}%</>}
      </p>
      <p className={styles.muted}>{i.formula}</p>
      <ul className={styles.hypotheses}>
        {(result.hypotheses ?? []).map((h) => (
          <li key={h.key} data-status={h.status}><strong>{h.title}</strong>: {h.status.replace("_", " ")}. {h.evidence}</li>
        ))}
      </ul>
      {(result.warnings ?? []).map((w, k) => <p key={k} className={styles.warning}>{w}</p>)}
      {result.field_check && <p className={styles.muted}>Field check: {result.field_check}</p>}
    </section>
  );
}

/** deepagents HITL: one decision per pending action request. */
export function ApprovalBar({ stream }: { stream: AnyStream }) {
  const [sent, setSent] = useState<unknown>(null);
  const value = stream.interrupt?.value as { action_requests?: { name: string; args: Record<string, unknown> }[] } | undefined;
  const requests = value?.action_requests ?? [];
  if (!requests.length) return null;
  const busy = sent === stream.interrupt; // one answer per interrupt, even on a double click
  const decide = (type: "approve" | "reject") => {
    if (busy) return;
    setSent(stream.interrupt);
    stream.respond({ decisions: requests.map(() => ({ type })) }).catch(() => setSent(null));
  };
  return (
    <div className={styles.approval}>
      {requests.map((r, k) => <span key={k}>Approve <strong>{r.name}</strong> {JSON.stringify(r.args)}?</span>)}
      <button disabled={busy} onClick={() => decide("approve")}>Approve</button>
      <button disabled={busy} onClick={() => decide("reject")}>Reject</button>
    </div>
  );
}

// ---------------------------------------------------------------- seismic lens

const LIST_LABEL: Record<string, string> = { soft_story: "Soft-story list", non_ductile_concrete: "Non-ductile concrete list" };
const STATE_LABEL: Record<string, string> = { done: "done", overdue: "past deadline", not_due_yet: "not due yet" };
const MATERIAL_LABEL: Record<string, string> = { ReinforcedConcrete: "reinforced concrete", WoodFrame: "wood frame" };
const FINDING_LABEL: Record<string, string> = {
  unfinished: "Ordered, not finished",
  stale_entry: "List entry looks stale (building replaced?)",
  material_conflict: "Records disagree on material: flag for a researcher",
  not_proven_safe: "Older concrete, not on the list: not proven safe",
  work_underway: "Retrofit permit on file",
};

/** Ordered vs done vs recorded: the city's retrofit order, each step, and what CoStar records. */
export function SeismicCard({ result }: { result: SeismicStatus | null }) {
  if (!result) return null;
  if (result.status === "not_applicable") return null;
  const conflict = result.hypotheses?.some((h) => h.key === "material_conflict");
  const listed = result.lists?.[0];
  return (
    <section className={styles.card} data-verdict={result.hypotheses?.some((h) => h.past_due) ? "worth_a_look" : undefined}>
      <h2>
        Retrofit order · {listed ? LIST_LABEL[listed.list] ?? listed.list : "not on a city list"}
        {result.synthetic && <span className={styles.badge}>illustrative data</span>}
      </h2>
      {listed && (
        <>
          <p className={styles.muted}>Ordered {listed.order_date ?? "(date not published)"} · {result.address}</p>
          <ol className={styles.steps}>
            {listed.steps.map((s) => (
              <li key={s.step} data-state={s.state}>
                <strong>{s.what}</strong>: {STATE_LABEL[s.state] ?? s.state}
                {s.done ? ` (${s.done})` : s.due ? ` · due ${s.due}${s.extended ? " (extended)" : ""}` : ""}
              </li>
            ))}
          </ol>
        </>
      )}
      <p className={conflict ? styles.warning : styles.muted}>
        City list: {listed ? (listed.list === "non_ductile_concrete" ? "concrete" : "wood soft-story") : "none"} · CoStar records:{" "}
        {MATERIAL_LABEL[result.costar_material ?? ""] ?? result.costar_material?.toLowerCase() ?? "unknown"}
        {result.year_built ? ` · built ${result.year_built}` : ""}
      </p>
      <ul className={styles.hypotheses}>
        {(result.hypotheses ?? []).map((h) => (
          <li key={h.key} data-status={h.key === "material_conflict" ? "untested" : "supported"}>
            <strong>{FINDING_LABEL[h.key] ?? h.key}</strong>: {h.evidence}
          </li>
        ))}
      </ul>
      {!!result.permits?.length && (
        <p className={styles.muted}>Latest permit: {result.permits[0].issued} · {result.permits[0].status} · {result.permits[0].work}</p>
      )}
      <p className={styles.muted}>Source: {result.source}</p>
    </section>
  );
}

/** Shown whenever the run used quake_replay: a replay must never read as a live event. */
export function QuakeBanner({ result }: { result: QuakeReplay | null }) {
  if (!result) return null;
  return (
    <section className={styles.card} data-verdict="worth_a_look">
      <h2>
        <span className={styles.badge}>REPLAY</span> {result.label}
      </h2>
      <p className={styles.big}>
        {result.unfinished_shaken_mmi_7_plus} of {result.unfinished} unfinished ordered retrofits felt very strong shaking (MMI 7+)
      </p>
      <ul className={styles.hypotheses}>
        {result.top.slice(0, 5).map((b) => (
          <li key={b.property_id}>
            <strong>{b.address ?? b.property_id}</strong> · MMI {b.shaking?.mmi ?? "?"} · {b.past_due ? "past a deadline" : b.status}
          </li>
        ))}
      </ul>
    </section>
  );
}
