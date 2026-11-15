# Bob's Shift

**A deep-agent game, built on real CoStar data, with real feedback enforcement.**

You're **Bob**, a building officer at the city of LA, on retrofit-deadline day. Real open cases from CoStar's queue land on your desk: buildings whose records disagree. Your analyst is an AI agent. It sends squads to pull each building's data, weighs the evidence in code, and sends you out on site visits into real downtown buildings. At **5:02 pm a simulated quake hits**. The agent screens each building and proposes a post-quake placard (green, yellow or red). **You post it.** At dawn a simulated aftershock tests your tags: the score is the **people you kept safe** and the **records you fixed**.

| The claim | What it means in the game |
|---|---|
| **Deep-agent game** | Bob's analyst is a LangChain **deepagents** agent (graph `desk`). It plans the shift, sends four squads in parallel (records, aerial, interior, city), picks its own evidence and says why, proposes each tag and **pauses for Bob's call** (a human-in-the-loop interrupt), then a second agent (the critic) reviews every draft correction at dawn |
| **Real CoStar data** | All 1,581 LA buildings in CoStar's kit, screened in code on the city map; CoStar's real open-case queue (328 cases; 156 in LA). Each building card lists every source on its own line (CoStar record, Vexcel aerial, Matterport 3D scan, LA retrofit lists, permits, the 1994 Northridge ShakeMap) and glows where two sources disagree |
| **Real feedback enforcement** | What Bob reports from a site visit is weighed as evidence: strong, **capped at 0.35**, never final. At 737 Broadway the report moves the walls from 66% to 73% concrete (with the 3D-scan read), which moves the screening, the proposed tag and the people at stake. At dawn the agent drafts a correction **citing Bob's words**, the critic reviews it, and "File" opens the real auditor case. Code sets every number; nothing changes a record without human approval |

**Track:** Entertainment. **Also:** CoStar "Inside and Out", LangChain "Best use of deepagents". Built at HackPrinceton Fall 2026.

> **For AI agents and new contributors:** this README is the full context. Read it top to bottom. The night game it replaced (**Last Stand LA**, zombies) is kept as the fallback: section A at the end, and `NEXT_PUBLIC_GAME_GRAPH=laststand`. Section 9 lists the rules you must follow before changing anything.

---

## B1. The shift (`/play?mode=foot`; `?demo=1` is the 2-minute stage cut)

| Time | What Bob does | What the agent does (graph `desk`) | What code computes |
|---|---|---|---|
| **9 am, the desk** (Tab) | Reads the inbox; picks a site visit; can **pre-call** a tag from the card and the aerial | `Start Bob's shift`: `inbox()` (the real queue), `building_card` for each case, its squads in parallel | Every card line, by source; the conflicts; people inside by day/night (IBC occupant loads × HAZUS time-of-day shares, shown as a range: an estimate) |
| **Site visit 1**: suite 1100, 122 7th St | Walks into the real suite (its Matterport tour), answers: empty / people working / can't tell | The suite check, then Bob's tip | The ghost-tenant case odds |
| **Site visit 2**: 737 Broadway | Walks in (its own 3D tour + the untextured scan), answers: concrete / brick / can't tell | `Inspect building 6375735`: open the case, choose checks (each with "why"), the aerial read by vision, the 3D-scan geometry, then Bob's tip | The walls odds: priors + each check's capped shift, ÷ total (66% → 73% concrete after the report + scan) |
| **5:02 pm, the simulated quake** | Day fades to night. Posts the tag: **1** green · **2** yellow · **3** red · N none | `Quake at 5:02 pm. Tag building 6375735`: `screen_building`, then `tag_building` (the interrupt: approve, change or reject) | A FEMA P-154-style screening score per material (weighted by today's odds), the chance of serious damage, people inside at 5 pm, and the tag the code suggests (shown beside the agent's proposal) |
| **Dawn** | Reads the shift report; files the drafts | `End the shift`: the critic reviews each case, `draft_correction` per case, `shift_report`, `log_shift` | A seeded aftershock from the building's own odds: damage state, the right tag, people safe / exposed / hurt / displaced, and what each tag would have done on average |

**Tags are simulated placards** (ATC-20 style: green = safe to occupy, yellow = limited entry, red = unsafe). Every tag, the quake and the aftershock say so: *game outcome, not an engineering assessment.*

