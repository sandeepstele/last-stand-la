"use client";
// The feedback controls: <Thumbs /> on a piece of the agent's text (a squad finding, a source row, a dawn draft) and
// <FeedbackExport /> (the JSONL download, the count, Clear and the honest note). The store is feedback.ts.

import type { CSSProperties } from "react";
import { addFeedback, clearFeedback, currentThread, downloadFeedback, useFeedback, useRating, type FeedbackKind, type Rating } from "./feedback";

const UP = "#4cc38a";
const DOWN = "#e5484d";

export function Thumbs({ kind, threadId, pid, label, item, style }: {
  kind: Exclude<FeedbackKind, "tag">; threadId?: string | null; pid: string; label: string; item: string; style?: CSSProperties;
}) {
  const thread = threadId === undefined ? currentThread() : threadId;
  const rating = useRating(kind, thread, pid, item);
  const btn = (r: Rating, glyph: string, title: string) => {
    const on = rating === r;
    const c = r === "up" ? UP : DOWN;
    return (
      <button type="button" title={title} aria-label={title} aria-pressed={on}
        onClick={(e) => {
          e.stopPropagation();
          addFeedback({ thread_id: thread, kind, pid, label, item, rating: r });
        }}
        style={{ padding: "0 5px", minWidth: 22, height: 18, lineHeight: "16px", border: `1px solid ${on ? c : "transparent"}`, borderRadius: 2, background: on ? `${c}33` : "transparent", fontSize: 11, cursor: "pointer", opacity: rating && !on ? 0.35 : on ? 1 : 0.6, filter: on ? "none" : "grayscale(1)" }}>
        {glyph}
      </button>
    );
  };
  return (
    <span style={{ display: "inline-flex", gap: 3, flex: "none", alignItems: "center", ...style }} onClick={(e) => e.stopPropagation()}>
      {btn("up", "👍", "Useful: tell the agent this was right")}
      {btn("down", "👎", "Wrong: tell the agent this was off")}
    </span>
  );
}

export const FEEDBACK_NOTE = "Preference data in the format used for RLHF/DPO. Collected from your feedback; nothing is trained here.";

/** The download button, the count, Clear, and the one-line note. `big` for the second-screen log page. */
export function FeedbackExport({ big = false, align = "start" }: { big?: boolean; align?: "start" | "end" }) {
  const items = useFeedback();
  const fs = big ? 15 : 13;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: align === "end" ? "flex-end" : "flex-start", gap: 3, font: `${fs}px/1.35 system-ui, sans-serif` }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <button type="button" disabled={!items.length} onClick={() => downloadFeedback(items)}
          style={{ padding: big ? "5px 12px" : "3px 10px", border: "1px solid #f5a524", borderRadius: 2, background: items.length ? "#f5a524" : "transparent", color: items.length ? "#111" : "#94a3b8", font: `700 ${fs}px system-ui, sans-serif`, cursor: items.length ? "pointer" : "default", borderColor: items.length ? "#f5a524" : "#475569" }}>
          Download feedback (JSONL)
        </button>
        <span style={{ color: "#e2e8f0" }}>{items.length} feedback item{items.length === 1 ? "" : "s"}</span>
        {items.length > 0 && (
          <button type="button" onClick={() => window.confirm(`Clear all ${items.length} feedback items from this browser?`) && clearFeedback()} style={{ padding: 0, border: "none", background: "none", color: "#94a3b8", textDecoration: "underline", font: `${fs}px system-ui, sans-serif`, cursor: "pointer" }}>
            Clear
          </button>
        )}
      </div>
      <span style={{ color: "#94a3b8", fontSize: fs - 1 }}>{FEEDBACK_NOTE}</span>
    </div>
  );
}
