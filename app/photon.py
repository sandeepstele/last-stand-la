"""Photon 2.0 messaging (stretch: outbound first, inbound and YES/NO approvals last).

Outbound contract (Photon 2.0 blog; verify against the beta docs once access is granted):
  POST https://api.photon.codes/v1/projects/{PHOTON_PROJECT_ID}/messages
  Authorization: Bearer {PHOTON_API_KEY}, idempotency-key: <uuid>
  body {spaceId, senderId, content}
  202 means ACCEPTED, not delivered.
Addressing: the owner's space and the sender are created once in the Photon dashboard/API and
set in .env (PHOTON_OWNER_SPACE_ID, PHOTON_SENDER_ID).

Inbound (not implemented): POST /photon/webhook verifying Standard Webhooks headers
(webhook-id, webhook-timestamp, webhook-signature), dedupe on webhook-id, accept only the
owner's texts. Approvals by text need the server, not the model, to send the approval prompt
from the interrupt payload (see docs/ENGINEERING.md, "Deferred").
"""

from __future__ import annotations

import os
import uuid
from typing import Any

import httpx

API = "https://api.photon.codes/v1/projects/{project}/messages"


def configured() -> bool:
    return all(os.environ.get(k) for k in ("PHOTON_API_KEY", "PHOTON_PROJECT_ID", "PHOTON_OWNER_SPACE_ID", "PHOTON_SENDER_ID"))


async def send(text: str, space_id: str | None = None) -> dict[str, Any]:
    if not configured():
        return {"status": "not_configured"}
    url = API.format(project=os.environ["PHOTON_PROJECT_ID"])
    headers = {"Authorization": f"Bearer {os.environ['PHOTON_API_KEY']}", "idempotency-key": uuid.uuid4().hex}
    body = {"spaceId": space_id or os.environ["PHOTON_OWNER_SPACE_ID"], "senderId": os.environ["PHOTON_SENDER_ID"], "content": text}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(url, headers=headers, json=body)
    except httpx.HTTPError as e:
        return {"status": "error", "detail": type(e).__name__}
    return {"status": "accepted" if response.status_code == 202 else f"http_{response.status_code}"}
