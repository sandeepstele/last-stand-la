# Deep agent: limitations and improvement plan ("Plan B")

**Who this is for:** the teammate improving the agent's reasoning while the game ships.
**Status:** Sat Nov 14. Every number below was measured on this repo today unless marked as a guess.

## Ground rules (read first)

1. **Work on your own branch:** `git checkout -b agent-plus main`. `main` is the working auditor (tag `auditor-v1` is the frozen fallback), and `game` is being built right now. Don't commit to either; open a PR or hand over commits.
2. **The demo must not break.**
   - The replay fallback (`app/replay.py`) keys on the system prompt, the question, the turn and the data tool outputs.
   - **Any change to a prompt or to a tool's output invalidates the recorded replay.** It has to be re-recorded (`RADAR_REPLAY=record:...`) and re-checked in strict mode (`RADAR_REPLAY_STRICT=1`) before it can merge.
3. **Code computes every number; the model chooses and explains.** Keep that split. No verdict, score or probability may come from model text.
4. **Hedged wording only.** Never say a record, owner or tenant is wrong, and use no company names.
5. **No paid services.** Use the Vertex Gemini key you have. Claude on Vertex is enabled but has **0 quota** until our quota request is approved.
6. **Data rules:**
   - licensed CoStar/Vexcel/Matterport data is never committed (`fixtures/*/*` is gitignored);
   - keys only in `.env`;
   - commits use the repo's noreply email, with no AI co-author trailers.
7. **Run the offline tests before every commit:** `uv run pytest -q`.

## How the agent reasons today

```
question ─▶ orchestrator (Gemini 3.8 Flash, thinking "low", 8 s per call, then fallback)
   turn 1:  write_todos + 4 specialists in parallel (records · aerial · interior · civic; Gemini Flash-Lite)
            + open_case(pid)  → hypotheses with HAND-SET priors (app/evidence.py CASES)
   turn 2:  check_evidence × 2-3  (the model picks from a FIXED menu of checks per case)
            each check → {finding, effects:[{hypothesis, delta}], why}   (deltas are HAND-SET)
            vision checks: one question about an image + an independent second look; must agree; capped ±0.2
   turn 3:  weigh_case (pure Python: priors + deltas, floor 0.02, normalise → posterior → likely/leaning/unresolved)
            → hedged answer + draft correction (needs human approval)
people:     record_note → human_report evidence, capped +0.35 in total
```
Code: `app/agent.py` (graphs, models, fallbacks), `app/prompts.py`, `app/tools.py`, `app/evidence.py`, `app/vision.py`, `app/game_agent.py` (game graph, on the `game` branch).

## Limitations

### A. Reasoning design
| # | Limitation | Evidence | Impact |
|---|---|---|---|
| A1 | **The prompt is a fixed script.** It's a numbered turn plan, so the model mostly follows steps instead of planning. | `app/prompts.py` LIVE_PROMPT | Judges may read it as "a pipeline with a narrator"; the agent is weak on novel questions |
| A2 | **The hypotheses are fixed per case type.** The model can't propose a new explanation ("two buildings share this address", "the list confused the parcel"). | `evidence.CASES` | Wrong-but-confident verdicts when the truth sits outside the menu |
| A3 | **The check menu is fixed and small** (5 per case), and there is no "fetch more evidence" path beyond it. | `CASES[...]["checks"]` | The investigation stops early, at "unresolved" |
| A4 | **No value-of-information logic.** The model picks checks by intuition; nothing estimates which check would move the posterior most. | The prompt asks for "2-3 checks" | Wasted calls (e.g. a vision call on a building whose vision answer was can't-tell before) |
| A5 | **No self-critique step.** Nothing reviews the verdict against the evidence trail before it's drafted. | — | An overconfident narrative can pass |
| A6 | **Memory is notes only.** The agent remembers what people said (`record_note`), but doesn't learn which checks were useful or which sources were wrong. | Store namespaces `notes`, `memories` | No improvement over time (Amazon's "adaptive intelligence" rubric) |

