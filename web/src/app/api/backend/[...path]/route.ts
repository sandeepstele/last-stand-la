// Same-origin proxy to the agent server's custom routes, so the browser never needs CORS.
// Only the case queue, decisions and cached evidence images pass through.
const BACKEND = process.env.LANGGRAPH_URL ?? "http://127.0.0.1:2024";
const ALLOWED = [/^healthz$/, /^cases\/queue$/, /^cases\/decision$/, /^evidence\/image\/[A-Za-z0-9_.-]+\.jpg$/];

async function forward(req: Request, path: string[]): Promise<Response> {
  const p = path.join("/");
  if (!ALLOWED.some((r) => r.test(p))) return Response.json({ error: "not allowed" }, { status: 404 });
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
