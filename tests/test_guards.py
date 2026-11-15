"""Live-model guards: blank replies are retried, and a wave never ends without the HOLD/RUN question."""

import asyncio

from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from app.guards import ForceCommitPlan, RetryBlank, needs_commit_plan


class Req:
    def __init__(self, messages, tool_choice=None):
        self.messages, self.tool_choice = messages, tool_choice

    def override(self, **kw):
        return Req(self.messages, kw.get("tool_choice", self.tool_choice))


def test_blank_reply_is_retried_then_replaced():
    replies = iter([AIMessage(content=""), AIMessage(content=[{"type": "text", "text": ""}])])
    out = RetryBlank("honest line").wrap_model_call(Req([]), lambda r: next(replies))
    assert out.content == "honest line"
    replies = iter([AIMessage(content=""), AIMessage(content="real answer")])
    assert RetryBlank("x").wrap_model_call(Req([]), lambda r: next(replies)).content == "real answer"
    calls = AIMessage(content="", tool_calls=[{"name": "t", "args": {}, "id": "1"}])
    assert RetryBlank("x").wrap_model_call(Req([]), lambda r: calls) is calls  # a tool call is not blank


def test_async_blank_retry():
    replies = iter([AIMessage(content=""), AIMessage(content="ok")])

    async def handler(r):
        return next(replies)
    assert asyncio.run(RetryBlank("x").awrap_model_call(Req([]), handler)).content == "ok"


def test_wave_forces_commit_plan_after_the_fallback():
    wave = [HumanMessage("Scout property 1"), AIMessage("done"), HumanMessage("Wave 1 is coming from the W"),
            AIMessage(content="", tool_calls=[{"name": "find_fallback", "args": {}, "id": "a"}]),
            ToolMessage(content="{}", name="find_fallback", tool_call_id="a")]
    assert needs_commit_plan(wave)
    seen = {}
    ForceCommitPlan().wrap_model_call(Req(wave), lambda r: seen.setdefault("choice", r.tool_choice))
    assert seen["choice"] == "commit_plan"
    asked = wave + [AIMessage(content="", tool_calls=[{"name": "commit_plan", "args": {}, "id": "b"}])]
    assert not needs_commit_plan(asked)
    assert not needs_commit_plan(wave[:3])  # fallback not in yet
    assert not needs_commit_plan([HumanMessage("Tip: x"), ToolMessage(content="{}", name="find_fallback", tool_call_id="a")])
