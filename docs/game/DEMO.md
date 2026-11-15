# Demo: Bob's Desk (the 2-minute pitch)

One pitch for the judging table and the video voice-over (the shots are in VIDEO_SHOTLIST.md). About 300 spoken words: a calm 2 minutes. **The stage cut (`?demo=1`) is Day 1 only**; the later days and the career summary get one spoken line and are for play at the table. **[TEAM]** marks a human decision. Framing: **the agent is the main character; Bob corrects it, and the aftershock grades them both.**

**Setup:** reset first (Play again, or `uv run python scripts/demo_reset.py`), then `http://127.0.0.1:3112/play?mode=foot&demo=1` (or the production build). Put `/play/log` on a second screen facing the judges. One client on the agent server. **Never** use `agent=off` or `stub=1` on stage.

**One-liner (open and close with it):** "Bob's Desk: a deep agent does the work, you correct it, and the aftershock grades you both."

| Time | On screen (keys) | Say |
|---|---|---|
| 0:00–0:10 | Title over downtown LA (Enter) | "After Northridge, inspectors tagged 66,000 buildings green, yellow or red, often in under half an hour each. I'm Bob, LA building office, one shift." |
| 0:10–0:25 | The desk opens; the first radio line: *"Last shift Bob changed my yellow to red at 601 Broadway, and the aftershock showed red was right."* | "My analyst is a LangChain deep agent, and it opens with what it learned from me yesterday. My corrections become its lessons." |
| 0:25–0:40 | Cards fill line by line, one source per line; the amber masonry-vs-concrete box; the city map (Tab to close) | "Real open cases from CoStar's data. It sends four squads in parallel, and every building gets a card: CoStar, Vexcel, Matterport, city lists, the county assessor. Amber where sources disagree." |
| 0:40–0:58 | F to 737 Broadway, E inside its 3D tour, **1** concrete; the calculation 66% → **73%** | "On records alone, probably masonry. I walk in and report concrete. My report is evidence, capped at 0.35, never final: 73% concrete now." |
| 0:58–1:20 | E out: **"Simulated quake at 5:02 pm"**; people run, cars stop; "Simulated aftershock in 0:45"; two HELP beacons; HQ proposes **YELLOW** ("code suggests YELLOW"); press **3** RED; walk Maya and Luis to the green assembly point | "A simulated quake. Aftershock in 45 seconds, two people trapped. The agent proposes yellow and waits for me. 251 people work here: red. And I get those two out." |
| 1:20–1:42 | Dawn: complete damage; RED kept 251 of 251 safe; "Rescue: 2 of 2"; **Agent vs Bob**: "Bob was right; the agent was wrong" | "Complete damage. Red kept all 251 safe; yellow would have left 25 inside. I overrode the agent and I was right, and that goes into its log for tomorrow. Every call is also saved as a preference pair, the format RLHF uses. We didn't train anything tonight; we collect it." |
| 1:42–2:00 | `/play/log` scrolling; File the reports → the auditor case with Bob's report | "Every number is published maths in code: FEMA screening, HAZUS damage, ATC-20 placards. Tomorrow is a different building, and the agent opens it with today's correction. Bob's Desk: a deep agent does the work, you correct it, the aftershock grades you both." |

**The memory line on stage:** The first shift after a reset opens from a seeded previous shift (601 Broadway); after that, each shift opens with what Bob actually corrected last time. So the opening line in the pitch is the seeded one; say "what it learned last shift", not "from me today".

**After the pitch: the next days (at the table, not in the 2-minute cut).** At dawn, **Next day (k of 4)** (Enter) keeps the history; **New game** resets it. Day 2's first radio line names the correction the judge just made on Day 1, which is the best live proof of the memory. **Days 2 to 4 have no aftershock** (no clock, no rescue): dawn shows the expected outcome of Bob's tag on the building's own odds, and whether it matches the code's suggestion. After Day 4, the **career summary** totals:
- tags right (Day 1 against the aftershock, Days 2 to 4 against the screening);
- people kept safe (Day 1 actual, Days 2 to 4 expected, labelled);
- records fixed;
- the Agent vs Bob record.

**Between judges, never Next day.** The career is saved per browser, so do both steps:
1. Press **New game**, either on the dawn screen or on the intro's "Career in progress: Day k of 4 … New game (Day 1)" bar.
2. Reset the server: `uv run python scripts/demo_reset.py`.

If New game isn't reachable, run this in the browser console:

```js
localStorage.removeItem("laststand.career.v1"); localStorage.removeItem("laststand.track.v1"); localStorage.removeItem("laststand.feedback.v1")
```

Every judge then starts on Day 1 from the seeded line.

| Day | Building (office suite) | Records disagree on | People | Dawn |
|---|---|---|---|---|
| 1 | 737 Broadway (suite 1100, 122 7th St) | Masonry vs concrete | 251 | Simulated aftershock |
| 2 | 621 Spring St (suite 404, 724 Spring St) | Steel vs concrete | 106 | Expected outcome |
| 3 | 730 Los Angeles St (suite 1400, 122 7th St) | Masonry vs concrete | 201 | Expected outcome |
| 4 | 620 Main St (a suite at 724 Spring St) | Masonry vs concrete | 40 | Expected outcome |

If a judge plays Day 2, a good line: "red on 621 Spring when the code says yellow keeps everyone out of harm but displaces about 26 people. That's the trade-off a real officer makes."

