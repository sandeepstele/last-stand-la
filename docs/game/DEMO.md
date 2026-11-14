# Last Stand LA: demo script and ops

## The 2-minute stage cut (current; Entertainment track; `?demo=1` on strict replay)

The user's decisions (1:50 pm): **Entertainment**; the deep agent is always visible and running; two doors stays (dawn flips to the auditor).

- **Normal mode** is the full Night Shift (a judge who plays walks both cases).
- **`?demo=1`** is the stage cut:
  - case #7 is worked by the agent from the records right after the briefing, while you head for case #6;
  - [F] fast-forwards the walk, the defence and the escape.
- **Never** use `agent=off` or `stub=1` on stage.

| Time | On screen | Say |
|---|---|---|
| 0:00 | Intro camera over real downtown LA | "Building records go stale. CoStar's record of this building says masonry; the city's retrofit list says concrete. Nobody has gone to look. Our deep agent works CoStar's queue of 328 cases like this, and tonight you're its eyes." |
| 0:12 | Enter. The HQ panel shows the agent's briefing (#6 and #7 from the real queue), then works #7. F to the door; scout radio; the drone shows the aerial it looked at | "It plans the night from the real queue, sends four squads in parallel, and looks at the aerial itself. Code weighs it." |
| 0:35 | E: inside the building's real 3D tour. [1] Concrete; the odds move | "So I go in and look. My report is evidence: capped, never final." |
| 0:55 | Step out; the horde; HQ proposes RUN or HOLD. Press the key; F | "The agent proposes; I decide. Code rolls the walls against the 1994 Northridge shaking at this block." |
| 1:10 | Aftershock, dawn, "File the report" | "And the night produced something real." |
| 1:15 | The auditor: the case file with your report as a person's report, the draft correction, the queue (#6 of 328; #7 already worked) | "Same agent, auditing CoStar's records: it worked case 7 from the data while I ran. **It checks CoStar's records against the city's lists, Vexcel aerials and Matterport tours together: 328 open cases in the queue. Tonight you saw two of them.** The other 326 it works overnight." |
| 1:50 | Close | "Settle tonight's cases and make it to dawn: every night, real records get checked." |

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
| Facade vision | **247337** | The city says concrete, CoStar steel; the agent saw concrete fins, and a second look confirmed it: *likely concrete (0.73)* |

**Words to avoid:**
- Never call the corner views "live feeds". They are **game camera views** (renders of the scene). The real imagery is the **ground** (the Vexcel mosaic) and the photos **HQ looked at** (marked "HQ evidence · real image").
- The breadth claim "568 buildings screened across Houston and LA" comes from the earlier verifier screen (266 consistent, 247 worth a look, 55 refused). **Confirm what it covers before saying it.** The safe numbers are 328 open cases; 226 LA buildings on retrofit lists; 61 unfinished; 12 of 69 concrete records agree.

**Acceptance:**
- `?demo=1` on strict replay, with F at approach and escape.
- Enter → the auditor case file in ≤ 1:20.
- 3 clean runs.
- The HQ panel shows an active agent task at every beat except the escape.
- The ≤ 2-minute video follows the same cut.

## The 2-minute table demo (on foot only, older script)

| Time | On screen | Say |
|---|---|---|
| 0:00 | The intro: the camera circles real downtown LA | "Every building here is real: CoStar's record, the city's retrofit orders, Vexcel's aerials, Matterport's tours." |
| 0:15 | Start; walking toward the hero building; the radio comes alive | "My commander is a LangChain deep agent. Four squads read the records in parallel… and they disagree: CoStar says masonry, the city's retrofit list says concrete." |
| 0:30 | The DRONE feed flips to the real aerial: "HQ looked: concrete frame visible" | "It doesn't guess. It picks the evidence and looks at the aerial itself. Code weighs it: 66% concrete." |
| 0:45 | [E] at the door: the real interior (its own 3D tour). Press [1] "Concrete" | "So I go in and look. My report is testimony: it moves the odds, capped, never final. 72% now." |
| 1:05 | Step out: the horde comes down the street from the west. "HQ proposes: RUN to [fallback]." Press [R] | "The agent read the horde, found a fallback away from it, and it waits for me. I make the call." |
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
3. **Between judges:** `uv run python scripts/demo_reset.py`, then press Enter on the dawn screen (or reload).
4. **Fallback ladder:**
   1. Live mode, if replay misbehaves (`RADAR_REPLAY` unset; timings in CONTRACT.md).
   2. The map mode `/play` (live only).
   3. The auditor at `/` (tag `auditor-v1`).
   4. The recorded video.
5. **Before the video:** confirm with CoStar whether real addresses may appear. Otherwise hide labels or crop.
6. **Never** edit `app/` on the demo machine while judges are around; the server has no hot reload.
