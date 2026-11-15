# Last Stand LA: demo script and ops

## The 2-minute pitch: a deep-agent game, real CoStar data, real feedback enforcement

**One-liner (open and close with it):** "Last Stand LA is a deep-agent game built on real CoStar data, where your feedback is enforced: what you see inside a real building changes the AI's case, your survival, and a real record."

Run `?demo=1` on strict replay, reset first. Press [F] to skip walks. **Never** use `agent=off` or `stub=1` on stage.

| Time | Claim | On screen | Say |
|---|---|---|---|
| 0:00 | — | The intro over all of LA: 1,581 buildings, pillars on the 86 with open cases (156 cases) | The one-liner |
| 0:10 | **Real CoStar data** | The dive into tonight's district; the HQ panel lists case #6 and #7 of CoStar's queue | "Every building and every case is real, from CoStar's kit: 156 open cases in LA where the records disagree." |
| 0:20 | **Deep agent** | Enter. The agent's own plan; four squads light up; "HQ looked at the aerial" (the real image); "why HQ chose this check" | "The commander is a LangChain deep agent. It plans, sends four sub-agents in parallel, picks its own evidence and tells you why." |
| 0:40 | **Real CoStar data** | F to 737 Broadway; E: the building's own 3D tour; W to walk | "CoStar says masonry, the city says concrete. Nobody's been inside. Now I am: this is the building's real scan." |
| 0:55 | **Feedback enforcement** | Press 1, Concrete. "Your report moved the odds": 66% → **73%** in the final recording (brick → 56%, can't tell → 67%) | "My report, plus HQ's read of the 3D scan, moved the odds. My report is capped at 0.35: strong, never final. Code enforces that, not the model." |
| 1:05 | **Feedback enforcement** | Step out; HQ proposes **RUN** (the stay-vs-run line under it: code favours RUN on the scores); press H anyway; hold the door; the walls hold, **77 vs 75** | "The agent proposes, and it waits for me. I overrode it and held, and the walls held because of what I saw. Brick (72) or can't tell (74), and they'd have broken in." |
| 1:25 | **Feedback enforcement** | Dawn: the agent drafts the correction citing my words; File opens the auditor case with my report in it | "And it reaches the real record: a draft correction citing my words. A human approves it." |
| 1:45 | — | The auditor queue (328 cases, LA and Houston) | "Same agent, all night, every case. Deep agent, real CoStar data, real feedback enforcement." |

**If asked "what's enforced?":**
- code sets every number (odds, caps, rolls);
- a person's report is capped at 0.35;
- the agent's own image reads are capped at 0.2, with a second look;
- "can't tell" is valid;
- nothing changes a record without human approval.

**If asked "is it live?":** "The stage run is a recorded replay of the real agent, so it's repeatable. Here's one live case." Then open `/` and ask about a case (about 15 s).

**Why 737 Broadway is the winning card:** it's the only address where all three sponsor layers meet:
- the CoStar record;
- the Vexcel aerial the agent reads (shown on screen as "HQ looked from above");
- the Matterport tour you walk into.

Your report from inside changes the real case. That's "Inside and Out". Case #7 uses two layers (the CoStar listing and the Matterport tour, also popped up on screen while the agent reads it).

**If a CoStar judge asks "what else does it use?":** open one of these in the auditor (`/`). These cases already work there; nothing new to record.

| Show | Case | What it proves |
|---|---|---|
| Before/after aerials | **11547997** (stale entry) | The agent compared the 2021 and 2026 Vexcel captures: a pitched roof became a new flat-roof building, matching a 2022 demolition permit: *likely replaced (0.98)* |
| Car counts ("sharp enough to count parking spaces") | **362982** | Cars on the lot fell from 47 to 29 between aerial captures (−38%). The agent counts it only as weak evidence |
| A ghost tenant + Matterport | **247386, suite 300** | CoStar records a 50-person office; the suite has been listed 15 months; the tour after the listing reads "furnished but unoccupied" |
| Facade vision | **247337** | The city says concrete, CoStar steel; the agent saw concrete fins, and a second look confirmed it: *likely concrete* (read the % off the screen) |

**Words to avoid:**
- Never call the corner views "live feeds". They are **game camera views** (renders of the scene). The real imagery is the **ground** (the Vexcel mosaic) and the photos **HQ looked at** (marked "HQ evidence · real image").
- The breadth claim "568 buildings screened across Houston and LA" comes from the earlier verifier screen (266 consistent, 247 worth a look, 55 refused). **Confirm what it covers before saying it.** The safe numbers are 328 open cases in the queue (156 in LA, 172 in Houston); 226 LA buildings on retrofit lists; 61 unfinished; 12 of 69 concrete records agree.

**Acceptance:**
- `?demo=1` on strict replay, with F at approach and escape.
- Enter → the auditor case file in about 1:01 on the strict `?demo=1` path with F (measured 9:35 pm, final recording, critic on): scout done at 11 s, dawn drafts at 46 s. Dawn and the auditor show the same % (same checks).
- 3 clean runs.
- The HQ panel shows an active agent task at every beat except the escape.
- The ≤ 2-minute video follows the same cut.

## The 2-minute table demo (on foot only, older script)

| Time | On screen | Say |
|---|---|---|
| 0:00 | The intro: the camera circles real downtown LA | "Every building here is real: CoStar's record, the city's retrofit orders, Vexcel's aerials, Matterport's tours." |
| 0:15 | Start; walking toward the hero building; the radio comes alive | "My commander is a LangChain deep agent. Four squads read the records in parallel… and they disagree: CoStar says masonry, the city's retrofit list says concrete." |
| 0:30 | The DRONE feed flips to the real aerial: "HQ looked: concrete frame visible" | "It doesn't guess. It picks the evidence and looks at the aerial itself. Code weighs it." (read the % off the screen) |
| 0:45 | [E] at the door: the real interior (its own 3D tour). Press [1] "Concrete" | "So I go in and look. My report is testimony: it moves the odds, capped, never final." (read the new % off the screen) |
| 1:05 | Step out: the horde comes down the street from the west. "HQ proposes HOLD or RUN" (code suggests one; the agent decides). Press [H] or [R] | "The agent read the horde, found a fallback away from it, and it waits for me. I make the call." |
| 1:20 | Sprint along the route, chased; Space shoves; the doors shut. Aftershock | "The walls roll against the scores, and the aftershock against the 1994 Northridge shaking at this exact block. Seeded, so every number is code." |
| 1:40 | Dawn: the case file and the draft correction | "And at dawn, the night produced something real: the evidence and a correction to a building record, for a human to approve. Game outcome, not an engineering assessment." |

**Variant (if time or a judge asks):**
1. Play again.
2. Answer [2] "Brick": the odds drop to 54%.
3. HOLD: the walls are 71 vs a roll of 78, so they break in. Run.

**Per-judge first lines:**
- **CoStar:** "Inside and out: you walk on the Vexcel aerial and into the Matterport tour, and the plot is a CoStar record the city disagrees with."
- **LangChain:** "todos, four parallel subagents, model-chosen case tools, an interrupt a player answers, a capped note from a human. The trace is in the other tab."

## Ops checklist

1. **Agent server** (primary):
   ```
   RADAR_REPLAY=game RADAR_REPLAY_STRICT=1 uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --no-reload --n-jobs-per-worker 4
   ```
   Then check that `curl -s 127.0.0.1:2024/healthz` shows `"replay":"game"`.
   - **Pacing:** `RADAR_REPLAY_DELAY_S` (default 1.0 s, judge-like; the primary verifies at 0.3).
   - **Never put `RADAR_REPLAY` in `.env`:** under `langgraph dev`, `.env` overrides the shell, so the server would be stuck in replay.
   - **Verify or re-record:** `scripts/game_nights.py` (see CONTRACT.md).
2. **Web:** `cd web && npm run build && npm start` (production; port 3000). Open `http://127.0.0.1:3000/play?mode=foot` once to warm it up.
3. **Between judges:** press Enter on the dawn screen (Play again resets the night, restores the night log and re-seeds the auditor). From a terminal: `uv run python scripts/demo_reset.py`. The server also resets tonight's cases at each "Brief the night shift".
   - **Let the case file finish before the next night starts.** A new briefing clears tonight's notes, and the case file reads your report from them, so a night started from anywhere (a second tab, a script) while "File the reports" is still answering makes its replay miss (seen once at 8:41 pm). One client only: no second tab, no test scripts against :2024 while judges play. A reload or crash is safe; Play again between judges.
   - **One browser tab** on the game during judging. Close every other tab on :3000 / :3110.
4. **Fallback ladder:**
   1. Live mode, if replay misbehaves (`RADAR_REPLAY` unset; timings in CONTRACT.md).
   2. The map mode `/play` (live only).
   3. The auditor at `/` (tag `auditor-v1`).
   4. The recorded video.
5. **Before the video:** confirm with CoStar whether real addresses may appear. Otherwise hide labels or crop.
6. **Never** edit `app/` on the demo machine while judges are around; the server has no hot reload.

## New since 6 pm (show at the table, not in the 2-minute cut)
- **All of LA:** the intro dive over 1,581 buildings and the 156 open LA cases (86 buildings).
- **Walk into 16 real buildings:** any lit door, [E]. 750 Broadway is a good one near the fortress.
- **Inside 737 Broadway:** walk its 19 real scan spots ([W]/[S], or click the floor plan), with the untextured 3D scan.
- **Side missions, careful:** don't stamp "Same building?" at 217 8th St on stage (its record says 13 stories in a ~22 m building, which a CoStar judge will catch). Solar never says "go solar" because roof age is taken from building age; don't present "check the roof first" as a finding about the roof.
- **Walk-by aerials:** the corner view shows the nearest building's real Vexcel image when one is on file (106 buildings), labelled "Real aerial on file".
- **Honesty:** real images and tours only where they're on file. Otherwise the corner views are game renders. Images feed the screen only; the agent's recorded evidence is unchanged.
