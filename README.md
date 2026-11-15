# Last Stand LA

**A deep-agent game, built on real CoStar data, with real feedback enforcement.**

You're **Bob**, a building officer at the city of LA, for **four days**. Each day is a different real downtown building whose records disagree. Real open cases from CoStar's queue land on your desk. Your analyst is an AI agent: it sends squads to pull each building's data, weighs the evidence in code, and sends you on site visits into the real buildings. At **5:02 pm a simulated quake hits**. The agent screens the building and proposes a post-quake placard (green, yellow or red), then **waits for your call**. On Day 1 a simulated aftershock tests your tag at dawn; on Days 2 to 4, dawn grades it in code on the building's own odds. Then **Next day**: the agent opens the morning with what you corrected yesterday. After Day 4, a **career summary**.

| The claim | What it means in the game |
|---|---|
| **Deep-agent game** | Bob's analyst is a LangChain **deepagents** agent (graph `desk`). It plans the day with todos, sends four squads in parallel (records, aerial, interior, city), picks its own evidence and says why, proposes each tag and **pauses for Bob's call** (a human-in-the-loop interrupt). A second agent (the critic) reviews every draft correction at dawn |
| **Real CoStar data** | All 1,581 LA buildings in CoStar's kit, screened in code on the city map, and CoStar's real open-case queue (328 cases, 156 in LA). Each building card lists every source on its own line (CoStar record, Vexcel aerial, Matterport 3D scan, LA retrofit lists, county assessor, permits, the 1994 Northridge ShakeMap) and glows where two sources disagree |
| **Real feedback enforcement** | What Bob reports from inside a building is weighed as evidence: strong, **capped at 0.35**, never final. At 737 Broadway the report moves the walls from 66% to 73% concrete, which moves the screening, the proposed tag and the people at stake. At dawn the agent drafts a correction **citing Bob's words**, the critic reviews it, and "File the reports" opens the auditor case. Code sets every number; nothing changes a record without a person's approval |

**The human-feedback loop.** Bob's approve or override is graded at dawn. The decision and its outcome go into the shift log, and the next morning's first line names the correction. Every placard decision and every 👍/👎 is also saved as preference data in the RLHF/DPO format (JSONL export). **No weights are trained:** the agent learns in context, from its log.

**Track:** Entertainment. **Also:** CoStar "Inside and Out", LangChain "Best use of deepagents". Built at HackPrinceton Fall 2026.

New to the game? Read **[docs/game/HOW_TO_PLAY.md](docs/game/HOW_TO_PLAY.md)** (one page).

---

## 1. A day (`/play?mode=foot`)

