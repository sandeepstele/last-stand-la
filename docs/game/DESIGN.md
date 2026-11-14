# Last Stand LA: game design (on foot)

**"The zombies are fake. The weak spots are real."**

This doc covers what the player does, what they see, how real data drives each mechanic, and what the deep agent changes in play. The build plan is in [BUILD_PLAN.md](BUILD_PLAN.md), the interface in [CONTRACT.md](CONTRACT.md), and the risks in [CRITIQUE.md](CRITIQUE.md).

## Why on foot

The first version (`/play`, the "commander's map") passed its end-to-end gate 3/3. But it was a bird's-eye map of floating boxes with HOLD/RUN buttons. The user's verdict: "just boxes… nothing for the normal man… where are the zombies… looks like a block clicker."

The on-foot version (`/play?mode=foot`) keeps the same agent, contract and replay. The player becomes a person in the street:
- a third-person survivor;
- visible zombies that chase;
- real buildings at real size;
- a walk into a real interior.

The map version stays as the fallback.

## The player's fantasy

You're a survivor in downtown LA at nightfall. Your squad commander is an AI on the radio. It reads every building's records faster than you can. But the records disagree about the one building you need, so somebody has to go and look. That's you.

## The loop (about 2 minutes)

| # | Beat | The player | The agent (`laststand` graph) | Code (server) |
|---|---|---|---|---|
| 1 | **Intro** (20 s, skippable) | Title, three briefing cards, controls. The camera circles the real district | — | — |
| 2 | **Approach** (about 15 s) | Spawns on the street about 60 m from the hero's door. Walks there with ambient zombies around | Within 75 m: `Scout property <pid>`. Four squads report on the radio, a case opens, and it runs checks, including a **vision look** at the aerial (shown on the DRONE feed) | Fortress card scores; `weigh_case` odds |
| 3 | **Inside** (about 20 s) | [E] at the door: the building's **own Matterport tour**. Answers "What are the walls made of?" with [1] concrete, [2] brick or [3] can't tell. Must answer to leave | `Tip: I'm inside the building. …`, then `record_note`, then `weigh_case` with `human_report` | The odds move, capped at 0.35 (in the recorded nights: concrete 0.66 → 0.72; brick 0.66 → 0.54. Live numbers depend on the checks the agent chose) |
| 4 | **Night** (about 10 s) | Steps out; the horde comes from the west down the real streets. Reads the agent's call; presses [H] HOLD or [R] RUN | `Wave 1 is coming from the W`, then `horde_status` and `find_fallback`, then `commit_plan`, which **pauses for the human** | — |
| 5a | **Hold** | Barricaded inside; zombies mob the door; the screen shakes | Resumes with the edit (HOLD) | Seeded roll: walls vs roll. In the recorded night HOLD **loses** (76 vs 78): breach, run |
| 5b | **Run** | Sprints along the glowing route to the fallback the agent picked, chased; [Space] shoves | Resumes with approve (RUN) | Seeded roll at the fallback: −10 for crossing on foot; the recorded night **holds** |
| 6 | **Aftershock** | The camera shakes; the strength comes from the 1994 Northridge shaking at that block | — | Quake score + 40 vs roll |
| 7 | **Dawn** | Sky turns pink. The **case file**: hypotheses, evidence, the player's report, the **draft correction** to a real record for a human to approve. [Enter] plays again | — | — |

**No game over.** If the player goes down, the squad drags them clear (health back to 60). The building's fate is the server's roll; the player's own fate is an arcade layer that never feeds the agent or the rolls.

## Controls

| Key | Action |
|---|---|
| W A S D | Move (relative to the camera); arrow keys also work |
| Mouse (pointer lock) or drag | Look |
| Shift | Sprint (stamina) |
| Space | Shove the zombies in front of you (PG: no weapons) |
| E | Enter or leave a building at its door |
| 1 / 2 / 3 | Answer the walls question (inside) |
| H / R | HOLD or RUN when the agent asks |
| Enter | Start, skip the intro, play again |

## What the player sees

- **The survivor (the "hero" character):** a low-poly figure built from three.js primitives, in a high-vis amber jacket with a flashlight. It has procedural walk, sprint and shove animations, an over-the-shoulder camera that never clips into buildings, a red screen-edge flash on hits, and stamina and health bars.
- **The zombies:** a horde of up to about 260 instanced low-poly figures (grey-green, arms forward, shambling).
  - They **wander** when ambient.
  - They **notice** you within 22 m with line of sight (1.6× when you sprint).
  - They **chase** at 3.6 m/s: slower than your sprint (7.5), faster than your walk (4.2). Running is a real decision.
  - Waves spawn 70-115 m out on the wave's compass side and come down the street grid.
  - Shoved zombies stagger. At dawn they shamble off and sink away.
