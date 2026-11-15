# Private case evaluation

`build_set.py` samples 30 cases from the local licensed kit and writes `cases.jsonl` beside these scripts. The JSONL is Git-ignored because it contains licensed property identifiers. It leaves labels blank for human review.

Use independent evidence when assigning `truth`, `confidence_of_label` (0–1), and `source_of_truth`. Leave a case unlabelled when the available evidence does not settle it. The sample is intentionally enriched for cases with stronger label evidence; it is not a random or population-representative sample.

Run `uv run python evals/run_eval.py` to evaluate the labelled cases with the deterministic evidence engine. The runner forces Vexcel and Matterport to cached mode, blocks uncached vision calls, and reports results only for labelled cases. Missing image evidence contributes no shift. The report is descriptive; a small signal-enriched set cannot establish general accuracy or calibrated probabilities.
