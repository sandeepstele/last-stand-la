# Devpost: Bob's Desk

Merged Sun Nov 15, ~1:15 am, from the 10:30 pm drafts (DEVPOST_DRAFT.md) and the build on `desk` a4279e2 (merged into `game`). Updated ~1 am for the multi-day game: four days and a career summary, from the backend's `days` branch (f20408e). The simulated aftershock is Day 1 only. One document; the video shot list is in VIDEO_SHOTLIST.md and the spoken pitch in DEMO.md. Not posted. Items marked **[TEAM]** need a human decision.

**Track:** Entertainment. **Special tracks (if allowed):** CoStar "Inside and Out: AI for the Built World"; LangChain "Best use of deepagents".

---

## Title
**Bob's Desk** [TEAM: or "Bob's Shift" as in the older draft; pick one and use it everywhere]

## Tagline
**Four shifts at the LA building office. A deep agent does the work, you correct it, and dawn grades you both.**

## Short description (Devpost "elevator pitch", ≤ 200 characters)
Play an LA building officer, one shift a day: settle record conflicts, tag buildings after a simulated quake, see at dawn who you kept safe. The AI analyst remembers your calls.

---

## Inspiration
After the 1994 Northridge earthquake, inspectors evaluated 66,546 buildings and posted each one green, yellow or red. A rapid evaluation typically takes 10 to 30 minutes, mostly from the outside. A placard is a judgment made under pressure, from records that are often out of date. In 2011 a building in Christchurch that three officials had passed after an earlier quake collapsed and killed 115 people.

We wanted a game where that judgment is the whole game. The paperwork is real: open record cases from the CoStar hackathon kit, the city's own retrofit lists, the 1994 shaking at each building. The arithmetic is published: FEMA's rapid screening score, HAZUS damage and casualty rates. An AI analyst does the legwork. The decision stays with you, and the aftershock grades it.

## What it does
You are **Bob**, a building officer in downtown Los Angeles, for a short career: **four days**, one shift a day, each on a different real building in the district. Day 1, at 737 Broadway, runs the full arc below, ending in a simulated aftershock. Days 2 to 4 run the same desk, walk-in and placard on other buildings, without the aftershock (see "Day after day").

**Morning: the agent remembers.** The analyst opens the shift from its own shift log. The first shift after a reset opens from a seeded previous shift (601 Broadway); after that, each shift opens with what Bob actually corrected last time.

**Day: the desk.** Bob's inbox holds real open cases from the CoStar queue, where two sources disagree about the same building. His analyst is a LangChain deep agent. It plans the shift, sends **four squads in parallel** (records, aerial, interior, city), and builds a **card per building** with one line per source:
- the CoStar record;
- the Vexcel aerial (the agent looks at the image itself);
- the Matterport 3D scan;
- the LA retrofit lists and permits;
- the LA County Assessor parcel;
- the LA County building survey's roof height;
- the LA City business registry;
- the USGS 1994 Northridge ShakeMap.

Fields where two sources disagree glow amber. Across the 62-building district the cards raise **56 disagreements** (floor area 20, height 15, material 11, year built 10). Bob works a suite case, then inspects **737 Broadway**, where the records disagree about what the building is made of.

**The walk-in.** Bob steps into the building's own 3D tour and reports what he sees. His report is evidence, not a verdict: code caps it at 0.35, and the agent weighs it with its own read of the scan.
- **On the records alone,** 737 Broadway is probably masonry (55%), and the code suggests **RED**.
- **After Bob reports concrete,** the odds move to concrete 73%, and the suggestion drops to **YELLOW**.

**5 pm: a simulated quake.** The clock hits 5:02 pm and the screen shakes. The streets react: pedestrians run into the open, cars stop with hazards flashing. On Day 1 a **simulated aftershock clock** starts (45 s on stage), and **two people are trapped** at 737 Broadway's door: Bob can lead them to a marked assembly point before it hits, at his own risk. The agent screens the building and proposes a placard, and the proposal is pinned in code to the screening's suggestion. Then it **stops and waits for Bob** (a human-in-the-loop interrupt): approve, or change the tag. At 5 pm the people count uses the HAZUS commute share, because offices are emptying and homes are filling.

**Dawn on Day 1: the aftershock grades the tag.** A seeded aftershock draws each tagged building's damage from that building's own odds. What Bob checked changes his tag, never the building. For 737 Broadway the draw is **complete damage**, and the report shows what every tag would have done:

