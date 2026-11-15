"""Bob's Desk numbers: published tables and the tag rule, on synthetic inputs (no kit data, no model)."""

import math

from app import desk


def test_p154_very_high_scores_and_modifiers():
    assert desk.p154("URM", 1913)["score"] == 0.9  # basic 0.9, pre-code 0.0
    assert desk.p154("C1", 1913)["score"] == 0.9   # basic 1.0, pre-code -0.1
    post = desk.p154("C1", 1990)                   # post-benchmark +1.4
    assert post["score"] == 2.4 and not post["detailed_evaluation"]
    assert desk.p154("S1", 1916)["score"] == 1.2


def test_worden_mmi_to_pga():
    assert math.isclose(desk.pga_g(8.5), 0.547, abs_tol=0.002)


def test_damage_probabilities_sum_to_one_and_masonry_is_weaker():
    pga = desk.pga_g(6.9)
    urm, c1 = desk.damage("URMM", "pre", pga), desk.damage("C1M", "pre", pga)
    assert math.isclose(sum(urm.values()), 1, abs_tol=0.01)
    assert urm["extensive"] + urm["complete"] > c1["extensive"] + c1["complete"]


def test_injuries_scale_with_occupants():
    p = {"none": 0, "slight": 0, "moderate": 0, "extensive": 0, "complete": 1}
    one = desk.injuries("URMM", p, 100)
    assert one[3] == round(100 * (0.85 * 0.02 + 0.15 * 10) / 100, 2)


def test_fema_and_hazus_classes():
    assert desk.fema_type("masonry", 1913) == "URM" and desk.fema_type("masonry", 1960) == "RM1"
    assert desk._hazus_class("C1", 9, 1913) == ("C1M", "pre")
    assert desk._hazus_class("URM", 9, 1960) == ("URMM", "low")
    assert desk._hazus_class("C1", 2, 1980) == ("C1L", "high")


def test_edited_tag_result_is_read_past_the_reviewer_note(monkeypatch):
    import threading

    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy-key-for-compile-only")
    with monkeypatch.context() as m:
        m.setattr(threading.Thread, "start", lambda self: None)
        from app import desk_agent
    from types import SimpleNamespace

    from langchain_core.messages import ToolMessage
    edited = ('Note: a human reviewer replaced this tool call before it ran. ...\n\nTool response:\n'
              '{"pid": "123", "tag": "red", "suggested": "yellow"}')
    rt = SimpleNamespace(state={"messages": [ToolMessage(content=edited, name="tag_building", tool_call_id="1")]})
    assert desk_agent._tags(rt) == [{"pid": "123", "tag": "red", "suggested": "yellow"}]


def test_yellow_is_not_free():
    assert desk._exposure("yellow", "complete") == (desk.YELLOW_ENTRY, 0.0)
    assert desk._exposure("yellow", "none") == (0.0, desk.YELLOW_DISPLACED)
    assert desk._exposure("red", "slight") == (0.0, 1.0) and desk._exposure("green", "extensive") == (1.0, 0.0)


def _desk_agent(monkeypatch):
    import threading

    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy-key-for-compile-only")
    with monkeypatch.context() as m:
        m.setattr(threading.Thread, "start", lambda self: None)
        from app import desk_agent
    return desk_agent


def test_force_tag_pins_the_code_suggestion_and_skips_a_failed_screen(monkeypatch):
    da = _desk_agent(monkeypatch)
    from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
    quake = HumanMessage("Quake at 5:02 pm. Tag building 123")
    ok = ToolMessage(content='{"pid": "123", "suggest": "yellow", "why": "x"}', name="screen_building", tool_call_id="s")
    bad = ToolMessage(content='{"error": "not a building"}', name="screen_building", tool_call_id="s")
    assert da.needs_tag([quake, ok]) and not da.needs_tag([quake, bad])
    proposed = AIMessage(content="", tool_calls=[{"name": "tag_building", "args": {"pid": "999", "tag": "red"}, "id": "t"}])
    pinned = da._pin(proposed, da._screened([quake, ok]))
    assert pinned.tool_calls[0]["args"] == {"pid": "123", "tag": "yellow"}


def test_blank_after_a_tag_speaks_the_tag_line(monkeypatch):
    da = _desk_agent(monkeypatch)
    from types import SimpleNamespace

    from langchain_core.messages import HumanMessage, ToolMessage
    msgs = [HumanMessage("Quake at 5:02 pm. Tag building 123"),
            ToolMessage(content='{"pid": "123", "tag": "red", "why": "Simulated post-quake placard (game): RED"}',
                        name="tag_building", tool_call_id="t")]
    assert da.DeskRetryBlank("say again")._say(SimpleNamespace(messages=msgs)).startswith("Simulated post-quake placard")
