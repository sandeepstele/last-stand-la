// Retrofit Radar <-> iMessage, through Photon Spectrum. Run: cd photon && npm start
//
// Outbound: POST http://127.0.0.1:$PHOTON_BRIDGE_PORT/send
//           Authorization: Bearer $PHOTON_BRIDGE_TOKEN   body {"text": "...", "to": "owner" | "team"}
//           app/photon.py calls this for notify_me. Only the team's own numbers can be texted.
// Inbound:  a text from an allowlisted number starts a run on the LangGraph server
//           ($PHOTON_ASSISTANT, default radar_worker) on one thread per sender, and the final
//           answer is texted back. If the run stops at an approval (send_outreach, watch_building),
//           the bridge, not the model, texts the request; YES or NO resumes the run.
import crypto from "node:crypto";
import http from "node:http";
import { Client } from "@langchain/langgraph-sdk";
import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { env, optionalEnv } from "./env.ts";
import {
  type ActionRequest,
  type PendingInterrupt,
  QUAKE_ALERT,
  SWEEP,
  allowedSender,
  describeActions,
  frame,
  inboundText,
  lastAiText,
  normalizePhone,
  parseDecision,
  plain,
  resumeFor,
  sameIds,
  tail,
  threadFor,
} from "./lib.ts";

const PORT = Number(optionalEnv("PHOTON_BRIDGE_PORT") ?? 8787);
const TOKEN = env("PHOTON_BRIDGE_TOKEN");
const LANGGRAPH_URL = optionalEnv("LANGGRAPH_URL") ?? "http://127.0.0.1:2024";
const ASSISTANT = optionalEnv("PHOTON_ASSISTANT") ?? "radar_worker";
const RUN_TIMEOUT_MS = Number(optionalEnv("PHOTON_RUN_TIMEOUT_S") ?? 600) * 1000;

const OWNER = normalizePhone(env("PHOTON_OWNER_PHONE"));
const TEAM = (optionalEnv("PHOTON_TEAM_PHONE") ?? "").split(",").map(normalizePhone).filter(Boolean);
const ALLOWED = new Set([OWNER, ...TEAM]);

const app = await Spectrum({
  projectId: env("SPECTRUM_PROJECT_ID"),
  projectSecret: env("SPECTRUM_PROJECT_SECRET"),
  providers: [imessage.config()],
});
const im = imessage(app);
const lg = new Client({ apiUrl: LANGGRAPH_URL });

type Sendable = { send(content: string): Promise<unknown> };
const spaces = new Map<string, Sendable>(); // one DM per number, reused for outbound

async function dm(phone: string): Promise<Sendable> {
  let space = spaces.get(phone);
  if (!space) {
    space = await im.space.create(await im.user(phone));
    spaces.set(phone, space);
  }
  return space;
}

const errMsg = (err: unknown) => String((err as Error)?.message ?? err).slice(0, 300);

// ---------- outbound: localhost HTTP ----------