| Bob's tag | People kept safe | Exposed | Hurt (HAZUS indoor rates) |
|---|---|---|---|
| **Red** (unsafe) | **251 of 251** | 0 | 0 |
| Yellow (limited entry) | 226 | 25 | 5 |
| Green (safe to occupy) | 0 | 251 | 54 |

**Agent vs Bob.** Dawn shows what the agent proposed, what Bob posted, and what the aftershock says was right: *"the agent proposed YELLOW · Bob posted RED (override) · the aftershock says RED: Bob was right; the agent was wrong."* That outcome goes into the agent's shift log, and a running track record shows how often each was right. The rescue gets its own line: *"Rescue (simulated): N of 2 brought out before the aftershock."*

Each row also shows the tag's **expected** outcome over the building's odds, so a good call that meets bad luck still reads as a good call. The shift score is **people kept safe plus records fixed**. A record fix counts only when a second model, the critic, agrees the evidence supports the correction draft.

**Day after day, then a career summary.** At dawn Bob chooses **Next day (k of 4)** (Enter), which keeps the history, or **New game**, which resets it. The HUD and the desk header show "Day k of 4". Each next day brings a different district building whose records disagree about its material, plus an office suite to check, and the analyst opens it with Bob's last real correction.

On Days 2 to 4 there is **no aftershock**, no aftershock clock and no rescue. Dawn grades Bob's placard in code: the **expected** people exposed and displaced under his tag on the building's own HAZUS odds, and whether it matches the code's suggestion. For example, posting red on Day 2 when the code suggests yellow exposes about 0 people and displaces about 26.

| Day | Building (and office suite) | What the records disagree on | People at stake | Graded by |
|---|---|---|---|---|
| 1 | 737 Broadway (suite 1100, 122 7th St) | Masonry on the CoStar record; concrete on the city's retrofit list | 251 | The simulated aftershock (complete damage) |
| 2 | 621 Spring St (suite 404, 724 Spring St) | Steel on the record; concrete on the city's list | 106 | Expected outcome on its own odds |
| 3 | 730 Los Angeles St (suite 1400, 122 7th St: a 12-person office on record) | Masonry vs concrete; 15 Matterport scans | 201 | Expected outcome on its own odds |
| 4 | 620 Main St (an office suite at 724 Spring St) | Masonry vs concrete | 40 | Expected outcome on its own odds |

On records alone the code suggests red for all four; Bob's walk-in reports move the odds. During play a "Your career so far: day k of 4" block grows at each dawn. After Day 4 it becomes the **career summary**:
- tags right: Day 1 against the aftershock, Days 2 to 4 against the screening;
- people kept safe: Day 1 actual plus Days 2 to 4 expected, labelled as such;
- records fixed;
- the Agent vs Bob record.

**The whole city, in code.** The map screens **all 1,581 LA buildings** in the kit from their records alone: **918 green, 446 yellow and 217 red** suggestions. Click any one for its card.

**A human-feedback loop you can watch.** The agent is the main character, and people correct it at four levels:
1. **Evidence:** Bob's site report is weighed as evidence, capped at 0.35.
2. **Decision:** Bob approves or overrides each placard (a human-in-the-loop interrupt), and dawn grades both of them: the simulated aftershock on Day 1, the code's screening on Days 2 to 4.
3. **Review:** a second model (the critic) reviews every correction draft, and a person approves any record change.
4. **Memory:** the override and its outcome go into the shift log, and the next shift opens with it. The log carries across days until a new game, so by Day 4 the agent has a record of how often Bob overruled it and how each call was graded. This is in-context learning from human corrections. The first shift after a reset opens from a seeded previous shift (601 Broadway); after that, each shift opens with what Bob actually corrected last time.

Every placard decision, and every 👍/👎 Bob gives a finding, a source or a draft, is also saved as **preference data in the format used for RLHF/DPO** (chosen/rejected pairs plus ratings), downloadable as JSONL. **No model weights were trained tonight;** the data is collected, not used.

**One engine, two doors.** The agent that plays Bob's analyst is also a working records auditor. "File" at dawn opens the real case, with Bob's report cited in the draft correction. Nothing changes a record without a person approving it.

> **Simulated post-quake placards. Game outcomes, not engineering assessments.**

## The maths behind a placard
Code computes every number; the model never sets one. Each step is a published method, and the game-specific choices are labelled on screen.

