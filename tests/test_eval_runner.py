import pytest

from evals.run_eval import selected_checks


def test_selected_eval_uses_the_checks_recorded_for_the_agent():
    assert selected_checks({"checks": ["look_from_above"]}, "selected", ["look_from_above", "permit_text"]) == ["look_from_above"]
    assert selected_checks({"checks": None}, "all", ["look_from_above", "permit_text"]) == ["look_from_above", "permit_text"]


def test_selected_eval_requires_valid_recorded_checks():
    with pytest.raises(ValueError, match="non-empty checks list"):
        selected_checks({"checks": None}, "selected", ["look_from_above"])
    with pytest.raises(ValueError, match="not valid"):
        selected_checks({"checks": ["bogus"]}, "selected", ["look_from_above"])
