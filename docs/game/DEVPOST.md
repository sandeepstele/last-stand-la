# Devpost draft + video shot list: Last Stand LA

Drafted Sat Nov 14, ~4:00 pm. **Track: Entertainment.** Specials to consider: CoStar "Inside and Out", LangChain "Best use of deepagents". Items marked **[TEAM]** need a human.

---

## Title
**Last Stand LA**

## Tagline
**Settle tonight's cases and make it to dawn.**

## Short description
A survival night on real downtown LA buildings, where your squad commander is an AI auditor. It works CoStar's real queue of building records that disagree, sends you into the buildings' real 3D tours to look, weighs your report as evidence, and asks you to call HOLD or RUN when the horde comes. At dawn, your night has produced real draft corrections.

## Inspiration
Building records go stale quietly. CoStar's record of a downtown tower says masonry; the city's earthquake-retrofit list says concrete. Nobody has gone to look. We built an AI deep agent that audits those records by checking permits and filings and reading aerial photos itself. Then we asked: what if checking a record was the most exciting thing you did all night?

## What it does
- **The briefing:** at nightfall, the AI commander (a LangChain deep agent) pulls the open cases inside your blocks from CoStar's real queue of **328** cases where records disagree, and writes tonight's plan.
- **Case #7:** CoStar records a 3-person office in suite 1100, but the suite is listed for lease. You walk into **that suite's real Matterport tour** and report what you see.
- **Case #6, your fortress:** CoStar says 737 Broadway is masonry; the city's retrofit list says non-ductile concrete. Four squads (sub-agents) check in parallel. The agent **chooses its own evidence** and says why: the city filings, and **a look at the Vexcel aerial itself** (the image pops up on screen). Then you walk into the building's own 3D tour and report the walls.
- **The night:**
  - The horde comes. The agent reads it, finds a fallback building, and proposes HOLD or RUN. It waits for you: a human-in-the-loop interrupt.
  - **Your report decides the outcome:** a "concrete" report makes the walls hold; "brick" means they break in.
  - Code rolls every number against the evidence and the **1994 Northridge shaking** at that block.
- **Dawn:** the agent drafts tonight's corrections live, **citing your words**. "File tonight's reports" opens the same agent as the auditor, on that case, with your report in the case file.

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
- The same agent runs as both the game's commander and a working records auditor (**328 open cases**).

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
| 1 | 0:00–0:08 | The intro camera circling the real downtown district at dusk; title "LAST STAND LA" | "Building records go stale. Nobody goes to look." |
| 2 | 0:08–0:18 | Enter. The HQ panel: "Tonight's cases: #6 and #7 of 328"; the plan appears | "Our AI commander works CoStar's real queue of 328 cases where records disagree, and plans the night." |
| 3 | 0:18–0:32 | F to 737 Broadway's door. The radio; four squad chips light up; **"HQ looked at the aerial"** moment with the real image | "Four squads in parallel. It picks its own evidence and looks at the aerial itself." |
| 4 | 0:32–0:45 | E: the real 3D tour. Press 1, Concrete. **"Your report moved the odds: 66% → 72%"** | "Then I go in and look. My report is evidence: capped, never final." |
| 5 | 0:45–1:00 | Step out facing the horde; HQ proposes RUN; press H instead; hold the door: shove, flare, stun, nail boards | "The agent proposes. I decide." |
| 6 | 1:00–1:10 | Walls hold (76 vs 75); the aftershock shakes the screen | "My concrete report is why the walls held. Code rolls every number." |
| 7 | 1:10–1:25 | Dawn: rank, "Records checked tonight", **the AI drafting corrections citing my words** | "At dawn it drafts real corrections, citing what I saw." |
| 8 | 1:25–1:45 | "File tonight's reports" opens the auditor: the case file with "the player" as a human report; the queue of 328 | "Same agent, as CoStar's auditor. The other 326 cases it works overnight." |
| 9 | 1:45–2:00 | Back to the city at dawn; title card | "Settle tonight's cases. Make it to dawn." |

**Capture tips:**
- 1920×1080 at 60 fps.
- Press V to mute in-game sound if recording the voice-over separately.
- Hide the cursor.
- Never show `?stub=1` or `agent=off`.
- **[TEAM: don't show street addresses unless CoStar OKs it. Crop the labels or blur them.]**
