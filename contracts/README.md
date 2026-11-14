# Contracts

The messages that cross a process boundary. Change the schema and every side together.

| Contract | From → to | Producer | Consumer |
|---|---|---|---|
| `frontend_action.schema.json` | agent → web (LangGraph `custom` stream channel) | `app/scene.py` `stage()` | `web/src/lib/useSceneActions.ts` |
| `ack.schema.json` | web → Store `["acks"]` via `web/src/app/api/ack/route.ts` | WorldPane after rendering | `app/scene.py` `stage()` |
| `field_scan.schema.json` | iPhone → `POST /field/scan` | `archive/ios-RadarField/.../ScanStore.swift` (archived) | `app/routes.py`, `app/field.py` |

HTTP routes on the agent server (`app/routes.py`):

| Route | Purpose |
|---|---|
| `GET /healthz` | configuration check (models, layer modes, replay mode); no secrets |
| `GET /cases/queue` | the case queue: counts by case type and the top cases (`id`, `case`, `property_id`, `suite?`, `address`, `label`, `imagery`, `stakes`) |
| `GET /cases/inbox` | newest inbox items (`{kind, text, at}`) and recorded decisions |
| `POST /cases/decision` | `{property_id, case, decision: approve|reject, draft, suite?}`: recorded in `corrections`, never sent |
| `GET /evidence/image/{name}` | a cached evidence image (file name only) |
| `POST /field/scan`, `GET /field/scans/{property_id}` | iPhone field scans (stretch) |

The web app's own route `web/src/app/api/approvals` lists paused `radar_worker` runs and resumes them with `{decisions: [{type: approve|reject}]}`, one per action request.

Store namespaces: `memories`, `skills`, `properties` (files via deepagents backend; keys without the route prefix), `queue`, `acks`, `outbox`, `scene`, `corrections`, `("notes", "<property_id>")` or `("notes", "<property_id>#<suite>")` (team notes from people), `field/<property_id>` (plain values).