### B. Evidence weights and calibration
| # | Limitation | Evidence | Impact |
|---|---|---|---|
| B1 | **Priors and deltas are hand-set guesses**, e.g. material_conflict priors .45 / .35 / .20; a compliance filing is +0.35. | `app/evidence.py` | Confidence numbers aren't calibrated; "73%" isn't a measured 73% |
| B2 | **There's no labelled ground truth.** We can't measure how often "likely" is right. | No eval set exists | We can't defend confidence numbers to a judge |
| B3 | **The evidence is treated as independent and added up.** Correlated checks (two permit-based checks) double count. | `weigh_case` adds deltas | Overconfidence |
| B4 | **The label thresholds are arbitrary** (likely ≥ .6, or ≥ .5 with a .3 margin). | `weigh_case` | Labels flip near the edges |

### C. Vision
| # | Limitation | Evidence | Impact |
|---|---|---|---|
| C1 | **It can't detect tuck-under (soft-story) parking.** | Tiled re-test: 1/5 true hits on listed soft-story buildings after a human check, plus 1 false positive (shadows read as bays). Whole-frame reads: 0/5 | We can't claim "the city's list missed this one" |
| C2 | **Downscaling hides ground-floor detail.** | A full-resolution crop of 7769260's south wing clearly shows carport bays that the whole-frame read missed | Most failures are an input problem, not a model problem |
| C3 | **Tiles pull in neighbours.** Full-frame tiles judge the wrong building. | 5912364's "hit" was a background building | False positives |
| C4 | **Obliques miss the parking side.** The open side often faces a narrow alley the 4 obliques can't see. | Run 3 crops: ground floor occluded | A data ceiling: some buildings can't be judged from the air |
| C5 | **Footprint-cropped obliques fail on complex outlines.** Outlines of 500+ vertices break the oriented-image lookup. | 3 of 10 returned no imagery | Use a bounding-box WKT |
| C6 | **Material from facades is hard.** It's fine for exposed concrete, but masonry vs concrete is often "can't tell". | 247337 and 6375735 read concrete; 52227 read can't-tell | Some conflicts stay unresolved |
| C7 | **Only Gemini is usable.** Claude Opus 5.5 is enabled on Vertex, but its quota is 0 (429 in global, us-east5, us). | `RADAR_VISION_MODEL` switch exists; the A/B never ran | No second model to compare or ensemble |
| C8 | **Second-look bug (fixed in 6f69a4d).** The skeptic said "the analyst is incorrect" yet returned confirmed=true. Now the second look gives its own answer and must match. | — | Earlier cached reads were re-checked and hold |

### D. Models, latency and reliability
| # | Limitation | Evidence | Impact |
|---|---|---|---|
| D1 | **Gemini stalls.** One gemini-4-argon turn took 84–113 s, and a 38 s stall was seen. | The worker was switched to 3.8 Flash; live calls are cut at 8 s and fall back | Fallbacks can change wording mid-run |
| D2 | **Live runs take 12–33 s per case** (scout 18 s). | demo_flow 5/5 passes | Fine for the demo, slow for interactive use |
| D3 | **Thinking is set to "low" or "minimal" everywhere for speed.** | `RADAR_*_THINKING` | We trade reasoning depth for latency; that has never been measured |
| D4 | **`langgraph dev` runs one job at a time locally** (raised to 4 with `--n-jobs-per-worker 4`). | — | The worker and live runs can queue behind each other |
| D5 | **Gemini returns content as blocks with signatures**, not plain strings. | The UI joins the text parts | Any new consumer must handle blocks |

