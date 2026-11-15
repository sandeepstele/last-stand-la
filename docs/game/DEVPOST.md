# Devpost draft + video shot list: Bob's Shift

Rewritten Sat Nov 14, ~11:30 pm, after the pivot from the night game. **Track: Entertainment.** Specials to consider: CoStar "Inside and Out", LangChain "Best use of deepagents". Items marked **[TEAM]** need a human.

---

## Title
**Bob's Shift** [TEAM: confirm the name]

## Tagline
**A deep-agent game on real CoStar data, where your feedback is enforced.**

## Short description
You're Bob, a building officer at the city of LA on retrofit-deadline day. Real open cases from CoStar's queue land on your desk. Your analyst is a LangChain deep agent: its squads pull every building's data, code weighs the evidence, and you go see for yourself. At 5:02 pm a simulated quake hits; the agent screens each building and proposes a placard, and you post it. At dawn a simulated aftershock tests your tags: people kept safe, records fixed.

## Inspiration
Building records go stale quietly. CoStar's record of a downtown tower says masonry; the city's earthquake-retrofit list says concrete. Nobody has gone to look. AI can work a queue of 328 such cases (156 in LA), but its weak spot is human eyes on the building, and the person who has to make the call. So we made that person the player: a city building officer, with an AI analyst whose numbers are all computed in code.

## What it does
**1. A deep-agent game.** Bob's analyst is a LangChain **deepagents** agent you can watch work:
- it plans the shift from CoStar's real queue;
- it sends four squads in parallel (records, aerial, interior, city);
- it chooses its evidence and says why, and **looks at the aerial photo itself**;
- after the quake it screens the building and **proposes a placard, then pauses for Bob's call** (a human-in-the-loop interrupt);
- at dawn it drafts corrections, and **a second agent (the critic) reviews each one**.
- Judges can follow every step: the desk's calculation sheet, the **L** log beside the game, and `/play/log` on a second screen.

**2. Real CoStar data.**
- **Bob's desk** shows a live card per building, one line per source (CoStar record, Vexcel aerial, Matterport scan, LA retrofit lists, permits, the 1994 Northridge ShakeMap), with the fields where **two sources disagree glowing amber**.
- **The city map screens all 1,581 LA buildings** in CoStar's kit, in code, ranked by people at risk; click any one for its card (Vexcel pulled live if not cached).
- Site visits walk into the buildings' own **Matterport 3D tours**.

**3. Real feedback enforcement.**
- **What Bob reports on a site visit is evidence:** with the 3D-scan read it moves 737 Broadway from 66% to 73% concrete, **capped at 0.35**, never final.
- **It changes the decision:** the walls odds feed the screening score, the chance of serious damage, the people at stake and the tag the code suggests.
- **It reaches the real record:** the dawn draft cites Bob's words, the critic reviews it, and "File" opens the real auditor case with his report in it.
- **Code sets every number**; no record changes without human approval.

**The numbers behind a placard** (all code, cited): a FEMA P-154-style rapid screening score per material, weighted by today's odds; people inside from IBC occupant loads and HAZUS time-of-day shares (shown as an estimated range); ATC-20-style placards (green = safe to occupy, yellow = limited entry, red = unsafe). **Placards, the quake and the aftershock are simulated: game outcome, not an engineering assessment.**

## How we built it
- **The deep agent:** LangChain **deepagents** on LangGraph (graph `desk`): planning, four parallel sub-agents, case tools (open a case, choose checks with code-computed statistics, weigh the evidence), the desk tools (`building_card`, `screen_building`, `triage`, `tag_building` as an interrupt, `shift_report`), a critic sub-agent, and a small shift log it reads the next morning.
- **Rule: the agent makes the calls, code does the maths, Bob decides.** The proposed tag is pinned in code to the screening's suggestion; vision effects are capped at 0.2 with a second look; a person's report at 0.35.
- **Models:** Gemini on Vertex AI. A strict replay mode records model answers so the stage demo is repeatable; data, tools and images stay live.
- **The game:** Next.js, React and three.js; a Vexcel aerial mosaic for the ground; about 190 real building outlines with heights (OpenStreetMap, LA County); a day-to-night sky; Matterport tours and an untextured 3D scan inside; a save/continue that reattaches the agent's thread.
- **Data:** the CoStar hackathon kit (records, tenants, listings), Vexcel (aerials, obliques), Matterport (3D tours), LA open data (seismic-retrofit orders, permits), USGS ShakeMap.

