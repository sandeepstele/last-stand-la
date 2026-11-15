"""Last Stand's night log seed (a tiny module: the reset script and the reset route import it without the agent)."""

# The fixed "previous night" every demo night starts from (Play again and scripts/demo_reset.py both restore it), so a
# judge's briefing always reads the same memory and the recorded replay stays valid.
LAST_STAND_LOG_SEED = """## Night 2026-11-13
- walls 737 Broadway; checks=compliance_filings; lead_move=compliance_filings; verdict=leaning; reviewer=not reviewed
Lesson: City filings moved the odds; check the facade before choosing the next lead.
"""
