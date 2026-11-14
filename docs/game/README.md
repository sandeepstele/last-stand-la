# docs/game: Last Stand LA

Everything about the game in one folder. For the engine underneath (the deep agent, the evidence engine, the data layers), start at the [repo README](../../README.md) and [docs/AGENT.md](../AGENT.md).

| Doc | Read it for |
|---|---|
| [DESIGN.md](DESIGN.md) | What the player does and sees, real data → mechanics, how the deep agent changes play, honesty rules, what's cut |
| [BUILD_PLAN.md](BUILD_PLAN.md) | Branches and owners, architecture of `web/src/game/foot/`, how to test, timeline and gates, merge procedure, cut order |
| [CONTRACT.md](CONTRACT.md) | HTTP contract v1.3, the exact agent messages the replay covers, the six recorded nights, the engine's bus events |
| [CRITIQUE.md](CRITIQUE.md) | What's been fixed, the open risks ranked with owners, the judging lens, how we could lose |
| [DEMO.md](DEMO.md) | The 2-minute demo script, per-judge lines, the ops checklist, the fallback ladder |

## Status (Sat Nov 14, ~1:20 pm)

- **Map mode** (`/play`): the end-to-end gate passed 3/3 live at 12:25. It's the fallback.
- **On-foot mode** (`/play?mode=foot`):
  - the skeleton runs (intro → walk → inside → night → escape → dawn) on synthetic data;
  - four builders are filling in the player, zombies plus live feeds, the real city, and the UI;
  - the gate is at **4:30**.
- **Backend:** contract v1.3 (aerial ground, OSM outlines, doors, inside views); six on-foot nights recorded; strict replay 3× clean.

## Try it

```bash
# agent server (see the repo README for setup)
uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --no-reload --n-jobs-per-worker 4
cd web && npm run dev
# http://127.0.0.1:3000/play?mode=foot            live
# http://127.0.0.1:3000/play?mode=foot&stub=1     synthetic, no backend
# http://127.0.0.1:3000/play?mode=foot&agent=off  real district, no agent calls (visual testing)
# http://127.0.0.1:3000/play                      the map mode (fallback)
```
