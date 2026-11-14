# photon/ — iMessage bridge (Photon Spectrum)

Lets Retrofit Radar text the team and take requests by text. One Node process holds the
[Spectrum](https://photon.codes/docs/spectrum-ts) connection (`spectrum-ts` 12.16, cloud iMessage).

```
agent notify_me ─► app/photon.py ─► POST 127.0.0.1:8787/send ─► bridge ─► iMessage ─► your phone
your phone ─► iMessage ─► bridge ─► LangGraph run (radar_worker, one thread per sender) ─► reply
                                    └─ stops at an approval? bridge texts it; YES / NO resumes the run
```

## Setup

1. In the repo's `.env` (never committed): `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` (project
   settings on app.photon.codes), `PHOTON_OWNER_PHONE`, optional `PHOTON_TEAM_PHONE` (comma-separated),
   and `PHOTON_BRIDGE_TOKEN` (any long random string; the Python side sends it as a bearer token).
2. On the free / Pro plan every number must be added as a **project user** in the Photon dashboard first,
   otherwise sends fail with `Target not allowed for this project`.
3. `npm install`

## Run

```
npm start                 # the bridge (needs `langgraph dev` on :2024 for inbound texts)
npm run send -- "hello"   # one-off text to PHOTON_OWNER_PHONE, to check the credentials
npm test                  # unit tests for the pure helpers (src/lib.ts)
```

- Only the numbers in `.env` can be texted (`"to": "owner"` or `"team"`); inbound texts from anyone else are ignored.
- The HTTP endpoint listens on 127.0.0.1 only and requires the bearer token.
- Inbound texts go to `PHOTON_ASSISTANT` (default `radar_worker`) at `LANGGRAPH_URL` (default `http://127.0.0.1:2024`).
- Logs show the last four digits of a number, never the full number or the message text.
