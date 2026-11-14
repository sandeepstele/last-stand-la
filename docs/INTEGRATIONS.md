# Integrations

The outside services the engine talks to, the env var **names** each one needs, and where the code lives. Put values in `.env` only (copied from `.env.example`); never in code, docs, commits, screenshots or logs. Overview: [ARCHITECTURE.md](ARCHITECTURE.md).

| Service | Code | Env var names | Key? |
|---|---|---|---|
| iMessage (Photon Spectrum) | `photon/`, `app/photon.py` | `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET`, `PHOTON_OWNER_PHONE`, `PHOTON_TEAM_PHONE`, `PHOTON_BRIDGE_TOKEN`, `PHOTON_BRIDGE_PORT`, `PHOTON_BRIDGE_URL` | yes |
| Vexcel API 2.0 | `app/vexcel.py`, `app/vision.py` | `VEXCEL_API_KEY` | yes (team key) |
| Matterport Model API | `app/matterport.py`, `app/vision.py` | `MATTERPORT_TEAM_TOKEN_ID`, `MATTERPORT_TEAM_TOKEN_SECRET` (fallback `MATTERPORT_TOKEN_ID`, `MATTERPORT_TOKEN_SECRET`) | yes (team token) |
| CoStar hackathon kit | `app/costar.py` | `COSTAR_KIT_DIR` | local files, licensed |
| LA open data, USGS | `scripts/fetch_public.py` | none | no |
| Gemini on Vertex AI | `app/agent.py` | `GOOGLE_API_KEY`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | yes |
| Claude on Vertex AI (optional vision) | `app/vision.py` | `RADAR_VISION_MODEL`, `RADAR_CLAUDE_REGION`, `RADAR_VISION_EFFORT` (auth: Google application default credentials) | gcloud login |
| LangSmith tracing | LangChain | `LANGSMITH_TRACING`, `LANGSMITH_API_KEY`, `LANGSMITH_ENDPOINT` | yes |
| NREL PVWatts (solar lens only) | `scripts/solar_screen.py` | `NLR_API_KEY` | free key |

`.env.example` also lists `MATTERPORT_SDK_KEY`, `MATTERPORT_HP_BASE`, `MATTERPORT_HP_TOKEN`, `GOOGLE_GENAI_USE_VERTEXAI`, `LANGSMITH_AGENT_ID` and `LANGSMITH_AGENT_ENVIRONMENT`; no code in this branch reads them.

## iMessage bridge (`photon/`)

A small Node process (`spectrum-ts`, cloud iMessage) that holds the Spectrum connection. Full setup: `photon/README.md`.

```
agent notify_me ─▶ app/photon.py ─▶ POST 127.0.0.1:8787/send (Bearer token) ─▶ bridge ─▶ iMessage ─▶ phone
phone ─▶ iMessage ─▶ bridge ─▶ radar_worker run (one thread per sender) ─▶ reply texted back
                               └─ stops at an approval? the bridge texts it; YES / NO resumes the run
scripts/quake_alert.py ─▶ POST /trigger ─▶ bridge starts an EARTHQUAKE ALERT (or --sweep: OVERNIGHT SWEEP) run
```

- **Run it:** `cd photon && npm install && npm start`. It needs `langgraph dev` on :2024 for inbound texts. `npm run send -- "hello"` checks the credentials, and `npm test` and `npm run typecheck` check the code.
- **Endpoints:**
  - `POST /send {text, to: "owner"|"team"}`;
  - `POST /trigger {event_id?}` or `{kind: "sweep"}`;
  - `GET /healthz`.
  
  The server listens on 127.0.0.1 only, and `/send` and `/trigger` require the bearer token (`PHOTON_BRIDGE_TOKEN`).
- **Who can text:** only the numbers in `.env` can be texted or text in. On the free plan, each number must also be added as a project user in the Photon dashboard, or sends fail with `Target not allowed for this project`.
- **Inbound runs:**
  - they go to `PHOTON_ASSISTANT` (default `radar_worker`) at `LANGGRAPH_URL` (default `http://127.0.0.1:2024`), with `configurable.channel = "imessage"`, so `notify_me` stays inbox-only and `record_note` marks the note as "from a text";
  - `PHOTON_RUN_TIMEOUT_S` (default 600) bounds a run.
- **Labels and logs:** texts get a `[REPLAY] ` prefix while the agent server replays recorded answers. Logs show the last four digits of a number, never the full number or the message text.
- **Without the bridge:** `notify_me` reports `not_configured` (no `PHOTON_BRIDGE_TOKEN`) or `bridge_offline`, and keeps a copy in the in-app inbox.

## Vexcel (`app/vexcel.py`, `app/vision.py`)

- **API:** base `https://api.vexcelgroup.com/v2`, header `X-API-KEY`. WKT is longitude first: `POINT(lon lat)`, srid 4326.
- **Endpoints used:**
  - `GET property/extract` for footprint, height, roof, structures and capture history;
  - `POST ortho/extract` for top-down images, optionally from a dated collection;
  - `GET oriented/collections` and `POST oriented/extract` for oblique side views;
  - `POST elements/detect` for car counts and rooftop equipment.
- **429 (too fast):** retried with exponential backoff, up to 5 retries.
- **Caching:** results and images are cached in `fixtures/vexcel/` and `fixtures/vision/` (gitignored: licensed). `RADAR_LAYER_VEXCEL` picks cached, live or auto ([BACKEND.md](BACKEND.md#data-layers-applayerspy)).

## Matterport (`app/matterport.py`)

- **API:** the GraphQL Model API at `https://api.matterport.com/api/models/graph`.
- **Read-only.** The token is all-access (it could archive models), so the client sends only whitelisted read queries: list models, read one model's layout. `app/vision.py` adds one more read query, for a suite tour's panorama faces.
- **Tokens:** the team token sees the event's models, including the twins the kit links to properties. The personal sandbox token is the fallback.
- **Caching:** layouts are cached in `fixtures/matterport/` (gitignored). `RADAR_MATTERPORT` picks auto, live or cached.

## CoStar kit (`app/costar.py`)

- **Location:** the unzipped kit lives **outside the repo**, at `COSTAR_KIT_DIR` (default `~/Downloads/costar-hackathon-kit`).
- **Licensed for the event:** never copy its files or values into the repo, and never send kit data to an outside service. Matching against public data happens on this machine.
- **No company names:** tenant names are used only inside `app/tenants.py`, to follow a company's trail. Everything shown says "a 50-person office" instead.

## LA open data and USGS (public, no key)

Fetched once by `scripts/fetch_public.py` into `fixtures/public/` (see [BACKEND.md](BACKEND.md#public-data)):

| Data | Source |
|---|---|
| Soft-story retrofit list | data.lacity.org dataset `dqq4-799r` |
| Non-ductile concrete retrofit list | data.lacity.org `ke3z-xgni` |
| Permits since 2020: retrofit work, demolition and new building | data.lacity.org `pi9x-tg5x` |
| 1994 Northridge earthquake and its ShakeMap grid | USGS event `ci3144585` |

The earthquake is always a **labeled replay** of a past event, never presented as live.
