"""Game-only evidence selection helpers; no live model or external data calls."""

import asyncio
import threading
from types import SimpleNamespace

from langchain_core.messages import AIMessage

from app import evidence, layers, vision


def _game_module(monkeypatch):
    # Importing the production module starts its cache-warm daemon; keep this unit test isolated.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "dummy-key-for-compile-only")
    with monkeypatch.context() as m:
        m.setattr(threading.Thread, "start", lambda self: None)
        from app import game_agent
    return game_agent


def test_game_hints_are_sorted_and_availability_comes_from_local_cache(monkeypatch, tmp_path):
    game = _game_module(monkeypatch)
    monkeypatch.setattr(layers, "FIXTURES", tmp_path / "fixtures")
    monkeypatch.setattr(vision, "CACHE", tmp_path / "vision")
    case_data = evidence._spec("material_conflict")
    stats = {"material_conflict": {
        check: {"cases": 10, "moved_cases": i, "move_rate": i / 10,
                "typical_move": 0.1, "expected_move": round(i / 100, 2)}
        for i, check in enumerate(evidence.CASES["material_conflict"]["checks"], start=1)
    }}

    hints = game._hints("123", case_data, None, stats)
    assert [hint["expected_move"] for hint in hints] == sorted(
        (hint["expected_move"] for hint in hints), reverse=True)
    assert hints[0]["check"] == evidence.CASES["material_conflict"]["checks"][-1]
    assert all(not hint["available"] for hint in hints if hint["check"] in {
        "site_structures", "look_from_above", "compare_captures"})
    top = len(evidence.CASES["material_conflict"]["checks"])  # the synthetic stats give the last check the top rate (1-based)
    assert hints[0]["moved_odds_in"] == f"{top * 10}% of the 10 cases where it could run"


def test_run_check_echoes_a_single_line_selection_reason(monkeypatch):
    game = _game_module(monkeypatch)
    async def outside(*_pids):
        return None
    async def notes(*_args):
        return []

    monkeypatch.setattr(game, "_outside", outside)
    monkeypatch.setattr(game, "_notes", notes)
    monkeypatch.setattr(evidence, "run_check", lambda *a: {"check": "compliance_filings", "effects": []})
    out = asyncio.run(game.run_check.coroutine(
        property_id="123", case="material_conflict", check="compliance_filings",
        why="Moved in 41% of cases.\nTypical move 0.30.", runtime=SimpleNamespace(store=None)))
    assert out["selection_reason"] == "Moved in 41% of cases. Typical move 0.30."


def test_game_open_case_adds_hints_only_to_its_own_output(monkeypatch):
    game = _game_module(monkeypatch)
    case_data = evidence._spec("material_conflict")
    monkeypatch.setattr(game, "_outside", lambda *_: asyncio.sleep(0, result=None))
    monkeypatch.setattr(game, "_notes", lambda *_: asyncio.sleep(0, result=[]))
    monkeypatch.setattr(evidence, "open_case", lambda *_args: {"cases": [case_data.copy()]})
    measured = {"material_conflict": {
        name: {"cases": 1, "moved_cases": 1, "move_rate": 1, "typical_move": 0.1,
               "expected_move": 0.1} for name in evidence.CASES["material_conflict"]["checks"]}}
    monkeypatch.setattr(evidence, "check_stats", lambda: measured)
    out = asyncio.run(game.open_case.coroutine(property_id="123", runtime=SimpleNamespace(store=None)))
    assert all("check_hints" in case for case in out["cases"])
    assert "check_hints" not in case_data


def test_debrief_reads_run_check_calls_from_this_thread(monkeypatch):
    game = _game_module(monkeypatch)
    msg = AIMessage(content="", tool_calls=[
        {"name": "run_check", "args": {"property_id": "123", "check": "compliance_filings"}, "id": "1"},
        {"name": "check_evidence", "args": {"property_id": "123", "check": "look_from_above"}, "id": "2"},
        {"name": "run_check", "args": {"property_id": "456", "check": "permit_text"}, "id": "3"},
    ])
    wave, checks = game._wave_and_checks(SimpleNamespace(state={"messages": [msg]}), "123")
    assert wave == 1
    assert checks == ["compliance_filings", "look_from_above"]
