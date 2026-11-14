// OWNER: builder B. Shared by horde.ts and feeds.ts (a constant, not a system import).
// THREE layer that only the DRONE feed camera enables: the tactical red/amber discs live here,
// so the main camera (layer 0 only) never draws them.
export const DRONE_LAYER = 2;
