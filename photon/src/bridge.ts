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
  describeActions,
  frame,
  lastAiText,
  normalizePhone,
  parseDecision,
  plain,
  resumeFor,
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

async function pendingInterrupts(threadId: string): Promise<PendingInterrupt[]> {
  const state = await lg.threads.getState(threadId);
  return state.tasks.flatMap((t) => t.interrupts ?? []).map((it) => ({
    id: it.id,
    actions: (it.value as { action_requests?: ActionRequest[] } | undefined)?.action_requests ?? [],
  }));
}

async function messageCount(threadId: string): Promise<number> {
  try {
    const state = await lg.threads.getState(threadId);
    return ((state.values as { messages?: unknown[] })?.messages ?? []).length;
  } catch {
    return 0; // new thread
  }
}

type Inbound = {
  content: { type: string; text?: string };
  react(reaction: string): Promise<unknown>;
  reply(content: string): Promise<unknown>;
};
type InboundSpace = Sendable & { responding<T>(fn: () => T | Promise<T>): Promise<T> };

async function handleInbound(from: string, space: InboundSpace, message: Inbound): Promise<void> {
  if (message.content.type !== "text" || !message.content.text?.trim()) {
    await message.reply("Radar reads text only for now.");
    return;
  }
  const text = message.content.text.trim();
  console.log(`[inbound] ${text.length} chars from ${tail(from)}`);
  await message.react("👍").catch(() => {}); // instant acknowledgement
  const threadId = threadFor(from);

  await space.responding(async () => {
    try {
      let pending: PendingInterrupt[] = [];
      try {
        pending = await pendingInterrupts(threadId);
      } catch {
        pending = []; // thread doesn't exist yet
      }
      const decision = pending.length ? parseDecision(text) : null;
      if (pending.length && !decision) {
        await message.reply(`Still waiting on your approval to ${describeActions(pending.flatMap((p) => p.actions))}. Reply YES or NO.`);
        return;
      }
      const before = await messageCount(threadId);
      const payload = decision
        ? { command: { resume: resumeFor(pending, decision) } }
        : { input: { messages: [{ role: "user", content: frame(text) }] } };
      const values = await lg.runs.wait(threadId, ASSISTANT, {
        ...payload,
        ifNotExists: "create",
        metadata: { trigger: "imessage" },
        signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      });
      const next = await pendingInterrupts(threadId);
      if (next.length) {
        await space.send(`Approval needed: ${describeActions(next.flatMap((p) => p.actions))}\nReply YES to approve or NO to reject.`);
        return;
      }
      const answer = lastAiText(values, before);
      await message.reply(answer ? plain(answer) : decision === "reject" ? "Rejected. Nothing was sent." : "Done.");
    } catch (err) {
      const offline = /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(errMsg(err));
      console.error(`[inbound] run failed: ${errMsg(err)}`);
      await message.reply(offline
        ? "Radar's agent server isn't reachable right now. Try again in a minute."
        : "That one failed on my side; it's in the logs.");
    }
  });
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

const chains = new Map<string, Promise<void>>(); // one request at a time per sender, senders in parallel
for await (const [space, message] of app.messages) {
  if (message.direction === "outbound") continue;
  const from = normalizePhone(message.sender?.id ?? "");
  if (!ALLOWED.has(from)) {
    console.log(`[inbound] ignored a message from an unknown sender ${tail(from)}`);
    continue;
  }
  spaces.set(from, space);
  const prev = chains.get(from) ?? Promise.resolve();
  chains.set(from, prev.then(() => handleInbound(from, space, message as unknown as Inbound)).catch((err) => {
    console.error(`[inbound] ${errMsg(err)}`);
  }));
}
