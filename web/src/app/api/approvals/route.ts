import { Client } from "@langchain/langgraph-sdk";

// Pending approvals on background-worker threads (the overnight sweep's file_correction, outreach drafts),
// so a person can decide in the app when texting isn't set up. The human clicks; nothing is auto-approved.
const client = () =>
  new Client({ apiUrl: process.env.LANGGRAPH_URL ?? "http://127.0.0.1:2024", apiKey: process.env.LANGSMITH_API_KEY || undefined });

type ActionRequest = { name?: string; args?: Record<string, unknown>; description?: string };

export async function GET() {
  try {
    const c = client();
    const threads = await c.threads.search({ metadata: { graph_id: "radar_worker" }, status: "interrupted", limit: 10 });
    const pending = [];
    for (const t of threads) {
      const state = await c.threads.getState(t.thread_id);
      for (const task of state.tasks) {
        for (const it of task.interrupts ?? []) {
          const actions = ((it.value as { action_requests?: ActionRequest[] } | undefined)?.action_requests ?? []).map((a) => ({
            name: a.name, args: a.args ?? {},
          }));
          if (actions.length) pending.push({ thread_id: t.thread_id, interrupt_id: it.id, actions, updated_at: t.updated_at });
        }
      }
    }
    return Response.json({ pending });
  } catch {
    return Response.json({ pending: [], error: "agent server unreachable" }, { status: 502 });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { thread_id?: unknown; decision?: unknown } | null;
  if (!body || typeof body.thread_id !== "string" || (body.decision !== "approve" && body.decision !== "reject")) {
    return Response.json({ error: "expected {thread_id, decision: approve|reject}" }, { status: 400 });
  }
  const c = client();
  // Only resume paused background-worker runs: never a live thread or an arbitrary id posted to this route.
  const thread = await c.threads.get(body.thread_id).catch(() => null);
  if (!thread || (thread.metadata as { graph_id?: string } | null)?.graph_id !== "radar_worker") {
    return Response.json({ error: "not a background-worker thread" }, { status: 403 });
  }
  const state = await c.threads.getState(body.thread_id).catch(() => null);
  const interrupts = state?.tasks.flatMap((t) => t.interrupts ?? []) ?? [];
  if (!interrupts.length) return Response.json({ error: "nothing pending on this thread" }, { status: 409 });
  // HumanInTheLoopMiddleware expects one decision per action request.
  const value = (it: (typeof interrupts)[number]) => ({
    decisions: ((it.value as { action_requests?: unknown[] } | undefined)?.action_requests ?? []).map(() => ({ type: body.decision })),
  });
  const resume = interrupts.length === 1 ? value(interrupts[0]) : Object.fromEntries(interrupts.map((it) => [it.id ?? "", value(it)]));
  try {
    await c.runs.create(body.thread_id, "radar_worker", { command: { resume } });
  } catch {
    return Response.json({ error: "agent server refused the resume" }, { status: 502 });
  }
  return Response.json({ status: "resumed", decision: body.decision });
}
