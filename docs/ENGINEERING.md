# Retrofit Radar engineering plan

**Current frame (Sat Nov 14, from 9:11 am): the AI auditor for CoStar's records.** The agent opens a *case* wherever a
CoStar record disagrees with another source, chooses the evidence that would settle it, weighs it in code, and hands back
a draft correction for a person to approve. Case types and their code:

| Case | Disagreement | Code |
|---|---|---|
| material_conflict | LA's non-ductile concrete list vs CoStar's recorded material | `app/retrofit_lists.py`, `app/evidence.py` |
| stale_entry | a city retrofit list still names a replaced building | `app/retrofit_lists.py`, `app/evidence.py` |
| ghost_tenant | a tenant on record in a suite that is listed for lease | `app/tenants.py`, `app/evidence.py` |

- **Evidence:** reusable checks return `{finding, effects: [{hypothesis, delta}], why}` (`app/evidence.py`). Vision checks
  (`app/vision.py`: Vexcel ortho/oblique/dated captures, Matterport panoramas) need a confirming second pass and are capped
  at ±0.2. Human reports (`record_note` → `human_report`) are capped at +0.35 and flagged when they contradict the records.
- **Tools:** `open_case`, `check_evidence`, `weigh_case`, `record_note`, `seismic_status`, `find_retrofit_targets`,
  `quake_replay`, plus the earlier verifier and scene tools. The live answer takes 3 model turns, plus 2 when a case is open.
- **UI:** queue (`GET /cases/queue`), 3D view, case file with live confidence bars, evidence images
  (`GET /evidence/image/{name}`) and Approve/Reject (`POST /cases/decision`, recorded only).
- **Demo:** `scripts/demo_reset.py`, `scripts/demo_flow.py`, and the labelled replay fallback (`app/replay.py`).
- **Verified numbers (Sat ~10:30 am, after the review fixes):**
  - 226 LA kit buildings are on a retrofit list; 61 are unfinished (2,091 apartments); 14 are past a deadline.
  - Only 12 of 69 concrete-list matches are recorded as concrete by CoStar.
  - In the Northridge replay, 42 of 61 felt MMI 7+.
  - Queue: 37 material_conflict, 18 stale_entry, 273 ghost_tenant (316 suites minus 43 sublets).
