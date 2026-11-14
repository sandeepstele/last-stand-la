# Frontend: the web app

`web/` is a Next.js 16 app with three.js. It has one page that talks to the agent server (`langgraph dev` on 127.0.0.1:2024). Overview: [ARCHITECTURE.md](ARCHITECTURE.md). `web/README.md` has the short version.

> `web/AGENTS.md` (written by `next dev`): this Next.js version has breaking changes. Read the guide in `web/node_modules/next/dist/docs/` before writing Next.js code.

## Run

```bash
cd web
npm install
npm run dev            # http://127.0.0.1:3000 (next dev -H 127.0.0.1: localhost only, on purpose)
npm run lint
npx next typegen       # generate .next/types (route and LayoutProps types) without a full build
npx tsc --noEmit       # type-check; needs the generated types above
```

Optional `web/.env.local`: `NEXT_PUBLIC_LANGGRAPH_URL` (the browser's `useStream`) and `LANGGRAPH_URL` (the server-side routes). Both default to `http://127.0.0.1:2024`. The `ack` and `approvals` routes also pass `LANGSMITH_API_KEY` when it is set (needed only for a deployed agent server). Never put a key in a `NEXT_PUBLIC_` variable.

## Page map

| File | What it holds |
|---|---|
| `web/src/app/page.tsx` | `LiveRun`: the one page. The layout (queue pane, 3D pane, agent pane, footer strip), the question form, the "Replay Northridge 1994" button, the run timer, the REPLAY badge and the error line |
| `web/src/components/Cases.tsx` | `CaseQueue` (left), `InboxCard` (left: case of the day, corrections waiting for you, recent decisions), `CaseFile` (right: hypotheses with live confidence bars, evidence steps with images and callouts, the verdict, the draft with Approve / Reject) |
| `web/src/components/Panels.tsx` | `PlanPanel` (todos and specialists), `VerifierCard`, `ApprovalBar` (live interrupts), `SeismicCard`, `QuakeBanner`, and the helpers `latestTool`, `latestVerify` and `finalAnswer` |
| `web/src/components/WorldPane.tsx` | The three.js scene. `perform(action)` applies a `frontend_action` and returns an `Ack` with a JPEG snapshot of the canvas |
| `web/src/lib/useSceneActions.ts` | Subscribes to the `custom` stream channel, performs each action, and posts the ack to `/api/ack` |
| `web/src/lib/contracts.ts` | TypeScript mirror of `contracts/*.schema.json` and the tool result shapes the cards read |
| `web/src/app/layout.tsx`, `globals.css` | Root layout and global styles |

**Scene verbs:** `WorldPane` handles `show_building` (clears the scene first), `ghost_compare`, `reveal_levels` and `place_solar`. The server sends them in that order within a turn, and the browser applies them in arrival order.

## How it uses `useStream`

```ts
const stream = useStream({ assistantId: "radar", apiUrl: API_URL });
const ask = (q: string) => void stream.submit({ messages: [{ type: "human", content: q }] }, { threadId: null });
```

- **Every question starts a fresh thread** (`threadId: null`). The previous case's tool results can't leak into this one's cards, the context stays small, and replay keys stay stable.
- **The cards read tool results** from `stream.messages`:
  - `latestTool(messages, "<tool name>")` parses the newest result of a tool;
  - `CaseFile` takes only `check_evidence` and `weigh_case` results that come after the newest `open_case`;
  - `liveConfidence()` mirrors `weigh_case`'s arithmetic (priors plus deltas, floor 0.02, normalize) so the bars move before the verdict lands.
- **Todos and specialists** come from `stream.values.todos` and `stream.subagents`.
- **Live approvals:** `stream.interrupt` holds them, and `ApprovalBar` answers with `stream.respond({decisions: [...]})`, one decision per action request.

Clicking a queue row asks the exact questions the replay recordings use: `Check building <pid>.` or `Check suite <suite> at building <pid>: is the tenant on record still there?`.

## Server routes

These run inside Next.js (server side), so the browser needs no CORS and never sees a key.

| Route | Does |
|---|---|
| `web/src/app/api/backend/[...path]/route.ts` | Same-origin proxy to the agent server's custom routes. **Allowlist only:** `healthz`, `cases/queue`, `cases/inbox`, `cases/decision`, `evidence/image/<name>.jpg`; anything else is a 404 |
| `web/src/app/api/approvals/route.ts` | `GET` lists interrupted `radar_worker` threads and their action requests. `POST {thread_id, decision: approve\|reject}` resumes one, after checking that the thread belongs to `radar_worker` (403 otherwise; 409 if nothing is pending) |
| `web/src/app/api/ack/route.ts` | `POST {id, ok, screenshot_jpeg_b64?, error?}` writes the ack to Store `["acks"]`, where `app/scene.py` waits for it |

## Styles

- CSS modules, no UI library: `web/src/app/page.module.css` (layout panes, cards, bars, chips, badges, the approval bar) and `web/src/components/world.module.css` (the 3D pane).
- `Cases.tsx` and `Panels.tsx` import `@/app/page.module.css`.
- Data attributes such as `data-status`, `data-sign` and `data-verdict` drive state styling.

## The REPLAY badge

`page.tsx` fetches `/api/backend/healthz` on load, on every run and every 15 s. When `replay` is set and is not `recording ...`, it shows a **REPLAY** badge with the recording's name and a note that only the model answers are replayed (the data, tools and images are live). A replayed answer must never show without it.

## Game screen `/play` (in progress)

> **In progress on the `game` branch. None of these files exist in this branch.** Built against **contract v1.1** (frozen) in `PLAN.md` (the team's private planning repo), section "Contract v1.1". Interface copy: [../contracts/README.md](../contracts/README.md#game-contract-v11-in-progress).

Planned, from `PLAN.md`:
- **New files only:** `web/src/game/*` and `web/src/app/play/*`, first built against synthetic stubs.
- **A new proxy,** `web/src/app/api/game/[...path]/route.ts`, allowing only `GET game/district`, `GET game/dossier/{pid}` and `POST game/resolve`. The shared proxy is not edited.
- **One thread on graph `laststand`.** `/play` has its own `respond` call for HOLD / RUN on `commit_plan`:
  - the button matching the agent's proposal sends `{type: "approve"}`;
  - the other sends `{type: "edit", edited_action: {name: "commit_plan", args: {pid, action, to_pid}}}`;
  - reject means "no orders, holding".
  
  `Panels.tsx` is untouched.
- **3D:** plain three.js (`MapControls`, fixed tilt), boxes or extruded footprints in flat colours by material, a hazard ring for unfinished retrofit orders, a dusk look, and one `InstancedMesh` horde.
- **HUD in the DOM, not WebGL:** the phase banner, the fortress card, a radio log, threat pips, HOLD / RUN and image insets. The footer reads "Game outcome, not an engineering assessment".
- **Reused:** the existing `CaseFile` for the dawn case file.

## How to

### Add a panel
1. Write a component in `web/src/components/` that takes `stream.messages` (or a parsed result) as props. Use `latestTool<T>(messages, "<tool>")` and add the result type to `web/src/lib/contracts.ts`.
2. Render it in the agent pane in `page.tsx`, and style it with classes in `page.module.css`.
3. Keep the wording hedged: show what each source says, never that a record or a person is wrong, and never a company name.

### Call a new agent-server route
1. Add the route on the Python side (see [BACKEND.md](BACKEND.md#add-an-http-route)).
2. Add its path regex to `ALLOWED` in `web/src/app/api/backend/[...path]/route.ts`.
3. Fetch it from the browser as `/api/backend/<path>`, never the agent server directly.

### Add a scene verb
1. Add it to `ORDER` and `SCENE_TOOLS` in `app/scene.py` and to `contracts/frontend_action.schema.json`.
2. Add it to the `Verb` type in `web/src/lib/contracts.ts`, and a `case` in `apply()` in `WorldPane.tsx`.
