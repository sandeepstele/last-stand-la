"""Texts to the team over iMessage, through the Photon Spectrum bridge in photon/.

The bridge is a small Node process (cd photon && npm start) that holds the Spectrum connection.
  Outbound (this module, used by notify_me):
    POST {PHOTON_BRIDGE_URL}/send   Authorization: Bearer {PHOTON_BRIDGE_TOKEN}
    {"text": ..., "to": "owner" | "team"} -> 200 {"status": "sent"} once Spectrum accepted it.
    The bridge can only text the team's own numbers from .env (PHOTON_OWNER_PHONE, PHOTON_TEAM_PHONE).
  Inbound (the bridge itself): a text from those numbers starts a radar_worker run on a thread per
  sender and the answer is texted back; approvals (send_outreach, watch_building) are texted by
  the bridge from the interrupt payload and resumed with YES / NO. See photon/README.md.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

DEFAULT_URL = "http://127.0.0.1:8787"


def configured() -> bool:
    return bool(os.environ.get("PHOTON_BRIDGE_TOKEN"))


async def send(text: str, to: str = "owner", transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
    if not configured():
        return {"status": "not_configured"}
    url = os.environ.get("PHOTON_BRIDGE_URL", DEFAULT_URL).rstrip("/") + "/send"
    headers = {"Authorization": f"Bearer {os.environ['PHOTON_BRIDGE_TOKEN']}"}
    try:
        async with httpx.AsyncClient(timeout=20, transport=transport) as client:
            response = await client.post(url, headers=headers, json={"text": text, "to": to})
    except httpx.ConnectError:
        return {"status": "bridge_offline"}
    except httpx.HTTPError as e:
        return {"status": "error", "detail": type(e).__name__}
    if response.status_code == 200:
        return {"status": "sent"}
    try:
        detail = str(response.json().get("detail", ""))[:200]
    except ValueError:
        detail = ""
    return {"status": f"http_{response.status_code}", "detail": detail}
