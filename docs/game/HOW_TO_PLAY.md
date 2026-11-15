# How to play Bob's Desk

A one-page guide to keep beside the game. Keys come from the code on `desk-a` (49af19d): `FootGame.tsx`, `PauseMenu.tsx`, `DeskView.tsx`, `DawnView.tsx`, `CareerSummary.tsx`. Open `/play?mode=foot` for the full four days. `?demo=1` is the 2-minute stage cut: Day 1 only, with shortcuts.

## Keys you need all the time

| Key | What it does |
|---|---|
| **W A S D** · mouse (or drag) · **Shift** | Move · look · sprint |
| **Tab** | Open or close **Bob's desk**: inbox, building cards, city map, calculation sheet, squad radio |
| **E** | Go through a lit door; press it again to step back out |
| **1 / 2 / 3** | Answer HQ's question inside a building; after the quake, post the tag |
| **C** | Optional side case near you (a solar roof, or "same building?") |
| **L** | The deep agent's live log beside the game |
| **P** or **Esc** | Pause menu: Missions, How to play, Agent log (and the feedback download), Restart night |
| **V** | Sound on or off |
| **Enter** | Start or continue from the title screen; at dawn, the main button (Next day / New game) |
| **F** | `?demo=1` only: skip the walk to the door |

## A day, step by step

| Step | What to do | Keys |
|---|---|---|
| **1. Start** | The title screen says "Career in progress: Day k of 4", or "Saved shift … Enter continues it". Enter starts or continues. | **Enter** |
| **2. Morning brief** | The agent reads the inbox and opens with last time's lesson. Day 1 opens from a seeded previous shift (601 Broadway); each later day opens with what Bob corrected the day before. Open the desk to watch the cards fill: one line per source, amber where two sources disagree. Optional: on a card, under "Call it from outside:", click green, yellow or red to pre-call the tag; dawn grades it. Rate findings 👍/👎. | **Tab**; click a card; click a building on the map |
| **3. Office suite case** | Walk to the lit door of the office building. When HQ has asked about the suite, go up. Answer: **1** empty · **2** people working · **3** can't tell. Then step out. If the evidence says the office is still there (and you didn't say empty), the workers follow you: bring them to the building. | **E** · **1/2/3** · **E** |
| **4. Walk to the building** | A route is drawn to today's building. Near it, the agent sends its four squads. | **W A S D**, **Shift** |
| **5. Inspect inside** | At the door, go in: it's the building's real 3D tour. Move between scan spots; look at the walls. Answer: **1** concrete · **2** brick · **3** can't tell. Your answer is evidence, capped at 0.35. Wait for HQ to finish, then step out. | **E** · **W/S** or click the floor plan · **1/2/3** · **E** |
| **6. 5:02 pm quake** | Stepping out starts the simulated quake: the screen shakes, day turns to night, people run and cars stop. The agent screens the building and proposes a tag; the code's suggestion shows beside it. | (wait a few seconds) |
| **7. Post the tag** | **1** green (safe to occupy) · **2** yellow (limited entry) · **3** red (unsafe) · **N** no tag. The agent waits for you. | **1/2/3/N** |
| **8. Day 1 only: aftershock clock + rescue** | "Simulated aftershock in 1:00" (0:45 on `?demo=1`). Maya and Luis are trapped by the door (HELP beacons). Walk right up to each one (about 2.5 m) and they follow you. Then walk them into the **green assembly ring**; the route is drawn. Anyone not there when the clock hits zero is still inside. Days 2 to 4 have no clock and no rescue. | **W A S D**, **Shift** |
| **9. Dawn** | The shift report shows the damage (Day 1: the simulated aftershock; Days 2 to 4: the expected outcome on the building's odds), people safe, exposed and hurt, and **Agent vs Bob**. Rate drafts 👍/👎. Click **File the reports** to open the auditor case with your report in it. | click |
| **10. Next** | **Next day (k of 4)** keeps the history and starts the next building. **New game** resets to Day 1. After Day 4 the main button is New game. | **Enter** = main button |

**The four days:**
- **Day 1:** 737 Broadway (suite 1100, 122 7th St).
- **Day 2:** 730 Los Angeles St (suite 404, 724 Spring St).
- **Day 3:** 620 Main St (suite 1400, 122 7th St).
- **Day 4:** 621 Spring St (a suite at 724 Spring St).

Days 2 to 4 call the live model the first time you play them, about 15 seconds per inspection step, so be patient.

## Side missions (optional; they show in the pause menu under "Optional")
- **Look inside another building:** walk to any other lit door before the quake and press **E** to go in; **E** again to leave. On the desk, a case's **"Site visit →"** button sends you there.
- **"Same building?"**: when the hint shows **C**, press it near a building whose city-list entry may be stale. The agent compares old and new aerials. Don't use it at 217 8th St on stage (its record says 13 stories in a building about 22 m tall).
- **Solar roof survey:** press **C** near a screened roof. The code never says "go solar", because roof age is taken from building age.

## The career summary
From Day 1's dawn, "Your career so far: day k of 4" grows each day; after Day 4 it becomes **Career summary**. It shows:
- **People kept safe** of those at stake. Day 1 comes from the simulated aftershock; later days are expected outcomes, and labelled so. It also shows how many people were hurt.
- **Tags right**, x of y. Later days count a tag as right when it matches the code's suggestion.
- **Records fixed.**
- **Rescued**, x of 2.
- **Points.**
- **Agent vs Bob:** the agent's proposals right x of y, and Bob's overrides right x of y.
- **One line per day:** the agent's tag, Bob's tag, and the right tag or "no aftershock (graded by the screening)".

It's saved in this browser. Between judges, press **New game** (on the dawn screen or the title screen's career bar), then run `uv run python scripts/demo_reset.py`.

## What to say to a judge while playing
1. "I'm Bob, LA building office. Every building and open case here is real, from CoStar's data. The quake and the placards are simulated."
2. "My analyst is a LangChain deep agent: four squads in parallel, a card per building, amber where the records disagree. Code computes every number."
3. "I go in and look. My report is evidence, capped at 0.35, never final. Watch the odds move on the calculation sheet."
4. "After the quake the agent proposes a placard and waits for me. I can overrule it, and dawn grades us both."
5. "It remembers: tomorrow it opens with today's correction. That's in-context memory; no weights are trained."