function authorized(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${TOKEN}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function readJson(req: http.IncomingMessage, limit = 16_384): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

const server = http.createServer(async (req, res) => {
  const reply = (code: number, body: object) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/healthz") return reply(200, { ok: true, assistant: ASSISTANT, numbers: ALLOWED.size });
  if (req.method === "POST" && req.url === "/trigger") {
    if (!authorized(req.headers.authorization)) return reply(401, { status: "unauthorized" });
    let body: Record<string, unknown>;
    try {
      body = await readJson(req);
    } catch (err) {
      return reply(400, { status: "error", detail: errMsg(err) });
    }
    const eventId = typeof body.event_id === "string" && /^[a-z0-9]{4,20}$/.test(body.event_id) ? body.event_id : "ci3144585";
    const kind = body.kind === "sweep" ? "sweep" : "quake";
    const content = kind === "sweep" ? SWEEP : QUAKE_ALERT(eventId);
    const owner = { send: async (t: string) => (await dm(OWNER)).send(t) };
    void enqueue(OWNER, () => runAndReport(OWNER, { input: { messages: [{ role: "user", content }] } }, owner, owner));
    console.log(`[trigger] ${kind} -> owner ${tail(OWNER)}`);
    return reply(202, { status: "started", kind });
  }
  if (req.method !== "POST" || req.url !== "/send") return reply(404, { status: "not_found" });
  if (!authorized(req.headers.authorization)) return reply(401, { status: "unauthorized" });
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (err) {
    return reply(400, { status: "error", detail: errMsg(err) });
  }
  const text = typeof body.text === "string" ? plain(body.text) : "";
  if (!text) return reply(400, { status: "error", detail: "text is required" });
  const to = body.to ?? "owner";
  const targets = to === "owner" ? [OWNER] : to === "team" ? [...ALLOWED] : null;
  if (!targets) return reply(400, { status: "error", detail: 'to must be "owner" or "team"' });
  try {
    for (const phone of targets) await (await dm(phone)).send(text);
    console.log(`[send] ${text.length} chars to ${targets.map(tail).join(", ")}`);
    return reply(200, { status: "sent", count: targets.length });
  } catch (err) {
    console.error(`[send] failed: ${errMsg(err)}`);
    return reply(502, { status: "error", detail: errMsg(err) });
  }
});

// ---------- inbound: texts -> agent runs ----------

const texted = new Map<string, string[]>(); // thread -> ids of the interrupts whose approval prompt we texted

async function pendingInterrupts(threadId: string): Promise<PendingInterrupt[]> {
  let state;
  try {
    state = await lg.threads.getState(threadId);
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return []; // new thread
    throw err;
  }
  return state.tasks.flatMap((t) => t.interrupts ?? []).map((it) => ({
    id: it.id,
    actions: (it.value as { action_requests?: ActionRequest[] } | undefined)?.action_requests ?? [],
  }));
}

async function messageCount(threadId: string): Promise<number> {
  try {
    const state = await lg.threads.getState(threadId);
    return ((state.values as { messages?: unknown[] })?.messages ?? []).length;
  } catch (err) {
    if ((err as { status?: number })?.status === 404) return 0;
    throw err;
  }
}

const ids = (p: PendingInterrupt[]) => p.map((x) => x.id ?? "");

async function textApproval(threadId: string, pending: PendingInterrupt[], to: Sendable): Promise<void> {
  texted.set(threadId, ids(pending));
  await to.send(`${await replayPrefix()}Approval needed: ${describeActions(pending.flatMap((p) => p.actions))}\nReply YES to approve or NO to reject.`);
}

type Reply = { send(content: string): Promise<unknown> };

/** "[REPLAY] " when the agent server is replaying recorded model answers, so a text never passes as live. */
async function replayPrefix(): Promise<string> {
  try {
    const r = await fetch(`${LANGGRAPH_URL}/healthz`, { signal: AbortSignal.timeout(3000) });
    const h = (await r.json()) as { replay?: string | null };
    return h.replay && !h.replay.startsWith("recording") ? "[REPLAY] " : "";
  } catch {
    return "";
  }
}

/** Start or resume a run on the sender's thread, then text the answer or the approval it stopped at. */
async function runAndReport(from: string, payload: Record<string, unknown>, reply: Reply, chat: Sendable,
                            fallback?: string): Promise<void> {
  const threadId = threadFor(from);
  try {
    const before = await messageCount(threadId);
    const values = await lg.runs.wait(threadId, ASSISTANT, {
      ...payload,
      ifNotExists: "create",
      metadata: { trigger: "imessage" },
      config: { configurable: { channel: "imessage" } }, // notify_me stays in the inbox for these runs
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    });
    const next = await pendingInterrupts(threadId);
    if (next.length) return await textApproval(threadId, next, chat);
    const answer = lastAiText(values, before);
    await reply.send((await replayPrefix()) + (answer ? plain(answer) : fallback ?? "Done."));
  } catch (err) {
    console.error(`[run] failed: ${errMsg(err)}`);
    // A run can outlive our wait (it keeps going on the server): if it stopped at an approval, say so.
    const pending = await pendingInterrupts(threadId).catch(() => []);
    if (pending.length) return await textApproval(threadId, pending, chat);
    const offline = /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(errMsg(err));
    await reply.send(offline ? "Radar's agent server isn't reachable right now. Try again in a minute."
                             : "That one is taking longer than expected or failed; it's in the logs.");
  }
}

async function handleInbound(from: string, space: InboundSpace, message: Inbound, text: string): Promise<void> {
  console.log(`[inbound] ${text.length} chars from ${tail(from)}`);
  await message.react("👍").catch(() => {}); // instant acknowledgement
  const threadId = threadFor(from);
  const reply = { send: (t: string) => message.reply(t) };
  const work = async () => {
    const pending = await pendingInterrupts(threadId);
    if (pending.length) {
      const decision = parseDecision(text);
      if (!decision || !sameIds(ids(pending), texted.get(threadId) ?? [])) {
        // Not a clear YES/NO, or not the approval we showed (e.g. the bridge restarted): show it again.
        return await textApproval(threadId, pending, space);
      }
      texted.delete(threadId);
      return await runAndReport(from, { command: { resume: resumeFor(pending, decision) } }, reply, space,
                                decision === "reject" ? "Rejected. Nothing was recorded." : "Approved.");
    }
    await runAndReport(from, { input: { messages: [{ role: "user", content: frame(text) }] } }, reply, space);
  };
  try {
    await space.responding(work);
  } catch (err) {
    console.error(`[inbound] ${errMsg(err)}`); // e.g. the typing indicator failed: do the work without it
    await work().catch((e) => console.error(`[inbound] ${errMsg(e)}`));
  }
}

type Inbound = {
  content: { type?: string; text?: string; content?: { type?: string; text?: string } };
  sender?: { id?: string; service?: string };
  react(reaction: string): Promise<unknown>;
  reply(content: string): Promise<unknown>;
};
type InboundSpace = Sendable & { type?: string; responding<T>(fn: () => T | Promise<T>): Promise<T> };

const chains = new Map<string, Promise<void>>(); // one request at a time per sender, senders in parallel
function enqueue(from: string, job: () => Promise<void>): Promise<void> {
  const next = (chains.get(from) ?? Promise.resolve()).then(job).catch((err) => console.error(`[queue] ${errMsg(err)}`));
  chains.set(from, next);
  return next;
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] up on 127.0.0.1:${PORT}; texts allowed to ${[...ALLOWED].map(tail).join(", ")}; inbound -> ${ASSISTANT} at ${LANGGRAPH_URL}`);
});

const shutdown = async () => {
  server.close();
  await app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  const m = message as unknown as Inbound;
  const sp = space as unknown as InboundSpace;
  const from = m.sender?.id ?? "";
  if (!allowedSender(from, m.sender?.service, ALLOWED)) {
    console.log(`[inbound] ignored a message from an unknown sender ${tail(from)}`);
    continue;
  }
  if (sp.type && sp.type !== "dm") continue; // never act inside group chats
  const text = inboundText(m.content);
  if (!text) continue; // tapbacks, read receipts, typing, attachments
  void enqueue(from, () => handleInbound(from, sp, m, text));
}
