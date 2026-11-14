# Last Stand LA

**"The zombies are fake. The weak spots are real."**

Last Stand LA is a zombie-survival night set on real downtown Los Angeles buildings. You pick a building to make your fortress. An AI squad commander (a LangChain **deep agent**) then scouts it from four real sources: the CoStar building record, the city's earthquake-retrofit orders, Vexcel aerial imagery and Matterport interior tours. Code scores your fortress from what the squads find.

Sometimes the sources disagree. CoStar may record masonry while the city lists the building as non-ductile concrete. Then your walls are a gamble, and the agent has to investigate which source is right before the horde arrives. At dawn, that investigation becomes a draft correction for a person to approve.

Built at HackPrinceton Fall 2026 (Nov 13-15).

> **For AI agents and new contributors:** this README is the full context. Read it top to bottom, then follow the links to `docs/` for detail. Section 10 lists the rules you must follow before changing anything.

---

## 0. Where the code is (read this first)

| Branch / tag | Contents | State (Sat Nov 14, afternoon) |
|---|---|---|
| **`game`** | **Last Stand LA**: everything this README describes (`app/fortress.py`, `app/game_agent.py`, `/game/*` routes, `web/src/game/*`, `/play`) | Built; the end-to-end gate (three clean runs) is in progress. Merged into `main` once it passes |
| `main` | The engine and docs. The engine started as **Retrofit Radar**, an auditor for building records, and still ships that app at `/` | Working and tested |
| tag `auditor-v1` | A frozen copy of the working auditor | The demo fallback: `git checkout auditor-v1` |
| `agent-plus` (to create) | Improvements to the agent's reasoning and vision | See [docs/AGENT_IMPROVEMENT_PLAN.md](docs/AGENT_IMPROVEMENT_PLAN.md) |

**Until `game` is merged, check out `game` to see the game code:** `git fetch && git checkout game`. The engine (agent, evidence, data layers, replay) is the same on both branches.

---

## 1. The game in two minutes

| Phase | What the player sees | What happens underneath |
|---|---|---|
| **Dusk** | A 3D district at dusk: 62 real buildings within 900 m, coloured by the material CoStar records. 11 have a **record conflict** (CoStar's material vs the city's concrete list). Buildings with an unfinished retrofit order get a pulsing ground ring | `GET /game/district`, precomputed at server start |
| **Pick** | Click a building; its **fortress card** appears in under a second, with walls, quake, roof, people and space scores, each with a reason and a source | `GET /game/dossier/{pid}`, computed in Python, not by the model |
| **Scout** | Radio chatter as four squads report in parallel. If the records conflict, the agent opens a case, chooses its checks (including a **vision look** at the aerial) and the wall odds settle live | Run 1 on the `laststand` graph: `"Scout property <pid>"` |
| **Night** | A wave arrives from a compass side. The agent proposes **HOLD** or **RUN** (to a fallback building). The player approves or switches | Run 2: `"Wave <n> is coming from the <sector>"`, then `horde_status`, `find_fallback` and `commit_plan`, which pauses for a human decision |
| **Aftershock** | The wave hits, then an aftershock sized by the **1994 Northridge** shaking at that block. Walls held or not | Seeded rolls in Python against the walls and quake scores (`POST /game/resolve` shape) |
| **Tip** | The player types a tip, for example "the walls are poured concrete" | Run 3: `"Tip: <text>"`, then `record_note` and `weigh_case` with `human_report`. The odds move, but a tip is capped and never decides alone |
| **Dawn** | The case file: hypotheses, evidence, confidence, and a **draft correction** for a CoStar researcher to approve | The same case engine as the auditor |

Every outcome is labelled **"Game outcome, not an engineering assessment."**

**The demo night** (seed `1990`): property `6375735` is the hero. CoStar records it as masonry, the city lists it as non-ductile concrete with the retrofit unfinished, and a vision read sees an exposed concrete frame. Holding it on wave 1 loses; running to the fallback survives. `254167` is the safe room, with a cached Matterport panorama for "step inside". `52227` is the honest "unresolved gamble", where the vision read can't tell. `256390` is drawn as a plain box, never extruded, because its Vexcel outline is probably a different structure.