## Challenges
- **We pivoted at 9 pm** from a zombie night game to Bob's office, because the user wanted a real mission the agent must calculate. The engine, the agent tools and the data carried over; the horde didn't.
- **Making the AI the main character:** its cards, maths and proposals are on screen, not in a chat box.
- **Honesty under game pressure:** records "disagree", never "wrong"; "unfinished" retrofit ≠ non-compliant; every placard labelled simulated; no colour before the quake (the agent can't pre-judge a building from records alone).
- **Making yellow cost something:** an early version made yellow a free win; limited entry now exposes people under serious damage, and dawn shows what each tag would have done on average.
- **A live demo with an AI:** strict replay, exact message contracts, one client at a time, and a reset between judges.

## Accomplishments
- A player's report from inside a real building becomes **capped evidence in a real case**, changes the placard decision, and lands in a reviewed draft correction.
- The same agent runs as both the game's analyst and a working records auditor (328 open cases).

## What we learned
**[TEAM: 2–3 honest sentences.]**

## What's next
- More case types on the desk (stale city-list entries with before/after aerials; ghost tenants across a whole building).
- A calibration set so evidence weights are learned, not hand-set.
- Multi-building shifts after the quake: triage order as a puzzle.

## Built with
langchain, deepagents, langgraph, python, gemini, vertex-ai, next.js, react, three.js, costar, vexcel, matterport, openstreetmap, usgs, la-open-data

## Honesty notes (keep on Devpost)
- Licensed CoStar, Vexcel and Matterport data is not in the repo; it is matched locally.
- The quake, placards and aftershock are simulated game events; the screening uses published methods (FEMA P-154, ATC-20, HAZUS occupancy) but is not an engineering assessment.
- **[TEAM: confirm with CoStar whether real addresses may appear in screenshots and the video.]**

---

# The 2-minute video shot list

Record on the production build (`npm run build && npm start`) against strict replay. Reset first, use `?demo=1`, F to skip walks, Tab for the desk.

| # | Time | Shot | Voice-over |
|---|---|---|---|
| 1 | 0:00–0:10 | Intro dive over all of LA; title "BOB'S SHIFT" | "I'm Bob. LA building office, retrofit-deadline day. Real buildings, from CoStar's data." |
| 2 | 0:10–0:28 | The desk: the inbox fills; cards fill line by line, each naming its source; the masonry-vs-concrete amber box; the city map | "My analyst is a deep agent. Four squads pull every building's data, and code weighs it. Here the records disagree." |
| 3 | 0:28–0:45 | Site visit: 737 Broadway's own 3D tour; press 1, concrete; the calc sheet 66% → 73% | "So I go look. My report is evidence: capped, never final." |
| 4 | 0:45–1:00 | Step out: "Simulated quake at 5:02 pm"; day to night; HQ proposes YELLOW, "code suggests YELLOW" | "A simulated quake. The agent screens the building and proposes a placard, and waits for me." |
| 5 | 1:00–1:10 | Press 3: RED | "251 people inside, the records still disagree. Red." |
| 6 | 1:10–1:30 | Dawn shift report: complete damage, RED was right, 251 of 251 safe, the "on average" row; the critic's review on the drafts | "The aftershock tests my tags. Every number is code, and a second agent checked the drafts." |
| 7 | 1:30–1:45 | File → the auditor case with my report | "Same agent, as CoStar's auditor. Nothing changes a record without a human." |
| 8 | 1:45–2:00 | `/play/log` step list scrolling; title card | "Every step on the record. Bob's Shift." |

**Capture tips:** 1920×1080 at 60 fps; V mutes in-game sound; hide the cursor; never show `?stub=1` or `agent=off`. **[TEAM: no street addresses unless CoStar OKs it.]**

---

# Appendix: the night game's Devpost draft (Last Stand LA, fallback)


Drafted Sat Nov 14, ~4:00 pm. **Track: Entertainment.** Specials to consider: CoStar "Inside and Out", LangChain "Best use of deepagents". Items marked **[TEAM]** need a human.

---

## Title
**Last Stand LA**

## Tagline
**A deep-agent game on real CoStar data, where your feedback is enforced.**

## Short description
You're the night shift for an AI auditor of CoStar's building records. A LangChain deep agent works CoStar's real queue of cases where records disagree, sends you into real LA buildings (their own 3D tours) to look, and enforces your report as evidence: capped, but strong enough to decide whether your walls hold tonight, and cited in the correction it drafts at dawn.

## Inspiration
Building records go stale quietly. CoStar's record of a downtown tower says masonry; the city's earthquake-retrofit list says concrete. Nobody has gone to look. AI can work a queue of 328 cases like this overnight (156 of them in LA), but its weak spot is human eyes on the building. So we made the human the player, and made the player's feedback count, within limits code enforces.

## What it does
**1. A deep-agent game.** Your commander is a LangChain **deepagents** agent, and you can watch it work:
- it plans the night from CoStar's real case queue with its own todo list;
- it sends four sub-agents in parallel (records, aerial, interior, city);
- it chooses which evidence to check, and says why;
- it **looks at the aerial photo itself** (the image pops up);
- it **pauses for your HOLD/RUN decision** (a human-in-the-loop interrupt);
- it drafts corrections at dawn.

**2. Real CoStar data.**
- The intro flies over **1,581 real LA buildings** with **156 open cases** (in 86 buildings) lit up.
- Tonight's cases are real: 737 Broadway (CoStar masonry vs the city's concrete list) and suite 1100 at 122 7th St (a 3-person office on record, but the suite is listed for lease).
- You walk on the Vexcel aerial and into the buildings' own **Matterport 3D tours**, stepping between real scan spots.
- City retrofit orders, permits and the 1994 Northridge ShakeMap set the stakes.