**The judges' view of the agent:**
- **Tab:** Bob's desk: the inbox, live building cards (every line names its source), the city map (all LA, coloured by the code's triage; click any building for its card, Vexcel pulled live if not cached), the calculation sheet (the arithmetic for each verdict), the squad radio.
- **L:** the agent log beside the game; **`/play/log`** on a second screen follows the live shift, step by step: who acted, which data it pulled, and the maths.
- **Save and Continue:** the game saves after each report and at dawn; after a reload, "Continue" reattaches the same thread and never re-sends a message.

## B2. What changed from the night game (for agents picking this up)
- New graph `desk` (`app/desk_agent.py`) and code model (`app/desk.py`: card, screen, triage, tag, shift). Routes: `GET /desk/card/{pid}[?checks=&live=1]`, `/desk/screen/{pid}`, `/desk/triage[?scope=city]`; `POST /demo/reset` re-seeds the desk log too.
- Frontend (`web/src/game/`): `useGame.ts` talks to `desk` (`GAME_GRAPH`), sends the exact shift messages, handles the `tag_building` interrupt and reads `shift_report`. New: `foot/DeskView.tsx` (the desk), `foot/ShiftReport.tsx` (dawn), the day palette in `foot/world.ts` (`ctx.day`). The horde, flares, barricades and the crate hunt are off in the shift.
- Replay: strict replay keys on the exact messages above; the desk recordings live in `fixtures/replay/` next to the night game's (`app/replay.py` explains record / fill / strict).

---

# Appendix A. Last Stand LA (the night game, kept as the fallback)


**A deep-agent game, built on real CoStar data, with real feedback enforcement.**

You're the night shift for an AI auditor of CoStar's building records. It works CoStar's real queue of open cases, where a building's records disagree, and sends you into real downtown LA buildings to look. What you report is **enforced feedback**: it changes the AI's case, your survival, and a draft correction to a real record. Every number is set by code, and a human approves every change.

| The claim | What it means in the game |
|---|---|
| **Deep-agent game** | Your commander is a LangChain **deepagents** agent. It plans the night with its own todos, sends four sub-agents in parallel (records, aerial, interior, city), picks its own evidence and says why, pauses for your HOLD/RUN call, and drafts the corrections at dawn |
| **Real CoStar data** | 1,581 real LA buildings and their 156 open cases, from CoStar's kit (328 in the queue across LA and Houston). You walk on the Vexcel aerial and into the buildings' own Matterport 3D tours. The city's retrofit orders, permits and the 1994 Northridge ShakeMap are in play too |
| **Real feedback enforcement** | Your report from inside a building is weighed as evidence: strong, but **capped at 0.35**, so it moves the odds without ever deciding alone. On the demo night it **decides your survival**: a "concrete" report makes the walls hold, "brick" lets the horde in. At dawn the agent drafts a correction **citing your words**, and "File" opens the real auditor case with your report in it. Code sets every number; nothing changes a record without human approval |

**Track:** Entertainment. **Also:** CoStar "Inside and Out", LangChain "Best use of deepagents". Built at HackPrinceton Fall 2026.

> **For AI agents and new contributors:** this README is the full context. Read it top to bottom, then the linked docs. Section 9 lists the rules you must follow before changing anything.

---

## 0. Where the code is

| Branch | What | State (Sat Nov 14, afternoon) |
|---|---|---|
| `foot-lead` | **The game on foot** (everything below), merged from seven builder branches | Playable; the strict-replay runs and the 4:30 check are next |
| `game` | Backend (`app/fortress.py`, `app/game_agent.py`, `/game/*`), the earlier map mode (`/play`) | `foot-lead` merges into it after the check |
| `main` | The engine and the auditor app (`/`) | `game` merges into it after the check |
| tag `auditor-v1` | A frozen copy of the working auditor | The last-resort fallback |
| `agent-plus` | The teammate's deep-agent improvements ([docs/AGENT_IMPROVEMENT_PLAN.md](docs/AGENT_IMPROVEMENT_PLAN.md)) | **Merge cutoff 6:00 pm**, then everything is re-recorded |

Everything about the game is in **[docs/game/](docs/game/README.md)**:
- [DESIGN](docs/game/DESIGN.md), with the user's decision log;
- [AUDIT](docs/game/AUDIT.md), on why the game exists;
- [CONTRACT](docs/game/CONTRACT.md), with the exact agent messages;
- [CRITIQUE](docs/game/CRITIQUE.md);
- [DEMO](docs/game/DEMO.md), the 2-minute cut and judge Q&A;
- [BUILD_PLAN](docs/game/BUILD_PLAN.md).

