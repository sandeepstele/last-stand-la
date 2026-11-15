"""Tests always measure check statistics live (never this machine's frozen snapshot, scripts/freeze_stats.py)."""

import pytest


@pytest.fixture(autouse=True)
def _live_check_stats(monkeypatch):
    monkeypatch.setenv("RADAR_STATS_LIVE", "1")
