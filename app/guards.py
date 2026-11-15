"""Two live-model guards (they never change replay keys: those come from the messages, not from call settings).

RetryBlank        a blank reply (no text, no tool calls) is retried once; if it is blank again, an honest line replaces
                  it, so the screen never shows an empty answer. Seen live Sat Nov 14: the auditor's second turn came
                  back blank and the run ended silently.
ForceCommitPlan   in the game, once a wave's find_fallback result is in, the next model call must call commit_plan:
                  the player's HOLD/RUN decision is never skipped. Seen live: the agent compared buildings in words
                  and ended the wave without asking.
"""

from __future__ import annotations

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage


def _text(m) -> str:
    c = getattr(m, "content", "")
    return c if isinstance(c, str) else "".join(b.get("text", "") if isinstance(b, dict) else str(b) for b in c or [])


def _last_ai(result) -> AIMessage | None:
    msgs = result if isinstance(result, list) else getattr(result, "result", None) or ([result] if isinstance(result, AIMessage) else [])
    return next((m for m in reversed(msgs) if isinstance(m, AIMessage)), None)


def _blank(result) -> bool:
    ai = _last_ai(result)
    return ai is not None and not ai.tool_calls and not _text(ai).strip()


def _replace(result, text: str):
    ai = _last_ai(result)
    new = AIMessage(content=text, id=getattr(ai, "id", None))
    if isinstance(result, AIMessage):
        return new
    result.result = [new if m is ai else m for m in result.result]
    return result


def latest_verdict(messages) -> str | None:
    """The newest weigh_case verdict.text since the last human message (code-built, hedged): what a blank answer
    should have said."""
    import json

    last_h = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
    for m in reversed(messages[last_h + 1:]):
        if isinstance(m, ToolMessage) and m.name == "weigh_case":
            try:
                text = ((json.loads(_text(m)) or {}).get("verdict") or {}).get("text")
            except ValueError:
                continue
            if text:
                return text
    return None


class RetryBlank(AgentMiddleware):
    def __init__(self, fallback: str):
        super().__init__()
        self.fallback = fallback

    def _say(self, request) -> str:
        return latest_verdict(getattr(request, "messages", []) or []) or self.fallback

    def wrap_model_call(self, request, handler):
        r = handler(request)
        if _blank(r):
            r = handler(request)
        return _replace(r, self._say(request)) if _blank(r) else r

    async def awrap_model_call(self, request, handler):
        r = await handler(request)
        if _blank(r):
            r = await handler(request)
        return _replace(r, self._say(request)) if _blank(r) else r


def needs_commit_plan(messages) -> bool:
    """True after a "Wave ..." message once find_fallback has answered and commit_plan hasn't been called yet."""
    last_h = max((i for i, m in enumerate(messages) if isinstance(m, HumanMessage)), default=-1)
    if last_h < 0 or not _text(messages[last_h]).strip().startswith("Wave "):
        return False
    tail = messages[last_h + 1:]
    fallback_in = any(isinstance(m, ToolMessage) and m.name == "find_fallback" for m in tail)
    asked = any(isinstance(m, AIMessage) and any(c.get("name") == "commit_plan" for c in m.tool_calls or []) for m in tail)
    return fallback_in and not asked


class ForceCommitPlan(AgentMiddleware):
    def _force(self, request):
        return request.override(tool_choice="commit_plan") if needs_commit_plan(request.messages) else request

    def wrap_model_call(self, request, handler):
        return handler(self._force(request))

    async def awrap_model_call(self, request, handler):
        return await handler(self._force(request))


DISCLAIMER = "Game outcome, not an engineering assessment."


class OutcomeDisclaimer(AgentMiddleware):
    """The radio report of a wave's outcome always carries the disclaimer: added in code if the model dropped it."""

    @staticmethod
    def _fix(request, result):
        msgs = getattr(request, "messages", []) or []
        last_h = max((i for i, m in enumerate(msgs) if isinstance(m, HumanMessage)), default=-1)
        if not any(isinstance(m, ToolMessage) and m.name == "commit_plan" for m in msgs[last_h + 1:]):
            return result
        ai = _last_ai(result)
        if ai is None or ai.tool_calls or "not an engineering assessment" in _text(ai).lower() or not _text(ai).strip():
            return result
        return _replace(result, _text(ai).rstrip() + "\n" + DISCLAIMER)

    def wrap_model_call(self, request, handler):
        return self._fix(request, handler(request))

    async def awrap_model_call(self, request, handler):
        return self._fix(request, await handler(request))