---

## 1. The night (about 3 minutes; `/play?mode=foot`)

| Beat | You | The deep agent (graph `laststand`) | Code |
|---|---|---|---|
| **Briefing** | Press Start | `Brief the night shift`: it calls `night_cases()` (the open queue cases inside the play area) and `write_todos` (its plan). Tonight that's **#7** and **#6** of the 328-case queue (LA and Houston) | — |
| **Case #7** | Walk into **suite 1100** at 122 7th St (its real tour). Answer: is anyone working here? | `Check suite 1100 at building 254167: is the tenant on record still there?`: it opens the ghost-tenant case and **chooses** checks (listing timeline, lease terms, tenancy trail, the suite's tour), then weighs them. Your `Tip: I'm inside suite 1100. …` becomes a capped human report | Odds per hypothesis. The 3-person office on record comes with you only if the evidence leans "present" and you didn't report the suite empty |
| **The cross** | About 370 m through the horde to 737 Broadway (sprint never runs dry; the route is drawn) | — | Real streets: OSM outlines on the Vexcel mosaic |
| **Case #6, the fortress** | Walk into **737 Broadway's own tour**. Answer: concrete, brick or can't tell? | `Scout property 6375735`: four squads in parallel (records, aerial, interior, city), `open_case` (CoStar masonry vs the city's concrete list), its checks, including **a vision read of the aerial** (shown on screen), then `weigh_case`. Your tip is weighed in | **Walls** = the case's odds × wall strength per material |
| **Night** | The horde comes from the west. **HOLD** (defend the door: boards, shoves, flares, the flashlight stun) or **RUN** (about 290 m to the fallback) | `Wave 1 is coming from the W`: `horde_status`, `find_fallback`, then `commit_plan`, which **pauses for your decision** (approve or edit) | A seeded roll (seed 2026). **On the demo night your report decides HOLD:** "concrete" holds (the walls just beat the roll of 75), "brick" or "can't tell" break in; a different set of checks picked live can shift that. RUN holds. Then the aftershock roll |
| **Dawn** | Score and rank; **File tonight's reports → open the auditor** | `Debrief the night shift`: `draft_correction` for each case it worked, citing your report | The drafts are hedged; a person approves them |

- **2-minute stage cut** (`?demo=1`): right after the briefing the agent works case #7 from the records, while you go straight to case #6. [F] fast-forwards the walk, the defence and the escape. See [docs/game/DEMO.md](docs/game/DEMO.md).
- **Controls:** WASD and the mouse; Shift sprint; Space shove; G flare (3 per night); hold the flashlight on a zombie to stun it; E enter or nail boards; Q medkit; H/R decide; V mute.
- **No game over:** if you go down, your squad drags you clear (−100 points). Difficulty is forgiving.

---

## 2. The deep agent (the main character)

### 2.1 What it is
- **The framework:** a LangChain **`deepagents`** agent (`create_deep_agent`), served by `langgraph dev`.
- **Its parts:**
  - an orchestrator that **plans with todos**;
  - **four specialist subagents** run in parallel via `task`;
  - **evidence tools it chooses between**;
  - a **Store** for people's notes;
  - **human-in-the-loop interrupts**.
- **Rule: the agent makes the calls, code does the maths, the engine runs the night.** The model picks the cases, the evidence, what to ask you, HOLD or RUN, and the fallback, and it drafts the corrections. Odds, scores, rolls, routes and wave sizes are deterministic Python; the prompt forbids typing a number a tool didn't return.

### 2.2 Graphs (`langgraph.json`)

| Graph | Entry | Used by |
|---|---|---|
| **`laststand`** | `app/game_agent.py:game_agent` | The game: the night-shift commander |
| `radar` | `app/agent.py:live_agent` | The auditor app (`/`) |
| `radar_worker` | `app/agent.py:worker_agent` | The auditor's overnight sweep and the iMessage worker |

Custom routes (`/game/*`, `/cases/*`, `/evidence/*`, `/healthz`) live in `app/routes.py` on the same server.

### 2.3 The `laststand` tools
- **Game tools:**
  - `night_cases()`: the open queue cases inside the play area;
  - `fortress_dossier(pid)`: walls, quake, roof, people and space scores;
  - `horde_status(wave)`;
  - `find_fallback(pid, away_from?)`;
  - `commit_plan(pid, action, to_pid?)`: **interrupts** for approve or edit; its result is the seeded roll;
  - `draft_correction(pid, suite?)`.
