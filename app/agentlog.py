"""A judge-readable log of one deep-agent run: who acted, which data it pulled, and the arithmetic behind each verdict.

Built only from the thread's own messages (the same tool results the agent saw). It never calls a model or a data
API, and it shows no company names (tool outputs already use descriptors like "a 3-person office"). The verdict
arithmetic is recomputed from weigh_case's own priors and evidence trail, exactly as app/evidence.weigh_case does it:
score = prior + sum of the check shifts (photo reads capped at +/-0.2, a person's report at +0.35); floor at 0.02;
normalise so the scores add to 100%; the label comes from fixed thresholds.
"""

from __future__ import annotations

import json
from typing import Any

SQUADS = {"records": "Records squad (CoStar building record)", "aerial": "Aerial squad (Vexcel roof, height, footprint)",
          "interior": "Interior squad (Matterport 3D scan)", "civic": "Civic squad (LA retrofit lists, permits, 1994 ShakeMap)",
          "critic": "Dawn critic (a second, independent model)", "general-purpose": "Explainer"}

SOURCES = {
    "night_cases": "CoStar's open-case queue, matched locally against LA's lists (code)",
    "fortress_dossier": "Fortress scores computed in code from CoStar, LA retrofit lists, the 1994 ShakeMap and Vexcel",
    "open_case": "Case hypotheses and starting odds (code)",
    "weigh_case": "Evidence weighed in code (no model)",
    "record_note": "Your report, saved as a team note (counts as testimony, capped)",
    "horde_status": "Seeded wave script (code)",
    "find_fallback": "Nearest stronger building, ranked in code by walls and quake scores",
    "commit_plan": "Waits for your HOLD/RUN, then a seeded dice roll against the scores (code)",
    "draft_correction": "Hedged correction draft built in code from tonight's evidence",
    "log_night": "Night log written in code from tonight's tool results (memory)",
    "read_file": "Last night's log (memory)",
    "write_todos": "The agent's plan",
    "task": "A squad (sub-agent) runs in parallel",
    "case_file": "The case's code-built evidence trail",
}
CHECK_SOURCES = {
    "look_from_above": "Vexcel oblique + top-down photos, read by Gemini twice (independent second look must agree)",
    "compare_captures": "Vexcel photos from two dates, read by Gemini twice",
    "suite_tour": "Matterport tour panoramas of the suite, read by Gemini twice",
    "interior_geometry": "Matterport 3D mesh of the scanned floor: measured ceiling height and floor span (code)",
    "compliance_filings": "LA retrofit-program filings for the building",
    "permit_text": "LA building-permit descriptions",
    "replacement_permits": "LA demolition / new-building permits",
    "era_and_height": "CoStar year built and floors vs the Vexcel height",
    "site_structures": "Vexcel structure count on the parcel",
    "listing_timeline": "CoStar listing dates vs the tenancy on record",
    "lease_terms": "CoStar lease terms",
    "tenancy_trail": "The tenant's other locations on record (no names shown)",
    "lot_activity": "Vexcel car counts on the lot across captures",
    "human_report": "A person's report (team note)",
}
HUMAN_CAP, VISION_CAP, FLOOR = 0.35, 0.2, 0.02


def _json(x: Any) -> Any:
    if isinstance(x, (dict, list)):
        return x
    s = str(x or "")
    i = s.rfind("Tool response:")
    s = s[i + len("Tool response:"):] if i >= 0 else s
    j = s.find("{")
    try:
        return json.loads(s[j:]) if j >= 0 else None
    except ValueError:
        return None


def _text(c: Any) -> str:
    return c if isinstance(c, str) else " ".join(b.get("text", "") for b in c or [] if isinstance(b, dict))


def math(w: dict) -> dict | None:
    """Recompute weigh_case's arithmetic from its own priors and trail, step by step."""
    priors, trail, post = w.get("priors"), w.get("trail") or [], w.get("posterior")
    if not priors or post is None:
        return None
    score = dict(priors)
    rows = []
    for t in trail:
        for e in t.get("effects") or []:
            score[e["hypothesis"]] = round(score.get(e["hypothesis"], 0) + e["delta"], 4)
            rows.append({"check": t["check"], "hypothesis": e["hypothesis"], "shift": e["delta"]})
    floored = {k: max(v, FLOOR) for k, v in score.items()}
    total = round(sum(floored.values()), 4)
    v = w.get("verdict") or {}
    return {"start": priors, "shifts": rows, "sum": {k: round(x, 2) for k, x in score.items()}, "floor": FLOOR,
            "total": total, "result": post, "leader": v.get("hypothesis"), "confidence": v.get("confidence"),
            "label": v.get("label"),
            "rule": "score = start + shifts (photo reads capped at ±0.2, a person's report at +0.35); "
                    "floor 0.02; divide by the total so the odds add to 100%; "
                    "likely if ≥60% (or ≥50% with a 30-point lead), leaning if ≥50% (or ≥40% with a 20-point lead)"}


