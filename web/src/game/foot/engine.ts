// Last Stand LA, on foot: the shared engine contract. Every builder codes against THIS file; only the
// coding lead edits it. Systems never import each other: they talk through ctx fields and the bus.
//
// Conventions (same as the server):
//   x = metres east, z = metres south of the district center; y = up. 1 unit = 1 metre.
//   Angles: degrees/radians CLOCKWISE FROM NORTH (-z). dirOf(0) = north = (0, -1); dirOf(90) = east = (1, 0).
//   player.yaw uses the same convention in radians: forward = (sin yaw, -cos yaw).

import * as THREE from "three";
import { approachPoint, makeCollider, pushOut, type Collider, type Pt } from "./collide";
import type { Input } from "./input";
import type { Building, District, Material, Sector } from "../types";

export type { Collider, Pt } from "./collide";

// ------------------------------------------------------------------ tuning (shared, so everyone feels the same world)
export const PLAYER_R = 0.45; // collision radius, m
export const ZOMBIE_R = 0.4;
export const WALK = 4.2; // m/s
export const SPRINT = 7.5; // m/s (stamina-limited)
export const ZOMBIE_WALK = 1.4; // wander / shamble
export const ZOMBIE_CHASE = 3.2; // forgiving (user, 2:10): slower than a walk-sprint mix, still tense; RUN must feel earned
export const NOTICE_R = 22; // a zombie notices the player inside this range with line of sight
export const DOOR_R = 4; // press E within this distance of a door
export const SCOUT_R = 75; // the agent starts scouting the hero when the player gets this close
export const FLOOR_M = 3.8; // metres per story (same as the server)

/** Where the two picture-in-picture feeds sit, in CSS px from the bottom-right corner of the canvas. */
export const FEED_RECTS = {
  drone: { right: 16, bottom: 44, w: 256, h: 160 },
  cctv: { right: 288, bottom: 44, w: 256, h: 160 },
} as const;

export const SECTOR_DEG: Record<Sector, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