- **Case engine tools:** `open_case`, `check_evidence`, `weigh_case`, `record_note`. Specialists: `records`, `aerial`, `interior` and `civic`, each with one tool and structured output.
- **Guards:**
  - every game tool refuses a pid outside the district;
  - the prompt pins the fortress to the thread's latest `Scout property <pid>`;
  - the game graph has its own backend, with no shared auditor memories;
  - hedged wording only ("the records disagree"); no company names.

### 2.4 The case engine (`app/evidence.py`, pure Python)

A case is a question with competing hypotheses and priors:
- **`material_conflict`:** concrete as the city lists it, 0.45; the material CoStar records, 0.35; a different structure, 0.20.
- **`ghost_tenant`:** still there, gone, subleasing, moved within, the listing is stale.
- **`stale_entry`.**

Each check returns `{finding, effects, why}`. `weigh_case` combines them into a posterior and a hedged verdict (likely, leaning or unresolved). Two caps apply:
- **vision effects are capped at 0.2** and need a skeptical **second look**;
- **a person's report is capped at 0.35:** strong, never final.

### 2.5 Vision, models, replay
- **Vision:** Gemini on Vertex AI reads the Vexcel oblique and top-down images and the Matterport suite faces. Answers are cached in `fixtures/vision/`.
- **Models:** Gemini 3.8 Flash orchestrates, with 3.5 Flash-Lite specialists. `ModelFallbackMiddleware` switches models after an 8 s stall.
- **Replay** (`app/replay.py`):
  - `RADAR_REPLAY=record:<name>`, `=<name>` and `=fill:<name>` (records misses only), plus `RADAR_REPLAY_STRICT=1` (no live calls; a miss is an error).
  - Keys are the system prompt, the latest human message and the tool results since.
  - **Any prompt or tool change means re-recording** (`scripts/game_nights.py`).
- More: [docs/AGENT.md](docs/AGENT.md), [docs/game/CONTRACT.md](docs/game/CONTRACT.md).

---

## 3. Real data → the game

| Source | In the game |
|---|---|
| **CoStar** | Material (wall strength), floors, people on record (wave sizes), the conflict at 737 Broadway, the 3-person office in suite 1100, **the 328-case queue (156 in LA) the agent briefs from** |
| **Vexcel** | The ground you walk on (an aerial mosaic at about 12 cm/px); **the aerial the agent reads** for 737 Broadway (it pops up as "HQ evidence · real image"); the roof score |
| **Matterport** | **737 Broadway's own tour** and **suite 1100's tour**: the rooms you walk into. The agent also reads suite 1100's tour (it pops up on screen) |
| **LA open data** | Seismic-retrofit orders (amber danger rings, the quake score, aftershock debris zones); permits as evidence |
| **USGS ShakeMap** | The 1994 Northridge shaking (MMI) per building: the aftershock strength |
| **OpenStreetMap** | About 190 surrounding buildings at real height (the LA County survey import) |

- **Game items, not data:** crates (boards, medkit), flares, zombies, fictional names.
- **The corner views are game camera renders, not live feeds.**
- **Licensed CoStar, Vexcel and Matterport data is never committed;** it is matched locally. Synthetic `TEST-*` fixtures and `?stub=1` run without it.

---

## 4. The auditor: where the agent's work lands (`/`)

The same agent, as **Retrofit Radar**, works the whole queue:
- an overnight sweep opens cases where CoStar disagrees with the city, the aerials or a suite tour: 273 ghost tenants, 37 material conflicts, 18 stale entries;
- it investigates each case, choosing evidence (including before/after aerials and car counts);
- it drafts corrections for a person to approve;
- it learns from texted corrections (iMessage via Photon).

The game's dawn deep link `/?check=<pid>&from=laststand` opens the case with your report in it.

**Verified numbers:** 226 LA kit buildings on a retrofit list; 61 unfinished (2,091 apartments); only 14 past a deadline; only 12 of 69 concrete-list matches recorded as concrete by CoStar; 328 open cases in the queue (156 in LA, 172 in Houston).

---

## 5. Frontend (`web/`, Next.js 16, React 19, three.js 0.187)

`web/src/game/foot/`:

