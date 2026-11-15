// Bob's feedback on the agent's work, kept in this browser and exported as JSONL in the preference-pair shape used
// for RLHF/DPO. Collected only: nothing is trained here. The export holds the game's own text and the building ids
// and labels already on screen; no personal data. OWNER: coding lead.
//
//   Thumbs (UI, see FeedbackUI.tsx): addFeedback({ thread_id, kind: "finding" | "source" | "draft", pid, label, item, rating })
//     clicking the same thumb again takes the rating back.
//
//   Tag decisions (automatic, no button; FootGame calls it when a tag result lands):
//     recordTagDecision({ thread_id, pid, label, agent_tag, bob_tag, right_tag? }: TagDecision): void
//       thread_id  string | null   the night's agent thread
//       pid        string          the building id
//       label      string          the building's name on screen
//       agent_tag  string | null   the placard the agent proposed ("green" | "yellow" | "red")
//       bob_tag    string          the placard Bob posted ("green" | "yellow" | "red" | "none")
//       right_tag  string | null   (optional) the game outcome's right tag, once known (dawn)
//     One record per thread + pid: calling it again (e.g. at dawn with right_tag) replaces the earlier one.
//
//   Export: feedbackJsonl(items) / downloadFeedback() / clearFeedback(); hooks: useFeedback(), useRating(...).

import { useMemo, useSyncExternalStore } from "react";

export type FeedbackKind = "finding" | "source" | "draft" | "tag";
export type Rating = "up" | "down";
export type FeedbackItem = {
  ts: number; // Date.now()
  thread_id: string | null;
  kind: FeedbackKind;
  pid: string;
  label: string;
  item: string; // the text the agent produced
  rating: Rating;
  // tag decisions only
  agent_tag?: string | null;
  bob_tag?: string;
  right_tag?: string | null;
};
export type TagDecision = { thread_id: string | null; pid: string; label: string; agent_tag: string | null; bob_tag: string; right_tag?: string | null };

const KEY = "laststand.feedback.v1";
const EVT = "laststand:feedback";
const THREAD_KEY = "laststand.log.thread"; // AgentLog's LOG_THREAD_KEY: the night the game is playing
const SOURCE = "Bob's Shift (simulated quake; game outcome, not an engineering assessment)";

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function parse(raw: string | null): FeedbackItem[] {
  if (!raw) return [];
  try {
    const a = JSON.parse(raw) as unknown;
    return Array.isArray(a) ? (a as FeedbackItem[]).filter((x) => x && typeof x.kind === "string" && (x.rating === "up" || x.rating === "down")) : [];
  } catch {
    return [];
  }
}

function write(items: FeedbackItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
    window.dispatchEvent(new Event(EVT));
  } catch {}
}

/** The night the game is playing, when the caller doesn't know it (the dawn drafts). */
export function currentThread(): string | null {
  try {
    return localStorage.getItem(THREAD_KEY);
  } catch {
    return null;
  }
}

const same = (a: Pick<FeedbackItem, "kind" | "thread_id" | "pid" | "item">, b: Pick<FeedbackItem, "kind" | "thread_id" | "pid" | "item">) =>
  a.kind === b.kind && (a.thread_id ?? null) === (b.thread_id ?? null) && a.pid === b.pid && (a.kind === "tag" || a.item === b.item);

/** A thumb on a finding, a source row or a draft. The same thumb again takes it back; the other thumb replaces it. */
export function addFeedback(f: Omit<FeedbackItem, "ts">) {
  const items = parse(read());
  const at = items.findIndex((x) => same(x, f));
  if (at >= 0 && items[at].rating === f.rating && f.kind !== "tag") items.splice(at, 1);
  else if (at >= 0) items[at] = { ...f, ts: Date.now() };
  else items.push({ ...f, ts: Date.now() });
  write(items);
}

/** Bob's placard against the agent's proposal (and the outcome's right tag, when known). Automatic; no button. */
export function recordTagDecision({ thread_id, pid, label, agent_tag, bob_tag, right_tag = null }: TagDecision) {
  try {
    const parts = [`Agent proposed ${agent_tag ?? "no tag"}`, `Bob posted ${bob_tag}`];
    if (right_tag) parts.push(`the outcome's right tag was ${right_tag}`);
    addFeedback({
      thread_id: thread_id ?? null, kind: "tag", pid: String(pid), label: label || `Building ${pid}`,
      item: `${parts.join("; ")}.`, rating: agent_tag && agent_tag === bob_tag ? "up" : "down",
      agent_tag: agent_tag ?? null, bob_tag, right_tag: right_tag ?? null,
    });
  } catch {}
}

export function clearFeedback() {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new Event(EVT));
  } catch {}
}

const subscribe = (f: () => void) => {
  window.addEventListener("storage", f);
  window.addEventListener(EVT, f);
  return () => {
    window.removeEventListener("storage", f);
    window.removeEventListener(EVT, f);
  };
};

/** Every feedback item in this browser ([] on the server render). */
export function useFeedback(): FeedbackItem[] {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  return useMemo(() => parse(raw), [raw]);
}

/** The current thumb on one piece of the agent's text, if any. */
export function useRating(kind: FeedbackKind, thread_id: string | null, pid: string, item: string): Rating | null {
  const items = useFeedback();
  return items.find((x) => same(x, { kind, thread_id, pid, item }))?.rating ?? null;
}

/** One JSON object per line: a preference pair per tag decision that disagrees, a rating record for everything else. */
export function feedbackJsonl(items: FeedbackItem[]): string {
  const lines = items.map((f) => {
    if (f.kind === "tag" && f.bob_tag) {
      const agent = f.agent_tag ?? null;
      const right = f.right_tag ?? null;
      const chosen = right ?? f.bob_tag;
      const rejected = right ? (agent && agent !== right ? agent : f.bob_tag !== right ? f.bob_tag : null) : agent && agent !== f.bob_tag ? agent : null;
      if (rejected && rejected !== chosen)
        return {
          type: "preference", prompt: `Post-quake placard for ${f.label} (${f.pid})`, chosen, rejected,
          agent_proposal: agent, human_choice: f.bob_tag, outcome_right_tag: right, source: SOURCE, thread_id: f.thread_id,
        };
    }
    return { type: "rating", kind: f.kind, item: f.item, rating: f.rating, pid: f.pid, label: f.label, thread_id: f.thread_id, source: SOURCE };
  });
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : "");
}

/** Saves bob-feedback-<date>.jsonl. */
export function downloadFeedback(items: FeedbackItem[] = parse(read())) {
  try {
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const url = URL.createObjectURL(new Blob([feedbackJsonl(items)], { type: "application/jsonl" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `bob-feedback-${date}.jsonl`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {}
}