1. **Rapid screening:** a FEMA P-154 Level 1 score (Very High seismicity table) for each material the evidence still allows, weighted by today's odds.
2. **Shaking:** the building's 1994 Northridge intensity from the USGS ShakeMap, converted to ground acceleration with the Worden et al. (2012) California relation.
3. **Damage odds:** HAZUS fragility curves for the building's class and code era.
4. **People inside:**
   - Residential: units × 2.64 people per LA household (Census).
   - Commercial: CoStar employee counts where the record has them; otherwise CoStar's occupied square feet ÷ the IBC 2021 occupant load; otherwise an assumed share of the code's design load (labelled).
   - Each count is scaled by the HAZUS 6.1 share of people present: day, night, or commute at 5 pm.
5. **Tags:** ATC-20 posting categories (green, yellow, red). The red threshold is a game choice. Yellow triggers at half of it, ATC-138's "inspection required" rule.
6. **Casualties:** HAZUS indoor casualty rates by damage state. A complete-damage draw is split by the class's chance of collapse.

## How we built it
- **The deep agent:** LangChain **deepagents** on LangGraph. One graph (`desk`) runs the shift as messages: start the shift, open a case, inspect a building, take a tip, tag after the quake, end the shift.
  - **Planning:** its own todo list from the real case queue.
  - **Sub-agents:** four specialists run in parallel (records, aerial, interior, city), plus a **critic** sub-agent on a second model that reviews every correction draft.
  - **Tools:** `building_card`, `screen_building`, `triage`, `tag_building` (an interrupt with approve / edit / reject), `shift_report`, and `log_shift`. `log_shift` writes a short memory of the shift that the agent reads the next morning.
  - **The rule:** the agent decides what to check and what to propose; code computes every number; Bob decides.
    - The proposed tag is pinned to the screening's suggestion.
    - The agent's own image reads are capped at 0.2 and need a second look.
    - A person's report is capped at 0.35.
  - **Human feedback:** `log_shift` stores, per tagged building, the agent's suggestion, Bob's tag and the right tag; the next shift's briefing reads it, so the agent's first line names the correction. The frontend keeps an Agent vs Bob track record and exports preference pairs (JSONL).
  - **Days:** `GET /desk/days` lists the four days (day, hero and office buildings and suite, doors, the disagreement, people at stake, the records-only suggestion); Day 1 is the stage day.
    - "Next day" sends "Start Bob's shift, day k" on the next building and keeps the shift log.
    - "New game" resets the log to the seeded line.
    - Day 1's dawn runs the simulated aftershock; Days 2 to 4 are graded by the screening's expected outcomes.
    - The frontend totals the career summary from the days' shift reports.
- **Models:** Gemini on Vertex AI. A strict replay mode records model answers so the judged demo is repeatable; the data, tools and images stay live.
- **The game:** Next.js, React and three.js. The ground is a Vexcel aerial mosaic, with real building outlines and heights. The day turns to night, and you walk into Matterport tours. Traffic and pedestrians run on lanes derived from the building grid and react to the quake. Near a building with real Vexcel imagery, the drone and camera views switch to the real photos. The aftershock clock and the rescue reuse the engine's survivor and debris systems. A side panel and a second screen (`/play/log`) show every step the agent takes, for judges.
- **Data:**
  - The CoStar hackathon kit: records, tenancies, listings, open cases.
  - Vexcel aerials and Matterport 3D tours.
  - LA open data: soft-story and non-ductile concrete retrofit lists, permits.
  - The USGS ShakeMap.
  - Three public sources added tonight, each from one district-wide download matched locally (no per-address lookups, no names):
    - the LA County Assessor parcels (61 of 62 district buildings matched);
    - the LA County building survey's roof heights (59 of 62);
    - the LA City business registry (56 of 62; counts and industries only).

## Challenges we ran into
- **We pivoted at 9 pm.** The first version was a zombie night game on the same data. We kept the engine, the agent and the data, and dropped the horde, because a building officer's real decision is a better game than a fight.
- **Making yellow cost something.** In an early version yellow kept everyone safe in every outcome, so tagging everything yellow won. Now yellow allows limited entry: 10% of occupants are exposed if the damage is serious, and 25% are displaced if it is minor (game shares, labelled).
- **Not rewarding luck.** One seeded roll can punish a careful call. Every dawn row now shows each tag's expected outcome next to what happened. The aftershock draws from the building's own odds, so gathering evidence changes Bob's tag, not the building.
- **Honesty under game pressure.**
  - Records "disagree"; we never say a record or an owner is wrong.
  - An unfinished retrofit is not called non-compliant.
  - Before the quake, a card shows a score, never a placard colour.
  - Every placard is labelled simulated.
