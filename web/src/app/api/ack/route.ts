import { Client } from "@langchain/langgraph-sdk";

// Server-side only: writes the browser's ack to the Store (namespace ["acks"]), where
// app/scene.py:stage() polls for it. The LangSmith key never reaches the browser.
export async function POST(req: Request) {
  const ack = (await req.json().catch(() => null)) as { id?: unknown; ok?: unknown; screenshot_jpeg_b64?: unknown; error?: unknown } | null;
  if (!ack || typeof ack.id !== "string" || typeof ack.ok !== "boolean") {
    return Response.json({ error: "expected {id: string, ok: boolean}" }, { status: 400 });
  }
  const client = new Client({
    apiUrl: process.env.LANGGRAPH_URL ?? "http://127.0.0.1:2024",
    apiKey: process.env.LANGSMITH_API_KEY || undefined,
  });
  await client.store.putItem(["acks"], ack.id, {
    ok: ack.ok,
    ...(typeof ack.screenshot_jpeg_b64 === "string" ? { screenshot_jpeg_b64: ack.screenshot_jpeg_b64 } : {}),
    ...(typeof ack.error === "string" ? { error: ack.error } : {}),
  });
  return Response.json({ ok: true });
}