/** Unit vector on the ground for a compass bearing in degrees (clockwise from north). */
export function dirOf(deg: number): Pt {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

// ------------------------------------------------------------------ shared state
export type PlayerState = {
  x: number;
  z: number;
  yaw: number; // radians, clockwise from north
  pitch: number; // radians, camera look up/down (player system owns it)
  speed: number; // current m/s (for animation + noise)
  sprinting: boolean;
  stamina: number; // 0..1
  health: number; // 0..100
  frozen: boolean; // director sets: no movement (intro, inside, dawn)
  hidden: boolean; // director sets: avatar not drawn (inside a building)
};

export type HordeInfo = {
  alive: number; // zombies currently simulated
  chasing: number; // of those, how many are chasing the player
  nearest: number; // metres to the nearest zombie (Infinity when none)
  pressing: number; // zombies within 2.5 m of the current horde:target point (drains the barricade during HOLD)
};

// ------------------------------------------------------------------ missions (v2: "Night 1")
/** A non-player character the horde can also go after (a rescued survivor). The mission system owns them. */
export type Npc = { id: string; x: number; z: number; alive: boolean; hidden: boolean };

export type SupplyKind = "boards" | "medkit";
/** A supply crate. why = where it comes from, e.g. "a medical office is on record here (CoStar)" or "scavenged". */
export type SupplySpot = { id: string; x: number; z: number; kind: SupplyKind; n: number; why: string; pid: string | null };
/** A trapped survivor (fictional people; the game's, not the data's). */
export type SurvivorSpot = { id: string; x: number; z: number; name: string };
export type SurvivorState = "trapped" | "following" | "safe" | "lost";

export type MissionState = {
  boards: number; // carried
  medkits: number; // carried
  flares: number; // carried road flares ([G] throws one; 3 per night)
  found: number; // crates picked up (score)
  survivors: { id: string; name: string; state: SurvivorState }[];
  barricade: { active: boolean; hp: number; max: number };
};

export type Events = {
  /** horde -> player: contact damage. */
  "player:hit": { damage: number; fromX: number; fromZ: number };
  /** player -> horde: Space pressed. Knock back zombies in front of the player (PG: a shove, no weapons). */
  "player:shove": { x: number; z: number; yaw: number };
  /** player -> director: health reached 0. The director rescues; there is no game over. */
  "player:downed": { x: number; z: number };
  /** director -> horde: keep `count` wanderers alive in the play area (0 = none). */
  "horde:ambient": { count: number };
  /** director -> horde: a wave arrives from `sector`, heading for (targetX, targetZ). size = the server's number; draw a capped share. */
  "wave:start": { n: number; sector: Sector; size: number; targetX: number; targetZ: number };
  /** director -> horde: where non-chasing wave zombies converge (the door during HOLD, the fallback during RUN). */
  "horde:target": { x: number; z: number };
  /** director -> horde: HOLD failed, zombies burst out at (x, z). */
  "wave:breach": { x: number; z: number; count: number };
  /** director -> horde: push every zombie within r of (x, z) out to r (used after a rescue). */
  "horde:repel": { x: number; z: number; r: number };
  /** director -> horde: dawn, the horde shambles off and fades. */
  "horde:clear": Record<string, never>;
  /** director -> world: a light beacon over a building (null = none). */
  "world:beacon": { pid: string | null };
  /** director -> world: the glowing route on the ground (null = hide). Absolute metres. */
  "world:route": { pts: Pt[] | null };
  /** director -> world: a conflict building settles toward a material (null = still a gamble). */
  "world:lean": { pid: string; material: Material | null };
  /** director -> world: boards on this building's door (null = none). */
  "world:barricade": { pid: string | null };
  /** director -> world/player: aftershock. amp ~0.1 (MMI 6) .. 0.6 (MMI 9). */
  "fx:shake": { amp: number; secs: number };
  /** director -> world: the aftershock cracked this building (a flash + debris, PG). */
  "fx:crack": { pid: string };
  // ---- missions (v2)
  /** director -> horde: a pack of `count` zombies that loiters around (x, z) (guarding a trapped survivor). */
  "horde:pack": { x: number; z: number; count: number };
  /** horde -> mission: a zombie reached an NPC. */
  "npc:hit": { id: string; damage: number; fromX: number; fromZ: number };
  /** director -> mission: place crates and trapped survivors (once per night). */
  "mission:setup": { supplies: SupplySpot[]; survivors: SurvivorSpot[] };
  /** director -> mission: spawn these survivors right away in "following" state (the office on record, found still there). */
  "mission:survivors": { survivors: SurvivorSpot[] };
  /** director -> mission: following survivors go into the building at (x, z) and become safe. */
  "mission:shelter": { pid: string; x: number; z: number };
  /** director -> mission: sheltered survivors come back out at (x, z) and follow the player again (RUN or breach). */
  "mission:evacuate": { x: number; z: number };
  /** director -> mission: HOLD. Defend this door: barricade on, drained by ctx.horde.pressing, repaired with [E] + boards. */
  "mission:defend": { pid: string; x: number; z: number; facing: number };
  /** director -> mission: the defence is over (held = the server's roll). Barricade off. */
  "mission:defend-end": { held: boolean };
  /** director -> mission: aftershock debris (game outcome, not an engineering assessment) falls in these zones for secs. */
  "mission:debris": { zones: { x: number; z: number; r: number }[]; secs: number };
  /** mission -> director: crate picked up / survivor state changed / medkit used / barricade broke. */
  "mission:pickup": { kind: SupplyKind; n: number; why: string };
  "mission:survivor": { id: string; name: string; state: SurvivorState };
  "mission:medkit": { hp: number };
  "mission:barricade-broken": Record<string, never>;
  /** director -> audio: a new radio line appeared (the agent's squads / HQ / you). Speak it, crackle. */
  "radio:line": { who: string; text: string; tone?: string };
  /** flare -> horde: a lit road flare at (x, z). Zombies within ~35 m that aren't in contact are drawn to it for secs. */
  "flare:lit": { x: number; z: number; secs: number };
  /** horde -> fx/audio: a zombie was stunned by the flashlight (held on it), at (x, z). */
  "zombie:stunned": { x: number; z: number };
  /** director -> mission: clear everything (play again). */
  "mission:reset": Record<string, never>;
};

export type Bus = {
  emit<K extends keyof Events>(k: K, e: Events[K]): void;
  on<K extends keyof Events>(k: K, f: (e: Events[K]) => void): () => void;
};

export function createBus(): Bus {
  const m = new Map<string, Set<(e: unknown) => void>>();
  return {
    emit(k, e) {
      m.get(k)?.forEach((f) => {
        try {
          f(e);
        } catch (err) {
          console.error(`bus ${String(k)}`, err);
        }
      });
    },
    on(k, f) {
      const s = m.get(k) ?? new Set();
      s.add(f as (e: unknown) => void);
      m.set(k, s);
      return () => s.delete(f as (e: unknown) => void);
    },
  };
}

export type FootCtx = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  district: District;
  byPid: Map<string, Building>;
  /** Every building as a ground polygon (kit footprints, kit boxes, backdrop blocks). */
  colliders: Collider[];
  colliderOf: Map<string, Collider>;
  /** The walkable rectangle (the ground mosaic + 80 m when present). Systems clamp to it. The mosaic itself is district.ground. */
  bounds: { x0: number; z0: number; x1: number; z1: number };
  input: Input;
  player: PlayerState;
  horde: HordeInfo;
  /** Survivors etc. Zombies chase the nearest of the player and these (alive && !hidden). The mission system writes them. */
  npcs: Npc[];
  /** Carried supplies, survivors, barricade. The mission system writes it; the director and HUD read it. */
  mission: MissionState;
  bus: Bus;
  /** "player": the player system drives the camera. "director": the director does (intro flyover). */
  cameraOwner: "player" | "director";
  /** Seconds since start. */
  time: number;
  /** 0 = night .. 1 = dawn. The director tweens it; world lighting and the sky read it. */
  dawn: number;
  stub: boolean;
  /** URL for an image file name served by the backend (/evidence/image/{name}). */
  imageUrl(name: string): string;
  /** Push a circle out of all buildings and clamp it to bounds. */
  collide(x: number, z: number, r: number): Pt;
};

