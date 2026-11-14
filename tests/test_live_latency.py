"""Live-turn latency: model timeouts and fallbacks, the three-turn prompt, and scene verbs that run in one
turn but still reach the screen in order. Synthetic data and fake models only; no API calls."""

import asyncio
import os
import time
from types import SimpleNamespace

os.environ.setdefault("ANTHROPIC_API_KEY", "dummy-key-for-compile-only")
os.environ.pop("GOOGLE_API_KEY", None)

import httpx2  # noqa: E402
import pytest  # noqa: E402
from langchain.agents import create_agent  # noqa: E402
from langchain.agents.middleware import ModelFallbackMiddleware, TodoListMiddleware  # noqa: E402
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel  # noqa: E402
from langchain_core.messages import AIMessage, HumanMessage  # noqa: E402

from app import interior, layers, prompts, scene  # noqa: E402
from app.verify import Aerial, Records  # noqa: E402


class FakeModel(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


@pytest.fixture
def gemini_env(monkeypatch):
    """A Gemini configuration like .env's, with a dummy key (constructing the clients makes no calls)."""
    monkeypatch.setenv("GOOGLE_API_KEY", "dummy")
    monkeypatch.setenv("GOOGLE_CLOUD_PROJECT", "test-project")
    monkeypatch.setenv("RADAR_ORCH_MODEL", "gemini-3.8-flash")
    monkeypatch.setenv("RADAR_SPEC_MODEL", "gemini-3.8-flash")
    monkeypatch.setenv("RADAR_WORKER_MODEL", "gemini-4-argon")
    for k in ("RADAR_FAST_MODEL", "RADAR_FAST_THINKING", "RADAR_ORCH_THINKING", "RADAR_SPEC_THINKING",
              "RADAR_MODEL_TIMEOUT_S", "RADAR_MODEL_RETRIES"):
        monkeypatch.delenv(k, raising=False)


# ------------------------------------------------------------- models: short attempts live, none for the worker


def _http(model):
    return model._prepare_request([HumanMessage("hi")])["config"].http_options


def test_make_model_caps_each_attempt(gemini_env):
    from app.agent import make_model

    quick = _http(make_model("gemini-3.8-flash", "low", timeout=8, attempts=1))
    assert quick.timeout == 8000 and quick.retry_options.attempts == 1  # attempts include the first call
    patient = _http(make_model("gemini-4-argon", "low"))
    assert patient.timeout is None and patient.retry_options.attempts == 6  # library default, 408/429/5xx only


def test_live_calls_get_one_short_attempt_per_model_and_the_worker_waits(gemini_env):
    from app.agent import models

    m = models()
    assert (m.orch.model, m.orch.timeout, m.orch.max_retries, m.orch.thinking_level) == ("gemini-3.8-flash", 8, 1, "low")
    assert (m.spec.model, m.spec.timeout, m.spec.thinking_level) == ("gemini-3.5-flash-lite", 8, "minimal")
    # Orchestrator: flash, then lite, then flash with no time limit (a slow answer, never a crash).
    assert m.orch_fallbacks[0] is m.spec
    assert (m.orch_fallbacks[-1].model, m.orch_fallbacks[-1].timeout) == ("gemini-3.8-flash", None)
    # Specialists: lite, then flash, then flash with no time limit.
    assert [(f.model, f.timeout) for f in m.spec_fallbacks] == [("gemini-3.8-flash", 8), ("gemini-3.8-flash", None)]
    # The background worker keeps the library defaults.
    assert (m.worker.model, m.worker.timeout, m.worker_spec.timeout) == ("gemini-4-argon", None, None)


def test_model_timeout_and_retries_come_from_env(gemini_env, monkeypatch):
    from app.agent import models

    monkeypatch.setenv("RADAR_MODEL_TIMEOUT_S", "12")
    monkeypatch.setenv("RADAR_MODEL_RETRIES", "1")
    m = models()
    assert (m.orch.timeout, m.orch.max_retries, m.spec.max_retries) == (12, 2, 2)
    monkeypatch.setenv("RADAR_MODEL_TIMEOUT_S", "0")
    assert models().orch.timeout is None


def test_live_graph_compiles_with_the_gemini_chain(gemini_env):
    from app import agent

    m = agent.models()
    assert agent.build("live", m=m) is not None and agent.build("worker", m=m) is not None


def test_only_the_live_graph_falls_back():
    from app import agent

    def fallbacks(mw):
        return [x for x in mw if isinstance(x, ModelFallbackMiddleware)]

    live, worker = agent._middleware(True), agent._middleware(False)
    assert len(fallbacks(live)) == 1 and not fallbacks(worker)
    todo_live = next(x for x in live if isinstance(x, TodoListMiddleware))
    todo_worker = next(x for x in worker if isinstance(x, TodoListMiddleware))
    assert todo_live.tool_description == prompts.TODO_TOOL_DESCRIPTION
    assert todo_worker.system_prompt == prompts.WORKER_TODO_PROMPT
    assert todo_worker.tool_description != prompts.TODO_TOOL_DESCRIPTION  # the worker keeps the stock tool
    for spec in agent._specialists(live=True):
        assert spec["model"] is agent.MODELS.spec and len(fallbacks(spec["middleware"])) == 1
    for spec in agent._specialists(live=False):
        assert spec["model"] is agent.MODELS.worker_spec and not fallbacks(spec.get("middleware", []))


def test_a_live_call_that_times_out_moves_to_the_next_model():
    class Stalled(FakeModel):
        def _generate(self, *args, **kwargs):
            raise httpx2.ReadTimeout("timed out")  # what google-genai raises when the last attempt times out

    fallback = FakeModel(messages=iter([AIMessage(content="answer from the fallback model")]))
    graph = create_agent(Stalled(messages=iter([])), tools=[], middleware=[ModelFallbackMiddleware(fallback)])
    out = graph.invoke({"messages": [{"role": "user", "content": "go"}]})
    assert out["messages"][-1].content == "answer from the fallback model"


def test_live_prompt_keeps_every_rule():
    p = prompts.LIVE_PROMPT_SOLAR
    for rule in ("check_link", "nothing\n  was compared or sized", "Never state a number that a tool did not return",
                 '"worth a look"', "(illustrative data)", "(placeholder inputs)", "notify_me", "send_outreach",
                 "approval", "ERROR", "Never describe what the screen shows"):
        assert rule in p, rule
    # Three turns: the specialists go out with show_building; everything else goes out together.
    assert "show_building. The records, aerial and\n   interior specialists" in p
    assert "verify_building, ghost_compare, reveal_levels, retrofit and\n   place_solar" in p


# ------------------------------------------------------------- scene verbs in one turn reach the screen in order


def _turn(*names):
    calls = [{"name": n, "args": {"property_id": "TEST-Z"}, "id": f"call-{n}", "type": "tool_call"} for n in names]
    return {"messages": [HumanMessage("go"), AIMessage(content="", tool_calls=calls)]}


def _runtime(state, verb, sent):
    return SimpleNamespace(state=state, tool_call_id=f"call-{verb}", stream_writer=sent.append, store=None, config={})


async def _later(seconds, result):
    await asyncio.sleep(seconds)
    if isinstance(result, Exception):
        raise result
    return result


def test_verbs_from_one_turn_go_out_in_screen_order(monkeypatch):
    """The model lists them in any order and the first verb loads slowest; the screen still builds in ORDER,
    and a verb that draws nothing hands over at once."""
    monkeypatch.setenv("RADAR_SCENE_MODE", "dispatch")
    state, sent = _turn("place_solar", "reveal_levels", "ghost_compare", "show_building"), []
    work = {"show_building": (0.15, {"n": 1}), "ghost_compare": (0.10, {"n": 2}),
            "reveal_levels": (0.05, "reveal_levels: nothing drawn (...)"), "place_solar": (0.0, {"n": 4})}

    async def turn():
        return await asyncio.gather(*(scene._draw(v, _runtime(state, v, sent), _later(*work[v])) for v in work))

    t0 = time.monotonic()
    results = asyncio.run(turn())
    assert [e["verb"] for e in sent] == ["show_building", "ghost_compare", "place_solar"]
    assert results[2] == "reveal_levels: nothing drawn (...)" and results[3] == "place_solar: sent to the screen."
    assert time.monotonic() - t0 < 2 and not scene._sent


def test_a_failing_verb_does_not_hold_up_the_next(monkeypatch):
    monkeypatch.setenv("RADAR_SCENE_MODE", "dispatch")
    state, sent = _turn("show_building", "ghost_compare", "place_solar"), []
    work = {"show_building": (0.1, {"n": 1}), "ghost_compare": (0.0, layers.LayerError("no data")), "place_solar": (0.0, {"n": 3})}

    async def turn():
        return await asyncio.gather(*(scene._draw(v, _runtime(state, v, sent), _later(*work[v])) for v in work),
                                    return_exceptions=True)

    t0 = time.monotonic()
    results = asyncio.run(turn())
    assert isinstance(results[1], layers.LayerError)
    assert [e["verb"] for e in sent] == ["show_building", "place_solar"]
    assert time.monotonic() - t0 < 2 and not scene._sent


def test_scene_order_holds_through_the_agent_graph(monkeypatch):
    """Real ToolNode wiring (tool_call_id, state): one model turn calls all four verbs; the building loads
    slowest for the first call."""
    monkeypatch.setenv("RADAR_SCENE_MODE", "dispatch")
    monkeypatch.delenv("RADAR_LAYER_COSTAR", raising=False)
    monkeypatch.delenv("RADAR_LAYER_VEXCEL", raising=False)
    monkeypatch.setattr(layers, "get_twin", lambda pid, rec=None: (None, None))
    b = layers.load_building("TEST-A")
    delays = iter([0.3, 0.2, 0.1])

    def slow_building(pid):
        time.sleep(next(delays, 0.0))
        return b

    monkeypatch.setattr(scene, "_building", slow_building)
    calls = [{"name": v, "args": {"property_id": "TEST-A"}, "id": f"c{i}", "type": "tool_call"} for i, v in enumerate(scene.ORDER)]
    model = FakeModel(messages=iter([AIMessage(content="", tool_calls=calls), AIMessage(content="done")]))
    graph = create_agent(model, tools=scene.SCENE_TOOLS)

    async def run():
        return [e async for e in graph.astream({"messages": [{"role": "user", "content": "go"}]}, stream_mode="custom")]

    events = asyncio.run(run())
    assert [e["verb"] for e in events] == ["show_building", "ghost_compare", "place_solar"]  # TEST-A has no twin here
    assert not scene._sent


def test_parallel_tools_parse_the_kit_once():
    """Turn-2 tools load the building in parallel threads; the kit index must be filled once, not per thread."""
    from concurrent.futures import ThreadPoolExecutor

    from app import costar

    fills = []

    @costar._once
    def index():
        fills.append(1)
        time.sleep(0.05)
        return {"fill": len(fills)}

    with ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda _: index(), range(8)))
    assert len(fills) == 1 and all(r is results[0] for r in results)
    index.cache_clear()
    assert index() == {"fill": 2}


