# Last Stand LA: contract (v1.3, frozen Sat Nov 14 ~12:50)

Shapes are frozen on both sides. Any change is announced first and is additive only. The types are in `web/src/game/types.ts`; the server is `app/fortress.py`, `app/game_agent.py` and `app/routes.py` on `game`.

## HTTP (agent server :2024; the web app proxies only these three via `web/src/app/api/game/[...path]/route.ts`)

```
GET  /game/district
  { center:{lat,lon}, radius_m, seed,
    buildings:[{ pid, label, x, z,                       // metres east / south of center
                 footprint:[[x,z],...]|null,              // RELATIVE to (x, z); open ring
                 w, d, height_m, stories,
                 material:"concrete|steel|masonry|wood|unknown",
                 list:"concrete|soft_story"|null, unfinished, past_due, mmi|null, hero,
                 year_built?, people?, conflict?:{costar, city}|null,          // v1.1
                 door?:{x, z, facing}|null }],                                  // v1.2: ABSOLUTE metres, 1 m outside the wall;
                                                                                //       facing = outward normal, degrees clockwise from north (-z)
    waves:[{ n, sector, arrive_s, size }],
    ground?:{ image, x0, z0, x1, z1 }|null,             // v1.2: aerial mosaic, north-up; image top = z0, left = x0
    blocks?:[{ ring:[[x,z],...], height_m }]|null,      // v1.3: OpenStreetMap buildings (not kit), ABSOLUTE metres
    attribution?: "© OpenStreetMap contributors"|null } // v1.3: show it whenever OSM shapes are on screen

GET  /game/dossier/{pid}
  { pid, label, scores:{ walls|quake|roof|people|space:{ value 0-100, label, why, source } },
    unknowns:[...], images:{ drone:[...], cctv:[...], pano?:[{face,name}], inside?:[{face,name}] },   // inside: v1.2
    case:{ case, question, hypotheses:[{key, claim, prior}] }|null, disclaimer }

POST /game/resolve  {pid, wave, seed, action:"hold"|"run", to_pid?, checks:[...]}
  -> { held, walls, quake, walls_roll, quake_roll, why, pid_final }
```

Images are served by `/evidence/image/{name}` (through `/api/backend/evidence/image/...`). Cube faces: f0 top, f1-f4 sides, f5 bottom.

