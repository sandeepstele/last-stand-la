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

## Game contract v1.1 (in progress)

> **In progress.** Last Stand LA is being built on the `game` branch; none of these routes, tools or files exist in this branch. **Source of truth:** `PLAN.md` in the team's private planning repo, sections "Contract v1.1" (frozen 12:40, supersedes v1 where they differ) and "Contract v1". This is a copy for convenience. Changes go through the coding lead. Hero buildings are listed in `PLAN.md`.

### v1 (original shapes)

```
GET /game/district ->
{ center:{lat,lon}, radius_m, seed,
  buildings:[{ pid, label, x, z,                 // metres east/south of center
     footprint:[[x,z],...]|null, w, d,           // w,d used when footprint null
     height_m, stories, material:"concrete|steel|masonry|wood|unknown",
     list:"concrete|soft_story|null", unfinished:bool, past_due:bool, mmi:number|null, hero:bool }],
  waves:[{ n, sector:"N|NE|E|SE|S|SW|W|NW", arrive_s, size }] }

GET /game/dossier/{pid} ->
{ pid, label,
  scores:{ walls|quake|roof|people|space: { value:0-100, label:"likely|leaning|unresolved|known", why, source } },
  unknowns:[string], images:{ drone:[name.jpg], cctv:[name.jpg] },   // served by /evidence/image/{name}
  case:{ case, question, hypotheses:[{key,claim,prior}] } | null,
  disclaimer:"Game outcome, not an engineering assessment" }

POST /game/resolve {pid, wave, seed} -> { held:bool, walls_roll, quake_roll, why }

Tool results in the stream (graph "laststand"):
  fortress_dossier(pid)      -> same shape as GET /game/dossier
  horde_status()             -> { wave, sector, eta_band:"<30s|30-60s|>60s", size_band:"small|large|huge" }
  find_fallback(pid)         -> { from_pid, to_pid, to_label, distance_band, reason }
  commit_plan(pid, action, to_pid?)  [interrupt_on]  args shown in HOLD/RUN
  open_case / check_evidence / weigh_case / record_note   (existing shapes; see web/src/components/Cases.tsx)
```

Scores, rolls and wave scripts are computed in Python, seeded and rounded, so strict replay keys stay stable. The model never sets a number.

### v1.1 changes (frozen)

- **`POST /game/resolve`:**
  - takes `{pid, wave, seed, action: "hold"|"run", to_pid?, checks: [...]}`;
  - returns `{held, walls, quake, walls_roll, quake_roll, why, pid_final}`;
  - the server re-runs `weigh_case` with the Store notes.
- **`commit_plan`:**
  - allowed decisions are approve, edit and reject;
  - once approved or edited, its tool result **is** the resolve object, so it lands in the trace;
  - the button matching the agent's proposal sends `{type: "approve"}`;
  - the other button sends `{type: "edit", edited_action: {name: "commit_plan", args: {pid, action, to_pid}}}`;
  - reject means "no orders, holding";
  - the `/play` page has its own respond call, and `Panels.tsx` is untouched.
- **Tools:**
  - `horde_status(wave: int) -> {wave, sector, eta_band, size_band}`;
  - `find_fallback(pid, away_from?: sector) -> {from_pid, to_pid, to_label, distance_band, reason}`.
- **Proxy:** a new route `web/src/app/api/game/[...path]/route.ts` allows only `GET game/district`, `GET game/dossier/{pid}` and `POST game/resolve`. The shared proxy is not edited.
- **Optional fields** (null when absent):
  - district building: `year_built`, `people`, `conflict: {costar, city}`;
  - dossier: `images.pano: [{face: "f0..f5", name}]`.
- **Threads:** one thread on graph `laststand`:
  1. "Scout <pid>";
  2. "Wave n is coming" (`horde_status` and `find_fallback`, then the `commit_plan` interrupt);
  3. "Tip: ..." (`record_note` and `weigh_case`).
