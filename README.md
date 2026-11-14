# Retrofit Radar

**An AI auditor for CoStar's building records.** Retrofit Radar is a LangChain deep agent. It finds places where a CoStar building record disagrees with the city's own records, the aerial imagery (Vexcel) or the inside of the building (Matterport). It investigates each disagreement the way a researcher would, looking at the images itself, and hands back a draft correction with its evidence for a person to approve. Built at HackPrinceton Fall 2026.

## The problem

Decisions about buildings rest on their records: what a building is made of, who occupies it, whether ordered work was done. Records go stale quietly. Checking them means a researcher pulling permits, photos and tours one building at a time.

## What it does

The agent opens **cases** wherever independent sources disagree. An overnight sweep works the queue on its own, and each morning it delivers a "case of the day", already investigated, with its correction draft waiting for approval:

| Case | The disagreement | Found in the CoStar kit (Houston + Los Angeles) |
|---|---|---|
| **Material conflict** | LA's non-ductile concrete retrofit list names the building; CoStar records another material | Only 12 of the 69 buildings matched to the city's concrete list are recorded as concrete by CoStar |
| **Stale entry** | A city retrofit list still names a building that was replaced | 18 found (including newer buildings that replaced a listed concrete one); some backed by demolition permits |
| **Ghost tenant** | CoStar records a company in a suite that is listed for lease right now | 316 suites, about 5,050 employees on record; 273 of them become cases (the other 43 are sublet listings, where the tenant itself offers the space) |

