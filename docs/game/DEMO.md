# Last Stand LA: demo script and ops

## The 2-minute pitch: one engine, two doors (current)

| Time | On screen | Say |
|---|---|---|
| 0:00 | The game starts; the HQ panel shows "Tonight's cases: #7 and #6 of 328" | "CoStar's records are only true if someone checks them. Our AI auditor works CoStar's real queue of 328 open cases, and tonight it sends you to two of them." |
| 0:10 | Suite 1100's real tour: [1] "Empty" | "CoStar says three people work here, but the suite is listed for lease. I look: empty. That's evidence now." |
| 0:20 | [F] to the fortress; the walls question; [1] Concrete; the odds move | "Case two: CoStar says masonry, the city says concrete. The agent looked at the aerial itself; I confirm from inside." |
| 0:35 | The wave; "HQ proposes RUN"; [R]; [F] fast-forward; dawn | "It reads the horde and proposes, and I decide. Code rolls every number." |
| 0:45 | **File the report** → the auditor on 737 Broadway, with "the player" as a human report in the case file | "What you just played is the real product: the same deep agent, as CoStar's auditor." |
| 0:50-1:45 | The auditor: the queue (#6 with your note), a ghost-tenant case, case of the day from the overnight sweep, a texted correction moving a verdict | the auditor script (README) |
| 1:45-2:00 | The numbers | "226 on retrofit lists, 61 unfinished, only 12 of 69 concrete records agree. Inside and out, the record should match the building." |

Use `?demo=1` for the presenter fast-forward [F]. The judge can play the full game at the table afterwards.

## The 2-minute table demo (on foot only, older script)

| Time | On screen | Say |
|---|---|---|
| 0:00 | The intro: the camera circles real downtown LA | "Every building here is real: CoStar's record, the city's retrofit orders, Vexcel's aerials, Matterport's tours. The zombies are fake. The weak spots are real." |
| 0:15 | Start; walking toward the hero building; the radio comes alive | "My commander is a LangChain deep agent. Four squads read the records in parallel… and they disagree: CoStar says masonry, the city's retrofit list says concrete." |
| 0:30 | The DRONE feed flips to the real aerial: "HQ looked: concrete frame visible" | "It doesn't guess. It picks the evidence and looks at the aerial itself. Code weighs it: 66% concrete." |
| 0:45 | [E] at the door: the real interior (its own 3D tour). Press [1] "Concrete" | "So I go in and look. My report is testimony: it moves the odds, capped, never final. 72% now." |
| 1:05 | Step out: the horde comes down the street from the west. "HQ proposes: RUN to [fallback]." Press [R] | "The agent read the horde, found a fallback away from it, and it waits for me. I make the call." |
| 1:20 | Sprint along the route, chased; Space shoves; the doors shut. Aftershock | "The walls roll against the scores, and the aftershock against the 1994 Northridge shaking at this exact block. Seeded, so every number is code." |
| 1:40 | Dawn: the case file and the draft correction | "And at dawn, the night produced something real: the evidence and a correction to a building record, for a human to approve. Game outcome, not an engineering assessment." |

**Variant (if time or a judge asks):**
1. Play again.
2. Answer [2] "Brick": the odds drop to 54%.
3. HOLD: the walls are 71 vs a roll of 78, so they break in. Run.

**Per-judge first lines:**
- **CoStar:** "Inside and out: you walk on the Vexcel aerial and into the Matterport tour, and the plot is a CoStar record the city disagrees with."
- **LangChain:** "todos, four parallel subagents, model-chosen case tools, an interrupt a player answers, a capped note from a human. The trace is in the other tab."

## Ops checklist

1. **Agent server** (primary):
   ```
   RADAR_REPLAY=game RADAR_REPLAY_STRICT=1 uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --no-reload --n-jobs-per-worker 4
   ```
   Then check that `curl -s 127.0.0.1:2024/healthz` shows `"replay":"game"`.
   - **Pacing:** `RADAR_REPLAY_DELAY_S` (default 1.0 s, judge-like; the primary verifies at 0.3).
   - **Never put `RADAR_REPLAY` in `.env`:** under `langgraph dev`, `.env` overrides the shell, so the server would be stuck in replay.
   - **Verify or re-record:** `scripts/game_nights.py` (see CONTRACT.md).
2. **Web:** `cd web && npm run build && npm start` (production; port 3000). Open `http://127.0.0.1:3000/play?mode=foot` once to warm it up.
3. **Between judges:** `uv run python scripts/demo_reset.py`, then press Enter on the dawn screen (or reload).
4. **Fallback ladder:**
   1. Live mode, if replay misbehaves (`RADAR_REPLAY` unset; timings in CONTRACT.md).
   2. The map mode `/play` (live only).
   3. The auditor at `/` (tag `auditor-v1`).
   4. The recorded video.
5. **Before the video:** confirm with CoStar whether real addresses may appear. Otherwise hide labels or crop.
6. **Never** edit `app/` on the demo machine while judges are around; the server has no hot reload.
