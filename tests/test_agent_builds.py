"""Both graphs compile against the pinned deepagents, with the intended tool surface (no API calls)."""

import os

os.environ.setdefault("ANTHROPIC_API_KEY", "dummy-key-for-compile-only")
os.environ.pop("GOOGLE_API_KEY", None)

from langchain.agents import create_agent  # noqa: E402
from langchain.agents.middleware import ToolErrorMiddleware  # noqa: E402
from langchain.tools import tool  # noqa: E402
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel  # noqa: E402
from langchain_core.messages import AIMessage  # noqa: E402

SCENE = {"show_building", "ghost_compare", "reveal_levels", "place_solar"}
SHARED = {"verify_building", "retrofit", "field_check", "notify_me", "send_outreach", "watch_building", "task", "write_todos"}


def _tools(graph):
    return set(graph.nodes["tools"].bound.tools_by_name)


def test_graphs_compile_with_the_intended_tools():
    from app import agent

    live, worker = _tools(agent.live_agent), _tools(agent.worker_agent)
    assert SHARED <= live and SHARED <= worker
    assert SCENE <= live and not SCENE & worker
    assert {"queue_next", "queue_done"} <= worker and not {"queue_next", "queue_done"} & live


def test_subagents_are_scoped():
    from app import agent

    specs = {s["name"]: s for s in agent._specialists()}
    assert set(specs) == {"records", "aerial", "interior", "general-purpose"}
    assert specs["general-purpose"]["tools"] == []  # overrides the default that inherits every tool
    assert all(len(specs[n]["tools"]) == 1 for n in ("records", "aerial", "interior"))


def test_a_failing_tool_becomes_a_message_not_a_crash():
    from app.agent import _tool_error

    @tool
    def boom(city: str) -> str:
        """Always fails."""
        raise KeyError(city)

    class FakeModel(GenericFakeChatModel):
        def bind_tools(self, tools, **kwargs):
            return self

    model = FakeModel(messages=iter([
        AIMessage(content="", tool_calls=[{"name": "boom", "args": {"city": "Houston"}, "id": "c1"}]),
        AIMessage(content="That data was unavailable."),
    ]))
    graph = create_agent(model, tools=[boom], middleware=[ToolErrorMiddleware(on_error=_tool_error)])
    out = graph.invoke({"messages": [{"role": "user", "content": "go"}]})
    tool_msgs = [m for m in out["messages"] if m.type == "tool"]
    assert tool_msgs and tool_msgs[0].content.startswith("ERROR from boom")
    assert out["messages"][-1].content == "That data was unavailable."