---

## 2. The deep agent (the brain)

### 2.1 What it is

- **A LangChain `deepagents` agent** (`create_deep_agent`), served by `langgraph dev` as the agent server.
- **Its parts:**
  - an orchestrator that plans with **todos**;
  - **four specialist subagents** that run in parallel through the `task` tool;
  - **evidence tools** that it chooses between;
  - a **Store** for team notes;
  - **human-in-the-loop interrupts**.
- **The core rule: code holds every number; the model holds the judgment.**
  - The model chooses which evidence to pull, reads the images, decides whether to hold or run, and explains in radio lines.
  - Scores, probabilities, wave sizes and dice rolls are deterministic Python.
  - The prompt forbids the model from typing a number a tool didn't return.

### 2.2 Graphs (`langgraph.json`)

| Graph | Entry | Used by |
|---|---|---|
| **`laststand`** | `app/game_agent.py:game_agent` | **The game.** The squad commander |
| `radar` | `app/agent.py:live_agent` | The auditor app's live questions (`/`) |
| `radar_worker` | `app/agent.py:worker_agent` | The auditor's overnight sweep and the iMessage worker |

Custom HTTP routes (`/game/*`, `/evidence/*`, `/healthz` and others) are in `app/routes.py`, mounted on the same server.

### 2.3 The `laststand` graph (`app/game_agent.py`)

```
"Scout property <pid>" ─▶ write_todos + task×4 (records · aerial · interior · civic) + fortress_dossier + open_case   (one message, parallel)
                         └─ if material_conflict ─▶ check_evidence(look_from_above, compliance_filings, …) ─▶ weigh_case ─▶ ≤5 radio lines
"Wave <n> is coming…"  ─▶ horde_status(n) + find_fallback(pid, away_from=sector) ─▶ commit_plan(pid, "hold"|"run", to_pid)
                         └─ INTERRUPT: player approves / edits (switches HOLD↔RUN) / rejects ("No orders. Holding.")
                         └─ resumed ─▶ fortress.resolve(...) (seeded rolls) ─▶ 2 radio lines from its `why`
"Tip: <text>"          ─▶ record_note(pid, note, source="the player", supports=<hypothesis>) ─▶ weigh_case(+human_report) ─▶ 2 lines
```

- **The game tools:**
  - `fortress_dossier(pid)`: the fortress card.
  - `horde_status(wave)` → `{wave, sector, eta_band, size_band}`.
  - `find_fallback(pid, away_from?)` → `{from_pid, to_pid, to_label, distance_band, reason}`.
  - `commit_plan(pid, action, to_pid?)`: gated by `interrupt_on` (approve / edit / reject). Its tool result **is** the resolve object, so the outcome lands in the trace.
- **Engine tools it reuses:** `open_case`, `check_evidence`, `weigh_case`, `record_note`.
- **Specialists** (shared with the auditor, `app/agent.py:_specialists`). Each has one tool and returns structured output:
  - `records` reads the CoStar record (type, area, stories, year built, roof renovations, tenancy).
  - `aerial` reads Vexcel attributes (footprint, height, roof shape and material, rooftop equipment).
  - `interior` reads the Matterport twin (levels, below-entrance levels, floor height).
  - `civic` reads LA's retrofit records (which list, order date, step deadlines with extensions, overdue steps, permits, conflicts with CoStar's material).
  - A tool-less `general-purpose` explainer replaces the default one, so no subagent inherits the approval-gated tools.
- **The prompt's rules:**
  - Name buildings by their address label, never by property id.
  - Say hypotheses in words, never as keys.
  - Never name a company.
  - Never say a record or owner is wrong; say the records disagree and which way the evidence leans.
  - Say "not in the data" for stairs, exits, supplies and parking.
- **One thread per night.** The web page keeps the thread; "play again" starts a fresh one.

### 2.4 The case engine (`app/evidence.py`, pure Python)

