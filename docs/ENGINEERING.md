# Engineering notes

See also: [ARCHITECTURE.md](ARCHITECTURE.md) (the system map and part docs) and [CONTRIBUTING.md](CONTRIBUTING.md) (setup, tests, branch, commit and data rules). The original Friday plan is archived in [archive/ENGINEERING-friday.md](archive/ENGINEERING-friday.md).

**Current frame (Sat Nov 14, from 9:11 am): the AI auditor for CoStar's records.** The agent opens a *case* wherever a
CoStar record disagrees with another source, chooses the evidence that would settle it, weighs it in code, and hands back
a draft correction for a person to approve. Case types and their code:

| Case | Disagreement | Code |
|---|---|---|
| material_conflict | LA's non-ductile concrete list vs CoStar's recorded material | `app/retrofit_lists.py`, `app/evidence.py` |
| stale_entry | a city retrofit list still names a replaced building | `app/retrofit_lists.py`, `app/evidence.py` |
| ghost_tenant | a tenant on record in a suite that is listed for lease | `app/tenants.py`, `app/evidence.py` |

- **Evidence:** reusable checks return `{finding, effects: [{hypothesis, delta}], why}` (`app/evidence.py`). Vision checks
  (`app/vision.py`: Vexcel ortho/oblique/dated captures, Matterport panoramas) need a confirming second pass and are capped
  at ±0.2. Human reports (`record_note` → `human_report`) are capped at +0.35 and flagged when they contradict the records.
- **Tools:** `open_case`, `check_evidence`, `weigh_case`, `record_note`, `seismic_status`, `find_retrofit_targets`,
  `quake_replay`, plus the earlier verifier and scene tools. The live answer takes 3 model turns, plus 2 when a case is open.
- **UI:** queue (`GET /cases/queue`), 3D view, case file with live confidence bars, evidence images
  (`GET /evidence/image/{name}`) and Approve/Reject (`POST /cases/decision`, recorded only).
- **Demo:** `scripts/demo_reset.py`, `scripts/demo_flow.py`, and the labelled replay fallback (`app/replay.py`).
- **Verified numbers (Sat ~10:30 am, after the review fixes):**
  - 226 LA kit buildings are on a retrofit list; 61 are unfinished (2,091 apartments); 14 are past a deadline.
  - Only 12 of 69 concrete-list matches are recorded as concrete by CoStar.
  - In the Northridge replay, 42 of 61 felt MMI 7+.
  - Queue: 37 material_conflict, 18 stale_entry, 273 ghost_tenant (316 suites minus 43 sublets).
- **Approvals:** a paused background run (the sweep's `file_correction`) appears in the web Inbox through `web/src/app/api/approvals`. That route resumes only `radar_worker` threads. iMessage YES/NO resumes the same interrupt.
- **Review log (Sat, three independent code reviewers plus runtime probing; every item verified with a probe script, then fixed):**
  - Replay: reused message ids and date-dependent keys.
  - Hedged verdict text everywhere.
  - ShakeMap cell spacing.
  - Replaced concrete buildings now open stale_entry.
  - Accessory permits ignored; tenant-trail double counting fixed; address ranges matched.
  - Finaled permits; float label margins.
  - Duplicate ghost cases.
  - UI: a fresh thread per question, case-scoped verdicts, no double submits, the replay badge re-polls, localhost-only dev server.
- Engineering rules: the model never types a number, the data layers load by property ID, and licensed data stays local.