/** A system is created once per page load and lives until unmount. "Play again" is handled via the bus/ctx. */
export type System = {
  update(dt: number): void;
  /** Optional extra pass after the main render (picture-in-picture feeds). */
  render?(): void;
  dispose(): void;
};
export type SystemFactory = (ctx: FootCtx) => System;

// ------------------------------------------------------------------ geometry shared by world + collision
export function buildingHeight(b: Building): number {
  const s = Math.max(1, b.stories || 1);
  let h = Number(b.height_m) || 0;
  if (h < 2.5 * s) h = s * FLOOR_M;
  return h > 0 ? h : 10;
}

/** The building's outline in ABSOLUTE metres: its real footprint when valid, otherwise its w x d box. */
export function outlineOf(b: Building): Pt[] {
  const fp = b.footprint;
  if (Array.isArray(fp) && fp.length >= 3 && fp.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
    return fp.map(([x, z]) => [x + b.x, z + b.z] as Pt);
  }
  const w = b.w > 0 ? b.w : 20;
  const d = b.d > 0 ? b.d : 20;
  return [
    [b.x - w / 2, b.z - d / 2],
    [b.x + w / 2, b.z - d / 2],
    [b.x + w / 2, b.z + d / 2],
    [b.x - w / 2, b.z + d / 2],
  ];
}

export function buildColliders(d: District): { colliders: Collider[]; colliderOf: Map<string, Collider> } {
  const colliders: Collider[] = [];
  const colliderOf = new Map<string, Collider>();
  for (const b of d.buildings) {
    const c = makeCollider(outlineOf(b), buildingHeight(b), b.pid);
    colliders.push(c);
    colliderOf.set(b.pid, c);
  }
  for (const k of d.blocks ?? []) {
    if (Array.isArray(k?.ring) && k.ring.length >= 3) colliders.push(makeCollider(k.ring, Number(k.height_m) || 12, null));
  }
  return { colliders, colliderOf };
}

export function boundsOf(d: District, focus: Pt[]): FootCtx["bounds"] {
  // The mosaic is drawn at its exact rectangle (world), but the walkable area extends past it: the hero's street only
  // connects to the rest of the grid outside the mosaic (Builder C's flood fill), so pad it.
  if (d.ground) return { x0: d.ground.x0 - 80, z0: d.ground.z0 - 80, x1: d.ground.x1 + 80, z1: d.ground.z1 + 80 };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of focus) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    z0 = Math.min(z0, z);
    z1 = Math.max(z1, z);
  }
  if (!Number.isFinite(x0)) return { x0: -250, z0: -250, x1: 250, z1: 250 };
  const m = 160;
  return { x0: x0 - m, z0: z0 - m, x1: x1 + m, z1: z1 + m };
}

export function makeCollide(colliders: Collider[], bounds: FootCtx["bounds"]): FootCtx["collide"] {
  return (x, z, r) => {
    const [px, pz] = pushOut(x, z, r, colliders);
    return [Math.min(bounds.x1 - r, Math.max(bounds.x0 + r, px)), Math.min(bounds.z1 - r, Math.max(bounds.z0 + r, pz))];
  };
}

/** Where to stand to "reach" a building: its door, else the point just outside its outline nearest `from`. */
export function reachPoint(ctx: FootCtx, pid: string, from: Pt): Pt | null {
  const b = ctx.byPid.get(pid);
  if (!b) return null;
  if (b.door) return [b.door.x, b.door.z];
  const c = ctx.colliderOf.get(pid);
  return c ? approachPoint(c, from[0], from[1], 1.5) : [b.x, b.z];
}