**Read the numbers off the screen** (66%, 73%, 251, 25, YELLOW → RED). If the recording differs, say what the screen shows. If Bob doesn't get Maya and Luis out, the aftershock still hits at 0:45 (dawn waits up to 75 s after the quake); say "I didn't make it to them" and move on.

**Simulated:** say "simulated quake" and "game outcome" at least once each. The video's lower third carries "Simulated post-quake placards. Game outcomes, not engineering assessments."

**Ops:** one client at a time on the agent server (a second tab or a script starting a shift clears the first one's notes). A reload mid-shift shows "Saved shift … Enter continues it". New game (or Play again) between judges, not Next day. **Replay by day:** Day 1 is the strict, recorded stage. Days 2 to 4 run in **fill** mode: the first play of a day calls the live model (about 15 s per inspect step) and records it, so later plays of the same path replay fast. Before pressing Next day for a judge, say "this day is live, so the agent takes a few seconds per step". Better still, play Days 2 to 4 once before judging so their usual paths are already recorded. The night game (Last Stand LA) is the fallback: `NEXT_PUBLIC_GAME_GRAPH=laststand`; its script is below.

## If a judge asks

- **"Is the AI deciding?"** "No. The agent decides what to check and what to propose, code computes every number, and the person makes the call. The placard is an interrupt the agent can't get past without me."
- **"Where do the numbers come from?"**
  - FEMA P-154 Level 1 screening, Very High seismicity.
  - The USGS 1994 ShakeMap at each building, converted with Worden et al. 2012.
  - HAZUS fragility and indoor casualty rates.
  - People from IBC occupant loads, CoStar employees or occupied square feet, and HAZUS time-of-day shares (5 pm counts as commute).
  - ATC-20 posting categories; yellow at half the red threshold, from ATC-138.
- **"Why does better evidence still end in red?"** "Settling masonry versus concrete matters less than the building's age and the shaking. The evidence made the record more accurate, and the odds still said 'old building, strong shaking.'"
- **"Isn't yellow always safest?"** "Not any more. Yellow allows limited entry, so 10% are exposed if the damage is serious, and 25% are displaced if it's minor. Both are labelled game shares."
- **"Is the agent learning, is this RLHF?"** "It learns in context: my override and how it turned out go into its shift log, and the next shift opens with that lesson. (On stage we start from a reset, so the first shift opens from a seeded previous shift; play a second shift and it opens with your real correction.) Every decision and every thumbs up or down is also saved as preference pairs in the format RLHF and DPO use. We didn't train any weights tonight; we collect the data."
- **"Is there more than one day?"** "Yes, four. Each day is a different real building in the district, and the agent carries its log forward, so it opens Day 2 with your Day 1 call. The aftershock is Day 1 only; on later days the code grades your tag on the building's own odds. After Day 4 you get a career summary: people kept safe, tags right, and you versus the agent. Same honesty: it's in-context memory; no weights change." Offer to press Next day.
- **"Is it live?"** "The stage run is a recorded replay of the real agent, so it's repeatable. The data, tools and images are live." Offer one live building card from the map.
- **"What about the whole city?"** "All 1,581 LA buildings in the kit, screened from records alone: 918 green, 446 yellow, 217 red suggestions. Those are odds for a commercial sample, not a prediction."
- **"What's different from other projects?"** "Most entries use code for the numbers and a person to approve. We found none that models earthquakes, and none where the cost of a wrong call plays out on a clock. A past Claude Code hackathon winner put AI at the permit counter before a building is built; Bob puts it at the counter after the quake, and lets you overrule it."

## Per-judge first lines
- **Entertainment:** "A desk game about one real decision: green, yellow or red, with 251 people inside."
- **CoStar:** "Inside and out: the plot is a CoStar record two sources disagree on, you walk the Matterport scan, the agent reads the Vexcel aerial, and your report reaches the real case."
- **LangChain:** "A todo plan, four parallel sub-agents, a critic sub-agent on a second model, a placard interrupt the player answers, and a shift memory that turns the player's overrides into the agent's next-morning lesson. Every step is in the log on the second screen."

## Words to avoid
- A record or an owner is "wrong". Say the records **disagree**.
- "Real-time feeds", or "prediction" for the citywide screen.
- "Non-compliant" for an unfinished retrofit.
- Company or tenant names from the records.
- **[TEAM: addresses on screen only if CoStar OKs it.]**

---

# Appendix: Last Stand LA (the night game, fallback)


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
- **The agent log, for judges:** press [L] in play for the live log beside the game: who acted, which data it pulled, and the arithmetic behind each verdict (0.45 → +0.20 aerial, +0.12 filings → 66%; with your report + the 3D scan → 73%). Best on a second screen facing the judges: open `http://127.0.0.1:3000/play/log` in the same browser; it follows the live night, then the auditor run filed from it. The pause menu has the same log under "Agent log".
- **Save and Continue:** the game saves after your suite report, after your walls report and at dawn. After a reload or a crash, the intro shows "Saved night … Continue": it reattaches the same thread and never re-sends a message (tested 9:09 pm: reload inside 737 → Continue → the wave replayed strictly).
- **Walk-by aerials:** the corner view shows the nearest building's real Vexcel image when one is on file (106 buildings), labelled "Real aerial on file".
- **Honesty:** real images and tours only where they're on file. Otherwise the corner views are game renders. Images feed the screen only; the agent's recorded evidence is unchanged.
