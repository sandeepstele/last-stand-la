"""Optional critic and night-log upgrades stay isolated and conservative."""

import asyncio
import json
import threading
from types import SimpleNamespace

from langchain_core.messages import AIMessage, ToolMessage

from app import evidence


def _game_module(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy-key-for-compile-only")
    with monkeypatch.context() as m:
        m.setattr(threading.Thread, "start", lambda self: None)
        from app import game_agent
    return game_agent


def test_critic_only_lowers_and_missing_review_does_not_change_verdict(monkeypatch):
    game = _game_module(monkeypatch)
    original = {"label_verdict": "likely", "confidence": 0.82, "text": "Draft correction"}
    untouched = game._apply_critic(original.copy(), {"follows": True, "weakest_link": "permit_text", "why": "Supported."})
    assert untouched["label_verdict"] == "likely" and untouched["confidence"] == 0.82
    lowered = game._apply_critic(original.copy(), {"follows": False, "weakest_link": "permit_text", "why": "The filing predates the current building."})
    assert lowered["label_verdict"] == "unresolved" and lowered["confidence"] == 0.82
    assert lowered["text"].startswith("A reviewer flagged: The filing predates the current building.")
    not_reviewed = game._apply_critic(original.copy(), None)
    assert not_reviewed["label_verdict"] == "likely" and not_reviewed["critic"]["status"] == "not reviewed"


def test_critic_result_matches_the_exact_case_marker(monkeypatch):
    game = _game_module(monkeypatch)
    msg = AIMessage(content="", tool_calls=[
        {"name": "task", "args": {"description": "case_ref=1:1100 review"}, "id": "a"},
        {"name": "task", "args": {"description": "case_ref=2:- review"}, "id": "b"},
    ])
    result = ToolMessage(content=json.dumps({"follows": False, "weakest_link": "suite_tour", "why": "No tour is available."}),
                         tool_call_id="a", name="task")
    runtime = SimpleNamespace(state={"messages": [msg, result]})
    assert game._critic_result(runtime, "1", "1100")["follows"] is False
    assert game._critic_result(runtime, "2", None) is None


def test_upgrades_are_on_by_default_and_can_be_switched_off(monkeypatch):
    game = _game_module(monkeypatch)
    monkeypatch.delenv("RADAR_CRITIC", raising=False)
    monkeypatch.delenv("RADAR_NIGHT_LOG", raising=False)
    assert "log_night" in {tool.name for tool in game._enabled_tools()}  # on by default (the critic is a subagent)
    assert "critic" in {s["name"] for s in game._enabled_subagents(game.MODELS)}
    monkeypatch.setenv("RADAR_CRITIC", "0")
    monkeypatch.setenv("RADAR_NIGHT_LOG", "0")
    assert "log_night" not in {tool.name for tool in game._enabled_tools()}
    assert "critic" not in {s["name"] for s in game._enabled_subagents(game.MODELS)}
    assert "case_file" not in {tool.name for tool in game.GAME_TOOLS}


def test_log_night_rejects_new_numbers_and_keeps_the_log_bounded(monkeypatch):
    game = _game_module(monkeypatch)

    class Store:
        def __init__(self):
            self.value = None

        async def aget(self, namespace, key):
            return SimpleNamespace(value=self.value) if self.value else None

        async def aput(self, namespace, key, value):
            assert namespace == ("laststand_log",) and key == "/latest.md"
            self.value = value

    store = Store()
    monkeypatch.setattr(game, "_night_summary", lambda _runtime: ["- walls 737 Broadway; checks=compliance_filings; lead_move=compliance_filings; verdict=leaning; reviewer=not reviewed"])
    runtime = SimpleNamespace(store=store)
    out = asyncio.run(game.log_night.coroutine(runtime=runtime, lesson="Check 737 filings before the facade."))
    assert out["lesson_saved"] is True
    out = asyncio.run(game.log_night.coroutine(runtime=runtime, lesson="Review 900 permits next."))
    assert out["lesson_saved"] is False and "rejected" in out["lesson_status"]
    from deepagents.backends.utils import file_data_to_string

    text = file_data_to_string(store.value)
    assert "Lesson: Review" not in text and len(text.encode()) <= 1024


def test_case_file_reads_only_the_thread_scoped_code_result(monkeypatch):
    game = _game_module(monkeypatch)

    class Store:
        async def aget(self, namespace, key):
            assert namespace == ("laststand_cases", "thread-a")
            assert key == "123:1100"
            return SimpleNamespace(value={"case": "ghost_tenant", "checks_used": ["suite_tour"],
                                          "trail": [], "posterior": {"still_there": 0.5},
                                          "verdict": {"label": "leaning"}, "model_narrative": "ignored"})

    async def outside(*_pids):
        return None
    monkeypatch.setattr(game, "_outside", outside)
    out = asyncio.run(game.case_file.coroutine(property_id="123", suite="1100",
                                               runtime=SimpleNamespace(store=Store(), config={"configurable": {"thread_id": "thread-a"}})))
    assert set(out) == {"case", "checks_used", "trail", "posterior", "verdict"}
    assert "model_narrative" not in out


def test_demo_reset_seeds_only_the_isolated_log_namespace():
    from scripts.demo_reset import LAST_STAND_LOG_SEED, reset_night_log

    class Store:
        def __init__(self):
            self.items = [{"namespace": ["laststand_log"], "key": "/old.md"},
                          {"namespace": ["memories"], "key": "/AGENTS.md"}]
            self.written = None

        def search_items(self, prefix, limit):
            return {"items": [x for x in self.items if x["namespace"][:len(prefix)] == prefix]}

        def delete_item(self, namespace, key):
            self.items = [x for x in self.items if not (x["namespace"] == namespace and x["key"] == key)]

        def put_item(self, namespace, key, value):
            self.written = (namespace, key, value)

    store = Store()
    assert reset_night_log(store) == 1
    assert store.written[0:2] == (["laststand_log"], "/latest.md")
    assert "## Night 2026-11-13" in LAST_STAND_LOG_SEED
    assert any(x["namespace"] == ["memories"] for x in store.items)


def test_dash_suite_is_a_building_case_and_drafts_wait_for_the_critic(monkeypatch):
    game = _game_module(monkeypatch)
    assert game._no_suite("-") is None and game._no_suite(" none ") is None and game._no_suite("1100") == "1100"
    asked = AIMessage(content="", tool_calls=[{"name": "task", "args": {"description": "case_ref=6375735:- review"}, "id": "t1"}])
    runtime = SimpleNamespace(state={"messages": [asked]})
    assert not game._critic_answered(runtime, "6375735", None)  # asked, not answered yet
    runtime.state["messages"].append(ToolMessage(content="{}", tool_call_id="t1", name="task"))
    assert game._critic_answered(runtime, "6375735", None)
