# Retrofit Radar

**The built world, ground-truthed.** A LangChain deep agent that checks a commercial building's listed area and stories against what the aerial and the interior twin actually measure, explains any gap before flagging it, and then sizes a solar and roof retrofit on numbers it trusts. A background worker keeps screening the watchlist. Built at HackPrinceton Fall 2026.

## Who it's for and the problem

**Who:** commercial solar and retrofit developers and asset managers screening Houston and Los Angeles buildings.

**The problem:** retrofit decisions rest on records someone typed in once (square feet, stories, roof), and checking a portfolio means checking each building by hand.

**What Retrofit Radar does:** it reads three layers for the same address:
- **CoStar records:** what the building claims to be.
- **Vexcel aerials:** what it looks like from above.
- **Matterport twins:** what it looks like inside.

When the layers disagree, it tests explanations such as a basement, a mezzanine, the floor count, a setback or a merged footprint. It then reports either **"verified inside and out"** or **"worth a look"**, with a range and a confidence, and never "the record is wrong". Finally it sizes solar on the usable roof and reports kWh per year and tonnes of CO2 avoided.

## How it works

```
question ─▶ orchestrator (deep agent, todos)
             ├─ records · aerial · interior specialists (parallel subagents)
             ├─ verify_building(property_id)  ← pure Python, loads every number from the data layers
             ├─ scene verbs ─▶ 3D world pane (each action confirmed by the browser)
             └─ retrofit(property_id)         ─▶ answer + approvals for anything that leaves the app
heartbeat ─▶ background worker: queue → verify → dossier → notify
```

The architecture, contracts, verifier rules and build plan are in [docs/ENGINEERING.md](docs/ENGINEERING.md). The message schemas are in [contracts/](contracts/).

## Run it

```bash
uv venv && uv pip install -e . pytest "langgraph-cli[inmem]"   # Python 3.11+
cp .env.example .env                                           # fill in keys; never commit .env
.venv/bin/python -m pytest -q                                   # 51 tests, no network
.venv/bin/langgraph dev --host 0.0.0.0 --port 2024 --no-browser # both graphs + /field/scan
.venv/bin/python scripts/seed_store.py --queue TEST-A           # standing orders, skills, queue
cd web && cp .env.local.example .env.local && npm install && npm run dev   # http://localhost:3000
```

Models are set in `.env`:
- **Live answers:** `gemini-3.8-flash` (`RADAR_ORCH_MODEL`), thinking low.
- **Live specialists:** `gemini-3.5-flash-lite` (`RADAR_FAST_MODEL`), thinking minimal.
- **Background worker:** `gemini-4-argon` (`RADAR_WORKER_MODEL`) with `gemini-3.8-flash` specialists (`RADAR_SPEC_MODEL`), thinking low.

All run on Vertex AI. Live calls get 8 s per attempt and then move to the other model; the worker has no timeout ([docs/ENGINEERING.md](docs/ENGINEERING.md) §4).

## What's real and what isn't (yet)

| Piece | Status |
|---|---|
| Verifier, twin analysis, field-scan parsing | Real; 51 tests |
| Live and worker graphs through `langgraph dev` | Real. Live answer in 22–31 s; worker tick writes dossiers. |
| CoStar / Vexcel data | **Cached fixtures.** `TEST-A` is **synthetic**. The CoStar toolkit adapter is in progress. |
| Matterport | Real read-only client on the HackPrinceton team token: picks the best twin the CoStar kit links to each property (nearest 250 m, largest scanned floor). |
| Web app | One page: 3D world pane, plan, specialists, verifier card, approvals |
| Photon texting | Outbound adapter written; not configured. Notifications land in the in-app outbox. |
| Radar Field (iOS LiDAR field check) | Compiles for device; see [ios/RadarField/README.md](ios/RadarField/README.md) |

## Limits we are honest about

- Solar yield, building electricity use, grid emissions and a few geometry constants are **placeholders** until sourced. Every result lists them.
- Footprint × stories approximates gross area; listed figures follow other conventions. That is why the verifier reports a **band**, not a point.
- A phone scan measures rooms, not buildings: its ceiling height only caps the floor count.
- Data from CoStar, Vexcel and Matterport is licensed for the event and is not in this repository.