- **Approvals:** a paused background run (the sweep's `file_correction`) appears in the web Inbox through `web/src/app/api/approvals`. That route resumes only `radar_worker` threads. iMessage YES/NO resumes the same interrupt.
- **Review log (Sat, three independent code reviewers plus runtime probing; every item verified with a probe script, then fixed):**
  - Replay: reused message ids and date-dependent keys.
  - Hedged verdict text everywhere.
  - ShakeMap cell spacing.
  - Replaced concrete buildings now open stale_entry.
  - Accessory permits ignored; tenant-trail double counting fixed; address ranges matched.
  - Finaled permits; float label margins.
  - Duplicate ghost cases.
  - UI: a fresh thread per question, case-scoped verdicts, no double submits, the replay badge re-polls, localhost-only dev server.
- Sections below are the original Friday plan (solar headline). The engineering rules still hold: the model never types a
  number, the data layers load by property ID, and licensed data stays local.

---

*Original plan, Fri Nov 13, 11:15 pm ET. Reviewed by four independent passes (integration, sponsor fit, scope,
reliability/security).*

## 1. What we were building (Friday)

Retrofit Radar checks a commercial building's listed area and stories (CoStar records) against what the aerial (Vexcel) and the interior twin (Matterport) measure. When they disagree, it tests explanations before flagging anything: basement, mezzanine, floor count, setback, merged footprint. Then it sizes a solar and roof retrofit on numbers it trusts and shows it in 3D. A background worker keeps screening the watchlist.

**The rule that runs through everything:** LLMs plan, gather and explain. Python does every number, loaded by property ID from the data layers, never typed by the model.

## 2. Tracks

| Track | Decision | What judges must see |
|---|---|---|
| **Sustainability** (the one main track) | Enter | "Renewable energy tools": every verdict ends on kWh/yr and t CO2/yr from sourced constants |
| **CoStar "Inside and Out"** | Enter **if real data arrives by Gate #1** | ≥2 real layers driving the verdict, the investigation, and the 3D view. Never demo the synthetic TEST-A as real. |
| **LangChain "Best use of deepagents"** | Enter | Trace: parallel `task` fan-out, todos, skills, Store memory, `interrupt_on`, worker threads |
| **Amazon "Best Practical AI Innovation"** | Enter | Working prototype, target user, README docs, pitch |
| Photon "Messaging Agent" | Only if a two-way text loop works by the 6 pm freeze | Text in, agent acts, reply out |
| Peri "Forward Deployed" | Skip, unless a business you consult says on record they would use it | Business name, person and role, evidence |
| Hardware, Physical AI, Arlequin, Photon voice, Rookie | Skip | — |

Judging is at your table. Special-track judges come only in round 1 (9:30–12:30). Finals (1:00–2:30) are main-track only.

## 3. System map

```
 laptop browser: web/ (Next.js)             langgraph dev :2024  (later: LangSmith Deployment)
 ┌───────────────────────────┐   useStream   ┌──────────────────────────────────────────────────┐
 │ WorldPane (three.js)      │◀────────────▶ │ graph radar        live: specialists + verifier   │
 │ Plan · Specialists ·      │  "custom"     │                    + scene verbs                  │
 │ Verifier card · Approvals │  channel      │ graph radar_worker background: + queue tools      │
 │ /api/ack ──put_item──────────────────────▶│ Store: memories skills properties queue acks      │
 └───────────────────────────┘               │        outbox scene field/<pid>                   │
 iPhone: archive/ios-RadarField ── POST /field/scan ▶│ http.app (app/routes.py): /field/scan /healthz   │
                                             └───────┬──────────────────────────────────────────┘
 app/layers.py: CoStar records · Vexcel attributes · Matterport twin (CoStar data kit + live Vexcel, cached after the first fetch; synthetic TEST-* fixtures)
 Models: live gemini-3.8-flash · live specialists gemini-3.5-flash-lite · worker gemini-4-argon (Vertex AI; live calls capped at 8 s, then the other model)
```

| Component | Path | Owner | State (verified tonight) |
|---|---|---|---|
| Graphs, prompts, models | `app/agent.py`, `app/prompts.py` | A | Both graphs run through `langgraph dev`. Live run 39.7 s with no tool errors. Worker tick finished, wrote a dossier and marked the queue item done. |
| Tools | `app/tools.py` | A | Numbers loaded by property ID; tool errors become messages (ToolErrorMiddleware) |
| Data layers | `app/layers.py`, `app/matterport.py` | **C** | CoStar data kit + live Vexcel (cached) + Matterport twins via the team token (read-only, best linked twin within 250 m), all with provenance. |
| Verifier | `app/verify.py`, `app/interior.py`, `app/field.py` | C | Covered by the test suite (143 tests), including a regression test for every reviewer finding |
| Scene verbs + confirmations | `app/scene.py`, `web/src/lib/useSceneActions.ts`, `web/src/app/api/ack/route.ts` | B | Backend loop verified with a scripted frontend: 3 of 3 actions confirmed. Browser rendering not yet run. |
| Web app | `web/` | B | Builds and type-checks. One page. |
| HTTP routes | `app/routes.py` | D | Upload, token gate and Store writes verified through `langgraph dev` |
| Heartbeat, seeding | `scripts/heartbeat.py`, `scripts/seed_store.py` | D | Seeding verified. `heartbeat.py tick` verified (as SDK calls). Cron not yet created. |
| iOS field check (stretch) | `archive/ios-RadarField/` (archived) | C | Compiles for device; not run on a phone |

## 4. Flows

**Live question** (three model turns; target under 60 s, measured in §9):
1. The user types "Is <PID> worth a solar and roof retrofit?" (PID = a CoStar property id; the city comes from the record).
2. Turn 1: `write_todos` (four items), plus `show_building(pid)`, plus `task` × 3 in parallel (records, aerial, interior).
3. Turn 2, one message: `write_todos` (all items completed), `verify_building`, `ghost_compare`, `reveal_levels`, `retrofit`, `place_solar`. Every one loads its own layers by property id, so none waits for another. `verify_building` reconciles, tests hypotheses and returns the verdict, provenance and assumption status. `retrofit` and `place_solar` run app/solar.py (Vexcel roof, PVWatts, CBECS, eGRID, CoStar leases).
   - The scene verbs run concurrently, but each sends its action only after the verbs ahead of it in that turn, so the screen always builds show → ghost → levels → solar (`app/scene.py`; the browser applies actions in arrival order, and `show_building` clears the scene). In ack mode they wait for their confirmations concurrently.
   - `reveal_levels` draws only the below-grade levels the verifier counts. `ghost_compare`, `reveal_levels` and `place_solar` draw nothing on a link-check failure. `show_building` still shows the structure the aerial measured.
4. Turn 3: a three-sentence answer ending on kWh/yr and t CO2/yr, with "(illustrative data)" and "(placeholder inputs)" labels when they apply. Todo updates ride along with real tool calls, so no turn only updates the plan.
5. Approvals (`send_outreach`, `watch_building`) appear as the approve/reject bar. `respond({decisions:[…]})` needs one decision per action request.

Live model calls (`app/agent.py` `models()`): the orchestrator is gemini-3.8-flash and the specialists gemini-3.5-flash-lite (thinking "minimal"). Each call gets one attempt of at most `RADAR_MODEL_TIMEOUT_S` (8 s), then the same request on the other model, then a last try with no limit (`ModelFallbackMiddleware`). Vertex sometimes holds a request 10–55 s before the first token, and a same-model retry usually lands in the same stall. When streaming (`langgraph dev`), the 8 s bounds the time to the first token. The worker graph keeps no timeout.

**Worker tick** (hourly cron, plus `scripts/heartbeat.py tick` as the demo button):
1. `queue_next()` returns up to 3 buildings.
2. For each: `verify_building`, `retrofit`, a dossier at `/properties/<pid>/dossier.md`, then `queue_done`.
3. `notify_me` only when a finding crosses a threshold. It always lands in the in-app outbox and is texted through the iMessage bridge (`photon/`) when the bridge runs.

**Texts** (Photon Spectrum, `photon/`): a text from a team number starts a `radar_worker` run on one thread per sender and the answer is texted back. When a run stops at an approval, the bridge (not the model) texts the request from the interrupt payload, and YES / NO resumes it with one decision per action request. Only the numbers in `.env` can text or be texted. See `photon/README.md`.

**Field check** (stretch): see §7 and `archive/ios-RadarField/README.md`. A stand-in scan never changes a verdict.

## 5. Contracts

Schemas live in `contracts/`. Store namespaces:

| Namespace | Key | Value | Writer → reader |
|---|---|---|---|
| `memories`, `skills`, `properties` | `/<path>` (route prefix stripped) | deepagents file (`create_file_data`) | seed script / agent → agent |
| `queue` | `<pid>` | `{task, status: queued\|done, reason, outcome, added_at}` | `watch_building`, seed → worker |
| `acks` | action id | `{ok, screenshot_jpeg_b64?, error?}` | web `/api/ack` → `stage()` |
| `scene` | thread id | `{degraded: true}` after an ack timeout | `stage()` |
| `outbox` | uuid | `{kind, text, delivery}` | `notify_me`, `send_outreach` → UI |
| `field`, `<pid>` | scan id | parsed FieldScan (raw RoomPlan JSON is dropped) | `/field/scan` → tools |

## 6. Verifier rules (what keeps verdicts honest)

1. **Numbers come from layers by property ID,** with provenance (`source`, `synthetic`). The model never supplies them.
2. **A twin rules things out only if it spans at least 70% of the footprint.** A one-suite twin leaves the hypotheses "untested".
3. **A twin taller than the measured building is ignored** with a warning ("may not be this building"). This caught the synthetic link tonight.
4. **The entrance is the first scan,** unless a level below it is labeled like a ground floor. Then that level becomes the entrance.
5. **Basement area is capped at that level's scanned extent.** Mezzanines count once per level and never as floors.
6. **Height gives a range of floor counts,** allowing for floor-height tolerance and a parapet. Rounding is never used.
7. **A phone ceiling height only caps the floor count.** "No lower level" needs the operator's attestation. Lower levels count only if the first room scanned was at the entrance.
8. **Every constant carries a status:** placeholder, heuristic or sourced. Placeholders surface in the answer and on the card.

## 7. Run it

```bash
.venv/bin/langgraph dev --host 0.0.0.0 --port 2024 --no-browser   # both graphs + /field/scan (.env is loaded)
.venv/bin/python scripts/seed_store.py --queue TEST-A              # standing orders, skills, worker queue
cd web && cp .env.local.example .env.local && npm run dev          # http://localhost:3000
.venv/bin/python scripts/heartbeat.py tick                         # one worker tick now
.venv/bin/python -m pytest -q                                      # 143 tests, offline
```

`langgraph dev` runs one job at a time locally, so a worker tick and a live question queue behind each other. Don't tick during a demo.

## 8. Build order and gates

| When | Who | Proof of concept | Pass | Fallback |
|---|---|---|---|---|
| Now → 12:45 am (**Gate #1**) | C (+A) | Real data | ≥3 Houston/LA properties cached with listed area, stories, footprint and height; ≥1 with a Matterport twin through CoStar's keys | MCP fails → OpenAPI. No twin → Plan 2 (records + Vexcel). <2 properties → Plan 3 (public county data, no CoStar track). |
| By 1 am | B | Screen confirmation in the browser | A real run shows "confirmed on screen" 5 times out of 5 | `RADAR_SCENE_MODE=dispatch` (send, don't wait) |
| By 3:15 am | A | Real-data live run | Verdict under 60 s on a real property; overnight worker batch queued | Cached layers |
| Sat 8:30 am | C + D | Story and constants | Demo story (A/B/C) picked from real results; PVWatts, CBECS and eGRID values entered in `SOURCED` | Keep the "placeholder inputs" label on stage |
| Sat 12 pm (**Gate #2**) | all | End to end | Live run under 60 s on 2 real properties; worker ticks; story locked | Shrink scope from the stretch list |
| Sat 6 pm (**Gate #3**) | all | Freeze | — | — |

## 9. Measured latency (Fri night)

| Orchestrator | One turn | Full live run |
|---|---|---|
| gemini-4-argon (thinking low) | 3.2 s typical; **one call took 113 s** | 39.7 s and 167 s |
| gemini-3.8-flash (thinking low) | 2.3 s | **22.6 s and 30.7 s** (first scene action at about 3 s) |

Decision: live = flash, worker = argon (`RADAR_ORCH_MODEL`, `RADAR_WORKER_MODEL`). Claude via Vertex is a one-line switch, but it needs `gcloud` login, not an API key.

## 10. Scope

- **Core:**
  - the live graph with the verifier;
  - the one-page web app (world pane, plan, specialists, verifier card, approvals);
  - the worker with hourly heartbeat and a manual tick;
  - cached/live layer switch;
  - README;
  - public LangSmith trace (TEST-A only).
- **Stretch, in this order:**
  1. Background strip in the UI.
  2. Photon outbound.
  3. iOS field check (on a phone by 9 am, round trip by 4 pm, else cut).
  4. Photon inbound and text approvals.
- **Cut:**
  - the writer subagent (cut by review);
  - async subagents, Showcase twin dive, `drop_pin`, Brief card, sound/TTS, Blender;
  - extra pages;
  - one cron per building;
  - deploying before a local run works end to end.

## 11. Open

- **Repo:** the hackathon rule needs a **public** GitHub repo created this weekend. It holds no commits yet; push only `retrofit-radar/`, never the private planning repo. A pre-commit hook (`scripts/check_secrets.sh`) blocks `.env` files, keys and real fixtures.
- **CoStar toolkit keys and terms:** ask the on-site engineers tonight what can be shown on Devpost and in screenshots. Real data stays gitignored.
- **Deployment:** the public repo has no real fixtures, so deploy from a private mirror or seed the Store. Custom routes skip platform auth; the field token is their only gate.
- **Photon:** built on Spectrum (`spectrum-ts` 12.16, cloud iMessage) as the `photon/` bridge, outbound and inbound with text approvals. On the free plan every number must be a project user in the Photon dashboard (`Target not allowed for this project` otherwise).
- **iOS:** `NSAllowsArbitraryLoads` is on for LAN http during the hackathon. Use a throwaway token and rotate it after the event.
- **After judging:** rotate all event keys.

## 12. Review log

| Finding | Severity | Resolution |
|---|---|---|
| Worker couldn't see the queue (CompositeBackend route vs raw Store dicts) | Blocker | `/queue/` route removed; `queue_next`/`queue_done` on the Store; worker verified |
| Any tool exception aborted the run | Blocker | `ToolErrorMiddleware` on the main agent and specialists; test added |
| `/field/scan` open without a token; `..` IDs; "false" read as true | Blocker | Token required (503 if unset), `compare_digest`, strict IDs and booleans, token on GET; tests |
| Licensed data would be committed | Blocker | `.gitignore` covers `fixtures/*/*` except synthetic TEST-*; demo twin unstaged; pre-commit hook |
| Story A depended on the first-scan guess; partial twins ruled things out; mezzanine double count; rounding invented floors | Blocker/Major | Rules 2–6 in §6, each with a regression test |
| LLM typed the verifier's inputs | Major | `verify_building(pid)` and `retrofit(pid)` load layers themselves |
| Writer and the auto general-purpose subagent inherited every tool | Major | Writer cut; explicit tool-less general-purpose |
| Cron had no input; morning digest needed its own cron | Major | `heartbeat.py` passes input; digest cut (hourly tick plus manual tick) |
| Field scans on local disk; blocking I/O under `langgraph dev` | Major | Store-backed scans; async handlers; verified with 0 blocking errors |
| Photon addressing undefined; text approvals deadlock | Major | Spectrum bridge addresses by phone (allowlisted); the bridge, not the model, texts approvals and resumes them |
| Peri forced; no projector; special-track judges only in round 1 | Major | Peri skipped; table demo; logistics in PLAN |
| Placeholders and synthetic data unlabeled | Major | Assumption status plus provenance in every result; prompt labels them |