| Time | What Bob does | What the agent does (graph `desk`) | What code computes |
|---|---|---|---|
| **9 am, the desk** (Tab) | Hears the agent's lesson from the last shift; reads the inbox; can **pre-call** a tag from a card; rates findings 👍/👎 | `Start Bob's shift` (`, day k` on later days): `inbox()`, `building_card` per case, squads in parallel | Every card line by source; the conflicts; people inside by time of day (IBC occupant loads × HAZUS time-of-day shares, shown as a range) |
| **Site visit 1:** the office suite | Walks into the real suite (its Matterport tour): empty, people working, or can't tell. If the tenant is still there, leads the workers out | The suite check, then Bob's tip | The ghost-tenant case odds |
| **Site visit 2:** the day's building | Walks in (its own 3D tour): concrete, brick or can't tell | `Inspect building <pid>`: opens the case, chooses checks (each with a "why"), reads the aerial by vision, then Bob's tip | The walls odds: priors plus each check's capped shift |
| **5:02 pm, the simulated quake** | Day turns to night; people run, cars stop. Posts the tag: **1** green · **2** yellow · **3** red · **N** none. **Day 1 only:** a 60 s aftershock clock and two people trapped at the door to lead to the assembly point | `Quake at 5:02 pm. Tag building <pid>`: `screen_building`, then `tag_building` (the interrupt: approve, change or reject) | A FEMA P-154-style screening score per material, the chance of serious damage (HAZUS), people inside at 5 pm, and the tag the code suggests (shown beside the agent's proposal) |
| **Dawn** | Reads the shift report and **Agent vs Bob**; rates drafts; files them; **Next day** or **New game** | `End the shift`: the critic reviews each case, `draft_correction`, `shift_report`, `log_shift` | Day 1: a seeded aftershock from the building's own odds (damage, the right tag, people safe / exposed / hurt). Days 2 to 4: the expected outcome of Bob's tag and whether it matches the code |

| Day | Building (office suite) | Records disagree on | People at stake | Dawn |
|---|---|---|---|---|
| 1 | 737 Broadway (suite 1100, 122 7th St) | Masonry on the CoStar record vs concrete on the city's list | 251 | Simulated aftershock |
| 2 | 730 Los Angeles St (suite 404, 724 Spring St) | Masonry vs concrete | 201 | Expected outcome |
| 3 | 620 Main St (suite 1400, 122 7th St) | Masonry vs concrete | 40 | Expected outcome |
| 4 | 621 Spring St (a suite at 724 Spring St) | Steel vs concrete | 106 | Expected outcome |

**Every day:** the desk, the office case and escort, the side missions (other buildings' doors, "same building?", solar roofs), Agent vs Bob, feedback. **The career summary** after Day 4: people kept safe, tags right, records fixed, rescues, points, and the Agent vs Bob record, one line per day.

**Tags are simulated placards** (ATC-20 style: green = safe to occupy, yellow = limited entry, red = unsafe). The quake, the aftershock and every tag say so on screen: *game outcome, not an engineering assessment.*

**What judges can watch:**
- **Tab:** Bob's desk: the inbox, live building cards (every line names its source), the city map (all of LA, coloured by the code's triage), the calculation sheet (the arithmetic behind each verdict), the squad radio.
- **L**, or **`/play/log`** on a second screen: the agent's log, step by step (who acted, which data it pulled, the maths).
- **Save and Continue:** a reload reattaches the same thread and never re-sends a message.
- **Feedback export:** "Download feedback (JSONL)" in the pause menu and on `/play/log`. Collected only.

---

## 2. The deep agent

- **Framework:** LangChain **`deepagents`** (`create_deep_agent`), served by `langgraph dev`. An orchestrator that plans with todos, four specialist subagents run in parallel via `task`, evidence tools it chooses between, a Store for notes and the shift log, and human-in-the-loop interrupts.
- **Rule: the agent makes the calls, code does the maths.** Odds, screening scores, damage, people counts and the aftershock are deterministic Python. The prompt forbids typing a number a tool didn't return.
- **Case engine** (`app/evidence.py`): a case is a question with competing hypotheses and priors (`material_conflict`, `ghost_tenant`, `stale_entry`). Each check returns `{finding, effects, why}`; `weigh_case` combines them. Vision effects are capped at 0.2 with a skeptical second look; a person's report is capped at 0.35.
- **Screening** (`app/desk.py`): FEMA P-154 basic scores, HAZUS fragility curves at the 1994 Northridge shaking, IBC 2021 occupant loads, HAZUS time-of-day occupancy, ATC-20 placards, the ATC-138 yellow threshold.
- **Models:** Gemini Flash on Vertex AI orchestrates, with Flash-Lite specialists and a model fallback on stalls. Vision reads Vexcel aerials and Matterport faces.
- **Replay** (`app/replay.py`): `RADAR_REPLAY=record:<name>`, `=<name>`, `=fill:<name>`, plus `RADAR_REPLAY_STRICT=1` (a miss is an error, never a live call). Keys are the system prompt, the latest human message and the tool results since, so **any prompt or tool change means re-recording** (`scripts/desk_shifts.py`).

| Graph (`langgraph.json`) | Entry | Used by |
|---|---|---|
| **`desk`** | `app/desk_agent.py` | The game (four days) |
| `laststand` | `app/game_agent.py` | The night mode (zombie fallback) |
| `radar` / `radar_worker` | `app/agent.py` | The auditor app (`/`) and its overnight sweep |

Custom routes (`/desk/*`, `/game/*`, `/cases/*`, `/evidence/*`, `/healthz`) live in `app/routes.py` on the same server. More: [docs/AGENT.md](docs/AGENT.md).

---

## 3. Real data → the game

| Source | In the game |
|---|---|
| **CoStar** | Material, floors, occupied space and tenants, the 328-case queue the agent works from, the record each draft correction targets |
| **Vexcel** | The aerial ground you walk on; the aerials the agent reads by vision; the drone and camera views |
| **Matterport** | The real 3D tours you walk into (the buildings and the office suites) |
| **LA City and County open data** | Seismic-retrofit orders, permits, the county assessor (year, area, material), LARIAC building heights, the business registry |
| **USGS ShakeMap** | The 1994 Northridge shaking per building |
| **OpenStreetMap** | Building outlines and heights around the district |

**Licensed CoStar, Vexcel and Matterport data is never committed;** it is matched locally. Synthetic `TEST-*` fixtures and `?stub=1` run without it.

---

## 4. The auditor (`/`)

The same agent works the whole queue as an auditor: an overnight sweep opens cases where CoStar disagrees with the city, the aerials or a suite tour; it investigates each one and drafts corrections for a person to approve. "File the reports" at dawn opens the day's case there, with Bob's report in it.

---

## 5. Run it

```bash
uv sync && cp .env.example .env                 # keys only in .env
uv run pytest -q                                # offline tests
uv run python scripts/fetch_public.py           # LA lists, permits, ShakeMap (cached)
uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --no-reload --n-jobs-per-worker 4
cd web && npm install && npm run dev            # http://127.0.0.1:3000/play?mode=foot
```

| URL | What |
|---|---|
| `/play?mode=foot` | The four-day game |
| `&demo=1` | The 2-minute stage cut (Day 1, with F to skip the walk) |
| `&stub=1` | Synthetic data, no backend |
| `&agent=off` | The real district with no agent calls (visual testing) |
| `/play/log` | The agent log on a second screen |

- **Stage demo:** start the server with `RADAR_REPLAY=stage RADAR_REPLAY_STRICT=1` (never put `RADAR_REPLAY` in `.env`). The recordings live in `fixtures/replay/` and stay local, so a fresh clone runs the agent live. Between judges press **New game** or run `uv run python scripts/demo_reset.py`. One browser tab on the game.
- **Night mode** (zombies, the fallback): set `NEXT_PUBLIC_GAME_GRAPH=laststand` for the web app.
- In git worktrees, run `next dev --webpack`.

---

## 6. Known limitations

- **Vision** is weak on fine detail, so its effect is capped and double-checked.
- **Evidence weights** are hand-set. See [docs/AGENT_IMPROVEMENT_PLAN.md](docs/AGENT_IMPROVEMENT_PLAN.md).
- **Four days, one district:** the days with imagery gathered. Days 2 to 4 have no aftershock, so they are graded on expected values.
- **Live runs vary** with the checks the agent chooses; replay is deterministic.
- **The screening is a game model** built from published methods, not an engineering assessment.

---

## 7. Docs

| Doc | For |
|---|---|
| [docs/game/](docs/game/README.md) | How to play, the demo, the Devpost, the video |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The system map |
| [docs/AGENT.md](docs/AGENT.md) | The deep agent in depth |
| [docs/BACKEND.md](docs/BACKEND.md) | Python, data, evidence engine, routes, Store, tests |
| [docs/FRONTEND.md](docs/FRONTEND.md) | The web app |
| [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) | Vexcel, Matterport, the CoStar kit, LA open data |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | Setup, tests, branch, commit and data rules |

## 8. Rules

1. **Secrets** live only in `.env`. `scripts/check_secrets.sh` runs as the pre-commit hook.
2. **Licensed data never enters git** (`fixtures/*/` except `TEST-*`). Never send kit data to outside services. Matterport is read-only.
3. **Numbers stay in Python;** add a tool rather than letting a prompt compute.
4. **The exact agent messages are a contract.** Changing a prompt, a tool output or a message string means re-recording and strict replay.
5. **Honesty:** "the records disagree", never "wrong"; "unfinished" is not non-compliant; no company names in agent output; "game outcome, not an engineering assessment" on screen.
6. **No paid services.**

## Team

[TEAM: names, Discord usernames]. Built at HackPrinceton Fall 2026.