def _summary(tool: str, args: dict, data: Any, raw: str) -> tuple[str, dict | None]:
    d = data if isinstance(data, dict) else {}
    if not d:
        return (raw[:220] if raw else ""), None
    if d.get("error"):
        return f"refused: {d['error'][:160]}", None
    if tool == "night_cases":
        cs = "; ".join(f"#{c['n']} {c['label']} ({c['case'].replace('_', ' ')})" for c in d.get("cases") or [])
        return f"{d.get('total')} open cases, {d.get('in_area')} in our blocks; tonight: {cs}", None
    if tool == "fortress_dossier":
        s = d.get("scores") or {}
        return "scores: " + ", ".join(f"{k} {v.get('value')}" for k, v in s.items()), None
    if tool == "open_case":
        parts = []
        for c in d.get("cases") or []:
            hyp = ", ".join(f"{h['key'].replace('_', ' ')} {round(h['prior'] * 100)}%" for h in c.get("hypotheses") or [])
            parts.append(f"{c['case'].replace('_', ' ')}: {hyp}")
        return "; ".join(parts) or "no case", None
    if tool in ("run_check", "check_evidence"):
        eff = ", ".join(f"{e['hypothesis'].replace('_', ' ')} {e['delta']:+.2f}" for e in d.get("effects") or []) or "no shift"
        why = f" (chosen because: {d['selection_reason']})" if d.get("selection_reason") else ""
        return f"{d.get('finding', '')[:180]} → {eff}{why}", None
    if tool == "weigh_case":
        v = d.get("verdict") or {}
        return v.get("text", ""), math(d)
    if tool == "find_fallback":
        return f"{d.get('to_label')}: {d.get('reason', '')[:120]}" + (f" | {d['compare']} → code suggests {d['suggest'].upper()}" if d.get("compare") else ""), None
    if tool == "commit_plan":
        return d.get("why", "")[:220], None
    if tool == "horde_status":
        return f"wave {d.get('wave')} from the {d.get('sector')}, {d.get('size_band')}, arriving {d.get('eta_band')}", None
    if tool == "draft_correction":
        c = d.get("critic") or {}
        crit = f"; critic: {c.get('status')}" + (f", {'agrees' if c.get('follows') else 'flagged'}" if c.get("status") == "reviewed" else "")
        return f"{d.get('label')}: {d.get('label_verdict')} {round((d.get('confidence') or 0) * 100)}%{crit}", None
    if tool == "log_night":
        return f"night logged ({d.get('nights_kept')} nights kept, lesson {'saved' if d.get('lesson_saved') else 'not saved'})", None
    if tool == "task":
        return ", ".join(f"{k}: {str(v)[:40]}" for k, v in list(d.items())[:5]), None
    return json.dumps(d)[:200], None


def build(messages: list[dict]) -> list[dict[str, Any]]:
    """Messages (LangGraph state dicts) -> ordered steps for the judge view."""
    steps: list[dict[str, Any]] = []
    calls: dict[str, tuple[str, dict]] = {}
    for m in messages:
        t = m.get("type")
        if t == "human":
            steps.append({"kind": "player", "text": _text(m.get("content"))[:200]})
        elif t == "ai":
            for c in m.get("tool_calls") or []:
                args = c.get("args") or {}
                calls[c.get("id")] = (c.get("name"), args)
                name = c.get("name")
                actor = SQUADS.get(args.get("subagent_type"), "a squad") if name == "task" else "Commander (deep agent)"
                source = CHECK_SOURCES.get(args.get("check"), SOURCES.get(name, "")) if name in ("run_check", "check_evidence") \
                    else SOURCES.get(name, "")
                shown = {k: v for k, v in args.items() if k in ("property_id", "pid", "suite", "check", "case", "wave",
                                                                 "away_from", "action", "to_pid", "why", "supports")}
                if name == "write_todos":
                    shown = {"plan": [x.get("content") for x in args.get("todos") or []][:6]}
                if name == "task":
                    shown = {"squad": args.get("subagent_type"), "asked": str(args.get("description", ""))[:120]}
                steps.append({"kind": "call", "actor": actor, "tool": name, "source": source, "args": shown})
            if not m.get("tool_calls") and _text(m.get("content")).strip():
                steps.append({"kind": "say", "actor": "Commander (deep agent)", "text": _text(m.get("content"))[:400]})
        elif t == "tool":
            name, args = calls.get(m.get("tool_call_id"), (m.get("name"), {}))
            raw = _text(m.get("content"))
            summary, mth = _summary(name or m.get("name") or "", args, _json(m.get("content")), raw)
            steps.append({"kind": "result", "tool": name, "summary": summary, **({"math": mth} if mth else {})})
    for i, s in enumerate(steps, 1):
        s["n"] = i
    return steps
