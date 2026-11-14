// OWNER: builder B (horde). PLACEHOLDER from the coding lead: no zombies yet.
// Replace freely; keep the export signature `createHorde: SystemFactory` and the bus events in engine.ts.

import type { FootCtx, System } from "./engine";

export function createHorde(ctx: FootCtx): System {
  ctx.horde.alive = 0;
  ctx.horde.chasing = 0;
  ctx.horde.nearest = Infinity;
  return { update() {}, dispose() {} };
}
