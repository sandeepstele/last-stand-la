# Pre-freeze evaluation results

## P1: deterministic evidence engine

**Pitch line:** The auditor matched **14/14 (100%) hand-labelled cases**: likely 11/11, leaning 3/3, unresolved 0. The remaining 16 of 30 candidates stay unlabelled because the available evidence does not settle them.

| Leader confidence | Cases | Mean confidence | Observed matches |
| --- | ---: | ---: | ---: |
| 50–60% | 3 | 52.0% | 3/3 (100%) |
| 60–80% | 6 | 70.7% | 6/6 (100%) |
| 80–100% | 5 | 83.4% | 5/5 (100%) |

The sample was deliberately enriched for stronger signals and is not representative of all cases. The small confidence bins do not establish calibration or general accuracy. Do not present the score without that caveat.

## P2: vision crops and voting

Not measured. This checkout has only two cached oblique/ortho image pairs and no per-view vision labels or image ground truth. The prior Gemini attempt returned Vertex 403; this pass stayed offline. No crop or voting changes were connected to the app.

## P5.1: thinking-level comparison

Not measured. There are no paired low/medium replay outputs, and this pass stayed offline after the Vertex permission failure. Accuracy-versus-time results need authorized model access and a fixed labelled prompt set.

No prompts or evidence weights changed.