### E. Data coverage (limits what reasoning can conclude)
| # | Limitation | Evidence |
|---|---|---|
| E1 | **Vexcel data is cached for only 173 of 1,581 LA kit buildings**, and only 12 of 1,417 LA multifamily buildings | Fresh pulls take ~10–15 s each |
| E2 | **Vexcel roof condition is graded for only 59 of 161 LA roofs**, and the scale's direction is undocumented | — |
| E3 | **Vexcel entrance elevation was null in our samples; vehicle counts were null on 14 of 16 captures** | Car counts come from our own detection instead (weak evidence) |
| E4 | **Matterport: 1,126 of 1,185 cached twins are single-floor suite tours.** Every model's `created` date is the event import date (2026-11-10), not the capture date | Use the attachment `originationDate` for tours |
| E5 | **CoStar's construction material field disagrees with the city's concrete list on 57 of 69 matches** | Unknown which source is usually right (see B2) |
| E6 | **25 aerial outlines are bigger than their parcel**, so the agent refuses to compare | — |
| E7 | **Address matching is ZIP + normalised street.** Some ranges and odd formats still miss | `app/retrofit_lists.py`, `app/costar.py` |

### F. Found while documenting (verify before relying on them)
| # | Issue | Where | Fix |
|---|---|---|---|
| F1 | **Strict replay doesn't cover vision.** `RADAR_REPLAY_STRICT` blocks only the chat models, so a vision question whose answer isn't cached in `fixtures/vision/` calls the live vision model even in strict replay | `app/vision.py`, `app/replay.py` | Pre-warm every vision read used in the demo, or make vision honor strict replay (raise on a cache miss) |
| F2 | **The vision cache key doesn't include the second-pass prompt**, so changing the skeptic prompt reuses old answers | `app/vision.py` | Add the second-pass prompt (or a version string) to the hash; delete the cached JSON after prompt changes |
| F3 | **`/healthz` reports `cached` for an unset `RADAR_LAYER_*`, but the loader defaults to `auto`** (it may fetch live) | `app/routes.py` vs `app/layers.py` | Report the real default |

## Plan B: workstreams in priority order

### P1. A labelled evaluation set: **do this first** (≈2–3 h)
Without ground truth, every other improvement is a guess.

**Tasks**
1. `evals/` (new folder; gitignored if it holds licensed values): `evals/build_set.py` writes `evals/cases.jsonl` with ~30 cases:
   - 15 material_conflict;
   - 8 stale_entry;
   - 7 ghost_tenant.
2. **Label each case by hand from evidence a human can check:** permit PDFs or descriptions, the cached aerial and oblique images, the suite tours.
   - Fields: `truth`, `confidence_of_label`, `source_of_truth`.
   - Leave unsure cases unlabelled.
3. `evals/run_eval.py`:
   - runs `evidence.open_case` → all checks → `weigh_case` offline (no model), and
   - optionally the live agent (`--live`, the model picks the checks).
   - Reports accuracy by label (likely, leaning, unresolved), a calibration table (predicted vs observed), and the average number of checks used.
4. Optional: push the set to a LangSmith dataset and run the agent as an experiment.

**Done when:** `uv run python evals/run_eval.py` prints accuracy and a calibration table, and is reproducible offline.

### P2. Vision v2: targeted crops and a stricter protocol (≈3–4 h)
**Tasks**
1. **Target the building, not the frame:**
   - project the building's footprint into each oblique (or use a bounding-box WKT, C5);
   - cut **facade bands**: the ground-floor band for parking, the full facade for material;
   - pass full resolution to the model and drop tiles that mostly show other buildings.
2. **Multi-view voting:** ask the same narrow question on 2–4 views. A finding needs ≥ 2 confirmed views; otherwise it's "can't tell".
3. **Few-shot exemplars:** include 2 reference crops (one positive, one negative) per question. Use cached images of buildings that aren't eval cases.
4. **A model A/B:** `RADAR_VISION_MODEL=claude-opus-5-5` once the quota lands. Keep answers cached per model, and compare them on P1.
5. Keep the independent second look, and keep the ±0.2 cap until P3 calibrates it.

