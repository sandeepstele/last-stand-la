# The deep agent

How the LangChain deep agent is built: graphs, prompts, specialists, the case flow, approvals, memory, models and the replay fallback. Code: `app/agent.py`, `app/prompts.py`, `app/tools.py`, `app/scene.py`, `app/replay.py`. Overview: [ARCHITECTURE.md](ARCHITECTURE.md).

## Graphs

Both graphs come from one builder, `build(mode)` in `app/agent.py`, and are registered in `langgraph.json`. They share one Store.

| Graph | Entry | Model | Purpose |
|---|---|---|---|
| `radar` | `app/agent.py:live_agent` | live orchestrator (timeout and fallback chain) | Live questions from the web app; drives the 3D view |
| `radar_worker` | `app/agent.py:worker_agent` | worker model (no time limit) | Overnight sweep, texts from the iMessage bridge, the earthquake alert, queue ticks; waits at approvals |
| `laststand` | not in this branch | — | **In progress** on the `game` branch; see [Last Stand LA](#last-stand-la-in-progress) |

### Tools per graph (default seismic lens)

| Tool group (`app/tools.py`) | Tools | `radar` | `radar_worker` |
|---|---|---|---|
| `SEISMIC_TOOLS` | `seismic_status`, `find_retrofit_targets`, `quake_replay` | yes | yes |
| `CASE_TOOLS` | `open_case`, `check_evidence`, `weigh_case`, `record_note` | yes | yes |
| verifier | `verify_building`, `field_check` | yes | yes |
| `SIDE_EFFECT_TOOLS` | `notify_me`, `send_outreach`, `watch_building` | yes | yes |
| `SCENE_TOOLS` (`app/scene.py`) | `show_building`, `ghost_compare`, `reveal_levels` | yes | no |
| `QUEUE_TOOLS` | `queue_next`, `queue_done`, `case_queue`, `file_correction` | no | yes |
| solar | `find_buildings`, `retrofit` | no | yes |

deepagents adds its own tools (`write_todos`, `task` for the specialists, and file tools over the backend).

`RADAR_LENS=solar` switches the live graph to the Friday solar lens: `find_buildings`, `verify_building`, `retrofit`, `field_check`, the side-effect tools, all four scene verbs (including `place_solar`) and `LIVE_PROMPT_SOLAR`. The default is `seismic`. `tests/test_agent_builds.py` pins these tool sets.

### Middleware

| Where | Middleware |
|---|---|
| Live orchestrator | `TodoListMiddleware` (custom prompt and tool description), `ToolErrorMiddleware`, `ModelFallbackMiddleware` |
| Live specialists | `ToolErrorMiddleware`, `AnswerAfterFetch` (after one tool result the model is called with no tools), `ModelFallbackMiddleware` |
| Worker | `TodoListMiddleware` (worker prompt) and `ToolErrorMiddleware`; no time limit |
| Worker specialists | `ToolErrorMiddleware` only; no time limit |

`ToolErrorMiddleware` turns any tool exception into an `ERROR from <tool>: ...` message, so a missing fixture or a network drop never aborts a run. The prompts tell the model to say the data was unavailable.

## Specialists

Defined in `_specialists()` in `app/agent.py`. Each data specialist has exactly one tool and a structured response model.

| Specialist | Tool | Response | Reads |
|---|---|---|---|
| `records` | `costar_record` | `RecordsOut` | The CoStar record: type, area, stories, year built, roof renovations, ownership, tenancy |
| `aerial` | `vexcel_attributes` | `AerialOut` | Vexcel: footprint, height, roof shape, material and condition, rooftop equipment, existing solar |
| `interior` | `twin_levels` | `InteriorOut` | The Matterport twin: levels, levels below the entrance, floor-to-floor height, coverage |
| `civic` | `seismic_status` | `CivicOut` | LA's retrofit records: list, order date, step deadlines with extensions, overdue steps, permits, material conflict |
| `general-purpose` | none | text | Replaces the auto-added general-purpose subagent, which would inherit every main tool and the approval gates |

Live specialists run on the fast model; the worker's run on the spec model with no time limit.

## Prompts (`app/prompts.py`)

| Constant | Used by |
|---|---|
| `LIVE_PROMPT` | `radar`, seismic lens (default) |
| `LIVE_PROMPT_SOLAR` | `radar` with `RADAR_LENS=solar` |
| `WORKER_PROMPT` | `radar_worker` |
| `TODO_PROMPT`, `TODO_TOOL_DESCRIPTION` | The live todo list: updated only together with real tool calls, never in a todo-only turn |
| `WORKER_TODO_PROMPT` | The worker's todo list |
| `RECORDS_PROMPT`, `AERIAL_PROMPT`, `INTERIOR_PROMPT`, `CIVIC_PROMPT`, `EXPLAINER_PROMPT` | The specialists |

The prompts are short on purpose: the tools carry the numbers and the rules live in code. Rules the prompts enforce include: never state a number a tool did not return, report `weigh_case`'s numbers as given, never say a record or an owner is wrong, never name a company, label synthetic data, and treat a replay as a replay.

## The live turn structure

From `LIVE_PROMPT`. Every tool loads its own data by property id, so calls in one turn go out together.

**A building** ("Check building 247337."):
1. `write_todos` (four items), `show_building`, and the `records`, `aerial`, `interior` and `civic` specialists in parallel (`task`).
2. `write_todos` (all completed), `seismic_status`, `open_case`, `verify_building`, `ghost_compare`, `reveal_levels`.
3. Only if `open_case` returned a case: two or three `check_evidence` calls chosen by the model (plus a `write_todos` update), then `weigh_case` with exactly those checks in the next message.
4. The answer, at most five sentences.

**A suite** ("Check suite 300 at building 247386: ..."): a ghost-tenant case in three turns: `open_case(property_id, suite)` with `show_building`, then the checks, then `weigh_case`.

**No property id:** `find_retrofit_targets`, then the top match. **An earthquake question:** `quake_replay`, always described as a replay of the 1994 Northridge earthquake.

### The worker's inputs (`WORKER_PROMPT`)

| Input | What the worker does |
|---|---|
| A text from the owner (bridge framing) | Answers only that; saves a stated correction with `record_note` |
| `OVERNIGHT SWEEP: ...` (`scripts/heartbeat.py`, or the bridge's `/trigger` with `kind: sweep`) | `case_queue` → investigates the top case → writes `/properties/<pid>/case.md` → `notify_me` (case of the day) → `file_correction` (waits for approval) |
| `EARTHQUAKE ALERT ...` (`scripts/quake_alert.py` via the bridge) | `quake_replay` → dossiers for the top three → one gated `send_outreach` |
| Anything else | A queue tick: `queue_next`, `verify_building`, `retrofit`, dossier, `queue_done` |

## The case flow

```
open_case(pid, suite?) ─▶ check_evidence(pid, case, check, suite?) × 2-3 ─▶ weigh_case(pid, case, checks, suite?)
      │                          (the model picks the checks)                    │
      └─ team_notes from Store ("notes", ...) add the human_report check          └─ posterior, verdict, next_check,
                                                                                     correction_draft (needs approval)
```

- `open_case` lists each case's hypotheses with priors and the checks it can run. Without a suite it may also return `ghost_suites`.
- `check_evidence` returns one check's `{finding, effects: [{hypothesis, delta}], why}` (plus images and a callout for vision checks).
- `weigh_case` **re-runs** the named checks itself; it does not trust numbers from the conversation. The arithmetic, caps and labels are in [BACKEND.md](BACKEND.md#evidence-engine-appevidencepy).

### `record_note` and `human_report`

- When a person states a fact ("the property manager says the tenant is still there"), the agent calls `record_note(property_id, note, suite?, source, supports?)`.
- It is stored under Store namespace `("notes", "<pid>")` or `("notes", "<pid>#<suite>")`; the suite is normalized, so "Suite 300" and "300" match.
- Notes record whether they came from a text (`channel == "imessage"`) or the app.
- On the next investigation `open_case` returns them as `team_notes` and adds the `human_report` check. Each note that names a valid `supports` hypothesis adds +0.25, capped at **+0.35** per hypothesis.
- When the person's report and the record evidence point different ways, `weigh_case` sets `report_conflicts_with_records` and the next check becomes a fresh tour or a site visit.

## Approvals (human in the loop)

`interrupt_on` in `build()`:

| Tool | Allowed decisions | Effect when approved |
|---|---|---|
| `send_outreach` | approve, edit, reject | Recorded in Store `("outbox",)`; outbound to third parties is not wired |
| `watch_building` | approve, reject | Adds the building to Store `("queue",)` |
| `file_correction` | approve, reject | Recorded in Store `("corrections",)`; nothing is sent |

How a paused run is resumed (always one decision per action request):
- **Live thread:** `ApprovalBar` in `web/src/components/Panels.tsx` calls `stream.respond({decisions: [...]})`.
- **Worker thread:** the web Inbox through `web/src/app/api/approvals` (resumes `radar_worker` threads only), or a YES / NO text through the bridge.

The case file's Approve / Reject on a draft is not an interrupt: it posts to `POST /cases/decision`, which records the decision in `("corrections",)`.

## Memory and standing orders

- `memory=["/memories/AGENTS.md"]` and `skills=["/skills/"]` in `build()`. A `CompositeBackend` routes `/memories/`, `/skills/` and `/properties/` to Store namespaces of the same name, with the route prefix stripped from the key.
- The standing orders are `seed/memories/AGENTS.md`, and the one skill is `seed/skills/area-reconciliation/SKILL.md`. Seed them into a running server with `scripts/seed_store.py` (`--queue` also queues property ids for the worker).
- The worker writes dossiers to `/properties/<pid>/case.md` or `/dossier.md`, and its worklog to `/memories/worklog.md`.

## Models and fallbacks

`models()` in `app/agent.py` picks them from the environment:

| Role | Env var | Code default with `GOOGLE_API_KEY` |
|---|---|---|
| Live orchestrator | `RADAR_ORCH_MODEL` (thinking `RADAR_ORCH_THINKING`, default `low`) | `gemini-4-argon` |
| Live specialists | `RADAR_FAST_MODEL` (thinking `RADAR_FAST_THINKING`, default `minimal`) | `gemini-3.5-flash-lite` |
| Specialist fallback, worker specialists | `RADAR_SPEC_MODEL` (thinking `RADAR_SPEC_THINKING`, default `low`) | `gemini-3.8-flash` |
| Worker | `RADAR_WORKER_MODEL` | same as the orchestrator |
| Vision reads | `RADAR_VISION_MODEL` | `gemini-3.8-flash` (`app/vision.py`) |

- A `gemini-*` name runs on Vertex AI with `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` (default `global`). Any other name is passed to LangChain as a model string. With only `ANTHROPIC_API_KEY` set, the defaults become `anthropic:claude-opus-5-5` (orchestrator) and `anthropic:claude-sonnet-5-5`.
- **Live calls** get one attempt of `RADAR_MODEL_TIMEOUT_S` seconds (default 8; 0 means no limit) plus `RADAR_MODEL_RETRIES` same-model retries (default 0). Then `ModelFallbackMiddleware` sends the same request to the other fast model, and finally to a copy with no time limit, so a slow call ends in an answer, not a crash.
- **The worker** has no time limit and keeps the library's default retries.
- **Vision on Claude:** `RADAR_VISION_MODEL=claude-opus-5-5` runs vision on Claude through Vertex AI (`RADAR_CLAUDE_REGION`, `RADAR_VISION_EFFORT`).

## Replay fallback (`app/replay.py`)

| `RADAR_REPLAY` | Behavior |
|---|---|
| unset | No wrapper; the live path is untouched |
| `record:<name>` | Runs normally and saves every model response to `fixtures/replay/<name>.json` |
| `<name>` | Answers from the recording, paced `RADAR_REPLAY_DELAY_S` apart (default 1.0 s). A step that wasn't recorded goes to the live model, unless `RADAR_REPLAY_STRICT=1`, which raises instead |

- Every chat model in `MODELS` is wrapped when `app/agent.py` is imported, so change the variable in `.env` and restart `langgraph dev`.
- A response is keyed by the agent's system prompt, the latest question, the number of model turns since it, and the data-tool results since it (dates masked; scene-tool results left out).
- Changing a prompt, a question's wording or the cached data therefore changes the key: re-record.
- Only chat models are replayed. Tools still run on the cached data, and vision reads come from the vision cache (`fixtures/vision/`), not from the recording.
- `/healthz` reports the mode, the web app shows a **REPLAY** badge, and the bridge prefixes texts with `[REPLAY] `.

## Tracing

LangSmith tracing uses LangChain's standard environment variables (`LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT`; names in `.env.example`). `scripts/run_agent.py` prints the trace URL when `LANGSMITH_TRACING=true`.

## Last Stand LA (in progress)

> **The code is on the `game` branch** (`app/game_agent.py`, `app/fortress.py`); it merges into `main` after the end-to-end gate. The [README](../README.md) has the full walkthrough. The source of truth is `PLAN.md` in the team's private planning repo, section "Contract v1.1" (frozen). A copy of the interface is in [../contracts/README.md](../contracts/README.md#game-contract-v11-in-progress).

Planned agent side:
- **A third graph, `laststand`,** on the same engine, with code in `app/fortress.py`.
- **One thread per game.** Run 1 "Scout <pid>"; run 2 "Wave n is coming" (`horde_status` and `find_fallback`, then the `commit_plan` interrupt); run 3 "Tip: ..." (`record_note` and `weigh_case`).
- **New tools:**
  - `fortress_dossier(pid)`;
  - `horde_status(wave)`;
  - `find_fallback(pid, away_from?)`;
  - `commit_plan(pid, action, to_pid?)`, gated by `interrupt_on` with approve, edit and reject. Once approved or edited, its tool result is the resolve object.
- **Existing tools reused:** `open_case`, `check_evidence`, `weigh_case` and `record_note`, with their existing shapes.
- **Numbers stay in Python.** Scores, rolls and wave scripts are computed in Python, seeded and rounded, so strict replay keys stay stable. The model never sets a number.

## How to

### Add a tool
1. Write it in `app/tools.py` (or a new module) with `@tool`. Load data by property id inside the tool; never accept numbers from the model. Use `ToolRuntime` for the Store. Push blocking I/O through `asyncio.to_thread`.
2. Add it to the right group (`CASE_TOOLS`, `SEISMIC_TOOLS`, `QUEUE_TOOLS`, ...) or directly to the tool lists in `build()`.
3. If it has a side effect, add it to `interrupt_on` and to `describePending` in `web/src/components/Cases.tsx`.
4. Update the expected tool sets in `tests/test_agent_builds.py`, and mention it in the prompt only if the model must call it at a specific step.

### Change a prompt
1. Edit `app/prompts.py`. For the solar prompt, keep the rules that `tests/test_live_latency.py::test_live_prompt_keeps_every_rule` checks. No test pins `LIVE_PROMPT` or `WORKER_PROMPT`, so re-read their rules list before you change them.
2. Run the tests, then a live run (`scripts/demo_flow.py` or the web app).
3. Re-record the replay: the system prompt is part of every replay key.

### Add a specialist
1. Add a response model (a pydantic `BaseModel`) and a spec dict in `_specialists()`, with exactly one data tool, a prompt in `app/prompts.py`, and `middleware()`.
2. Mention it in the live prompt's first turn so the orchestrator calls it in parallel with the others.
3. Update `tests/test_agent_builds.py::test_subagents_are_scoped`.
