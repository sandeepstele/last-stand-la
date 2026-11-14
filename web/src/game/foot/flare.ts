// OWNER: builder B (horde + flares). PLACEHOLDER from the coding lead: [G] does nothing yet.
// createFlare: [G] throws a road flare (ctx.mission.flares, 3 per night) along the aim; it lands, burns red for 8 s and emits
// "flare:lit" so the horde is drawn to it. Keep the export.

import type { FootCtx, System } from "./engine";

export function createFlare(ctx: FootCtx): System {
  void ctx;
  return { update() {}, dispose() {} };
}
