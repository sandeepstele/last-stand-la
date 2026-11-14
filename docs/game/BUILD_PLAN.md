# Last Stand LA on foot: build plan

Sat Nov 14. The decision ("Go, all of it") came at 12:25; the skeleton was done by 12:50; four builders started at 12:55. **Gate at 4:30. Hard freeze at 10:00 pm.**

## Branches

| Branch | What | Owner |
|---|---|---|
| `game` | Backend v1.3, the map mode (`/play`, G1 passed 3/3), the six recorded nights | Primary session |
| `foot` / `foot-lead` | The on-foot skeleton: engine contract, collision, input, director, placeholders | Coding lead |
| `foot-a` | `player.ts`: survivor, controls, camera, flashlight, health, shove | Builder A |
| `foot-b` | `horde.ts`, `feeds.ts`: zombies, live DRONE and CCTV | Builder B |
| `foot-c` | `world.ts`: aerial ground, real outlines, facades, lights, beacon, route (A*), barricades | Builder C |
| `foot-d` | `IntroOverlay`, `InsideView`, `FootHud`, `DawnView`, `foot.module.css` | Builder D |

Worktrees live in `.claude/worktrees/foot-*`, with `web/node_modules` symlinked. Dev servers must run `next dev --webpack`; Turbopack can't follow the symlink. Builder ports are 3121-3124; the lead is 3110.

## Architecture (web/src/game/foot/)

```
FootGame.tsx   director: the story steps, useGame (agent + contract), RAF loop, HUD state       (lead)
engine.ts      THE CONTRACT: FootCtx, PlayerState, bus events, tuning constants, outlines       (lead)
collide.ts     2D polygon collision, line of sight, approach points                               (lead)
input.ts       keys + pointer lock + drag-look fallback                                           (lead)
player.ts      createPlayer(ctx): System                                                          (A)
horde.ts       createHorde(ctx): System                                                           (B)
feeds.ts       createFeeds(ctx): Feeds (render() after the main render, scissored into FEED_RECTS) (B)
world.ts       createWorld(ctx): System                                                           (C)
IntroOverlay / InsideView / FootHud / DawnView (.tsx)  props fixed by the director                (D)
```

- **Systems never import each other.** They share `ctx` (player state, horde info, colliders, camera ownership, dawn) and a typed **bus** (`player:hit`, `player:shove`, `player:downed`, `horde:*`, `wave:*`, `world:*`, `fx:*`).
- **Frame order:** director tick → each system's `update(dt)` → main render → each system's `render()` (the feeds) → `input.endFrame()`.
- Each system is wrapped so that one crashing system logs once and the game keeps running.

## The director's steps

`intro → approach → inside → night → (hold → [breach] →) escape → safe → aftershock → dawn`. "Play again" resets to `approach` without a reload. The calls into `useGame`:
- `select(hero)` at start;
- `startScout()` within 75 m;
- `sendTip(TIP_TEXTS[i])` after the scout finishes;
- `startNight(1)` on stepping out;
- `decide("hold"|"run")` on H or R;
- `goDawn()`;
- `reset()`.

## Testing

- **Stub:** `/play?mode=foot&stub=1`: synthetic district plus a timer-driven fake agent, so the full story runs with no backend.
- **Real district, no agent:** `/play?mode=foot&agent=off`: real data from :2024, but the director never calls the agent. Use it for visuals; it costs no Vertex calls.
- **Real, live:** `/play?mode=foot`. Only the lead runs this, and only at integration.
- **Debug handle (dev only):** `window.__foot = { ctx, step }`, for emitting bus events, teleporting and moving the camera from test scripts.
- **Headless driver:** `scratchpad/shot.mjs <url> <outdir> '<steps>'`. Steps are wait, key, keys, press, click, shot and eval. It prints console errors.
- **Checks before every commit:** `npx tsc --noEmit -p .` and `npx eslint src/game/foot src/app/play`.

## Timeline v2 (adopted Sat ~6 pm: the hard deadline is 8:00 am Sunday, not 10 pm)

| Time | What |
|---|---|
| Now-1:00 am | Build everything in scope. Rolling strict-replay checks after each backend cache or recording change; one slot holder at a time on :2024 |
| **1:00 am** | **Feature freeze.** Final re-record plus strict ×3 on the frozen data and build |
| 1:00-2:30 | Record the ≤2:00 video from the `?demo=1` cut on strict replay (addresses per CoStar's answer); upload it unlisted |
| 2:30-4:00 | Final README and Devpost; merge to main; make the repo public (**the user confirms**); submit (one main track, Entertainment, plus specials; Discord usernames) |
| 4:00-8:00 | Buffer and **sleep** (the presenter's energy is scored). Devpost text edits only, no code |
| 8:30 | demo_reset; `next build` + `next start`; open the page once; fallback tabs ready. Judging 9:30 am-2:30 pm |

**Push rule:** push `main` only, never `--all`. The stale local branches feat/find-buildings, feat/replay, feat/ui and perf/live-latency carry the user's personal email.

## Timeline (original, superseded)

| Time | Milestone |
|---|---|
| 1:50 | C: ground + proportional buildings |
| 2:15 | A: player playable; B: zombies chase; D: HUD + intro |
| 2:45 | B: feeds; C: facades + lighting; D: inside + dawn |
| 3:15 | **All builders final** |
| 3:15-4:00 | Lead: merge a/b/c/d into `foot`, integration fixes, fps check on the demo laptop |
| 3:45-4:15 | Primary: strict replay ×3 on the merged branch (one night per tip, mixing HOLD and RUN) |
| **4:30** | **Gate:** walk → scout → inside → answer → wave → chased → HOLD/RUN → resolve → dawn, 3× with no reload, at least 30 fps, no console errors |
| 4:30-7:30 | Polish (cut order below), `next build` and `next start` for the demo, strict replay rehearsal |
| 8:00 | Docs, Devpost, video |
| 10:00 | Freeze |

**If the gate fails:** the map mode (`/play`) ships as the demo, and the on-foot mode becomes a 20 s teaser in the video.

## Merge procedure

1. Every builder commits on its own branch.
2. The lead merges `foot-a`, `foot-b`, `foot-c` and `foot-d` into `foot-lead`. Expect no conflicts: the builders own disjoint files.
3. The lead fixes the integration and runs the stub and agent-off checks, then the live check.
4. The primary merges `foot-lead` into `game`, then `game` into `main` after the gate.
5. Commits use the noreply identity, with no AI trailers.

## Cut order (if late)

1. CCTV shader look → plain colour CCTV
2. Lamps and point lights → moonlight only
3. Facade emissive windows → flat facades
4. The CCTV feed entirely
5. Route A* → straight line
6. Zombie count 260 → 120
7. The drone feed (keep the agent's photo override as a DOM image)
8. On-foot mode (ship the map mode)

**Never cut:** the agent loop, code-computed numbers, the walls question inside the real interior, HOLD/RUN as a human decision, the dawn case file, the disclaimer, strict replay.
