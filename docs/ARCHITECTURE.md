# Architecture

Retrofit Radar is an AI auditor for CoStar building records. A LangChain deep agent (Gemini on Vertex AI) opens a **case** wherever a CoStar record disagrees with LA's earthquake-retrofit lists, the Vexcel aerials or the Matterport interiors. It chooses the evidence checks, Python weighs them, and a draft correction waits for a person to approve it.

This engine is tagged **`auditor-v1`** and is the fallback demo. A game front end, **Last Stand LA**, is being built on top of it on the `game` branch (**in progress**; see [AGENT.md](AGENT.md#last-stand-la-in-progress) and [FRONTEND.md](FRONTEND.md#game-screen-play-in-progress)).

## System map

```
 Browser: web/ (Next.js + three.js, 127.0.0.1:3000)
   page.tsx ──── useStream(assistantId "radar"), a fresh thread per question ──┐
   WorldPane ◀── "custom" stream channel: frontend_action events ─────────────┤
   /api/ack ──── writes the browser's ack to Store ["acks"] ──────────────────┤
   /api/backend/* ── same-origin proxy to the custom routes (allowlist) ───────┤
   /api/approvals ── lists and resumes paused radar_worker threads ───────────┤
                                                                              ▼
 Agent server: langgraph dev (127.0.0.1:2024), configured by langgraph.json
   graphs   radar (live) · radar_worker (background) · laststand (PLANNED, game branch)
   agent    app/agent.py (models, specialists, middleware, approvals) · app/prompts.py
   tools    app/tools.py · app/scene.py (scene verbs for the 3D view)
   routes   app/routes.py (http.app): /healthz · /cases/* · /evidence/image/* · /field/*
   Store    notes · corrections · outbox · queue · acks · scene · field · memories · skills · properties
                                                                              │
 Pure Python: every number is computed here, never typed by the model         ▼
   app/evidence.py        cases, checks, weigh_case ◀── app/vision.py (two-pass reads, fixtures/vision/)
   app/retrofit_lists.py, app/quake.py ◀── fixtures/public/ (scripts/fetch_public.py)
   app/tenants.py, app/cases.py ◀── the CoStar kit (COSTAR_KIT_DIR, outside the repo)
   app/layers.py ◀── app/costar.py · app/vexcel.py · app/matterport.py (cached under fixtures/, gitignored)
   app/replay.py          wraps the chat models when RADAR_REPLAY is set (fixtures/replay/)

 Side channels
   photon/ bridge (127.0.0.1:8787) ⇄ iMessage: texts start radar_worker runs; YES / NO resumes approvals
   app/photon.py ── notify_me ──▶ bridge POST /send
   scripts/heartbeat.py (cron or a manual tick) ── "OVERNIGHT SWEEP" ──▶ radar_worker
   scripts/quake_alert.py ──▶ bridge POST /trigger ──▶ radar_worker (labeled Northridge replay)
```

## How the parts connect

1. **A question** typed in the web app streams a `radar` run. The agent writes a todo list, fans out to four specialists in parallel, opens a case, runs the checks it picks, and calls `weigh_case`.
2. **The 3D view** follows the agent: scene verbs (`app/scene.py`) emit `frontend_action` events on the `custom` stream channel. The browser draws each one and posts an ack back through `/api/ack` into the Store.
3. **The numbers** come from Python. `weigh_case` re-runs the named checks itself and returns the posterior, a verdict label (*likely*, *leaning* or *unresolved*) and an optional draft correction. The model reports these numbers; it never computes them.
4. **Approvals** are human-in-the-loop interrupts (`interrupt_on` in `app/agent.py`). Nothing is sent to CoStar, the city or an owner; approved drafts are only recorded in the Store.
5. **In the background**, `radar_worker` runs the overnight sweep (case of the day), handles texts from the iMessage bridge, and waits at approvals that the web Inbox or a YES / NO text resumes.
6. **Offline fallback:** with `RADAR_REPLAY` set, the chat models answer from a recording, while the tools, data, images and 3D view stay real. The UI and texts label it as a replay.

## Part docs

| Doc | Covers |
|---|---|
| [AGENT.md](AGENT.md) | The deep agent: graphs, prompts, specialists, the live turn structure, the case flow, approvals, memory, models and fallbacks, replay, tracing |
| [BACKEND.md](BACKEND.md) | Python and data: data layers and cache modes, public data, the evidence engine, vision, tenants, the case queue, HTTP routes, Store namespaces, scripts, tests |
| [FRONTEND.md](FRONTEND.md) | The web app: page map, `useStream`, the proxy and approvals routes, styles, the REPLAY badge, the game screen (in progress) |
| [INTEGRATIONS.md](INTEGRATIONS.md) | The iMessage bridge, Vexcel, Matterport, the CoStar kit, LA open data and USGS, models and tracing (env var names only) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Setup, tests, branch and commit rules, data rules, troubleshooting |
| [ENGINEERING.md](ENGINEERING.md) | Current engineering notes, verified numbers, review log |
| [../contracts/README.md](../contracts/README.md) | Messages that cross a process boundary, HTTP routes, Store namespaces, the game contract |
