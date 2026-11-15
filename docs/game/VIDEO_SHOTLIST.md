# Video shot list: Bob's Desk (2:00 cut)

For whoever records the submission video (about 1 am). The voice-over is the pitch in DEMO.md, line for line. Build: `desk` a4279e2 (merged into `game`). **[TEAM]** marks a human decision.

## Before you record
1. **Server:** the agent server on :2024 in replay (stage recordings). Ask the backend session for "SLOT FREE" first: one client only while recording.
2. **Reset:** `uv run python scripts/demo_reset.py` (or Play again on the dawn screen). Every take starts from a reset.
3. **Window A (the game):** `http://127.0.0.1:3112/play?mode=foot&demo=1`, 1920×1080, browser zoom 100%, sound on (V toggles it). For the cleanest frame rate use the production build instead: `cd web && npm run build && npm start`, then `http://127.0.0.1:3000/play?mode=foot&demo=1`.
4. **Window B (the agent log):** `/play/log` on the same host, in the same browser so it follows the live shift.
5. **Lower third for the whole video:** "Simulated post-quake placards. Game outcomes, not engineering assessments."
6. **Don't show** `?stub=1` or `agent=off`, or the browser's address bar if possible. **[TEAM: street addresses only if CoStar OKs it; otherwise blur the building labels.]**

## The cut

| # | Time | Window / URL | What to do | On screen | Voice-over |
|---|---|---|---|---|---|
| 1 | 0:00–0:10 | A: `/play?mode=foot&demo=1` | Let the intro dive play; press **Enter** at about 0:08 | Downtown LA from above, 1,581 buildings, the title | "After Northridge, inspectors tagged 66,000 buildings green, yellow or red, often in under half an hour each. I'm Bob, LA building office, one shift." |
| 2 | 0:10–0:25 | A | Press **Tab** (the desk). Hold on the squad radio | The radio's first line: *"Last shift Bob changed my yellow to red at 601 Broadway, and the aftershock showed red was right."* | "My analyst is a LangChain deep agent, and it opens with what it learned from me yesterday. My corrections become its lessons." |
| 3 | 0:25–0:40 | A (desk) | Click the **737 Broadway** card; let the camera rest on the amber box, then the map | Cards filling line by line, one source each; "CoStar record says masonry · LA retrofit list says concrete"; the city map | "Real open cases from CoStar's data. It sends four squads in parallel, and every building gets a card: CoStar, Vexcel, Matterport, city lists, the county assessor. Amber where sources disagree." |
| 4 | 0:40–0:58 | A | **Tab** (back to the street), **F** (skip the walk), **E** (go inside), **1** (concrete). Then **Tab** for one beat on the calculation | The building's own 3D tour; the calculation: aerial +0.20, filings +0.12, 3D scan +0.05, Bob's site report +0.25 → **73%** | "On records alone, probably masonry. I walk in and report concrete. My report is evidence, capped at 0.35, never final: 73% concrete now." |
| 5 | 0:58–1:20 | A | **Tab** to close, **E** (step out). When HQ proposes YELLOW, press **3** (RED). Then **W A S D** to Maya and Luis (HELP beacons) and lead them to the green ring | "Simulated quake at 5:02 pm"; day to night; people running, cars on hazards; "Simulated aftershock in 0:45"; "HQ proposes a YELLOW tag … code suggests YELLOW"; RED posted | "A simulated quake. Aftershock in 45 seconds, two people trapped. The agent proposes yellow and waits for me. 251 people work here: red. And I get those two out." |
| 6 | 1:20–1:42 | A (dawn) | Let the dawn screen settle; slow pan from the shift report to Agent vs Bob | Complete damage, RED right, **251 of 251 safe**; "Rescue (simulated): 2 of 2"; **"the agent proposed YELLOW · Bob posted RED (override) · the aftershock says RED: Bob was right"** | "Complete damage. Red kept all 251 safe; yellow would have left 25 inside. I overrode the agent and I was right, and that goes into its log for tomorrow. Every call is also saved as a preference pair, the format RLHF uses. We didn't train anything tonight; we collect it." |
| 7 | 1:42–1:52 | B: `/play/log` | Scroll slowly | The agent's steps: who acted, which data it pulled, the maths table | "Every number is published maths in code: FEMA screening, HAZUS damage, ATC-20 placards." |
| 8 | 1:52–2:00 | A | Click **File the reports**; end on the auditor case and the title card | The auditor case with Bob's report in it | "The same agent works the real record queue. Bob's Desk: a deep agent does the work, you correct it, the aftershock grades you both." |

## If a take goes wrong
- **The aftershock hits before Maya and Luis are out:** keep rolling. Dawn says "Rescue (simulated): 0 of 2" and Bob may be hurt; replace the rescue line with "I didn't make it to them."
- **A step takes longer than the cut:** trim in the edit. The agent waits for Bob at the placard, so there is no rush before shot 5.
- **"HQ couldn't finish the drafts":** a replay miss. Reset and retake; tell the backend session the time.
- **The memory line has scrolled out of the desk radio by shot 2:** press **L** instead; the agent log lists the commander's first line near the top. Or open the desk sooner (Tab right after Enter).
- **A reload mid-take:** the intro shows "Saved shift … Enter continues it". Press Enter to continue the same shift, or reset and retake for a clean video.

## Capture tips
- 1920×1080 at 60 fps. Record the game and the log windows separately and cut between them.
- Hide the cursor except in the desk shots (3) and the File click (8).
- Record the voice-over separately and lay it over; mute game sound with V if it clashes.
- Keep it at 2:00 or less; cut shot 7 shorter before cutting anything else.