A **case** is a question with competing hypotheses and priors. The game mainly uses `material_conflict`:

| Hypothesis | Prior | Walls if true |
|---|---|---|
| `city_list_current`: it's concrete; CoStar's material is out of date | 0.45 | concrete, 85 |
| `costar_current`: it's what CoStar records; the list entry is a screening false positive | 0.35 | CoStar's material |
| `different_structure`: the two sources describe different structures at the address | 0.20 | unknown, 45 |

- **Checks the agent can choose:**
  - `compliance_filings`, `permit_text`, `replacement_permits`, `era_and_height`, `site_structures`;
  - `look_from_above` (vision);
  - `compare_captures` (vision, oldest vs newest aerial);
  - `human_report` (a person's tip).
- **How a check works:** each returns `{finding, effects:[{hypothesis, delta}], why}`. `weigh_case` combines them into a posterior and a hedged verdict: `likely`, `leaning` or `unresolved`.
- **Caps:** vision effects are capped at **0.2** and need a skeptical **second look** before they count; "can't tell" is a valid answer. A human report is capped at **0.35**: strong testimony, but never final.
- **In the game,** the **walls score is the posterior-weighted average** of the wall values. A conflict therefore literally makes your walls a gamble, and each check the agent runs moves the odds.
- **Other case types** (auditor side, same engine): `stale_entry` (the list names a building that was replaced) and `ghost_tenant` (CoStar records a tenant in a suite that's listed for lease).
- Details: [docs/AGENT.md § The case flow](docs/AGENT.md) and [docs/BACKEND.md](docs/BACKEND.md).

### 2.5 Vision (`app/vision.py`)

- The agent looks at **Vexcel oblique and top-down images** (and, on the auditor side, Matterport panoramas).
- **Two passes:** an independent skeptical second look must confirm before the effect counts.
- **Models:**
  - Gemini on Vertex AI by default.
  - `RADAR_VISION_MODEL=claude-opus-5-5` switches to Claude on Vertex. It is enabled, but our quota is currently 0 (calls return 429) and there is no automatic fallback, so leave it unset for now.
- Answers are cached in `fixtures/vision/`, so a demo never re-asks.
- **Known weakness:** fine-detail reads are unreliable. A tuck-under-parking test found 1 of 5, plus a false positive. That is why vision is capped and why the plan to improve it is in [docs/AGENT_IMPROVEMENT_PLAN.md](docs/AGENT_IMPROVEMENT_PLAN.md).

### 2.6 Models and speed

- The orchestrator is **Gemini 3.8 Flash**; the specialists are **Gemini 3.5 Flash-Lite**, both on Vertex AI.
- `ModelFallbackMiddleware` switches to a faster model after an **8 s** stall.
- **Measured live:**
  - scout about 18 s;
  - wave to HOLD/RUN prompt about 4 s;
  - resume after the decision about 2 s;
  - a tip about 5 s (the hero's odds go 0.66 → 0.72).

### 2.7 Replay (offline fallback, `app/replay.py`)

- **Record a good night:** `RADAR_REPLAY=record:game`.
- **Play it back:** `RADAR_REPLAY=game`. Add `RADAR_REPLAY_STRICT=1` to forbid any live model or vision call; a cache miss is an error, not a silent live call.
- Replay keys are the prompt, the question, the turn and the tool outputs. **Any change to a prompt or a tool output means re-recording.**
- When replay is on, the UI shows a REPLAY badge and only offers the recorded tip.
- Replay files live in `fixtures/replay/` and are **not committed**, because they contain licensed data.

More: [docs/AGENT.md](docs/AGENT.md) covers graphs, tools per graph, middleware, prompts, turn structure, approvals, memory, models, replay and tracing.

---

## 3. Fortress scores and the night (`app/fortress.py`)

All scores run from 5 to 95 and come with `{value, label, why, source}`.

| Score | Computed from |
|---|---|
| **walls** | CoStar's material (concrete 85, steel 70, masonry 60, wood 30, unknown 45). With a material conflict, it's the case posterior averaged over the hypotheses (above) |
| **quake** | The city's retrofit order (listed and unfinished = weak; finished = better) and the felt **MMI** at the site in the 1994 Northridge ShakeMap |
| **roof** | Vexcel roof shape and objects; skylights are ways in |
| **people** | Employees CoStar records in the building, or apartments |
| **space** | CoStar gross area and floors |

- **District:**
  - center property `254167`, radius 900 m;
  - heroes `6375735`, `254167`, `52227`;
  - real Vexcel outlines for 11 buildings, boxes for the rest;
  - 3.8 m per floor.
- **Waves** (a fixed script; sizes scale with the district's real apartment count):
  - wave 1 from the W at 20 s (290);
  - wave 2 from the N at 45 s (500);
  - wave 3 from the E at 70 s (790).
- **Resolve** is a seeded roll (`Random("seed:wave:pid:action")`). The same inputs always give the same night:
  - the walls hold if `roll ≤ walls − 10 if you ran`;
  - the building rides out the aftershock if `roll ≤ quake + 40`.
- **Cached data only:** the game reads cached Vexcel files and never fetches live data while someone is playing. The district and every fortress card are precomputed at server start.

### HTTP contract (v1.1, frozen)

```
GET  /game/district        → {center, radius_m, seed, buildings:[{pid, label, x, z, footprint|null, w, d, height_m, stories,
                               material, list, unfinished, past_due, mmi, hero, year_built?, people?, conflict?}], waves:[{n, sector, arrive_s, size}]}
GET  /game/dossier/{pid}   → {pid, label, scores:{walls|quake|roof|people|space}, unknowns, images:{drone, cctv, pano?}, case|null, disclaimer}
POST /game/resolve         {pid, wave, seed, action:"hold"|"run", to_pid?, checks} → {held, walls, quake, walls_roll, quake_roll, why, pid_final}
```

Footprints are relative to the building's own `x, z` (in metres east and south of the center). Images are served by `/evidence/image/{name}`. The full contract is in [contracts/README.md](contracts/README.md).

---

## 4. Frontend (`web/`, route `/play`)

- **Stack:**
  - **Next.js 16**, **React 19** and TypeScript;
  - **three.js 0.187** (WebGL) for the 3D;
  - **`@langchain/react` `useStream`** for the live agent stream (graph `laststand`).
- **Files:**
  - `web/src/app/play/page.tsx`: the page.
  - `web/src/game/useGame.ts`: the state machine (dusk → scout → night → aftershock → dawn) and data loading.
  - `District3D.tsx`: buildings (extruded outlines or boxes), material colours, hazard rings, the route line and the camera (MapControls, fixed tilt).
  - `Horde.ts`: one `InstancedMesh` horde, walking straight lines from the wave's side. It is deterministic, with no pathfinding.
  - `Hud.tsx`: everything on screen is DOM, not WebGL. It holds the fortress card, radio log, threat pips, HOLD/RUN, drone and CCTV feeds, the tip row and the disclaimer.
  - `Pano.tsx`: the Matterport cube-face panorama ("step inside").
  - `radio.ts`: turns tool calls and results into radio lines, without pids or hypothesis keys.
  - `stubAgent.ts`, `stub/*.json`: a **synthetic** stand-in. `/play?stub=1` runs the whole loop with no backend and no licensed data.
  - `web/src/app/api/game/[...path]/route.ts`: a same-origin proxy that allows only the three game routes.
- **HOLD/RUN:** the button matching the agent's proposal sends `{type:"approve"}`. The other button sends `{type:"edit", edited_action:{name:"commit_plan", args:{pid, action, to_pid}}}`.
- More: [docs/FRONTEND.md](docs/FRONTEND.md).

---

## 5. Data

| Source | What the game uses | Notes |
|---|---|---|
| **CoStar hackathon kit** | Material, year built, stories, area, tenants and employee counts, address labels | **Licensed; never committed.** Matched only on the machine running the agent |
| **Vexcel API** | Building outlines, height, roof shape and objects, oblique and top-down images, capture history | Licensed; cached locally in `fixtures/vexcel/` |
| **Matterport Model API** | Levels and 360° panoramas (the safe room) | Team token, **read-only** queries only |
| **LA open data** | Soft-story and non-ductile concrete retrofit lists, retrofit, demolition and new-building permits | Free; `scripts/fetch_public.py` |
| **USGS ShakeMap** | 1994 Northridge shaking (MMI) at each building | Free; a labeled historical replay, not live |

Only synthetic `TEST-*` fixtures are in the repo, so tests run without the licensed data. More: [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

---

## 6. Honesty rules (product rules, enforced in prompts and UI)

- **Labels:** every outcome is a **game outcome, not an engineering assessment**. The zombies are fake; the data is real.
- **Records:** never say a record or an owner is wrong. Say the records **disagree** and which way the evidence **leans**.
- **Retrofit orders:** "unfinished" is not non-compliance. Most orders are on schedule (only 1 of the 9 unfinished orders in the district is past a deadline). Say "overdue" only when the city's step is overdue.
- **No company names.** Say "a 50-person office".
- **No claims without data** about stairs, exits, supplies, parking, tuck-under parking or a helipad.
- **Vision:** it is capped evidence, never a verdict.
- **Addresses:** street addresses appear in the UI from the kit at runtime. Don't put them in screenshots or the video until CoStar confirms that's OK.

---

## 7. Repo map

```
app/
  game_agent.py     laststand graph: game tools, GAME_PROMPT, interrupt on commit_plan, startup warm-up
  fortress.py       district, fortress scores, waves, find_fallback, seeded resolve
  agent.py          models, specialists, middleware, the radar / radar_worker graphs
  evidence.py       cases, checks, caps, weigh_case (pure Python)
  tools.py          open_case / check_evidence / weigh_case / record_note and the auditor's tools
  vision.py         two-pass vision reads (Gemini or Claude on Vertex), cached
  replay.py         record / replay / strict replay of model calls
  routes.py         /game/*, /evidence/*, /healthz and the auditor's routes
  costar.py vexcel.py matterport.py retrofit_lists.py quake.py tenants.py   data layers
  prompts.py        specialist and auditor prompts
web/src/game/       the game UI (see §4);  web/src/app/play/  the /play page
web/src/            the auditor UI at /
scripts/            demo_reset.py, demo_flow.py, fetch_public.py, quake_alert.py, check_secrets.sh, …
seed/               standing orders (memories/AGENTS.md) and skills loaded into the agent
photon/             iMessage bridge (Photon Spectrum, TypeScript)
contracts/          API and message contracts
tests/              offline pytest suite (150 tests on game), including tests/test_fortress.py
docs/               detailed docs (index in §11)
archive/            retired code, kept for reference
```

---

## 8. Run it

```bash
uv sync                                         # Python 3.11+
cp .env.example .env                            # fill in keys; never commit .env
uv run pytest -q                                # offline tests, no network
uv run python scripts/fetch_public.py           # LA lists, permits, ShakeMap → fixtures/public (cached)
uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --n-jobs-per-worker 4
cd web && npm install && npm run dev            # http://127.0.0.1:3000/play
```

- **No licensed data or keys?** Open **`http://127.0.0.1:3000/play?stub=1`**. It uses synthetic buildings and a timer-driven agent, and runs the whole loop with no backend.
- **Between demos:** run `uv run python scripts/demo_reset.py`. It clears team notes, decisions and paused game nights; evidence caches are kept.
- **Offline demo:**
  1. Start the server with `RADAR_REPLAY=game RADAR_REPLAY_STRICT=1`.
  2. Check that `/healthz` shows `"replay"`.
  3. Use the recorded tip chip.
- **Ports:** the agent server is 2024 and the web app is 3000. Both bind to 127.0.0.1 only. The web app reads `LANGGRAPH_URL` (server side) and `NEXT_PUBLIC_LANGGRAPH_URL` (browser).
- **Traces:** set the LangSmith env vars in `.env`.
- More setup and troubleshooting (port conflicts, Vertex 429s, replay misses, `tsc` route types): [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

---

## 9. Known limitations (and where to help)

- **Vision is weak on fine detail.** It reads big things (a concrete frame, a replaced roof) but not small ones, which is why it is capped and double-checked.
- **Evidence weights are hand-set, not calibrated.** There is no labeled evaluation set yet.
- **The model sometimes stalls or skips a check** on Vertex. The fallback model and the prompt's "one message, all in parallel" structure are what keep runs fast.
- **Claude on Vertex has no quota yet,** so vision runs on Gemini.
- **The district is one 900 m circle, and three heroes are hand-verified.** Other buildings are scored, but nobody has checked them by hand.

The full list, with workstreams (an evaluation set, vision v2, weight calibration, reasoning and reliability) and what is safe to change before and after the demo freeze, is in **[docs/AGENT_IMPROVEMENT_PLAN.md](docs/AGENT_IMPROVEMENT_PLAN.md)**. Start there if you are improving the agent.

---

## 10. Rules for anyone changing this repo (people and AI agents)

1. **Secrets:**
   - Keys live only in `.env`. Never put them in code, commits, docs, screenshots or logs.
   - Run `scripts/check_secrets.sh` before committing.
2. **Licensed data never enters git.** That covers CoStar, Vexcel and Matterport data, and anything in `fixtures/*/` except the `TEST-*` files. Don't send kit data to outside services.
3. **Matterport is read-only.** Never call a mutation.
4. **Numbers stay in Python.** Don't let a prompt compute, round or invent a score, probability or roll. Add a tool instead.
5. **Changing a prompt or a tool's output breaks replay keys.**
   - Re-record (`RADAR_REPLAY=record:game`).
   - Re-run strict replay three times.
6. **Don't edit the `radar` or `radar_worker` graphs** for game work. `app/game_agent.py` reuses their pieces.
7. **Keep the honesty rules (§6)** in every new prompt line, UI string and doc.
8. **Git:**
   - Work on a branch, never directly on `main`.
   - Run `uv run pytest -q`, `cd web && npx tsc --noEmit && npm run lint` before you push.
   - Commit messages are plain English, with no AI co-author trailers.
   - Ask the team before pushing to a shared branch.
   - Full rules: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md#branch-rules).
9. **No paid services.** Use the existing Vertex project and free public data.

---

## 11. Docs index

| Doc | Read it for |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The system map and how the parts connect |
| [docs/AGENT.md](docs/AGENT.md) | The deep agent in depth: graphs, tools per graph, middleware, specialists, prompts, turn structure, case flow, approvals, memory, models, replay, tracing, and how to add a tool or specialist |
| [docs/AGENT_IMPROVEMENT_PLAN.md](docs/AGENT_IMPROVEMENT_PLAN.md) | Known limitations and the improvement plan (Plan B) |
| [docs/BACKEND.md](docs/BACKEND.md) | Python and data: data layers, the evidence engine, vision, routes, the Store, scripts, tests |
| [docs/FRONTEND.md](docs/FRONTEND.md) | The web app (the auditor at `/`, the game at `/play`) |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Vexcel, Matterport, the CoStar kit, LA open data, iMessage (Photon) |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Setup, tests, demo helpers, branch, commit and data rules, troubleshooting |
| [contracts/README.md](contracts/README.md) | API and message contracts, including the game contract v1.1 |

### The engine's other front end: the auditor (`/`)

The same agent also runs as **Retrofit Radar**, an auditor for CoStar's records:
- An overnight sweep opens cases where CoStar disagrees with the city, the aerials or a suite tour.
- The agent investigates each case and drafts corrections for approval.
- Approvals can come by text over iMessage.

This is the demo fallback (tag `auditor-v1`). Its details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/FRONTEND.md](docs/FRONTEND.md).

## Team

[TEAM: names, Discord usernames]. Built at HackPrinceton Fall 2026 (Nov 13-15).
