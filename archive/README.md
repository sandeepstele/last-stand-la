# Archive

Files kept for history and fallback; none of them is used by the current app, the tests or the demo.
Restore any of them with `git mv archive/<path> <original path>`.

| Archived | Was | Why archived |
|---|---|---|
| `ios-RadarField/` | `ios/RadarField/` | iPhone LiDAR field-scan app from the Friday plan; never part of the demo. The `/field/scan` route and `contracts/field_scan.schema.json` still exist on the backend. |
| `scripts/investigate.py` | `scripts/investigate.py` | Command-line runner for the original twin verifier (Friday plan). |
| `scripts/vexcel_probe.py` | `scripts/vexcel_probe.py` | One-off Vexcel API probe used while wiring the client. |
| `web-public/*.svg` | `web/public/*.svg` | Unused create-next-app template icons. |

Solar code (`app/solar.py`, `scripts/solar_screen.py`) is **not** archived: the data layer and `find_buildings` still import it. It is hidden from the UI.