**3. Real feedback enforcement.**
- **What you report inside counts as evidence.** Together with HQ's read of the 3D scan, it moves the odds (66% → 73%), but your report is **capped at 0.35**: strong testimony, never final.
- **It decides your survival tonight.** On the demo night a "concrete" report makes the walls hold (they just beat a roll of 75); "brick" lets the horde in.
- **It reaches the real record.** At dawn the agent drafts a correction **citing your words**, and "File" opens the real auditor case with your report in it.
- **Code sets every number,** what the agent sees is capped at 0.2 with a second look, and **no record changes without human approval**.

**Side missions** are other real case types from CoStar's queue: is the office on record still there, is it the same building the city listed, and is this roof worth solar. Each is answered by code from the records, and "can't tell yet" is often the honest answer.

## How we built it
- **The deep agent:** LangChain **deepagents** on LangGraph.
  - **Planning:** `write_todos`.
  - **Sub-agents:** four specialists run in parallel (records, aerial, interior, city).
  - **Case tools:** open a case, choose checks with code-computed statistics ("moved the odds in 100% of the cases where it could run"), weigh the evidence.
  - **Human in the loop:** an interrupt for HOLD/RUN, plus capped human reports.
  - **Debrief:** a correction-drafting step.
- **Rule: the agent makes the calls, code does the maths, the engine runs the night.**
  - Every probability, score, roll and route is deterministic Python.
  - Vision effects are capped at 0.2 and need a second look; a person's report is capped at 0.35.
- **Models:** Gemini on Vertex AI. A strict replay mode records model answers, so the stage demo is repeatable; the data, tools and images stay live.
- **The game:**
  - Next.js and React with three.js.
  - The ground is a Vexcel aerial mosaic; about 190 real building outlines with heights come from OpenStreetMap and the LA County building survey.
  - Instanced zombies with flow-field steering, flares, a flashlight stun.
  - Procedural WebAudio and spoken radio.
  - Seven systems talk over a typed event bus.
- **Data:** the CoStar hackathon kit (records, tenants, listings), Vexcel (aerials, oblique images), Matterport (3D tours), LA open data (seismic-retrofit orders, permits), USGS ShakeMap.