# ------------------------------------------------------------- reveal_levels decides for itself


def _layout(levels_z, origin):
    floors = [{"id": f, "sequence": i, "label": f} for i, f in enumerate(levels_z)]
    locs = [{"id": "origin", "position": {"x": 0, "y": 0, "z": levels_z[origin]}, "floor": {"id": origin}}]
    locs += [{"id": f"{f}{i}{j}", "position": {"x": 1 + i * 8.5, "y": 1 + j * 8.5, "z": z}, "floor": {"id": f}}
             for f, z in levels_z.items() for i in range(5) for j in range(5)]
    return {"id": "synthetic", "floors": floors, "locations": locs}


def _reveal(monkeypatch, twin, link_problem=None):
    b = layers.Building("TEST-Z", Records(rba_sqft=48_000, stories=3), Aerial(footprint_sqft=13_700), "SYNTHETIC1",
                        twin, {}, {}, {"costar": {"synthetic": True}}, [], link_problem)
    monkeypatch.setattr(scene, "_building", lambda pid: b)
    monkeypatch.setenv("RADAR_SCENE_MODE", "dispatch")
    sent = []
    rt = SimpleNamespace(store=None, stream_writer=sent.append, config={})
    return asyncio.run(scene.reveal_levels.coroutine(property_id="TEST-Z", runtime=rt)), sent


def test_reveal_levels_draws_the_basement_the_verifier_counts(monkeypatch):
    out, sent = _reveal(monkeypatch, interior.profile(_layout({"B1": -4.0, "L1": 0.0, "L2": 4.0, "L3": 8.0}, "L1")))
    assert out == "reveal_levels: sent to the screen."
    assert [lv["label"] for lv in sent[0]["args"]["levels"]] == ["B1"]


@pytest.mark.parametrize("case", ["no_basement", "no_twin", "wrong_structure"])
def test_reveal_levels_draws_nothing_otherwise(monkeypatch, case):
    twin = {"no_basement": interior.profile(_layout({"L1": 0.0, "L2": 4.0, "L3": 8.0}, "L1")), "no_twin": None,
            "wrong_structure": interior.profile(_layout({"B1": -4.0, "L1": 0.0, "L2": 4.0}, "L1"))}[case]
    out, sent = _reveal(monkeypatch, twin, "another structure" if case == "wrong_structure" else None)
    assert out.startswith("reveal_levels: nothing drawn") and not sent
