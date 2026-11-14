# Retrofit Radar web app

Next.js 16 + three.js. A single page talks to the agent server (`langgraph dev` on 127.0.0.1:2024).

## What's on the page

- **Case queue** (left): `GET /cases/queue`, in the order "imagery gathered first, then by stakes". Clicking a row asks the agent to investigate that building or suite.
- **Inbox** (left):
  - the case of the day (`GET /cases/inbox`);
  - corrections **waiting for you**, listed from paused background runs by `src/app/api/approvals/route.ts`. Approve or Reject resumes that run.
- **3D view** (center): the agent drives it with scene verbs over the LangGraph `custom` stream channel (`src/lib/useSceneActions.ts`, `src/components/WorldPane.tsx`). The browser confirms each action through `/api/ack`.
- **Case file** (right, `src/components/Cases.tsx`):
  - hypotheses with live confidence bars;
  - the evidence steps, with images and callouts for vision checks;
  - the verdict, worded as a lead to check, never as a fact;
  - a draft correction with Approve/Reject (`POST /cases/decision`, recorded only).
- **REPLAY badge:** shown whenever the agent server runs a recorded replay. It re-checks `/healthz` on every run and every 15 s.

## How it talks to the backend

- **`useStream`** (`@langchain/react`) streams runs straight from the agent server. Every question starts a **fresh thread** (`submit(..., { threadId: null })`).
- **`src/app/api/backend/[...path]`** is a same-origin proxy to the agent server's custom routes. Only an allowlist passes: `healthz`, `cases/queue`, `cases/inbox`, `cases/decision`, `evidence/image/<name>.jpg`.
- **`src/app/api/approvals`** lists and resumes interrupted `radar_worker` threads only.

## Run

```bash
npm install                         # optional .env.local: NEXT_PUBLIC_LANGGRAPH_URL, LANGGRAPH_URL (both default to http://127.0.0.1:2024)
npm run dev                         # http://127.0.0.1:3000 (bound to localhost on purpose)
npx tsc --noEmit                    # type-check (run once `npm run dev` has generated .next/types)
```