## Challenges
- **Making the AI the main character, not a chatbot on the radio.** Its plan, squads, chosen evidence and odds live on screen. Big "moments" show the aerial it read and how your report moved the odds.
- **Honesty under game pressure:**
  - records "disagree", never "wrong";
  - "unfinished" retrofit ≠ non-compliant;
  - no company names;
  - every outcome labelled "game outcome, not an engineering assessment";
  - crates and flares are game items, not data.
- **Real geography is hard:** the fallback is 290 m around a real city block, so we added a drawn route and adrenaline.
- **A live demo with an AI:** strict replay plus exact message contracts, and a reset between judges.

## Accomplishments
- The judge's own report from inside a real building becomes **capped evidence in a real case** and changes the outcome.
- The same agent runs as both the game's commander and a working records auditor (**328 open cases** in its queue, LA and Houston).

## What we learned
**[TEAM: 2–3 honest sentences.]**

## What's next
- **More case types in the game:** stale city-list entries with before/after aerials, and car counts from the aerials.
- **A calibration set,** so the evidence weights are learned rather than hand-set (our teammate's evaluation work).
- **Night 2:** a different district from the queue.

## Built with
langchain, deepagents, langgraph, python, gemini, vertex-ai, next.js, react, three.js, costar, vexcel, matterport, openstreetmap, usgs, la-open-data

## Honesty notes (keep on Devpost)
- Licensed CoStar, Vexcel and Matterport data is not in the repo; it is matched locally.
- The quake is a labelled historical replay (1994 Northridge).
- The drone and camera corner views are game renders. The real images are the ground and the photos the agent looked at.
- **[TEAM: confirm with CoStar whether real addresses may appear in screenshots and the video.]**

---

# The 2-minute video shot list

Record on the production build (`npm run build && npm start`) against strict replay. Run `demo_reset` first, use `?demo=1`, and press F to skip walks.

| # | Time | Shot | Voice-over |
|---|---|---|---|
| 1 | 0:00–0:08 | The intro over all of LA (1,581 buildings, 86 case pillars, 156 open cases), diving into tonight's district; title "LAST STAND LA" | "Building records go stale. Here are 156 in LA where they disagree. Nobody goes to look." |
| 2 | 0:08–0:18 | Enter. The HQ panel: "Tonight's cases: #6 and #7"; the plan appears | "Our AI commander works CoStar's real queue of 328 cases (LA and Houston) where records disagree, and plans the night." |
| 3 | 0:18–0:32 | F to 737 Broadway's door. The radio; four squad chips light up; **"HQ looked at the aerial"** moment with the real image | "Four squads in parallel. It picks its own evidence and looks at the aerial itself." |
| 4 | 0:32–0:45 | E: the real 3D tour. Press 1, Concrete. The odds move (read the % off the screen) | "Then I go in and look. My report and HQ's read of the 3D scan move the odds. My report is evidence: capped, never final." |
| 5 | 0:45–1:00 | Step out facing the horde; HQ proposes RUN; press H instead; hold the door: shove, flare, stun, nail boards | "The agent proposes. I decide." |
| 6 | 1:00–1:10 | Walls hold (76 vs 75); the aftershock shakes the screen | "My concrete report is why the walls held. Code rolls every number." |
| 7 | 1:10–1:25 | Dawn: rank, "Records checked tonight", **the AI drafting corrections citing my words** | "At dawn it drafts real corrections, citing what I saw." |
| 8 | 1:25–1:45 | "File tonight's reports" opens the auditor: the case file with "the player" as a human report; the queue of 328 (LA and Houston) | "Same agent, as CoStar's auditor. The other 326 cases it works overnight." |
| 9 | 1:45–2:00 | Back to the city at dawn; title card | "Settle tonight's cases. Make it to dawn." |

**Capture tips:**
- 1920×1080 at 60 fps.
- Press V to mute in-game sound if recording the voice-over separately.
- Hide the cursor.
- Never show `?stub=1` or `agent=off`.
- **[TEAM: don't show street addresses unless CoStar OKs it. Crop the labels or blur them.]**
