# Last Stand LA: critique (how this could still lose)

Adversarial by design. Updated Sat Nov 14, ~1:20 pm, while the four on-foot builders are running. Each item has a severity, the evidence, and the mitigation with an owner. ✅ = done.

## Already fixed today

- ✅ **"Block clicker."** The map mode was a dashboard. The answer is the on-foot mode: a player, zombies, a walk-in interior. User verdict, 12:25.
- ✅ **Buildings not proportional.** Every non-outlined building was a 28-35 m square at the CoStar point, and the rest of downtown was empty. Fix: OSM outlines (LA County heights) for 183 backdrop buildings, plus true outlines for kit buildings. The hero's Vexcel outline was 2× its floor area; OSM's matches CoStar's floor area.
- ✅ **Agent drift.** In a night run the agent pulled an auditor building (247386) from shared memory and proposed holding it. Fix: the game graph has its own backend; tools refuse pids outside the district; the prompt pins the building. Test added.
- ✅ **A hot reload killed a live run** (`contents are required`). Fix: the demo server runs `--no-reload`, and backend edits are announced first.
- ✅ **Addresses in source code.** The tip preset hardcoded a street address. Fix: tips say "the building"; labels come only from data at runtime.
- ✅ **The radio mangled names** ("nonductileconcrete"). Fix: underscores become spaces.
- ✅ **The radio vanished while inside**, during a 10-30 s wait. Fix: a compact radio overlay in the inside view.
- ✅ **Replay paths a player could break:** "no orders" was not recorded, and leaving without a report skipped the tip. Fix: the N key is removed and a report is required before the night.

## Open risks

| # | Severity | Risk | Evidence | Mitigation (owner) |
|---|---|---|---|---|
| 1 | **High** | **Integration.** Four systems built against placeholders meet for the first time at 3:15 | Seams: camera ownership (A vs intro vs inside), FEED_RECTS scissor maths vs D's DOM frames, the route event sent every frame (C must throttle), zombie hits while the player is hidden (B must skip) | Frozen engine contract; **interim merge at about 2:20** to catch seams early; integration window 3:15-4:00 (lead) |
| 2 | **High** | **Frame rate on the demo laptop.** Headless tests use software GL and don't measure real fps | 3 render passes (main, drone, CCTV), a 3 MB ground texture, about 250 extruded buildings, 260 zombies × 6 instanced parts, spot and point lights | Measure on the real machine at 3:30 with a dev fps readout. Knobs in cut order: feeds every 2nd frame, 120 zombies, fewer lights (lead) |
| 3 | **High** | **Strict replay covers exactly one path family:** scout 6375735 → one of 3 tips → wave 1 W → HOLD-edit or RUN-approve | Anything else in strict mode = a replay miss = an error on stage. The map mode is unverified in replay (a tip after the wave was never recorded) | On-foot mode only sends those strings (done). If the map mode becomes the demo, re-record it (5 min, primary). Rehearse strict ×3 at 3:45 and 7:30 (primary) |
| 4 | Medium | **Live latency.** Scout 12-22 s; tip 5-11 s; the walk to the door is about 15 s | The player can wait about 20 s inside before they may leave | Radio overlay inside (done); the panorama gives them something to look at; replay pacing 1.0 s makes the demo predictable |
| 5 | Medium | **The agent reads as "radio chatbot"** if the judges miss the moments where it decides | The visible decisions are the evidence choice, the vision look, the odds moving after the tip, and the HOLD/RUN proposal with a reason | Intro card 2 says it plainly; the DRONE feed shows the image the agent looked at; the walls verdict line updates live; dawn shows the evidence chain. The pitch narrates it (see DEMO.md) |
| 6 | Medium | **Spawn and door geometry on the real district** are untested end to end | The hero's door was recomputed (facing 307°). The spawn is door + 10 m + 60 m along the street and could land off the mosaic or in an alley | Lead verifies in agent-off mode at the interim merge; move the spawn by hand if needed |
| 7 | Medium | **Honesty in the visuals** | The facade windows and lit-window pattern are stylised. "Down real streets" means steering through real outlines, not street routing. The route is code (A*) to the fallback the agent picked | DESIGN.md says so; the pitch must too. Never call windows or routes "data" |
| 8 | Medium | **Real addresses on screen and in the video** | Building labels come from the licensed kit; CoStar hasn't confirmed this is OK | Teammate asks CoStar. Until then the video uses a build with labels hidden (a one-line prop), or crops |
| 9 | Medium | **Demo stability** | The dev server compiles on first load (about 10-20 s), and pointer lock needs a click | Demo on `next build && next start`; open the page once before judges arrive; keyboard-only play works without the mouse |
| 10 | Low | **Controls are unfamiliar to judges** | WASD, mouse, E, 1/2/3, H/R | The intro controls card, keycap hints on the HUD, an E prompt at the door. The presenter can drive while narrating |
| 11 | Low | **The vision read itself is weak on fine detail** | The tuck-under test went 1/5. The hero's read ("exposed concrete frame") is verified and cached | The game uses only the hero's verified read; vision is capped at 0.2 with a second look |

### Found during the build
- ✅ **The walkable area cut off the hero's street** (Builder C's flood fill: about 3,000 m² reachable). Fix: bounds = the mosaic padded by 80 m.
- ✅ **The camera faced the wall after stepping out** (Builder A). Fix: face the door's outward direction on step-out, breach and defend.
- ✅ **A negative first-frame dt** ran timers backwards (Builder A). Fix: clamp at 0.
- ⚠️ **The escape route is long:** 356 m around a real city block (hero door → fallback 9629605), about 85 s at walking pace. Mitigation: "adrenaline" (sprint never runs dry during the escape) brings it to about 47 s. For the 2-minute pitch, narrate during the run, or skip the intro.

## Judging lens (what each judge needs to see in 2 minutes)

- **Entertainment (main track):** play, not a dashboard. A person, a horde, a choice under pressure, a walk-in reveal. ✔ if the gate passes.
- **CoStar "Inside and Out":** inside = the Matterport tour you walk into; out = the Vexcel aerial you walk on. The record conflict is the plot, and the dawn correction is the payoff. Say "the night improved a real record" out loud.
- **LangChain deepagents:**
  - todos;
  - four parallel subagents;
  - the case tools chosen by the model;
  - a human-in-the-loop interrupt that a player answers;
  - a capped Store note from the player.
  
  Have the LangSmith trace open in a tab.
- **Risk to avoid:** looking like a reskin of the map mode. The demo opens on foot, not on the map.

## What would make us lose (and the counter)

1. **The game crashes or stalls on stage.** Counter: strict replay, a prod build, demo_reset between judges, the map-mode fallback tab open.
2. **Judges think the AI is decoration.** Counter: the narration plus the drone photo plus the odds moving on your answer.
3. **It looks unfinished.** Counter: the cut order is explicit, and a polish block from 4:30 to 7:30. Never demo a half feature; hide it instead.
4. **A sponsor bristles at "the record may be out of date".** Counter: hedged wording everywhere; "the records disagree"; a human approves every correction.
