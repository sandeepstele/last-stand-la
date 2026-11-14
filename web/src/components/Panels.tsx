"use client";

import type { AnyStream } from "@langchain/react";
import type { VerifyResult } from "@/lib/contracts";
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

/** The newest verify_building tool result in the thread, parsed. */
export function latestVerify(messages: readonly unknown[]): VerifyResult | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Msg;
    if (kind(m) === "tool" && m.name === "verify_building") {
      try {
        return JSON.parse(text(m.content)) as VerifyResult;
      } catch {
        return null;
      }
    }
  }
  return null;
}

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
};

export function VerifierCard({ result }: { result: VerifyResult | null }) {
  if (!result) return <section className={styles.card}><h2>Verifier</h2><p className={styles.muted}>Waiting for verify_building…</p></section>;
  const i = result.initial;
  return (
    <section className={styles.card} data-verdict={result.verdict}>
      <h2>
        Verifier · {VERDICT_LABEL[result.verdict]} <small>({result.confidence})</small>
        {result.synthetic_data && <span className={styles.badge}>illustrative data</span>}
      </h2>
      <p className={styles.big}>
        Listed {i.listed_sqft.toLocaleString()} sq ft · expected {i.expected_low_sqft.toLocaleString()}–{i.expected_high_sqft.toLocaleString()}
        {i.gap_pct !== 0 && <> · {i.gap_pct > 0 ? "+" : ""}{i.gap_pct}%</>}
      </p>
      <p className={styles.muted}>{i.formula}</p>
      <ul className={styles.hypotheses}>
        {result.hypotheses.map((h) => (
          <li key={h.key} data-status={h.status}><strong>{h.title}</strong>: {h.status.replace("_", " ")}. {h.evidence}</li>
        ))}
      </ul>
      {result.warnings.map((w, k) => <p key={k} className={styles.warning}>{w}</p>)}
      {result.field_check && <p className={styles.muted}>Field check: {result.field_check}</p>}
    </section>
  );
}

/** deepagents HITL: one decision per pending action request. */
export function ApprovalBar({ stream }: { stream: AnyStream }) {
  const value = stream.interrupt?.value as { action_requests?: { name: string; args: Record<string, unknown> }[] } | undefined;
  const requests = value?.action_requests ?? [];
  if (!requests.length) return null;
  const decide = (type: "approve" | "reject") => void stream.respond({ decisions: requests.map(() => ({ type })) });
  return (
    <div className={styles.approval}>
      {requests.map((r, k) => <span key={k}>Approve <strong>{r.name}</strong> {JSON.stringify(r.args)}?</span>)}
      <button onClick={() => decide("approve")}>Approve</button>
      <button onClick={() => decide("reject")}>Reject</button>
    </div>
  );
}
