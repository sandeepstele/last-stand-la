// Contract v1.1 + v1.2/v1.3 optional fields (Last Stand LA). Mirrors the backend's /game/* routes and laststand tool results.
// Shapes only: every number here is computed server-side; the frontend never invents one.

export type Material = "concrete" | "steel" | "masonry" | "wood" | "unknown";
export type Sector = "N" | "NE" | "E" | "SE" | "S" | "SW" | "W" | "NW";

/** GET /game/district: one building. x,z are metres east/south of the district center. */
export type Building = {
  pid: string;
  label: string;
  x: number;
  z: number;
  /** Open ring [[x,z],...] in metres, RELATIVE to this building's (x, z); w,d are used when null. */
  footprint: [number, number][] | null;
  w: number;
  d: number;
  height_m: number;
  stories: number;
  material: Material;
  list: "concrete" | "soft_story" | null;
  unfinished: boolean;
  past_due: boolean;
  mmi: number | null;
  hero: boolean;
  // ---- v1.1 optional fields (null or absent when unknown)
  /** Year built, for the hover facts. */
  year_built?: number | null;
  /** People on record in the building, for the hover facts. */
  people?: number | null;
  /** An open record conflict on material: what the listing records vs what the city list implies. */
  conflict?: { costar: Material; city: Material } | null;
  // ---- v1.2 optional: the one or two buildings the player can walk into
  /** Door in ABSOLUTE district metres, 1 m outside the wall. facing = outward normal, degrees clockwise from north (-z). */
  door?: { x: number; z: number; facing: number } | null;
};

/** v1.2: one aerial mosaic for the ground, north-up. Image top edge = z0, left edge = x0 (district metres). */
export type Ground = { image: string; x0: number; z0: number; x1: number; z1: number };

/** v1.3 (planned): a real building outline that is NOT a kit building (backdrop + collision). ABSOLUTE district metres. */
export type Block = { ring: [number, number][]; height_m: number };

export type Wave = { n: number; sector: Sector; arrive_s: number; size: number };

export type District = {
  center: { lat: number; lon: number };
  radius_m: number;
  seed: number;
  buildings: Building[];
  waves: Wave[];
  /** v1.2 optional: null or absent when the mosaic could not be fetched. */
  ground?: Ground | null;
  /** v1.3 optional: other real buildings around the play area; [] or absent when unavailable. */
  blocks?: Block[] | null;
  /** v1.3: "© OpenStreetMap contributors" when blocks/outlines came from OSM. Show it in the footer and credits. */
  attribution?: string | null;
};

export type ScoreKey = "walls" | "quake" | "roof" | "people" | "space";
export type ScoreLabel = "likely" | "leaning" | "unresolved" | "known";
export type Score = { value: number; label: ScoreLabel; why: string; source: string };

export type Hypothesis = { key: string; claim: string; prior: number };
export type DossierCase = { case: string; question: string; hypotheses: Hypothesis[] };

/** v1.1 optional: one cube face of an interior panorama (f1-f4 sides, f0 top, f5 bottom). */
export type PanoFace = { face: "f0" | "f1" | "f2" | "f3" | "f4" | "f5"; name: string };

/** GET /game/dossier/{pid}, and the fortress_dossier tool result. */
export type Dossier = {
  pid: string;
  label: string;
  scores: Record<ScoreKey, Score>;
  unknowns: string[];
  /** File names served by /evidence/image/{name}. */
  images: { drone: string[]; cctv: string[]; pano?: PanoFace[]; inside?: PanoFace[] };
  case: DossierCase | null;
  disclaimer: string;
};

export type PlanAction = "hold" | "run";

/** POST /game/resolve (v1.1). checks = names of the check_evidence calls seen in the stream for this pid. */
export type ResolveRequest = { pid: string; wave: number; seed: number; action: PlanAction; to_pid?: string; checks: string[] };
/** The resolve object; also commit_plan's tool result once approved or edited. */
export type ResolveResult = {
  held: boolean;
  walls: number;
  quake: number;
  walls_roll: number;
  quake_roll: number;
  why: string;
  pid_final: string;
};

/** horde_status(wave) tool result */
export type HordeStatus = {
  wave: number;
  sector: Sector;
  eta_band: "<30s" | "30-60s" | ">60s";
  size_band: "small" | "large" | "huge";
};

/** find_fallback(pid, away_from?) tool result */
export type Fallback = { from_pid: string; to_pid: string; to_label: string; distance_band: string; reason: string };

/** commit_plan(pid, action, to_pid?) args, shown in HOLD/RUN (interrupt_on). */
export type CommitPlanArgs = { pid: string; action: PlanAction; to_pid?: string };

/** deepagents HumanInTheLoop interrupt value. */
export type HitlValue = { action_requests?: { name: string; args: Record<string, unknown> }[] };

/** One decision per pending action request. */
export type HitlDecision =
  | { type: "approve" }
  | { type: "reject" }
  | { type: "edit"; edited_action: { name: string; args: Record<string, unknown> } };

export const SCORE_KEYS: ScoreKey[] = ["walls", "quake", "roof", "people", "space"];
export const DISCLAIMER = "Game outcome, not an engineering assessment";
