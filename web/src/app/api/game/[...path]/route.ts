// Same-origin proxy for the game routes, so the browser never needs CORS.
// /api/game/district -> GET /game/district; /api/game/dossier/{pid} -> GET /game/dossier/{pid};
// /api/game/resolve -> POST /game/resolve. Nothing else passes.
const BACKEND = process.env.LANGGRAPH_URL ?? "http://127.0.0.1:2024";
const PID = /^[A-Za-z0-9_#.-]+$/;

function target(method: string, path: string[]): string | null {
  const seg = path.map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (method === "GET" && seg.length === 1 && seg[0] === "district") return "game/district";
  if (method === "GET" && seg.length === 1 && seg[0] === "city") return "game/city";
  if (method === "GET" && seg.length === 1 && seg[0] === "solar") return "game/solar";
  if (method === "GET" && seg.length === 1 && seg[0] === "stale") return "game/stale";
  if (method === "GET" && seg.length === 2 && seg[0] === "mesh" && PID.test(seg[1])) return `game/mesh/${encodeURIComponent(seg[1])}`;
  if (method === "GET" && seg.length === 2 && seg[0] === "suites" && PID.test(seg[1])) return `game/suites/${encodeURIComponent(seg[1])}`;
  if (method === "GET" && seg.length === 2 && seg[0] === "dossier" && PID.test(seg[1])) return `game/dossier/${encodeURIComponent(seg[1])}`;
  if (method === "POST" && seg.length === 1 && seg[0] === "resolve") return "game/resolve";
  // Bob's desk: the per-building card (by data source), the screening sheet, and the triage map layer.
  if (method === "GET" && seg.length === 1 && seg[0] === "triage") return "desk/triage";
  if (method === "GET" && seg.length === 2 && (seg[0] === "card" || seg[0] === "screen") && PID.test(seg[1])) return `desk/${seg[0]}/${encodeURIComponent(seg[1])}`;
  // The deep agent's log for one run (read-only; built from the thread's messages).
  if (method === "GET" && seg.length === 2 && seg[0] === "log" && /^[0-9a-f-]{8,64}$/i.test(seg[1])) return `game/log/${seg[1]}`;
  // Play again: clear people's notes so a fresh night replays exactly (the server only accepts {"confirm":"reset"}, locally).
  if (method === "POST" && seg.length === 2 && seg[0] === "demo" && seg[1] === "reset") return "demo/reset";
  return null;
}

async function forward(req: Request, path: string[]): Promise<Response> {
  const p = target(req.method, path);
  if (!p) return Response.json({ error: "not allowed" }, { status: 404 });
  const init: RequestInit = { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json" } };
  if (req.method === "POST") init.body = await req.text();
  // The dossier may carry the checks run so far (the server recomputes walls with them + people's notes). Whitelisted shape.
  const sp = new URL(req.url).searchParams;
  const checks = sp.get("checks");
  const params = new URLSearchParams();
  if ((p.startsWith("game/dossier/") || p.startsWith("desk/card/") || p.startsWith("desk/screen/")) && checks && /^[a-z_,]{1,300}$/.test(checks)) params.set("checks", checks);
  if (p === "desk/triage" && sp.get("scope") === "city") params.set("scope", "city"); // all LA kit buildings, screened in code
  if (p.startsWith("desk/card/") && sp.get("live") === "1") params.set("live", "1"); // pull Vexcel live when no aerial is cached
  const q = params.toString() ? `?${params.toString()}` : "";
  const r = await fetch(`${BACKEND}/${p}${q}`, init).catch(() => null);
  if (!r) return Response.json({ error: "agent server unreachable" }, { status: 502 });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
