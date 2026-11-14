"use client";

import { useChannelEffect, type AnyStream } from "@langchain/react";
import { asFrontendAction, type Ack, type FrontendAction } from "./contracts";

/**
 * Subscribe to the agent's frontend_action events (LangGraph "custom" channel), perform each one,
 * and POST the ack to /api/ack so app/scene.py:stage() can confirm it.
 */
export function useSceneActions(stream: AnyStream, perform: (action: FrontendAction) => Promise<Ack>) {
  useChannelEffect(stream, ["custom"], {
    onEvent(event) {
      const action = asFrontendAction((event as { params?: { data?: unknown } }).params?.data);
      if (!action) return;
      void perform(action)
        .catch((error: unknown): Ack => ({ id: action.id, ok: false, error: String(error) }))
        .then((ack) =>
          fetch("/api/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ack) }),
        );
    },
  });
}
