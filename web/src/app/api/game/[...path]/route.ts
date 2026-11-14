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
  if (method === "GET" && seg.length === 2 && seg[0] === "dossier" && PID.test(seg[1])) return `game/dossier/${encodeURIComponent(seg[1])}`;
  if (method === "POST" && seg.length === 1 && seg[0] === "resolve") return "game/resolve";
  return null;
}

async function forward(req: Request, path: string[]): Promise<Response> {
  const p = target(req.method, path);
  if (!p) return Response.json({ error: "not allowed" }, { status: 404 });
  const init: RequestInit = { method: req.method, headers: { "content-type": req.headers.get("content-type") ?? "application/json" } };
  if (req.method === "POST") init.body = await req.text();
  const r = await fetch(`${BACKEND}/${p}`, init).catch(() => null);
  if (!r) return Response.json({ error: "agent server unreachable" }, { status: 502 });
  return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") ?? "application/json" } });
}

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  return forward(req, (await ctx.params).path);
}
