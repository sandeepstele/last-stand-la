"""Record/replay wrapper (app/replay.py) with a fake model: no network."""

from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from app import replay


class Fake(GenericFakeChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def test_records_then_replays_without_the_model(tmp_path, monkeypatch):
    monkeypatch.setattr(replay, "DIR", tmp_path)
    monkeypatch.setenv("RADAR_REPLAY_DELAY_S", "0")
    msgs = [SystemMessage("you are radar"), HumanMessage("Check building 247337.")]
    rec = replay.ReplayChatModel(inner=Fake(messages=iter([AIMessage(content="recorded answer")])), name_="t", recording=True)
    assert rec.invoke(msgs).content == "recorded answer"

    class Boom(Fake):
        def _generate(self, *a, **k):
            raise AssertionError("the live model was called during replay")

    play = replay.ReplayChatModel(inner=Boom(messages=iter([])), name_="t")
    assert play.bind_tools([]).invoke(msgs).content == "recorded answer"


def test_key_ignores_scene_acks_but_not_data():
    base = [SystemMessage("s"), HumanMessage("q"), AIMessage(content="", tool_calls=[{"name": "show_building", "args": {}, "id": "1"}])]
    a = base + [ToolMessage("show_building: sent to the screen.", name="show_building", tool_call_id="1")]
    b = base + [ToolMessage("show_building: confirmed.", name="show_building", tool_call_id="1")]
    assert replay.key(a) == replay.key(b)
    c = base + [ToolMessage('{"team_notes": [1]}', name="open_case", tool_call_id="1")]
    assert replay.key(a) != replay.key(c)


def test_unset_means_no_wrapper(monkeypatch):
    monkeypatch.delenv("RADAR_REPLAY", raising=False)
    sentinel = object()
    assert replay.wrap(sentinel) is sentinel


def test_blank_responses_are_never_recorded(tmp_path, monkeypatch):
    from langchain_core.messages import AIMessage

    from app import replay

    monkeypatch.setattr(replay, "DIR", tmp_path)
    replay._save("t", "k1", AIMessage(content=""))
    replay._save("t", "k2", AIMessage(content=[{"type": "text", "text": ""}]))
    assert not (tmp_path / "t.json").exists()
    replay._save("t", "k3", AIMessage(content="hello"))
    assert list(replay._load("t")) == ["k3"]
