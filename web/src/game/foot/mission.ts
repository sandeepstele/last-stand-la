// OWNER: builder E (missions). PLACEHOLDER from the coding lead: no crates, no survivors, no barricade yet.
// Replace freely; keep the export `createMission: SystemFactory` and the mission:* / npc:* events in engine.ts.

import type { FootCtx, System } from "./engine";

export function createMission(ctx: FootCtx): System {
  const offs = [
    ctx.bus.on("mission:reset", () => {
      ctx.npcs.length = 0;
      Object.assign(ctx.mission, { boards: 0, medkits: 0, found: 0, survivors: [], barricade: { active: false, hp: 100, max: 100 } });
    }),
    ctx.bus.on("mission:defend", () => (ctx.mission.barricade = { active: true, hp: 100, max: 100 })),
    ctx.bus.on("mission:defend-end", () => (ctx.mission.barricade = { ...ctx.mission.barricade, active: false })),
  ];
  return {
    update() {},
    dispose() {
      offs.forEach((f) => f());
    },
  };
}
