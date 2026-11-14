# Contributing

How to set up, test, branch, commit and debug. Read [ARCHITECTURE.md](ARCHITECTURE.md) first for the map, then the part doc you need: [AGENT.md](AGENT.md), [BACKEND.md](BACKEND.md), [FRONTEND.md](FRONTEND.md), [INTEGRATIONS.md](INTEGRATIONS.md).

## Setup

You need Python 3.11+ with [uv](https://docs.astral.sh/uv/), and Node with npm.

```bash
uv sync                                    # Python deps + dev tools (pytest, langgraph-cli)
cp .env.example .env                       # fill in values; .env is gitignored, never commit it
ln -sf ../../scripts/check_secrets.sh .git/hooks/pre-commit   # once per clone (worktrees share the main checkout's hooks)
uv run python scripts/fetch_public.py      # LA lists, permits, USGS -> fixtures/public/ (once; then offline)
```

- **Cases need the CoStar kit,** unzipped outside the repo. Set `COSTAR_KIT_DIR` in `.env` (default `~/Downloads/costar-hackathon-kit`). Without it, the queue and cases are unavailable, but the tests still pass.
- **Ask the coding lead for the `.env` values.** Never paste them into chat, docs, issues or commits.

Run the agent server and the web app in two terminals:

```bash
uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --n-jobs-per-worker 4
uv run python scripts/seed_store.py        # with the server up: standing orders + skills into the Store (re-run if the Store was cleared)
cd web && npm install && npm run dev       # http://127.0.0.1:3000
```

- **Bind to 127.0.0.1, never 0.0.0.0.** The custom routes skip the server's auth.
- **Use `--n-jobs-per-worker 4`,** so a background worker run and a live question don't queue behind each other.
- `langgraph dev` loads `.env` itself (`"env": ".env"` in `langgraph.json`).
- **Optional iMessage bridge:** `cd photon && npm install && npm start` (see `photon/README.md`).
- **Sanity check:** `curl -s http://127.0.0.1:2024/healthz` shows the models, layer modes and replay mode.

## Tests

All tests are offline: synthetic data, fake models, mocked HTTP. No kit, keys or network needed.

```bash
uv run pytest -q                           # or: .venv/bin/python -m pytest -q
cd photon && npm test && npm run typecheck # the bridge's pure helpers
cd web && npm run lint && npx next typegen && npx tsc --noEmit
```

Expected on the current branch: **142 passed, 1 skipped**. The skipped test needs a local-only Matterport demo fixture.

## Demo helpers

| Command | What it does |
|---|---|
| `uv run python scripts/demo_reset.py` | Clears team notes, decisions, outbox and paused worker threads in the running server's Store, then re-warms the queue. Keeps every cache. `--dry-run` shows what it would clear; `--keep-paused` leaves paused runs alone |
| `uv run python scripts/demo_flow.py --runs 5` | Runs the scripted demo (material conflict, ghost tenant, a texted correction, the ghost again, a second ghost, a stale entry) with a reset before each pass. Prints a timing and verdict table and `ALL CLEAN` or `NOT CLEAN` |
| `uv run python scripts/quake_alert.py` | Asks the bridge to start the labeled 1994 Northridge replay on the owner's thread; `--sweep` fires the overnight sweep instead. Needs the bridge and `langgraph dev` |
| `uv run python scripts/heartbeat.py tick` | One overnight sweep now (`create`, `list` and `delete` manage the hourly cron; delete it after judging) |

**Offline fallback:**
1. Record a clean run: set `RADAR_REPLAY=record:demo` in `.env`, restart `langgraph dev`, run `scripts/demo_flow.py`.
2. Demo from it: set `RADAR_REPLAY=demo` (add `RADAR_REPLAY_STRICT=1` to forbid live model calls) and restart.

The UI shows a REPLAY badge. Details: [AGENT.md](AGENT.md#replay-fallback-appreplaypy).

## Branch rules

| Branch | Rule |
|---|---|
| `main` | The **auditor-v1** fallback demo (tag `auditor-v1`). **Never commit to `main` without the coding lead.** |
| `game` | Last Stand LA work (in progress). Branch from `game` and merge back through the coding lead |
| feature branches | Small, single-purpose (`feat/...`, `fix/...`), cut from `game` for game work |

- **Push only when the coding lead says so.**
- **The game interface is frozen:** contract v1.1 in `PLAN.md`. Changes go through the coding lead. Copy: [../contracts/README.md](../contracts/README.md#game-contract-v11-in-progress).

## Commit rules

- **Identity:** commit with a GitHub noreply address, never a personal email. The project's commits use `91664223+sandeepstele@users.noreply.github.com`; check yours with `git config user.email`. Teammates use their own `<id>+<user>@users.noreply.github.com`.
- **No AI attribution:** no `Co-Authored-By` trailers or AI attribution lines in commit messages or PR descriptions.
- **Small commits,** one change each, with a message that says what changed and why.
- **Run the tests before every commit** (`uv run pytest -q`). For web changes, also run `npm run lint` and `npx tsc --noEmit` in `web/`.
- **The pre-commit hook must pass.** Never bypass it with `--no-verify`.

## Data rules

- **Licensed data never enters git.** CoStar, Vexcel and Matterport data, and anything derived from it (vision images and answers, rankings, replays), stays local:
  - `.gitignore` ignores `fixtures/*/*`, except `fixtures/*/.gitkeep` and the synthetic `fixtures/costar/TEST-A.json` and `fixtures/vexcel/TEST-A.json`;
  - the kit lives outside the repo (`COSTAR_KIT_DIR`);
  - the pre-commit hook `scripts/check_secrets.sh` blocks staged `.env` files, real `fixtures/costar|vexcel|matterport/` files (only `TEST-*.json` passes) and key-shaped strings.
- **Keys only in `.env`.** Never in code, docs, tests, commits, screenshots or logs.
- **No company names** in the UI, texts, logs or docs. Tenants are described by industry and headcount ("a 50-person office"); names stay inside `app/tenants.py`.
- **Hedged wording.** Never say a record, an owner or a tenant is wrong:
  - say what each source says and that it is "worth a look";
  - say "past a deadline" only for a step whose state is overdue;
  - "not on the list" never means "safe";
  - the earthquake is always a labeled replay.
- **Matterport is read-only.** Only the whitelisted read queries in `app/matterport.py`.
- **Nothing is sent to CoStar, the city or an owner.** Approvals are recorded only.
- **Localhost only** for every server.

## Adding a feature end to end

Example: a new evidence check for a case.

1. **Branch** from `game` (or from the branch the coding lead names).
2. **Engine:** write the check in `app/evidence.py` and register it in `CHECKS`, `CHECK_WHAT` and the case's `CASES[...]["checks"]` ([BACKEND.md](BACKEND.md#add-an-evidence-check)). Numbers come from data loaded by property id, never from the model.
3. **Test:** add a test in `tests/test_evidence.py` with synthetic data. Run `uv run pytest -q`.
4. **Agent:** add the check name to the `check_evidence` docstring in `app/tools.py`. Touch the prompt only if the model must use it at a specific step ([AGENT.md](AGENT.md#change-a-prompt)).
5. **UI:** add a label in `CHECK_LABEL` (`web/src/components/Cases.tsx`). Run `npm run lint` and `npx tsc --noEmit`.
6. **Live check:** restart `langgraph dev`, ask about a building in the web app (or run `scripts/demo_flow.py`), and check that the case file shows the step and the bars move.
7. **Replay:** if the flow or a prompt changed, re-record the replay.
8. **Docs:** update the part doc, and `contracts/README.md` if a shape, route or namespace changed.
9. **Commit** in small steps, then ask the coding lead to merge.

## Troubleshooting

### Port already in use (2024, 3000, 8787)

```bash
lsof -nP -iTCP:2024 -sTCP:LISTEN          # find the process holding the port (also 3000, 8787)
kill <pid>                                 # stop it if it is a stale server of yours
```

### `npx tsc --noEmit` fails on `LayoutProps` or route types

These types are generated into `web/.next/types` and `web/.next/dev/types`. Run `npx next typegen` (or `npm run dev` once), then type-check again.

### Vertex quota or 429

- **Live calls:** a failed or slow call (one attempt of `RADAR_MODEL_TIMEOUT_S`, default 8 s) moves to the fallback model automatically. Repeated 429s mean the project's quota is spent for the moment: wait a minute, or point `RADAR_ORCH_MODEL` / `RADAR_FAST_MODEL` at another Gemini model in `.env` and restart.
- **Vision reads** are cached in `fixtures/vision/`. A rehearsed building doesn't call the model again; on a new one the check can report its images as unavailable (no effect on the case) until the quota recovers.
- **Before a demo,** switch to the replay (`RADAR_REPLAY=demo`, `RADAR_REPLAY_STRICT=1`).
- **No paid keys:** use the existing Vertex project and free tiers; don't sign up for new paid APIs.
- **Vexcel 429s** are retried with backoff automatically.

### Replay miss

The server logs `replay miss <key>: system=... question=...` (logger `radar.replay`). With `RADAR_REPLAY_STRICT=1`, the run instead fails with "replay <name> has no recording for this step".

The key covers the system prompt, the question, the turn count and the data-tool results. A miss usually means one of these changed:
- the question's wording differs (the UI asks `Check building <pid>.`);
- a prompt changed;
- the Store still holds a judge's team note, so `open_case` returns `team_notes`;
- cached data changed.

Fix:
1. Run `scripts/demo_reset.py` and retry.
2. If it still misses, re-record: `RADAR_REPLAY=record:demo`, restart, `scripts/demo_flow.py`, then switch back to `RADAR_REPLAY=demo` and restart.

### The queue says "Queue unavailable"

The case queue needs the CoStar kit (`COSTAR_KIT_DIR`) and `fixtures/public/` (`scripts/fetch_public.py`). Check that `curl -s http://127.0.0.1:2024/cases/queue` returns JSON.

### `langgraph dev` reports a blocking call

A route or async tool did file or HTTP I/O on the event loop. Wrap it in `asyncio.to_thread`, as the existing tools and routes do.