**Done when:** on the P1 set, vision accuracy is reported per question (material, replaced, tuck-under), and tuck-under on the 10 probe buildings beats 1/5 with ≤ 1 false positive. If it doesn't, document it and leave tuck-under out of the product.

### P3. Calibrate the evidence weights (≈2 h, needs P1)
**Tasks**
1. Fit priors and per-check deltas from the labelled set: a simple per-case logistic regression, or a smoothed Naive Bayes on check outcomes.
2. Report the calibration before and after; keep the caps.
3. Handle correlated checks (B3): group permit-based checks and take the max within the group, not the sum.
4. Reset the label thresholds so "likely" is ≥ 80% observed accuracy on the set.

**Done when:** `evidence.CASES` priors and deltas come from a checked-in fit script (fitted values only, no licensed data), and calibration improves on a held-out split.

### P4. Make the agent actually reason (≈3–4 h)
1. **Value-of-information hint (code):** `open_case` returns, for each unused check, the expected posterior change, computed from the calibrated deltas and the check's historical "can't tell" rate. The prompt tells the model to justify its pick ("I chose X because…"). The model still chooses.
2. **An open hypothesis:** add an `other` hypothesis with a small prior to every case. If evidence fits no listed hypothesis, the verdict says so instead of forcing a pick.
3. **A critic step (cheap):** before drafting, one critic call (Flash) reads the evidence trail and must answer "does the verdict follow? yes / no + why". On "no", the label drops to unresolved. Gate it with a flag (`RADAR_CRITIC=1`) so it can be turned off for latency.
4. **A stop rule:** stop when the posterior lead is ≥ .3, or when no unused check has an expected change above .05.
5. **Learning from approvals:** store which checks moved cases that people approved, and feed the counts into the value-of-information hint. That's the adaptive-intelligence story.
6. **Prompt:** replace the numbered script with goals plus constraints (keep the 3-turn latency budget), and re-record the replay.

**Done when:** on P1, accuracy is ≥ today's with the same or fewer checks per case, and the LangSmith trace shows the model's stated reason for each check.

### P5. Reliability and latency (≈1–2 h, any time)
1. Measure thinking levels: run P1 with orchestrator thinking low vs medium, and report accuracy vs seconds.
2. Run slow vision checks as an async subagent (deepagents 0.7.37 has one; beta) so the answer can stream before the image read finishes. Only after the demo.
3. Prefetch Vexcel images for any building the queue might open (a background worker job).

## What fits before Sunday's demo vs after
| Before the 10 pm freeze (safe) | After the hackathon |
|---|---|
| P1 eval set (offline only) | P3 calibration in the product |
| P2 crops plus voting, measured offline | P4 prompt rewrite (needs a replay re-record) |
| P5.1 the thinking-level measurement | P5.2 async vision |
| A one-page result for the pitch: "we measured X% accuracy on N hand-labelled cases" | |

**Never merge into `main` or `game` before the freeze without the coding lead's OK, a full test run and a strict replay check.**

## Quick reference
- **Run:** `uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --n-jobs-per-worker 4`
- **Tests:** `uv run pytest -q`
- **Models:** `RADAR_ORCH_MODEL`, `RADAR_FAST_MODEL`, `RADAR_SPEC_MODEL`, `RADAR_WORKER_MODEL`, `RADAR_VISION_MODEL`, `RADAR_*_THINKING`, `RADAR_MODEL_TIMEOUT_S`, `RADAR_MODEL_RETRIES`
- **Replay:** `RADAR_REPLAY=record:<name>` / `RADAR_REPLAY=<name>` / `RADAR_REPLAY_STRICT=1`
- **Demo helpers:** `scripts/demo_reset.py`, `scripts/demo_flow.py --runs 5`
- **Where things live:** see `docs/ARCHITECTURE.md` and the part docs (AGENT, BACKEND, FRONTEND), plus `docs/CONTRIBUTING.md`.