- **The city:** see "Real data → mechanics" below. Every building is at its real outline and height, on the real aerial photo.
- **Two live feeds that follow you:**
  - **DRONE:** a camera 70 m above you, north-up, with red markers on zombies and amber on you. It works as tactical awareness: see what's behind the building. **When the agent runs its vision check, the drone slot shows the real aerial image it looked at, with its finding** ("HQ looked: concrete frame visible"). The agent's eyes become yours for 10 s.
  - **CCTV:** a fixed security camera on the nearest real building corner that can see you. It switches as you move ("CCTV · <building> · corner").
- **HUD:**
  - objective;
  - a compass with the target and the wave direction;
  - the radio (the agent's squads);
  - the hero's fortress card (WALLS / QUAKE / ROOF, plus the agent's live verdict line);
  - health and stamina;
  - key hints;
  - the decision panel;
  - the threat level;
  - the disclaimer and OSM attribution.

## Real data → mechanics

| Real data (source) | In the game |
|---|---|
| Building outlines and heights (OpenStreetMap; LA County building survey import) | The streets you walk and the walls you can't walk through. About 190 real buildings at real proportions (the median is 25 m) |
| Aerial mosaic (Vexcel, about 12 cm/px) | The ground: real streets, crossings, rooftops |
| Construction material (CoStar) | Building colour and the **walls** score (concrete 85 … wood 30): how likely the barricade holds |
| City seismic-retrofit orders (LA open data) | A pulsing amber ring on unfinished orders (red if past due) and the **quake** score |
| Record conflict (CoStar material vs city concrete list) | A two-tone building with a "?": your walls are a gamble, and the odds are the case posterior |
| 1994 Northridge shaking (USGS ShakeMap, MMI) | Aftershock strength (camera shake) and the quake score |
| Interior 3D tour (Matterport) | The room you walk into and look around: what you report comes from what you see |
| Aerial oblique and top-down (Vexcel) | The agent's vision check, shown on the DRONE feed |
| Floors (CoStar stories) | Window rows on the facades (3.8 m per floor). The windows themselves are stylised, not real |
| Supplies | **Game items, not data.** The kit's tenant industries are almost all "office", with no medical or hardware categories, so crates are placed by the game (seeded) and labelled "a crate (game item)". Never attach an "on record" reason to them |
| People on record (CoStar) | Wave sizes scale with the district's real apartments (290 / 500 / 790). The lit-window pattern is stylised; don't present it as data |
| Vexcel roof objects (skylights, AC units) | In the fortress card's ROOF score ("skylights are ways in"). Rendering them on the roof is a stretch goal |

## How the deep agent changes play

| Moment | What the agent decides | What the player feels |
|---|---|---|
| Approach | Plans the mission (todos), sends four squads in parallel, opens the case, **chooses** which evidence separates the hypotheses | Radio chatter while walking; the walls bar settles; the drone feed flashes the aerial it read |
| Inside | Weighs the player's report as **testimony**, capped, and says how the odds moved | "My answer mattered," honestly: it moves, but never decides alone |
| Night | Reads the horde, finds a fallback **away** from the wave, proposes HOLD or RUN with a reason, then **waits for the human** | A real call to make, with the agent's advice and the odds on screen |
| After | Reports the roll in two lines | The outcome is fair and repeatable (seeded) |
| Dawn | The case file and draft correction | "My night fixed a real record" (pending human approval) |

The model never types a number: scores, odds, rolls and wave sizes all come from Python.

## Honesty rules (on screen and in the pitch)

- "Game outcome, not an engineering assessment" is always visible.
- Records "disagree"; never "wrong". The verdict is hedged ("may be concrete, as the city lists it").
- "Unfinished" retrofit ≠ non-compliant; "overdue" only when a step is past due.
- No claims about stairs, exits, supplies, parking or tuck-under (there is no data).
- No company names. Street addresses come only from data at runtime; **none in source code**. Addresses in the video only if CoStar says OK.
- The route is code (A* around real outlines) to the fallback **the agent picked**. Say it that way.

## Cut (not building today)

Guns or gore, pathfinding for zombies (they steer), characters with rigs or model files, shadows, audio (stretch), multiple heroes, a second district, the commander's map inside on-foot mode (M key; the map mode stays at `/play`), roof objects (stretch, needs a v1.4 field).
