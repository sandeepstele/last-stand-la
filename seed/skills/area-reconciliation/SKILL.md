---
name: area-reconciliation
description: How Retrofit Radar decides whether a building's listed area agrees with what the aerial and the twin measured, and how to explain a gap before flagging it. Use for any building verification.
---

# Area reconciliation

The arithmetic is done by the `verify_building` tool. Never compute or state an area yourself.

**Expected range** = footprint x listed stories x efficiency band (0.80-1.00, rentable vs. gross).
Listed stories are assumed to count floors from the entrance level up (verify with CoStar).

**A gap is a question, not an error.** Before calling anything "worth a look", test:

| Hypothesis | Who tests it |
|---|---|
| Below-grade levels (basement, garage) | interior (Matterport twin) |
| Mezzanine or partial floors | interior |
| More or fewer floors than listed | interior + aerial height |
| Setback tower or podium | aerial (oblique imagery) |
| Footprint merges a neighbor / several buildings | aerial + records |
| Addition or demolition since the record | needs two captures; usually untested |

**Verdicts:** consistent, verified inside and out, explained, likely explained, worth a look.
Always give the range and the confidence. Never say "CoStar is wrong".

Constants marked PLACEHOLDER in `app/verify.py` must be replaced with sourced values before the demo.
