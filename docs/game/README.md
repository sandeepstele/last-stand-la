# docs/game: Last Stand LA

Everything about the game in one folder. For the engine underneath (the deep agent, the evidence engine, the data layers), start at the [repo README](../../README.md) and [docs/AGENT.md](../AGENT.md).

| Doc | Read it for |
|---|---|
| [HOW_TO_PLAY.md](HOW_TO_PLAY.md) | One page beside the game: keys, each step of a day, side missions, the career summary |
| [DEMO.md](DEMO.md) | The 2-minute pitch, judge Q&A, the ops checklist (appendix: the night mode) |
| [DEVPOST.md](DEVPOST.md) | The Devpost write-up |
| [VIDEO_SHOTLIST.md](VIDEO_SHOTLIST.md) | The video, shot by shot |
| [DESIGN.md](DESIGN.md) | The night mode's design and decision log (zombie fallback) |
| [CONTRACT.md](CONTRACT.md) | The night mode's HTTP contract and the exact agent messages the replay covers |

## Try it

```bash
# agent server (see the repo README for setup)
uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --no-reload --n-jobs-per-worker 4
cd web && npm run dev
# http://127.0.0.1:3000/play?mode=foot            the four-day game (live agent)
# http://127.0.0.1:3000/play?mode=foot&demo=1     the 2-minute stage cut (Day 1)
# http://127.0.0.1:3000/play?mode=foot&stub=1     synthetic, no backend
# http://127.0.0.1:3000/play?mode=foot&agent=off  real district, no agent calls (visual testing)
```

The night mode (zombies) runs with `NEXT_PUBLIC_GAME_GRAPH=laststand` set for the web app.