**Current real values** (v1.3):
- **Ground:** x −420..60, z −220..60; 4096×2389; about 11.7 cm/px.
- **Blocks:** 183 OSM buildings; the median height is 25 m.
- **Hero:** 6375735. It has a conflict (CoStar masonry vs the city's concrete list), a door at (−358.4, −158.3) facing 307°, and `inside` = its own twin's top-floor loft.
- **Safe room:** 254167, known concrete, with a door at (9.3, −16.4) facing 40°; `inside` = suite 1100.
- **Fallback:** the agent picks 9629605.
- **Waves:** W at 20 s (290), N at 45 s (500), E at 70 s (790).
- **Seed:** 1990.

## The agent (graph `laststand`, one thread per night)

**The Night Shift (on foot, live).** The agent briefs the night from the real queue. Messages in this order on one thread:
1. `Brief the night shift` (a fresh thread). The agent calls `night_cases()`, then `write_todos`.
   - Result: `{"total": 328, "in_area": 17, "cases": [{"n", "case", "property_id", "suite", "label", "question", "stakes"}]}`.
   - These are the queue cases inside the play area with imagery gathered: tonight, #6 (material conflict, 6375735) and #7 (ghost tenant, 254167 suite 1100).
2. `Check suite 1100 at building 254167: is the tenant on record still there?`: the agent opens the ghost_tenant case and chooses among listing_timeline, lease_terms, tenancy_trail, lot_activity and suite_tour, then calls weigh_case.
3. One of:
   - `Tip: I'm inside suite 1100. It's empty: no one is working here.`
   - `Tip: I'm inside suite 1100. People are working here.`
   - `Tip: I'm inside suite 1100. I can't tell if anyone works here.`
   
   The agent calls record_note, then weigh_case. The office NPCs spawn only if the verdict leans `still_there`.
4. Then the case #6 sequence below, on the SAME thread (`Scout property` is not fresh).

Stub and `agent=off` play case #6 only.

**Case #6 messages, in this order.** These are the exact strings the replay covers:
1. `Scout property 6375735`
2. One of:
   - `Tip: I'm inside the building. The walls and columns look like concrete.`
   - `Tip: I'm inside the building. The walls look like brick.`
   - `Tip: I'm inside the building. I can't tell what the walls are made of.`
3. `Wave 1 is coming from the W`
4. The resume of the `commit_plan` interrupt. **The mapping is relative to the agent's proposal, never fixed:**
   - the key that matches the proposal's `args.action` sends `{type:"approve"}`;
   - the other key sends `{type:"edit", edited_action:{name:"commit_plan", args:{pid, action, to_pid}}}`, where to_pid is `find_fallback.to_pid` for RUN and `null` for HOLD.

   In all six recorded nights the agent proposed RUN to 9629605, so in replay RUN = approve and HOLD = edit. Live, it may propose HOLD; `useGame.decide` handles both.

**Tool results the UI reads:**
- `fortress_dossier` (dossier shape);
- `open_case`;
- `check_evidence` (`{finding, effects, why, images?, callout?}`; images are shown on the DRONE feed);
- `weigh_case` (`{property_id, posterior, verdict:{hypothesis, label, confidence, text}}`);
- `horde_status`;
- `find_fallback` (`{from_pid, to_pid, to_label, distance_band, reason}`);
- `commit_plan` (the resolve object).

## The six recorded nights (seed 1990, strict replay 3× clean)

The numbers in this table are the replay's. Live odds depend on which checks the agent chooses: in one live night it added a check, and the tip moved 0.78 → 0.82. Every number is still computed in code.

| Tip | Odds (concrete, as the city lists it) | HOLD | RUN to 9629605 |
|---|---|---|---|
| Concrete | 0.66 → 0.72 | walls 76 vs roll 78: they get in | 70 − 10 vs 8: held |
| Brick | 0.66 → 0.54 (CoStar's material 0.17 → 0.32) | 71 vs 78: they get in | held |
| Can't tell | unchanged, 0.66 | 74 vs 78: they get in | held |

The aftershock is survived in every case.

**Re-record or verify:** `scripts/game_nights.py` (on `game`, 5667ca6).
- **Command:** `uv run python scripts/game_nights.py [--tips concrete brick cant_tell] [--actions run hold]`.
- **To record:** `cp fixtures/replay/demo.json fixtures/replay/game.json`, then start the server with `RADAR_REPLAY=record:game`.
- **To verify:** start it with `RADAR_REPLAY=game RADAR_REPLAY_STRICT=1`, then `grep -c "replay miss"` on the server log must print 0.
- **When to re-record:** only if the prompt, the tools, these strings or the seed change.

**The map mode is live-only (unverified in replay, not impossible).** Replay keys depend only on the steps since the latest message. So the map mode's scout, wave and HOLD/RUN steps would hit (before a tip, its HOLD result equals the can't-tell night, 74 vs 78). But a tip sent *after* the wave is untested, and the map mode's old preset text would miss for sure.

## The on-foot engine (frontend-internal; see `web/src/game/foot/engine.ts`)

**Systems:** `createWorld`, `createPlayer`, `createHorde` and `createFeeds`, each `(ctx) => System {update, render?, dispose}`.

**Bus events:**

| Event | From → to | Payload |
|---|---|---|
| `player:hit` | horde → player | `{damage, fromX, fromZ}` |
| `player:shove` | player → horde | `{x, z, yaw}` |
| `player:downed` | player → director | `{x, z}` |
| `horde:ambient` | director → horde | `{count}` |
| `wave:start` | director → horde | `{n, sector, size, targetX, targetZ}` |
| `horde:target` | director → horde | `{x, z}` |
| `wave:breach` | director → horde | `{x, z, count}` |
| `horde:repel` | director → horde | `{x, z, r}` |
| `horde:clear` | director → horde | `{}` |
| `world:beacon` | director → world | `{pid \| null}` |
| `world:route` | director → world | `{pts: [from, to] \| null}` |
| `world:lean` | director → world | `{pid, material \| null}` |
| `world:barricade` | director → world | `{pid \| null}` |
| `fx:shake` | director → world, player | `{amp, secs}` |
| `fx:crack` | director → world | `{pid}` |

**Conventions:** x east, z south, metres. Angles are clockwise from north (−z): forward = (sin yaw, −cos yaw).
