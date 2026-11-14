# Contracts

The messages that cross a process boundary. Change the schema and every side together.

| Contract | From → to | Producer | Consumer |
|---|---|---|---|
| `frontend_action.schema.json` | agent → web (LangGraph `custom` stream channel) | `app/scene.py` `stage()` | `web/src/lib/useSceneActions.ts` |
| `ack.schema.json` | web → Store `["acks"]` via `web/src/app/api/ack/route.ts` | WorldPane after rendering | `app/scene.py` `stage()` |
| `field_scan.schema.json` | iPhone → `POST /field/scan` | `ios/RadarField/.../ScanStore.swift` | `app/routes.py`, `app/field.py` |

Store namespaces: `memories`, `skills`, `properties` (files via deepagents backend; keys without the route prefix), `queue`, `acks`, `outbox`, `scene`, `field/<property_id>` (plain values).