- **A live demo with an AI.** Strict replay, exact message contracts, one client at a time, and a reset between judges.

## Prior art, and how Bob's Desk differs
Bob's numbers come from open engineering work: HAZUS fragility, casualty and time-of-day tables from NHERI SimCenter's damage-and-loss library ([DamageAndLossModelLibrary](https://github.com/NHERI-SimCenter/DamageAndLossModelLibrary), the data behind [pelicun](https://github.com/NHERI-SimCenter/pelicun)), and ATC-138's "inspection at half the red-tag threshold" rule ([PBEE-Recovery](https://github.com/OpenPBEE/PBEE-Recovery)). Field tools already exist for the inspector's side: [Cairn](https://github.com/nikhilpravinpise/Cairn) is an offline FEMA P-154 triage app, and [EQanalytics](https://github.com/AntonMu/EQanalytics) flags soft stories from street imagery. A past Claude Code hackathon winner put AI at the permit counter before a building is built. None of them is a game, and none puts a person's placard call on a clock against a real building's records. Of the roughly 35 public CoStar-track repos we read this weekend, none models earthquakes. Most share our pattern (code computes, agents gather, a person approves); Bob makes that pattern the gameplay. We copied no code from any of them, only published data and rules.

## Accomplishments we're proud of
- What a player reports from inside a real building becomes capped evidence in a real case. It changes the placard decision and lands in a reviewed correction draft.
- Of the roughly 35 public CoStar-track projects we read this weekend, none models earthquakes, and almost none is a game with a clock and a score.
- Every number on screen is computed in code, with its published source or its game assumption labelled beside it.

## What we learned
**[TEAM: 2–3 honest sentences in your own voice.]** Candidates:
- Better records don't make a building safer. Bob's report moved 737 Broadway from "probably masonry" to "probably concrete", yet an old building in strong shaking still warranted red.
- The data's best story was occupancy over time, not material. HAZUS says an office holds 1% of its daytime people at night, while an apartment block is full.
- Code computing every number is now common in this track. What sets a project apart is how visible the calculation is and what is at stake when it is wrong.

## What's next
- An ATC-20 Rapid Evaluation grid at night (six conditions, rules in code) with an "exterior only / exterior and interior" choice.
- A detailed-evaluation budget: about one building in five, matching Cal OES's 80:20 Rapid-to-Detailed guidance.
- Day-desk retrofit-ordinance cases: a missing termination certificate, an appeal past 60 days, a permit stuck at "Ready to Issue".
- Seeded cases where the agent is confidently wrong, and others where overriding it is the mistake.
- Using the collected preference pairs: with enough shifts, fine-tune or DPO-train the analyst's proposals (tonight they are only collected).
- A calibration set so evidence weights are learned rather than hand-set.

## Built with
langchain, deepagents, langgraph, python, gemini, vertex-ai, next.js, react, three.js, costar, vexcel, matterport, usgs, la-open-data, la-county-gis

## Honesty notes (keep on the Devpost page)
- Licensed CoStar, Vexcel and Matterport data is not in the repository; it is matched locally.
- The quake, the placards, the aftershock clock, the trapped occupants and the aftershock are simulated game events. The NPC traffic and pedestrians are decoration.
- "Human feedback" here means in-context learning from Bob's overrides (the shift log, carried across days until a new game) and collected preference data. No model was fine-tuned or RL-trained; no weights change from day to day.
- The aftershock is Day 1 only: a simulated event on 737 Broadway. Days 2 to 4 have no aftershock; their dawn shows expected outcomes from each building's HAZUS odds, labelled as expected, never as something that happened. The days are game days, not a timeline of a real earthquake sequence. The screening uses published methods (FEMA P-154, HAZUS, ATC-20, ATC-138, IBC) but is not an engineering assessment.
- The P-154 probability is a ranking signal at a code-level design earthquake, not a forecast of 1994 shaking.
- The 1,581-building screen comes from records only. Its share of red (about 14%) is a forecast of damage odds for a commercial-real-estate sample, not comparable to the roughly 6% posted red after Northridge.
- Game choices are labelled as such: the red threshold, yellow's entry and displacement shares, the assumed occupancy share when no count exists, and the fragility dispersion.
- **[TEAM: confirm with CoStar whether real addresses (737 Broadway) may appear in screenshots and the video.]**

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
