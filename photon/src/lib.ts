// Pure helpers for the bridge (no network), so they can be unit-tested.
import crypto from "node:crypto";

export const MAX_TEXT = 1500;

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";
  return "+" + (digits.length === 10 ? "1" + digits : digits);
}

export const tail = (phone: string) => "…" + phone.slice(-4); // logs never carry full numbers

export function plain(text: string): string {
  // iMessage shows markdown literally; keep the words, drop the markup.
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .trim()
    .slice(0, MAX_TEXT);
}

export function threadFor(phone: string): string {
  // A stable UUID per sender, so a restart keeps the conversation (and any pending approval).
  const h = crypto.createHash("sha256").update(`radar-photon:${phone}`).digest("hex");
  const variant = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function parseDecision(text: string): "approve" | "reject" | null {
  const t = text.trim().toLowerCase();
  if (/^(y|yes|yep|yeah|approve|approved|ok|okay|go|do it)\b/.test(t)) return "approve";
  if (/^(n|no|nope|reject|rejected|stop|cancel|don't|dont)\b/.test(t)) return "reject";
  return null;
}

export type ActionRequest = { name?: string; args?: Record<string, unknown>; description?: string };
export type PendingInterrupt = { id?: string; actions: ActionRequest[] };

export function describeActions(actions: ActionRequest[]): string {
  const lines = actions.map((a) => {
    const args = a.args ?? {};
    if (a.name === "send_outreach") return `send ${String(args.to ?? "someone")} this message: "${String(args.text ?? "").slice(0, 300)}"`;
    if (a.name === "watch_building") return `start watching building ${String(args.property_id ?? "?")} (${String(args.reason ?? "").slice(0, 200)})`;
    return (a.description ?? a.name ?? "an action").slice(0, 300);
  });
  return lines.join("; ") || "an action";
}

export function resumeFor(pending: PendingInterrupt[], decision: "approve" | "reject"): unknown {
  // HumanInTheLoopMiddleware expects one decision per action request.
  const value = (p: PendingInterrupt) => ({ decisions: p.actions.map(() => ({ type: decision })) });
  if (pending.length === 1) return value(pending[0]);
  return Object.fromEntries(pending.map((p) => [p.id ?? "", value(p)]));
}

export function lastAiText(values: unknown, from = 0): string | null {
  const messages = ((values as { messages?: unknown[] })?.messages ?? []) as Array<{ type?: string; role?: string; content?: unknown }>;
  for (let i = messages.length - 1; i >= from; i--) {
    const m = messages[i];
    if (m?.type !== "ai" && m?.role !== "assistant") continue;
    const c = m.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("") : "";
    if (text.trim()) return text.trim();
  }
  return null;
}

export function frame(text: string): string {
  return (
    "Text from the team over iMessage. Your final answer is texted back as is: at most three short " +
    "sentences, plain text, no markdown, and do not call notify_me for this request.\n\n" + text
  );
}