| Owner | Files |
|---|---|
| Director (lead) | `FootGame.tsx` (the story steps, the agent calls through `useGame`, the HUD state) |
| Shared contract | `engine.ts` (ctx, the typed bus, constants), `collide.ts`, `input.ts` |
| A | `player*.ts`: survivor, camera, flashlight |
| B | `horde*.ts`, `feeds.ts`, `flare.ts`: zombies (flow fields, lure, stun), drone and camera views |
| C | `world*.ts`: aerial ground, OSM outlines, facades, lights, route A* |
| D | `IntroOverlay`, `InsideView`/`InsidePano`, `FootHud`, `DawnView`, `ui.tsx`, `foot.module.css` |
| E | `mission*.ts`: crates, the office escort, door defence, debris |
| F | `HqPanel`, `hqModel`, `hqDrafts`: the agent on screen (briefing, plan, squads, evidence, odds, drafts) |
| G | `audio*.ts`: procedural sound plus a spoken radio |

Systems never import each other; they share `ctx` and bus events. The earlier map mode is `/play`; the auditor is `/`. More: [docs/game/BUILD_PLAN.md](docs/game/BUILD_PLAN.md), [docs/FRONTEND.md](docs/FRONTEND.md).

---

## 6. Run it

```bash
uv sync && cp .env.example .env                 # keys only in .env
uv run pytest -q                                # offline tests
uv run python scripts/fetch_public.py           # LA lists, permits, ShakeMap (cached)
uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --no-reload --n-jobs-per-worker 4
cd web && npm install && npm run dev            # http://127.0.0.1:3000/play?mode=foot
```

**Modes:**
- `?mode=foot`: the live Night Shift.
- `&demo=1`: the 2-minute stage cut with [F] fast-forward.
- `&stub=1`: synthetic data, no backend.
- `&agent=off`: the real district with no agent calls (visual testing).

**Demo:**
- Start the server with `RADAR_REPLAY=game RADAR_REPLAY_STRICT=1` (never put `RADAR_REPLAY` in `.env`).
- Use `npm run build && npm start`.
- Between judges, press Enter at dawn (Play again resets and re-seeds) or run `uv run python scripts/demo_reset.py`. The server also resets tonight's cases at each briefing. One browser tab on the game.
- In git worktrees, run `next dev --webpack`.

---

## 7. Known limitations

- **Vision** is weak on fine detail; it is capped and double-checked.
- **Evidence weights** are hand-set; there is no evaluation set yet. See [AGENT_IMPROVEMENT_PLAN](docs/AGENT_IMPROVEMENT_PLAN.md).
- **One night, one district:** two cases have the imagery gathered.
- **Live odds vary** with the checks the agent chooses. Replay is deterministic.

---

## 8. Docs index

| Doc | For |
|---|---|
| [docs/game/](docs/game/README.md) | Everything about the game |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The system map |
| [docs/AGENT.md](docs/AGENT.md) | The deep agent in depth |
| [docs/AGENT_IMPROVEMENT_PLAN.md](docs/AGENT_IMPROVEMENT_PLAN.md) | Limitations and the improvement plan |
| [docs/BACKEND.md](docs/BACKEND.md) | Python, data, evidence engine, routes, Store, tests |
| [docs/FRONTEND.md](docs/FRONTEND.md) | The web app |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Vexcel, Matterport, the CoStar kit, LA open data, Photon |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Setup, tests, branch, commit and data rules |

---

## 9. Rules (people and AI agents)

1. **Secrets** live only in `.env`. Run `scripts/check_secrets.sh` before committing.
2. **Licensed data never enters git** (`fixtures/*/` except `TEST-*`). Never send kit data to outside services. Matterport is read-only.
3. **Numbers stay in Python;** add a tool rather than letting a prompt compute.
4. **The exact agent messages are a contract** ([CONTRACT.md](docs/game/CONTRACT.md)). Changing a prompt, a tool output or a message string means re-recording and strict replay ×3. After the 6:00 pm cutoff, no agent changes go into the demo build.
5. **Honesty:**
   - "the records disagree", never "wrong";
   - "unfinished" ≠ non-compliant;
   - no company names, and no street addresses in source code;
   - "Game outcome, not an engineering assessment" on screen;
   - never call the corner views "live".
6. **Git:**
   - work on a branch;
   - run `uv run pytest -q` and `cd web && npx tsc --noEmit && npx eslint src` before you push;
   - commit as the noreply identity with plain messages and no AI trailers;
   - ask before pushing shared branches.
7. **No paid services.**

## Team

[TEAM: names, Discord usernames]. Built at HackPrinceton Fall 2026.
