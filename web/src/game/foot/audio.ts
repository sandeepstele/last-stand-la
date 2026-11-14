// OWNER: builder G (audio). PLACEHOLDER from the coding lead: silent.
// Replace freely; keep the export `createAudio: SystemFactory`. Listen to the bus (incl. "radio:line") and read ctx; never emit
// agent inputs, never block the frame, start only after the first user gesture.

import type { FootCtx, System } from "./engine";

export function createAudio(ctx: FootCtx): System {
  void ctx;
  return { update() {}, dispose() {} };
}
