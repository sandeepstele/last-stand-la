# Backend: Python and data

The Python modules under `app/`, the data they read, the HTTP routes, the Store, `scripts/` and `tests/`. Overview: [ARCHITECTURE.md](ARCHITECTURE.md). The agent itself: [AGENT.md](AGENT.md).

**The rule that runs through everything:** every number is computed in Python and loaded by property id. The model chooses, reads images and explains; it never types a number into a tool.

## Module map

| Module | Role |
|---|---|
| `app/agent.py`, `app/prompts.py` | Graphs, models, specialists, middleware (see [AGENT.md](AGENT.md)) |
| `app/tools.py` | The tools the agent sees: thin wrappers around the modules below |
| `app/scene.py` | Scene verbs: `frontend_action` events for the 3D view, confirmed through Store `("acks",)` |
| `app/evidence.py` | The evidence engine: cases, checks, `weigh_case`, hedged verdict text, correction drafts |
| `app/vision.py` | Vexcel ortho and oblique images, Matterport panoramas, car counts, and two-pass vision reads |
| `app/retrofit_lists.py` | LA's soft-story and non-ductile concrete lists and permits, matched to kit buildings by address and ZIP |
| `app/quake.py` | Shaking (MMI) at a building from the USGS ShakeMap; the labeled Northridge replay |
| `app/tenants.py` | Ghost-tenant candidates: occupied on record and listed for lease, from the kit |
| `app/cases.py` | The overnight case queue shared by `GET /cases/queue` and the `case_queue` tool |
| `app/layers.py` | Data layers by property id, with provenance and cache modes |
| `app/costar.py`, `app/vexcel.py`, `app/matterport.py` | Readers for the CoStar kit, the Vexcel API and the Matterport Model API (read-only) |
| `app/routes.py` | Custom HTTP routes mounted on the agent server |
| `app/replay.py` | Record and replay of the chat models (see [AGENT.md](AGENT.md#replay-fallback-appreplaypy)) |
| `app/photon.py` | Outbound texts through the iMessage bridge |
| `app/verify.py`, `app/interior.py`, `app/field.py` | The Friday verifier: listed area vs footprint × stories, Matterport levels, iPhone field scans |
| `app/solar.py`, `app/search.py` | The Friday solar lens (kept; not offered live in the seismic lens) |

Blocking I/O (files, HTTP) is called through `asyncio.to_thread` from async tools and routes: `langgraph dev` rejects blocking calls on the event loop.

## Data layers (`app/layers.py`)

Every loader returns data with provenance (`source`, `synthetic`).

| Env var | Values (default `auto`) | Meaning |
|---|---|---|
| `RADAR_LAYER_COSTAR` | `cached` · `kit` (`live` is an alias) · `auto` | `cached` reads `fixtures/costar/<id>.json` only (the synthetic `TEST-*` records). `kit` reads the CoStar kit at `COSTAR_KIT_DIR`. `auto` uses the fixture if there is one, else the kit |
| `RADAR_LAYER_VEXCEL` | `cached` · `live` · `auto` | `cached` reads `fixtures/vexcel/<id>.json` only. `live` calls Vexcel `property/extract` at the CoStar coordinates and caches the result. `auto` uses the cache if there is one, else live |
| `RADAR_MATTERPORT` | `auto` · `live` · `cached` | Matterport layouts (`app/matterport.py`). `live` writes through to `fixtures/matterport/`. `cached` never calls the network |

- `COSTAR_KIT_DIR` defaults to `~/Downloads/costar-hackathon-kit`. The kit stays outside the repo.
- Note: `GET /healthz` prints `cached` for an unset `RADAR_LAYER_*` variable, but the loader's real default is `auto`.

**Two guards against comparing the wrong structure:**
- A Vexcel footprint far from CoStar's floor plate sets `link_problem`; `verify_building` then returns `check_link` and compares nothing.
- An outline more than 1.25× its own parcel is treated as including a neighbor.

**Twin choice:** among the Matterport twins the kit links to a property (up to 10), the largest scan geolocated within 250 m of the CoStar point is used.

**The case logic reads the kit directly.** `app/evidence.py`, `app/retrofit_lists.py`, `app/tenants.py` and `app/cases.py` call `app/costar.py`, so cases need `COSTAR_KIT_DIR` whatever `RADAR_LAYER_COSTAR` says.

## Public data

`scripts/fetch_public.py` downloads public, keyless data once into `fixtures/public/`; after that everything runs offline. `--refetch` downloads it all again.

| File | Source | Read by |
|---|---|---|
| `softstory.json` | LA soft-story retrofit list (data.lacity.org `dqq4-799r`) | `app/retrofit_lists.py` |
| `ndc.json` | LA non-ductile concrete list (`ke3z-xgni`) | `app/retrofit_lists.py` |
| `retrofit_permits.json` | LA permits since 2020 with soft-story or non-ductile work (`pi9x-tg5x`) | `app/retrofit_lists.py` |
| `demo_new_permits.json` | LA demolition and new-building permits (`pi9x-tg5x`) | `app/evidence.py` `replacement_permits` |
| `usgs_ci3144585.json`, `shakemap_ci3144585_grid.xml` | USGS event and ShakeMap grid, 1994 Northridge | `app/quake.py` |

- **Matching** (`app/retrofit_lists.py`) is done locally by normalized street address plus ZIP, LA only. Nothing from the kit is sent anywhere.
- **Hypotheses:** `assess()` returns these per building: `unfinished` (with `past_due`), `stale_entry`, `material_conflict`, `not_proven_safe` and `work_underway`.
- **Quake replay** (`app/quake.py`): every result carries `replay=True` and the event's real date. The MMI comes from the nearest ShakeMap grid cell.

## Evidence engine (`app/evidence.py`)

### Cases

| Case | Opens when | Hypotheses (prior) |
|---|---|---|
| `material_conflict` | `assess()` finds `material_conflict`: the concrete list names the building, CoStar records another material | `city_list_current` 0.45 · `costar_current` 0.35 · `different_structure` 0.20 |
| `stale_entry` | `assess()` finds `stale_entry`: on a list, CoStar's year built is 1978 or later, and the work is unfinished (or the entry is on the concrete list) | `replaced` 0.55 · `year_is_renovation` 0.45 |
| `ghost_tenant` | `open_case(pid, suite)` on a suite that is both occupied on record and listed | `still_there` 0.30 · `gone_dark` 0.25 · `subleasing` 0.10 · `moved_within` 0.10 · `listing_stale` 0.25 |

### Checks

| Check | Cases | Reads |
|---|---|---|
| `compliance_filings` | material_conflict, stale_entry | Filings with the city's retrofit program |
| `permit_text` | material_conflict | Materials named on retrofit permits |
| `replacement_permits` | material_conflict, stale_entry | Demolition or new-building permits since 2020 (accessory work excluded) |
| `era_and_height` | material_conflict, stale_entry | Year built, stories, aerial height per floor |
| `site_structures` | material_conflict | Structures Vexcel sees on the parcel |
| `look_from_above` | material_conflict | **Vision:** oblique and top-down images of the facade |
| `compare_captures` | material_conflict, stale_entry | **Vision:** oldest vs newest aerial capture |
| `listing_timeline` | ghost_tenant | Listing date and type vs move-in date |
| `lease_terms` | ghost_tenant | Lease expiration on record |
| `tenancy_trail` | ghost_tenant | The company's newer locations (company names never leave `app/tenants.py`) |
| `lot_activity` | ghost_tenant | Car counts across captures (building-level, weak) |
| `suite_tour` | ghost_tenant | **Vision:** the suite's Matterport leasing tour |
| `human_report` | any case, when team notes exist | What a person told the team (see [AGENT.md](AGENT.md#record_note-and-human_report)) |

Ghost-tenant checks need `suite=`. `run_check()` refuses an unknown case or check with `{status: "bad_case" | "bad_check", allowed}`.

### The check result

```python
{"property_id", "suite"?, "case", "check", "looks_at",
 "finding": "what it found, in words",
 "effects": [{"hypothesis": "<key>", "delta": +0.2}, ...],   # signed shifts, judgment calls kept small for weak evidence
 "why": "the reason for those shifts",
 "images"?, "callout"?, "vision"?,   # vision checks
 "human"?}                           # human_report
```

### Weighing (`weigh_case`)

1. Re-run each named check (in order, de-duplicated; checks outside the case are ignored).
2. Start from the priors, add each delta, and floor each hypothesis at 0.02.
3. Normalize and round to two decimals; the leader is the verdict.
4. Label it:

| Label | Rule (`conf` = leader's share, `margin` = lead over the runner-up) |
|---|---|
| `likely` | `conf ≥ 0.6`, or `conf ≥ 0.5` and `margin ≥ 0.3` |
| `leaning` | `conf ≥ 0.5`, or `conf ≥ 0.4` and `margin ≥ 0.2` |
| `unresolved` | anything else |

**Caps:**
- **Vision** (`VISION_CAP = 0.2`): each vision effect is clamped to ±0.2. A read that the second pass doesn't confirm is `cant_tell` and moves nothing.
- **Human reports** (`HUMAN_CAP = 0.35`): +0.25 per usable note, at most +0.35 per hypothesis.

**Output:**
- `posterior`, `trail`, `verdict {hypothesis, claim, confidence, label, text}`, `next_check`, `report_conflicts_with_records`, `correction_draft` and `draft_needs_approval`.
- `verdict.text` is hedged (the `HEDGED` table): "worth a look", never "the record is wrong".
- A correction draft is written only for a *likely* or *leaning* verdict on:
  - ghost_tenant: `gone_dark`, `moved_within` or `listing_stale`;
  - material_conflict: `city_list_current`;
  - stale_entry: `replaced`.

## Vision (`app/vision.py`)

- **Images:**
  - Vexcel ortho (`ortho/extract`, optionally from a dated collection);
  - oblique (`oriented/collections`, then `oriented/extract`);
  - Matterport skybox faces for a suite tour;
  - car counts from Vexcel `elements/detect`.
  
  All are cached in `fixtures/vision/` (gitignored: licensed imagery).
- **`ask()` is a two-pass read:**
  1. The first pass answers one question from a fixed list of choices (or `cant_tell`) and says what it saw.
  2. A skeptical second pass sees the same images and the first answer, and gives its own answer from the same choices.
  3. The read counts only when the two answers match (`confirmed`); otherwise the answer is `cant_tell`.
- **Answers are cached** as `fixtures/vision/<pid>_<key>_<hash>.json`. The hash covers the vision model, the question and the image names, but not the second-pass prompt: after changing that prompt, delete the cached JSON files to re-ask.
- **Model:** `RADAR_VISION_MODEL` (default `gemini-3.8-flash`); a `claude*` name runs on Vertex AI.
- **Errors:** a failed read raises `VisionUnavailable` and is not cached. The check then reports the images (or the tour) as unavailable, with no effects.

## Tenants and the case queue

- **`app/tenants.py`** joins the kit's tenancies, listings and tour attachments. A suite is a candidate when it has a current tenancy and a live listing.
  - Sublet and assignment listings are excluded from the queue: the tenant itself is offering the space.
  - Tenants are described by industry and headcount ("a 50-person office"). Nothing it returns carries a company name.
- **`app/cases.py`** `build_queue()` lists material_conflict and stale_entry cases from `retrofit_lists.portfolio()` and ghost-tenant rows from `tenants.queue_rows()`.
  - It sorts cases whose own imagery is already cached first, then by stakes.
  - It is cached for 60 s.

## HTTP routes (`app/routes.py`)

Mounted on the agent server through `langgraph.json` `"http": {"app": "./app/routes.py:app"}`, next to LangGraph's own API on port 2024.

| Route | Purpose |
|---|---|
| `GET /healthz` | Configuration check: models, field uploads, scene mode, layer modes, Matterport mode, replay mode. No secrets |
| `GET /cases/queue` | Counts by case type and the top 25 cases |
| `GET /cases/inbox` | The newest five outbox items and five recorded decisions |
| `POST /cases/decision` | `{property_id, case, decision: approve\|reject, draft, suite?}`, recorded in `("corrections",)`, never sent |
| `GET /evidence/image/{name}` | A cached `.jpg` from `fixtures/vision/` (file name only; anything else is a 404) |
| `POST /field/scan`, `GET /field/scans/{property_id}` | iPhone field scans (stretch); header `X-Radar-Token` must match `RADAR_FIELD_TOKEN`, refused when it is unset |

Custom routes skip the server's own auth. The web app reaches them only through its allowlisted proxy (see [FRONTEND.md](FRONTEND.md#server-routes)).

**Planned (game branch, in progress):** `GET /game/district`, `GET /game/dossier/{pid}`, `POST /game/resolve`; see [../contracts/README.md](../contracts/README.md#game-contract-v11-in-progress).

## Store namespaces

| Namespace | Key | Value | Written by → read by |
|---|---|---|---|
| `memories`, `skills`, `properties` | file path without the route prefix (e.g. `/AGENTS.md`) | deepagents file data | `scripts/seed_store.py`, the agent → the agent |
| `notes`, `<pid>` or `notes`, `<pid>#<suite>` | random id | `{note, at, source, supports, recorded_by}` | `record_note` → `open_case`, `check_evidence`, `weigh_case` |
| `corrections` | random id | `{property_id, suite, case, decision, draft, at, note, via?}` | `POST /cases/decision`, `file_correction` → `GET /cases/inbox` |
| `outbox` | random id | `{kind, text, to?, delivery, at}` | `notify_me`, `send_outreach` → `GET /cases/inbox` |
| `queue` | property id | `{task, status: queued\|done, reason?, outcome?, added_at, ...}` | `watch_building`, `seed_store.py` → `queue_next`, `queue_done` |
| `acks` | action id | `{ok, screenshot_jpeg_b64?, error?}` | web `/api/ack` → `app/scene.py` `stage()` |
| `scene` | thread id | `{degraded: true}` after an ack timeout | `stage()` |
| `field`, `<pid>` | scan id | parsed field scan | `POST /field/scan` → `verify_building`, `field_check` |

`scripts/demo_reset.py` clears `notes`, `corrections` and `outbox` (and paused worker threads) between demos.

## Scripts (`scripts/`)

| Script | What it does |
|---|---|
| `fetch_public.py` | Download LA lists, permits and the USGS data into `fixtures/public/` |
| `seed_store.py` | Seed standing orders and skills into the Store; `--queue` adds worker queue items |
| `demo_reset.py` | Clear notes, decisions, outbox and paused worker threads; re-warm the queue (`--dry-run`, `--keep-paused`) |
| `demo_flow.py` | Run the scripted demo against the server and print a timing and verdict table (`--runs N`) |
| `quake_alert.py` | Ask the bridge to start the labeled Northridge replay (`--sweep` fires the overnight sweep instead) |
| `heartbeat.py` | `tick` runs one worker sweep now; `create`, `list` and `delete` manage the hourly cron |
| `run_agent.py` | Run a graph in process with an in-memory Store and print each step (scene verbs in dispatch mode) |
| `check_secrets.sh` | The pre-commit hook: blocks `.env` files, real fixtures and key-shaped strings |
| `investigate.py`, `vexcel_probe.py`, `solar_screen.py` | Friday tools: the verifier from the command line, one Vexcel fetch, the solar ranking |

## Tests (`tests/`)

All offline: synthetic records, fake models and mocked HTTP. No kit, keys or network needed.

| File | Covers |
|---|---|
| `test_evidence.py` | Cases, checks, weighing, caps, drafts, ghost tenants |
| `test_retrofit_lists.py` | List matching and the hypotheses on synthetic rows |
| `test_case_routes.py` | `/cases/queue`, `/cases/decision`, `/evidence/image` |
| `test_replay.py` | Record, replay and the replay key |
| `test_agent_builds.py` | Both graphs compile with the intended tools; specialists are scoped; tool errors become messages |
| `test_live_latency.py` | Timeouts and fallbacks, the solar prompt's rules, scene-verb ordering |
| `test_layers.py` | Data-layer wiring, cache modes, twin choice, wrong-structure guards |
| `test_photon.py` | `app/photon.py` against a mocked bridge |
| `test_core.py`, `test_field.py`, `test_solar.py`, `test_search.py` | The Friday verifier, field scans, solar screen, search |

## How to

### Add an evidence check
1. Write the check function in `app/evidence.py`. Building checks take `(pid, case)`; ghost-tenant checks take `(pid, case, suite)` and go in `GHOST_CHECKS`. Return `{finding, effects, why}`.
2. Register it in `CHECKS` (which `run_check` and `weigh_case` dispatch through), describe it in `CHECK_WHAT`, and add it to each case's `CASES[case]["checks"]`.
3. A vision check goes through `_vision_result()`, so the ±0.2 cap and the `cant_tell` rule apply.
4. Add a test in `tests/test_evidence.py` (monkeypatch `_ctx` or `_facts` with synthetic data, as the existing tests do).
5. List the check name in the `check_evidence` docstring in `app/tools.py` (the model reads it), and add a label to `CHECK_LABEL` in `web/src/components/Cases.tsx`.

### Add a case type
1. Add a `CASES` entry (question, hypotheses whose priors sum to 1, checks), its `HEDGED` sentences, and, if it can draft a correction, a branch in `weigh_case`.
2. Make it open: a hypothesis key from `retrofit_lists.assess()` (see `cases_for`), or a dedicated path in `open_case`. Add queue rows in `app/cases.py`.
3. Add a label in `CASE_LABEL` (`web/src/components/Cases.tsx`), the `supports` keys in the `record_note` docstring, and tests.

### Add an HTTP route
1. Write an async handler in `app/routes.py`, add a `Route`, and keep blocking work in `asyncio.to_thread`. Use `_store(request)` for the Store (tests inject an `InMemoryStore`).
2. If the browser needs it, add its path to `ALLOWED` in `web/src/app/api/backend/[...path]/route.ts`.
3. Document it in `contracts/README.md`, and add a test like `tests/test_case_routes.py`.

### Add a data source
1. Public data: fetch it in `scripts/fetch_public.py` into `fixtures/public/`, then load it lazily with a clear "run fetch_public" error, like `retrofit_lists._load()` and `quake.event()`.
2. Licensed or keyed data: add a reader module that caches under `fixtures/<source>/` (already gitignored by `fixtures/*/*`). Give it a `RADAR_LAYER_*`-style mode if it can run live, and return provenance with every record.
3. Never send kit data to an outside service. Add synthetic fixtures for the tests.