**By the numbers** (LA, recomputed from the kit and the city's lists on Sat Nov 14):
- **226** kit buildings are on an LA earthquake-retrofit list.
- **61** of them haven't finished the ordered work (**2,091 apartments**). Only **14** are past a deadline, even after the city's extensions; the rest are on schedule.
- **42 of the 61** felt very strong shaking (MMI 7+) in a replay of the 1994 Northridge earthquake.

For each case the agent:
1. **Opens the case:** competing hypotheses, each with a prior confidence.
2. **Chooses the evidence** most likely to separate them:
   - city retrofit filings, permit wording, and demolition or new-building permits;
   - year built and floor height against the materials used in that era;
   - lease terms and the company's trail to newer locations;
   - car counts across aerial captures;
   - **vision reads** of Vexcel aerial and oblique imagery and Matterport 360° tours, each confirmed by a skeptical second pass.
3. **Weighs the evidence in code**, not in the model. It returns a verdict (*likely*, *leaning* or *unresolved*), the next check, and a **draft correction** that a person approves or rejects. Nothing is sent to anyone.
4. **Learns from people.** A correction texted in (for example, "the property manager says the tenant is still there") becomes evidence with a source and a date. It moves the case, capped so it never settles the case on its own, and the agent says where the person and the records disagree.

**Examples (live runs):**
- **247337, Los Angeles.** The city lists non-ductile concrete; CoStar records steel. The agent looked at the facade, saw "closely spaced vertical concrete fins running the full height", and a second look confirmed it. With the retrofit plans filed with the city's concrete program, the verdict is *likely concrete, as the city lists it; CoStar's material is worth a look (0.73)*, with a correction draft for a CoStar researcher.
- **11547997.** The agent compared the 2021 and 2026 aerial captures: a pitched-roof building was replaced by a new flat-roof one. That matches a 2022 demolition permit: *likely replaced (0.98)*.
- **247386, suite 300.** CoStar records a 50-person office there, and the suite has been listed for 15 months. A leasing tour taken after the listing reads "furnished but unoccupied": *worth a look, leaning gone (0.42)*. A texted "the property manager says they're still there" moves it to *unresolved*, flags the conflict, and makes the next check a site visit.

## How it works

```
live question ─▶ orchestrator (deepagents: todos, parallel specialists)
                   ├─ records · aerial · interior · civic specialists (parallel task)
                   ├─ open_case ─▶ check_evidence (the agent chooses) ─▶ weigh_case (pure Python)
                   │      checks: filings · permits · era & height · tenancy trail · lot activity · vision (2-pass)
                   ├─ scene verbs ─▶ 3D view (three.js)
                   └─ draft correction ─▶ a person approves or rejects (recorded, never sent)
texts (iMessage via Photon) ─▶ background worker ─▶ record_note ─▶ next investigation weighs it
overnight sweep (cron) ─▶ top case ─▶ investigate ─▶ dossier ─▶ "case of the day" ─▶ file_correction waits for YES/NO
```

- **Code holds the rules; the model holds the judgment.** Matching, deadlines, priors and evidence weights are deterministic and tested. The model chooses what to check, reads the images and explains. It never types a number a tool didn't return.
- **deepagents features in use:**
  - planning with todos;
  - parallel subagents;
  - a filesystem for dossiers;
  - Store-backed team notes;
  - human-in-the-loop approvals;
  - a scheduled background worker;
  - LangSmith traces.
- **Speed:** a live case takes about 10-30 s. Model calls that stall on Vertex fall over to a faster model after 8 s.
- **Models:**
  - Gemini 3.8 Flash on Vertex AI orchestrates; Gemini 3.5 Flash-Lite runs the specialists;
  - vision reads run on Gemini 3.8 Flash, or on Claude Opus 5.5 on Vertex AI with `RADAR_VISION_MODEL=claude-opus-5-5`.

## The web app

- **Left:** the overnight case queue, plus an **Inbox** with the case of the day and any correction **waiting for you** (Approve or Reject resumes the paused background run).
- **Center:** the building in 3D.
- **Right:** the live case file. Confidence bars move as each piece of evidence lands, vision checks show the image and the agent's callout, and the draft correction has Approve/Reject.
- **Isolation and safety:** every question runs on a fresh thread, so no case's results bleed into the next. The dev server listens on 127.0.0.1 only. Approvals are recorded, never sent.

## Honesty and limits

- **We never say a record or an owner is wrong.** Either source can be out of date, so verdicts are drafts for a person to review.
- **"Unfinished" is not non-compliance.** Most retrofit orders are on schedule, with deadlines running to the 2040s. Only 14 of the 61 unfinished orders are past a deadline, even after the city's extensions.
- **Vision is evidence, not a verdict.** Its weight is capped at 0.2, it needs a confirming second look, and "can't tell" is a valid answer.
- **Car counts are lot-level** and count only as weak evidence. Tours are dated, and older tours count for less.
- **An aerial outline bigger than its own parcel** usually includes a neighbor, so the agent refuses to compare areas there.
- **Earthquake mode is a labeled replay** of the 1994 Northridge earthquake (USGS ShakeMap). It is an optional trigger, not live data; the UI and texts mark replays.
- **Company names are never shown.** Tenants appear as "a 50-person office".

## Data

- **CoStar hackathon kit:** properties, tenancies, companies, listings, attachments.
- **Vexcel:** property attributes, ortho and oblique imagery, open-vocabulary detection, capture history.
- **Matterport (team token, read-only queries):** layouts and 360° panoramas.
- **Free public data:**
  - LA's soft-story and non-ductile concrete retrofit lists;
  - LADBS permits since 2020 (retrofit, demolition and new building);
  - the USGS Northridge ShakeMap.

**Licensed CoStar, Vexcel and Matterport data is not in this repository.** It is matched only on the machine that runs the agent, and nothing from the kit is sent to outside services. Synthetic `TEST-*` fixtures let the tests run without it.

## Run it

```bash
uv sync                                                   # Python 3.11+, dependencies + dev tools
cp .env.example .env                                      # fill in keys; never commit .env
uv run pytest -q                                          # offline tests, no network
uv run python scripts/fetch_public.py                     # LA lists, permits, USGS (cached in fixtures/public)
uv run langgraph dev --host 127.0.0.1 --port 2024 --no-browser --n-jobs-per-worker 4
cd web && npm install && npm run dev   # http://127.0.0.1:3000; defaults to the agent server on 127.0.0.1:2024
```

Optional:
- **iMessage:** `cd photon && npm install && npm start`. This is the Photon Spectrum bridge; it needs `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `PHOTON_OWNER_PHONE` and `PHOTON_BRIDGE_TOKEN`, and each phone number must be added as a Photon project user.
- **Demo helpers:**
  - `scripts/demo_reset.py` clears team notes, decisions, drafts and paused worker runs between demos;
  - `scripts/demo_flow.py --runs 5` runs the scripted demo and prints a timing table;
  - `scripts/quake_alert.py` fires the labeled Northridge replay.
- **Offline fallback:**
  - record a good run with `RADAR_REPLAY=record:demo`;
  - replay it with `RADAR_REPLAY=demo` (add `RADAR_REPLAY_STRICT=1` to forbid live model calls).

  The tools, images and 3D view stay real, and the UI shows a REPLAY badge.

## Team

[TEAM: names, Discord usernames]. Built at HackPrinceton Fall 2026 (Nov 13-15).
