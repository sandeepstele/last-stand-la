"""The judge log: steps from a thread's messages, and the verdict arithmetic recomputed from weigh_case."""

import json

from app import agentlog


def test_math_matches_weigh_case_arithmetic():
    w = {"priors": {"city_list_current": 0.45, "costar_current": 0.35, "different_structure": 0.2},
         "trail": [{"check": "look_from_above", "effects": [{"hypothesis": "city_list_current", "delta": 0.2},
                                                            {"hypothesis": "costar_current", "delta": -0.1}]},
                   {"check": "compliance_filings", "effects": [{"hypothesis": "city_list_current", "delta": 0.12},
                                                               {"hypothesis": "costar_current", "delta": -0.05}]}],
         "posterior": {"city_list_current": 0.66, "costar_current": 0.17, "different_structure": 0.17},
         "verdict": {"hypothesis": "city_list_current", "confidence": 0.66, "label": "likely"}}
    m = agentlog.math(w)
    assert m["sum"] == {"city_list_current": 0.77, "costar_current": 0.2, "different_structure": 0.2}
    assert m["total"] == 1.17 and round(0.77 / 1.17, 2) == m["result"]["city_list_current"]
    assert len(m["shifts"]) == 4 and "floor 0.02" in m["rule"]


def test_steps_name_the_actor_source_and_math():
    msgs = [{"type": "human", "content": "Scout property 6375735"},
            {"type": "ai", "content": "", "tool_calls": [
                {"id": "a", "name": "task", "args": {"subagent_type": "aerial", "description": "property id 6375735"}},
                {"id": "b", "name": "run_check", "args": {"property_id": "6375735", "case": "material_conflict", "check": "look_from_above", "why": "w"}}]},
            {"type": "tool", "tool_call_id": "b", "name": "run_check", "content": json.dumps({
                "finding": "exposed concrete frame", "effects": [{"hypothesis": "city_list_current", "delta": 0.2}], "selection_reason": "100% of 3"})},
            {"type": "ai", "content": "Likely concrete."}]
    s = agentlog.build(msgs)
    assert s[1]["actor"].startswith("Aerial squad") and "Vexcel" in s[2]["source"]
    assert "city list current +0.20" in s[3]["summary"] and "chosen because" in s[3]["summary"]
    assert s[-1]["kind"] == "say" and [x["n"] for x in s] == list(range(1, len(s) + 1))
