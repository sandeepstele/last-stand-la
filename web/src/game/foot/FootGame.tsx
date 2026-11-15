"use client";

// Last Stand LA, on foot (/play?mode=foot, add &stub=1 for synthetic data). OWNER: coding lead (the director).
//
// The story, on one agent thread (useGame drives the laststand graph exactly as the map mode does):
//   intro   title + briefing while the camera circles the real district
//   approach  walk to the hero building; within SCOUT_R the agent starts scouting it ("Scout property <pid>")
//   inside  [E] at its door: the REAL interior (Matterport) + "what are the walls made of?" -> "Tip: ..." (record_note)
//   night   step out: "Wave 1 is coming from the <S>", zombies come, the agent proposes HOLD or RUN; [H]/[R]/[N]
//   hold    barricaded inside; the server's roll decides; a failed roll = breach -> escape
//   escape  sprint along the agent's route to the fallback building, chased
//   safe -> aftershock (code roll, Northridge shaking) -> dawn (the real case file + draft correction)
//
// The Night Shift (user decision 1:45): the agent BRIEFS the night from the real CoStar case queue ("Brief the night shift" ->
// night_cases + write_todos). Case #7 first (a ghost tenant: is the office on record in suite 1100 still there? the player walks
// into that suite's real tour and reports), then case #6 (the fortress walls), then the night. Reports are real evidence.
// Missions ("Night 1"): a nightfall clock, trapped survivors to rescue and escort, supply crates (boards for the barricade,
// medkits), an active door defence on HOLD, an escort run on RUN, aftershock debris zones (game outcome, not an engineering
// assessment), a dawn score and "file the report". None of it adds an agent message: the recorded replay stays valid.
//
// Hard rule: what the player does with their hands (health, sprinting) never feeds the agent or the rolls.
// The building's fate is the server's seeded roll; the player's fate is the arcade layer. No game over.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Game } from "../useGame";
import { evidenceUrl } from "../Pano";
import { SECTOR_NAME, checksFor, kind, latestResult, parse, radioLines, type Msg } from "../radio";
import { DISCLAIMER, type Building } from "../types";
import { boundsOf, buildColliders, createBus, dirOf, makeCollide, reachPoint, DOOR_R, SCOUT_R, SECTOR_DEG, type FootCtx, type Pt, type SupplySpot, type SurvivorSpot, type SurvivorState, type System } from "./engine";
import { createInput, type Input } from "./input";
import { closestOnPoly } from "./collide";
import { createWorld } from "./world";
import { createPlayer } from "./player";
import { createHorde } from "./horde";
import { createFeeds, type Feeds } from "./feeds";
import { createMission } from "./mission";
import { createAudio } from "./audio";
import { createFlare } from "./flare";
import { createCityMap, type City } from "./cityMap";
import { createRoofObjects, type RoofSystem } from "./roofObjects";
import { SuiteSweep, type SweepScore } from "./SuiteSweep";
import { InsideMesh3D } from "./InsideMesh3D";
import { PauseMenu } from "./PauseMenu";
import { SolarSurvey, type SolarRoof } from "./SolarSurvey";
import { StaleCheck, type StaleCase } from "./StaleCheck";
import { HqPanel } from "./HqPanel";
import { HqMoments } from "./hqMoments";
import { mulberry32 } from "../prng";
import { IntroOverlay } from "./IntroOverlay";
import { InsideView, type InsideMode } from "./InsideView";
import { FootHud, RadioSubs, type Banner, type Hint, type Objective } from "./FootHud";
import { DawnView } from "./DawnView";
import { Badges, footStyles } from "./ui";

type Step = "intro" | "office" | "suite" | "approach" | "inside" | "visit" | "night" | "hold" | "escape" | "safe" | "result" | "dawn";

const TIP_CHOICES = ["Concrete", "Brick", "Can't tell"];
const SUITE_CHOICES = ["Empty", "People working", "Can't tell"];
// Exact strings: the replay covers these three (sent as "Tip: <text>").
const suiteTips = (suite: string) => [
  `I'm inside suite ${suite}. It's empty: no one is working here.`,
  `I'm inside suite ${suite}. People are working here.`,
  `I'm inside suite ${suite}. I can't tell if anyone works here.`,
];
// night_cases() (laststand graph): the open queue cases inside the play area, in queue order. Only those with imagery gathered.
type NightCase = { n: number; case: string; property_id: string; suite: string | null; label: string; question?: string; stakes?: string };
// Exact strings: the backend's replay recording covers these three (sent as "Tip: <text>"). No address in source code.
const TIP_TEXTS = [
  "I'm inside the building. The walls and columns look like concrete.",
  "I'm inside the building. The walls look like brick.",
  "I'm inside the building. I can't tell what the walls are made of.",
];

const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const bearing = (from: Pt, to: Pt) => ((Math.atan2(to[0] - from[0], -(to[1] - from[1])) * 180) / Math.PI + 360) % 360;

function pickHero(bs: Building[]): Building | null {
  return bs.find((b) => b.door && b.conflict) ?? bs.find((b) => b.hero && b.conflict) ?? bs.find((b) => b.hero) ?? null;
}

/** A spot on the street in front of the hero's door, ~60 m along it, facing back toward the door. */
function spawnFor(ctx: FootCtx, door: Pt, facingDeg: number): { at: Pt; yaw: number } {
  const [fx, fz] = dirOf(facingDeg);
  const perp: Pt = [-fz, fx];
  const street: Pt = [door[0] + fx * 10, door[1] + fz * 10];
  for (const k of [60, -60, 45, -45, 30, -30, 15, -15, 0]) {
    const c: Pt = [street[0] + perp[0] * k, street[1] + perp[1] * k];
    const [x, z] = ctx.collide(c[0], c[1], 0.5);
    if (Math.hypot(x - c[0], z - c[1]) < 0.05) return { at: [x, z], yaw: (bearing([x, z], door) * Math.PI) / 180 };
  }
  const [x, z] = ctx.collide(street[0], street[1], 0.5);
  return { at: [x, z], yaw: (bearing([x, z], door) * Math.PI) / 180 };
}

const NIGHTFALL_S = 150; // the dusk clock
const DEFEND_MIN_S = 25; // HOLD lasts at least this long before the server's roll is shown
const SURVIVOR_NAMES = ["Maya", "Luis", "Grace", "Dev"]; // fictional

/** Crates and trapped survivors for this night. Seeded: same district, same night. Real supply data (v1.4) wins when present. */
function planMission(ctx: FootCtx, heroPid: string, door: Pt, spawn: Pt): { supplies: SupplySpot[]; survivors: SurvivorSpot[] } {
  const rnd = mulberry32((ctx.district.seed || 1990) * 7 + 3);
  const free = (x: number, z: number) => {
    const [cx, cz] = ctx.collide(x, z, 0.8);
    const b = ctx.bounds;
    return Math.hypot(cx - x, cz - z) < 0.05 && x > b.x0 + 8 && x < b.x1 - 8 && z > b.z0 + 8 && z < b.z1 - 8;
  };
  const pick = (rMin: number, rMax: number, avoid: Pt[], minGap: number): Pt | null => {
    for (let i = 0; i < 80; i++) {
      const a = rnd() * Math.PI * 2, r = rMin + rnd() * (rMax - rMin);
      const x = door[0] + Math.sin(a) * r, z = door[1] - Math.cos(a) * r;
      if (free(x, z) && avoid.every((q) => Math.hypot(q[0] - x, q[1] - z) > minGap)) return [x, z];
    }
    return null;
  };
  const supplies: SupplySpot[] = [];
  const used: Pt[] = [spawn, door];
  for (const b of ctx.district.buildings) {
    for (const [i, s] of (b.supplies ?? []).entries()) {
      if (b.pid === heroPid) continue;
      const at = reachPoint(ctx, b.pid, door);
      if (!at || !free(at[0], at[1])) continue;
      supplies.push({ id: `${b.pid}-${i}`, x: at[0], z: at[1], kind: s.kind, n: s.kind === "boards" ? 2 : 1, why: s.why, pid: b.pid });
      used.push(at);
    }
  }
  const want = { boards: 4, medkit: 1 };
  for (const s of supplies) want[s.kind] = Math.max(0, want[s.kind] - 1);
  for (const kind of ["boards", "boards", "boards", "boards", "medkit"] as const) {
    if (want[kind] <= 0) continue;
    const at = pick(25, 110, used, 18);
    if (!at) continue;
    want[kind] -= 1;
    used.push(at);
    supplies.push({ id: `crate-${supplies.length}`, x: at[0], z: at[1], kind, n: kind === "boards" ? 2 : 1, why: "a crate (game item)", pid: null });
  }
  const survivors: SurvivorSpot[] = [];
  for (let i = 0; i < 2; i++) {
    const at = pick(45, 90, [...used, ...survivors.map((v) => [v.x, v.z] as Pt)], 30);
    if (at) survivors.push({ id: `sv-${i}`, x: at[0], z: at[1], name: SURVIVOR_NAMES[i] });
  }
  return { supplies, survivors };
}

function safely(name: string, s: System): System {
  let warned = false;
  const guard = (f: () => void) => {
    try {
      f();
    } catch (e) {
      if (!warned) console.error(`[foot] ${name}`, e);
      warned = true;
    }
  };
  return {
    update: (dt) => guard(() => s.update(dt)),
    render: s.render ? () => guard(() => s.render!()) : undefined,
    dispose: () => guard(() => s.dispose()),
  };
}

/**
 * agentOff (?agent=off): visual testing against the real district without spending agent runs. The director never
 * calls the agent; the night starts on stepping out, H/R work locally and a HOLD always breaches after 5 s.
 * In development, window.__foot = { ctx, step } lets test scripts emit bus events (e.g. a wave) by hand.
 */
/** presenter (?demo=1): [F] fast-forwards the slow parts (walk to the door, the escape run, the door defence) for a 30-40 s pitch. */
export function FootGame({ game, replay, agentOff = false, presenter = false }: { game: Game; replay: string | null; agentOff?: boolean; presenter?: boolean }) {
  const { district } = game;
  const router = useRouter();
  const wrapRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<FootCtx | null>(null);
  const feedsRef = useRef<Feeds | null>(null);
  const roofRef = useRef<RoofSystem | null>(null);
  const gRef = useRef(game);
  useEffect(() => {
    gRef.current = game;
  });

  const hero = useMemo(() => (district ? pickHero(district.buildings) : null), [district]);
  const heroLabel = hero?.label ?? "";
  const safeRoom = useMemo(() => district?.buildings.find((b) => b.door && b.pid !== hero?.pid) ?? null, [district, hero]);
  // The Night Shift needs the live agent (the briefing comes from the real queue). Stub / agent-off play case #6 only.
  const feats = district?.features;
  const nightShift = !!safeRoom && !game.stub && !agentOff && (!feats || feats.includes("night_shift"));
  const office = nightShift ? safeRoom : null;
  const brief = useMemo(() => latestResult<{ total?: number; in_area?: number; cases?: NightCase[] }>(game.messages, "night_cases"), [game.messages]);
  const case7 = useMemo(() => (office ? brief?.cases?.find((c) => c.case === "ghost_tenant" && String(c.property_id) === office.pid && c.suite) ?? null : null), [brief, office]);
  const case6 = useMemo(() => (hero ? brief?.cases?.find((c) => c.case === "material_conflict" && String(c.property_id) === hero.pid) ?? null : null), [brief, hero]);
  const queueTotal = brief?.total ?? null;
  const fallbackPid = game.fallback?.to_pid && district?.buildings.some((b) => b.pid === game.fallback?.to_pid) ? game.fallback.to_pid : safeRoom?.pid ?? null;
  const labelOf = (pid: string | null | undefined) => (pid ? district?.buildings.find((b) => b.pid === pid)?.label ?? game.fallback?.to_label ?? "the fallback" : "");

  // ------------------------------------------------------------------ UI state (React); the loop reads it through refs
  const [step, setStepState] = useState<Step>("intro");
  const stepRef = useRef<Step>("intro");
  const stepAt = useRef(0);
  const setStep = (s: Step) => {
    stepRef.current = s;
    stepAt.current = ctxRef.current?.time ?? 0;
    setStepState(s);
  };
  const [banner, setBannerState] = useState<Banner | null>(null);
  const bannerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setBanner = (b: Banner | null, ms = 3500) => {
    if (bannerTimer.current) clearTimeout(bannerTimer.current);
    setBannerState(b);
    if (b && ms > 0) bannerTimer.current = setTimeout(() => setBannerState(null), ms);
  };
  const [tip, setTip] = useState<{ chosen: number | null; sentAt: number | null }>({ chosen: null, sentAt: null });
  const tipRef = useRef(tip);
  useEffect(() => {
    tipRef.current = tip;
  }, [tip]);
  const [hud, setHud] = useState({ health: 100, stamina: 1, yawDeg: 0, threat: 0, threatDir: null as number | null, nearDoor: false, target: null as null | { label: string; bearingDeg: number; dist: number } });
  const [dronePhoto, setDronePhoto] = useState<{ src: string; caption: string } | null>(null);
  const [cctvPhoto, setCctvPhoto] = useState<{ src: string; caption: string } | null>(null);
  const cctvPhotoOn = useRef(false);
  useEffect(() => {
    cctvPhotoOn.current = !!cctvPhoto;
  }, [cctvPhoto]);
  const [feedCaps, setFeedCaps] = useState({ drone: "DRONE", cctv: "CCTV" });
  const routeTo = useRef<Pt | null>(null);
  const downed = useRef(false);
  const scoutAsked = useRef(false);
  const scoutStarted = useRef(false); // "Scout property" sent exactly once per night
  const nightAsked = useRef(false); // the loop outruns React: send "Wave 1 is coming" exactly once
  const shockFired = useRef(false);
  const tipSending = useRef(false);
  // the Night Shift: briefing + case #7
  const briefAsked = useRef(false);
  const suiteAsked = useRef(false);
  const suiteSending = useRef(false);
  const officeSpawned = useRef(false);
  const downedCount = useRef(0);
  // All of LA (the city map) and the buildings you can look inside on your own (any building with a door + a real tour).
  const [city, setCity] = useState<{ buildings: number; cases: number } | null>(null);
  const [visit, setVisit] = useState<string | null>(null);
  const [nearVisit, setNearVisit] = useState<string | null>(null);
  const [sweep, setSweep] = useState<SweepScore>({ stamped: 0, right: 0 });
  const sweepRef = useRef(sweep);
  useEffect(() => {
    sweepRef.current = sweep;
  }, [sweep]);
  // Walk between the real scan spots inside a building (Matterport twin positions), when the dossier has them.
  const [hop, setHop] = useState(0);
  // Solar-roof survey (side mission): screened roofs in the play area, [C] near one to survey and stamp.
  const [solar, setSolar] = useState<SolarRoof[]>([]);
  const solarRef = useRef<SolarRoof[]>([]);
  useEffect(() => {
    solarRef.current = solar;
  }, [solar]);
  const [solarOpen, setSolarOpen] = useState<string | null>(null);
  const [solarStamps, setSolarStamps] = useState<Record<string, SolarRoof["answer"]>>({});
  const [nearSolar, setNearSolar] = useState<string | null>(null);
  // "Same building?" (stale entry): the walkable case(s) open with [C] at the building; the rest are listed in the menu.
  const [stale, setStale] = useState<StaleCase[]>([]);
  const staleRef = useRef<StaleCase[]>([]);
  useEffect(() => {
    staleRef.current = stale;
  }, [stale]);
  const [staleOpen, setStaleOpen] = useState<string | null>(null);
  const [staleStamps, setStaleStamps] = useState<Record<string, StaleCase["answer"]>>({});
  const [nearStale, setNearStale] = useState<string | null>(null);
  const solarRightRef = useRef(0);
  useEffect(() => {
    solarRightRef.current = solar.filter((r) => solarStamps[r.pid] === r.answer).length + stale.filter((c) => staleStamps[c.pid] === c.answer).length;
  }, [solar, solarStamps, stale, staleStamps]);
  // Pause (P / Esc / the button): the sim freezes; agent runs in flight keep streaming.
  const [paused, setPausedState] = useState(false);
  const pausedRef = useRef(false);
  const setPaused = (v: boolean) => {
    pausedRef.current = v;
    setPausedState(v);
  };
  const [hopHeading, setHopHeading] = useState(0);
  const hopCount = useRef(0);
  const visitFrom = useRef<Step>("approach");
  const [nearPhoto, setNearPhoto] = useState<{ src: string; caption: string } | null>(null);
  const nearPhotoOn = useRef(false);
  const nearPid = useRef<string | null>(null);
  const nearAt = useRef(0);
  const debriefAsked = useRef(false);
  const debriefSent = useRef(false);
  const [suiteTip, setSuiteTip] = useState<{ chosen: number | null; sentAt: number | null }>({ chosen: null, sentAt: null });
  const suiteTipRef = useRef(suiteTip);
  useEffect(() => {
    suiteTipRef.current = suiteTip;
  }, [suiteTip]);
  const case7Ref = useRef<NightCase | null>(null);
  useEffect(() => {
    case7Ref.current = case7;
  }, [case7]);
  // missions
  const nightfallAt = useRef(Infinity);
  const nightFallen = useRef(false);
  const startedAt = useRef(0);
  const debrisFired = useRef(false);
  const defendEnded = useRef(false);
  const [prog, setProg] = useState({ reached: false, checked: false, survived: false, filed: false });
  const [mhud, setMhud] = useState({ flares: 0, boards: 0, medkits: 0, found: 0, crates: 0, survivors: [] as { name: string; state: SurvivorState }[], barricade: null as null | { hp: number; max: number }, timer: null as null | { label: string; secs: number; urgent: boolean } });
  const cratesTotal = useRef(0);
  const [score, setScore] = useState({ saved: 0, total: 0, found: 0, health: 100, secs: 0, points: 0, rank: "C", downed: 0 });

  // ------------------------------------------------------------------ engine: created once per district
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap || !district || !hero) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    wrap.prepend(renderer.domElement);
    renderer.domElement.style.display = "block";
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2000);
    const input: Input = createInput(renderer.domElement);
    const byPid = new Map(district.buildings.map((b) => [b.pid, b]));
    const { colliders, colliderOf } = buildColliders(district);
    const focus: Pt[] = district.buildings.filter((b) => b.hero || b.door).map((b) => [b.x, b.z]);
    const bounds = boundsOf(district, focus);
    const ctx: FootCtx = {
      scene, camera, renderer, district, byPid, colliders, colliderOf, bounds, input,
      player: { x: 0, z: 0, yaw: 0, pitch: 0, speed: 0, sprinting: false, stamina: 1, health: 100, frozen: true, hidden: false },
      horde: { alive: 0, chasing: 0, nearest: Infinity, pressing: 0, nearestX: NaN, nearestZ: NaN },
      npcs: [],
      mission: { boards: 0, medkits: 0, flares: 0, found: 0, survivors: [], barricade: { active: false, hp: 100, max: 100 } },
      bus: createBus(),
      cameraOwner: "director",
      time: 0,
      dawn: 0,
      stub: gRef.current.stub,
      imageUrl: evidenceUrl,
      collide: makeCollide(colliders, bounds),
    };
    ctxRef.current = ctx;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __foot?: unknown }).__foot = { ctx, step: () => stepRef.current, game: () => gRef.current, since: () => ctx.time - stepAt.current, flags: () => ({ scoutAsked: scoutAsked.current, briefAsked: briefAsked.current, nightAsked: nightAsked.current }) };
    const first = office?.door && !presenter ? office : hero;
    const door: Pt = first.door ? [first.door.x, first.door.z] : reachPoint(ctx, first.pid, [first.x, first.z + 40]) ?? [first.x, first.z];
    const sp = spawnFor(ctx, door, first.door?.facing ?? 180);
    Object.assign(ctx.player, { x: sp.at[0], z: sp.at[1], yaw: sp.yaw });

    const feeds = createFeeds(ctx);
    feedsRef.current = feeds;
    const systems = [safely("world", createWorld(ctx)), safely("player", createPlayer(ctx)), safely("horde", createHorde(ctx)), safely("mission", createMission(ctx)), safely("flare", createFlare(ctx)), safely("roof", (roofRef.current = createRoofObjects(ctx))), safely("city", createCityMap(ctx, (c: City) => setCity({ buildings: c.buildings.length, cases: c.buildings.filter((b) => b.case).length }))), safely("audio", createAudio(ctx)), safely("feeds", feeds)];
    ctx.bus.emit("world:beacon", { pid: hero.pid });
    const offDown = ctx.bus.on("player:downed", () => (downed.current = true));
    const offMission = [
      ctx.bus.on("mission:pickup", (e) => setBanner({ title: e.kind === "boards" ? `+${e.n} boards` : "+1 medkit", sub: e.kind === "medkit" ? "Press Q to use it." : "For the barricade.", tone: "good" }, 2200)),
      ctx.bus.on("mission:survivor", (e) =>
        setBanner(
          e.state === "following" ? { title: `${e.name} is with you`, sub: "Keep them close. Zombies go for them too.", tone: "good" }
          : e.state === "safe" ? { title: `${e.name} is safe`, tone: "good" }
          : e.state === "lost" ? { title: `${e.name} ran for it`, sub: "Lost in the dark.", tone: "bad" } : null,
          2600,
        ),
      ),
      ctx.bus.on("mission:barricade-broken", () => ctx.bus.emit("world:barricade", { pid: null })),
      ctx.bus.on("mission:barricade-broken", () => setBanner({ title: "The barricade is down", sub: "Shove them back. E with boards rebuilds it.", tone: "bad" }, 3000)),
      ctx.bus.on("mission:medkit", () => setBanner({ title: "Patched up", tone: "good" }, 1500)),
    ];

    const resize = () => {
      const w = wrap.clientWidth || 1, h = wrap.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    let last = performance.now();
    let hudAt = 0;
    const frame = (now: number) => {
      const dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); // the first rAF timestamp can precede `last`
      last = now;
      if (!pausedRef.current) {
        ctx.time += dt;
        tickRef.current(dt);
        for (const s of systems) s.update(dt);
      }
      const size = renderer.getSize(new THREE.Vector2());
      renderer.setScissorTest(false);
      renderer.setViewport(0, 0, size.x, size.y);
      renderer.render(scene, camera);
      for (const s of systems) s.render?.();
      input.endFrame();
      if (now - hudAt > 120) {
        hudAt = now;
        hudRef.current();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offDown();
      offMission.forEach((f) => f());
      for (const s of systems) s.dispose();
      input.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      ctxRef.current = null;
      feedsRef.current = null;
    };
  }, [district, hero, office, presenter]);

  // ------------------------------------------------------------------ helpers the loop uses
  const doorOf = (ctx: FootCtx, b: Building | null): Pt | null => (b ? (b.door ? [b.door.x, b.door.z] : reachPoint(ctx, b.pid, [ctx.player.x, ctx.player.z])) : null);
  const objectivePoint = (ctx: FootCtx): { at: Pt; label: string } | null => {
    const s = stepRef.current;
    if ((s === "office" || s === "suite") && office) {
      const d = doorOf(ctx, office);
      return d ? { at: d, label: office.label } : null;
    }
    if ((s === "approach" || s === "inside") && hero) {
      const d = doorOf(ctx, hero);
      return d ? { at: d, label: hero.label } : null;
    }
    if (s === "escape" && routeTo.current) return { at: routeTo.current, label: labelOf(fallbackPid) };
    return null;
  };

  const startEscape = (ctx: FootCtx, breach: boolean) => {
    const toPid = fallbackPid;
    const from: Pt = [ctx.player.x, ctx.player.z];
    const to = toPid ? reachPoint(ctx, toPid, from) : null;
    routeTo.current = to;
    ctx.player.frozen = false;
    ctx.player.hidden = false;
    ctx.cameraOwner = "player";
    ctx.bus.emit("world:route", { pts: to ? [from, to] : null });
    ctx.bus.emit("world:beacon", { pid: toPid });
    if (to) {
      // Something waits on the way: a pack about 45% along the line to the fallback.
      const [mx, mz] = ctx.collide(from[0] + (to[0] - from[0]) * 0.45, from[1] + (to[1] - from[1]) * 0.45, 0.5);
      ctx.bus.emit("horde:pack", { x: mx, z: mz, count: 8 });
    }
    // The horde swarms the fortress you left (chasers still come for you); not the door you're running to.
    if (hero?.door) ctx.bus.emit("horde:target", { x: hero.door.x, z: hero.door.z });
    setStep("escape");
    setBanner(breach ? { title: "They're through", sub: to ? `Run to ${labelOf(toPid)}.` : "Get clear and survive.", tone: "bad" } : { title: `Run to ${labelOf(toPid)}`, sub: "Hold Shift to sprint. Space to shove.", tone: "warn" });
  };

  const startDefend = (ctx: FootCtx, door: Pt) => {
    const f = dirOf(hero?.door?.facing ?? 180);
    // 3 m out: the over-the-shoulder camera then stays outside the door's planks (Builder E's measurement).
    [ctx.player.x, ctx.player.z] = ctx.collide(door[0] + f[0] * 3, door[1] + f[1] * 3, 0.5);
    ctx.player.yaw = ((hero?.door?.facing ?? 180) * Math.PI) / 180; // face the horde
    ctx.player.frozen = false;
    ctx.player.hidden = false;
    ctx.cameraOwner = "player";
    defendEnded.current = false;
    ctx.bus.emit("world:barricade", { pid: hero?.pid ?? null });
    ctx.bus.emit("mission:defend", { pid: hero?.pid ?? "", x: door[0], z: door[1], facing: hero?.door?.facing ?? 180 });
    ctx.mission.boards += 2; // two boards to start: [E] does something even without crates
    {
      // The first of the wave hits the door within ~5 s: a pack 28 m out on the wave's side.
      const w1 = gRef.current.district?.waves.find((x) => x.n === 1);
      const dir = w1 ? dirOf(SECTOR_DEG[w1.sector]) : f;
      const [bx, bz] = ctx.collide(door[0] + dir[0] * 28, door[1] + dir[1] * 28, 0.5);
      ctx.bus.emit("wave:breach", { x: bx, z: bz, count: 14 });
    }
    // The crowd presses on the defender's spot (door + 3 m): letting them crowd you drains the barricade (Builder B's measurement).
    ctx.bus.emit("horde:target", { x: door[0] + f[0] * 3, z: door[1] + f[1] * 3 });
    ctx.input.lock();
    setStep("hold");
    setBanner({ title: "Hold the door", sub: "Space to shove. Hold E to nail boards.", tone: "warn" }, 4500);
  };

  useEffect(() => {
    const playing = () => !["intro", "dawn", "inside", "suite", "visit", "result"].includes(stepRef.current);
    let progUnlockAt = 0;
    const ctx0 = ctxRef.current;
    if (ctx0) {
      const orig = ctx0.input.unlock.bind(ctx0.input);
      ctx0.input.unlock = () => {
        progUnlockAt = performance.now();
        orig();
      };
    }
    const kd = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      if (e.code === "KeyP" || (e.code === "Escape" && !document.pointerLockElement)) {
        if (pausedRef.current) setPaused(false);
        else if (playing()) {
          ctxRef.current?.input.unlock();
          setPaused(true);
        }
      }
    };
    const plc = () => {
      if (!document.pointerLockElement && playing() && !pausedRef.current && performance.now() - progUnlockAt > 300) setPaused(true);
    };
    window.addEventListener("keydown", kd);
    document.addEventListener("pointerlockchange", plc);
    return () => {
      window.removeEventListener("keydown", kd);
      document.removeEventListener("pointerlockchange", plc);
    };
  }, [district, hero]);

  // The director tick: runs every frame inside the loop. Reads game state through gRef, never closes over stale state.
  const tickRef = useRef<(dt: number) => void>(() => {});
  useEffect(() => {
    tickRef.current = (dt: number) => {
      void dt;
      const ctx = ctxRef.current;
      const g = gRef.current;
      if (!ctx || !hero) return;
      const p = ctx.player;
      const k = ctx.input.pressed;
      const s = stepRef.current;
      const here: Pt = [p.x, p.z];
      const heroDoor = doorOf(ctx, hero)!;
      const since = ctx.time - stepAt.current;

      // The dusk clock: at nightfall the streets fill up (arcade pressure; the agent's wave still waits for your report).
      if (!nightFallen.current && ctx.time > nightfallAt.current && (s === "office" || s === "suite" || s === "approach" || s === "inside")) {
        nightFallen.current = true;
        ctx.bus.emit("horde:ambient", { count: 40 });
        setBanner({ title: "Night has fallen", sub: "The streets are crawling. Get inside.", tone: "bad" }, 3500);
      }
      const fireDebris = () => {
        if (debrisFired.current) return;
        debrisFired.current = true;
        const zones = ctx.district.buildings
          .filter((b) => b.unfinished)
          .map((b) => ctx.colliderOf.get(b.pid))
          .filter((c): c is NonNullable<typeof c> => !!c && c.maxX > ctx.bounds.x0 && c.minX < ctx.bounds.x1 && c.maxZ > ctx.bounds.z0 && c.minZ < ctx.bounds.z1)
          .map((c) => ({ x: (c.minX + c.maxX) / 2, z: (c.minZ + c.maxZ) / 2, r: Math.max(c.maxX - c.minX, c.maxZ - c.minZ) / 2 + 6 }))
          .filter((zn) => !(stepRef.current === "hold" && dist([zn.x, zn.z], heroDoor) < zn.r + 8)); // not on the door you're holding
        const b = g.outcome ? ctx.byPid.get(g.outcome.pid_final) : hero;
        const mmi = b?.mmi ?? 7;
        ctx.bus.emit("fx:shake", { amp: Math.max(0.12, Math.min(0.6, (mmi - 5.5) * 0.17)), secs: 4 });
        ctx.bus.emit("mission:debris", { zones, secs: 7 });
        setBanner({ title: "Aftershock", sub: "Stay clear of the red zones: unfinished city retrofit orders (a game outcome).", tone: "bad" }, 5000);
      };

      if (downed.current) {
        downed.current = false;
        downedCount.current += 1;
        const o = objectivePoint(ctx);
        const at: Pt = s === "escape" || s === "hold" ? here : o?.at ?? heroDoor;
        [p.x, p.z] = s === "escape" || s === "hold" ? [p.x, p.z] : ctx.collide(at[0] + 2, at[1] + 2, 0.5);
        p.health = 60;
        ctx.bus.emit("horde:repel", { x: p.x, z: p.z, r: 18 });
        setBanner({ title: "You went down", sub: "Your squad dragged you clear.", tone: "bad" });
      }

      if (s === "intro") {
        // From all of LA down to tonight's district: 2.4 km up to 110 m over 16 s.
        const kk = Math.min(1, ctx.time / 16);
        const e = kk * kk * (3 - 2 * kk);
        const alt = 2400 * (1 - e) + 110 * e, rad = 1800 * (1 - e) + 170 * e, ang = ctx.time * 0.12;
        if (ctx.camera.far < 30000) {
          ctx.camera.far = 30000;
          ctx.camera.updateProjectionMatrix();
        }
        ctx.camera.position.set(hero.x + Math.sin(ang) * rad, alt, hero.z + Math.cos(ang) * rad);
        ctx.camera.lookAt(hero.x, 10, hero.z);
        if (k.has("Enter") && g.district) begin();
        return;
      }
      if (presenter && k.has("KeyF")) {
        // Fast-forward for the pitch: never changes what the agent is sent, only where the player stands / how long HOLD lasts.
        if (s === "approach") [p.x, p.z] = ctx.collide(heroDoor[0] + dirOf(hero.door?.facing ?? 180)[0] * 2, heroDoor[1] + dirOf(hero.door?.facing ?? 180)[1] * 2, 0.5);
        if (s === "escape" && fallbackPid) {
          const at = reachPoint(ctx, fallbackPid, here) ?? routeTo.current;
          if (at) [p.x, p.z] = ctx.collide(at[0], at[1], 0.5);
        }
        if (s === "hold") stepAt.current = ctx.time - DEFEND_MIN_S;
      }
      if ((s === "office" || s === "approach") && k.has("KeyC")) {
        // The nearer of a stale-entry case and a screened roof.
        const ns = staleRef.current.find((c) => Math.hypot(c.x - p.x, c.z - p.z) < 40);
        const near = solarRef.current.find((r) => Math.hypot(r.x - p.x, r.z - p.z) < 38);
        const dS = ns ? Math.hypot(ns.x - p.x, ns.z - p.z) : Infinity, dR = near ? Math.hypot(near.x - p.x, near.z - p.z) : Infinity;
        if (solarOpen || staleOpen) {
          setSolarOpen(null);
          setStaleOpen(null);
        } else if (ns && dS <= dR) {
          setStaleOpen(ns.pid);
          ctx.input.unlock();
        } else if (near) {
          setSolarOpen(near.pid);
          ctx.input.unlock();
        }
      }
      if (s === "visit") {
        if (k.has("KeyE") && visit) {
          const b = ctx.byPid.get(visit);
          if (b?.door) {
            const f = dirOf(b.door.facing);
            [p.x, p.z] = ctx.collide(b.door.x + f[0] * 2.5, b.door.z + f[1] * 2.5, 0.5);
            p.yaw = (b.door.facing * Math.PI) / 180;
          }
          p.frozen = false;
          p.hidden = false;
          ctx.input.lock();
          setVisit(null);
          setStep(visitFrom.current);
        }
        return;
      }
      if ((s === "office" || s === "approach") && k.has("KeyE")) {
        const other = ctx.district.buildings.find((b) => b.door && b.pid !== hero.pid && (s !== "office" || b.pid !== office?.pid) && dist(here, [b.door.x, b.door.z]) < DOOR_R);
        if (other) {
          g.loadDossier(other.pid);
          visitFrom.current = s;
          p.frozen = true;
          p.hidden = true;
          ctx.input.unlock();
          setVisit(other.pid);
          setHop(0);
          setStep("visit");
          return;
        }
      }
      if (s === "office" && office) {
        const od = doorOf(ctx, office)!;
        if (!briefAsked.current && !g.isLoading) briefAsked.current = g.say("Brief the night shift", true);
        const c7 = case7Ref.current;
        // The briefing came back without a case here: straight to the fortress.
        if (g.runDone && briefAsked.current && !c7 && since > 2) {
          g.select(hero.pid);
          ctx.bus.emit("world:beacon", { pid: hero.pid });
          setStep("approach");
          setBanner({ title: `Reach ${hero.label}`, sub: "The records disagree about its walls.", tone: "info" }, 4000);
          return;
        }
        if (c7 && !suiteAsked.current && g.runDone && (presenter || dist(here, od) < SCOUT_R)) {
          if (g.say(`Check suite ${c7.suite} at building ${office.pid}: is the tenant on record still there?`)) suiteAsked.current = true;
        }
        // The 2-minute stage cut (?demo=1): the agent works case #7 from the records while you head for case #6.
        if (presenter && suiteAsked.current) {
          g.select(hero.pid);
          ctx.bus.emit("world:beacon", { pid: hero.pid });
          setStep("approach");
          setBanner({ title: `Reach ${hero.label}`, sub: `HQ is working case #${c7?.n ?? ""} from the records while you go.`, tone: "info" }, 4000);
          return;
        }
        if (dist(here, od) < DOOR_R && k.has("KeyE") && suiteAsked.current) {
          p.frozen = true;
          p.hidden = true;
          ctx.input.unlock();
          setStep("suite");
        } else if (dist(here, od) < DOOR_R && k.has("KeyE")) {
          setBanner({ title: "HQ is still briefing", sub: "Give it a moment.", tone: "info" }, 1500);
        }
        return;
      }
      if (s === "suite" && office) {
        const t = suiteTipRef.current;
        const c7 = case7Ref.current;
        for (const [code, i] of [["Digit1", 0], ["Digit2", 1], ["Digit3", 2]] as const) if (k.has(code) && t.chosen === null) setSuiteTip({ chosen: i, sentAt: null });
        if (c7 && t.chosen !== null && t.sentAt === null && !suiteSending.current && g.runDone) {
          if (g.say(`Tip: ${suiteTips(String(c7.suite))[t.chosen]}`)) {
            suiteSending.current = true;
            setSuiteTip({ chosen: t.chosen, sentAt: g.messages.length });
          }
        }
        if (k.has("KeyE") && t.sentAt !== null && g.runDone) {
          const od = doorOf(ctx, office)!;
          const f = dirOf(office.door?.facing ?? 180);
          [p.x, p.z] = ctx.collide(od[0] + f[0] * 2.5, od[1] + f[1] * 2.5, 0.5);
          p.yaw = ((office.door?.facing ?? 180) * Math.PI) / 180;
          p.frozen = false;
          p.hidden = false;
          ctx.input.lock();
          // The agent's verdict decides whether the office on record is still here to be brought to safety.
          let lean: string | null = null;
          for (let i = g.messages.length - 1; i >= 0; i--) {
            const m = g.messages[i] as Msg;
            if (kind(m) !== "tool" || m.name !== "weigh_case") continue;
            const w = parse<{ property_id?: string; verdict?: { hypothesis?: string; label?: string } }>(m);
            if (String(w?.property_id) !== office.pid) continue;
            lean = w?.verdict?.hypothesis ?? null;
            break;
          }
          const n = Math.min(4, Math.max(1, Number(/(\d+)-person/.exec(c7?.stakes ?? "")?.[1] ?? 3)));
          // Tenant present = "still there" or "the listing is stale" (the suite was leased and the listing never came down).
          // The office comes with you only if the evidence leans present AND you didn't report the suite empty.
          const present = lean === "still_there" || lean === "listing_stale";
          if (present && t.chosen !== 0 && !officeSpawned.current) {
            officeSpawned.current = true;
            const names = ["Ana", "Ben", "Chen", "Dara"].slice(0, n);
            const spots = names.map((name, i) => {
              const [x, z] = ctx.collide(od[0] + f[0] * (3 + i), od[1] + f[1] * (3 + i) + (i % 2 ? 1.2 : -1.2), 0.5);
              return { id: `office-${i}`, x, z, name };
            });
            ctx.bus.emit("mission:survivors", { survivors: spots });
            setBanner({ title: "The office looks like it's still here", sub: `The listing may be out of date. Bring them to ${hero.label}.`, tone: "good" }, 4500);
          } else {
            setBanner({
              title: "Nobody to bring",
              sub: t.chosen === 0
                ? `The records list ${n} ${n === 1 ? "person" : "people"} in suite ${c7?.suite}; your report disagrees. HQ will flag it for a person to check.`
                : `The evidence doesn't settle it yet. HQ will flag suite ${c7?.suite} for a person to check.`,
              tone: "info",
            }, 5000);
          }
          g.select(hero.pid);
          ctx.bus.emit("world:beacon", { pid: hero.pid });
          setStep("approach");
        }
        return;
      }
      if (s === "approach") {
        if (office && !presenter && suiteTipRef.current.sentAt !== null) {
          // The long cross between the two real cases: sprint never runs dry, and the route is drawn (Night Shift, ~3 min).
          p.stamina = Math.max(p.stamina, 0.6);
          if (dist(here, heroDoor) > 12) ctx.bus.emit("world:route", { pts: [here, heroDoor] });
          else ctx.bus.emit("world:route", { pts: null });
        }
        if (!scoutAsked.current && dist(here, heroDoor) < SCOUT_R && g.phase === "dusk") {
          scoutAsked.current = true;
          if (g.selected !== hero.pid) g.select(hero.pid);
        }
        if (!agentOff && scoutAsked.current && !scoutStarted.current && g.selected === hero.pid && g.phase === "dusk" && !g.isLoading) {
          scoutStarted.current = true;
          g.startScout(!briefAsked.current);
        }
        if (dist(here, heroDoor) < DOOR_R && k.has("KeyE")) {
          ctx.bus.emit("mission:shelter", { pid: hero.pid, x: heroDoor[0], z: heroDoor[1] });
          setHop(0);
          setProg((q) => ({ ...q, reached: true }));
          p.frozen = true;
          p.hidden = true;
          ctx.input.unlock();
          setStep("inside");
        }
        return;
      }
      if (s === "inside") {
        const t = tipRef.current;
        for (const [code, i] of [["Digit1", 0], ["Digit2", 1], ["Digit3", 2]] as const) if (k.has(code) && t.chosen === null) setTip({ chosen: i, sentAt: null });
        // Send the chosen answer once the scout run has finished (exactly once: the loop outruns React).
        if (agentOff && t.chosen !== null && t.sentAt === null) {
          setTip({ chosen: t.chosen, sentAt: 0 });
          setProg((q) => ({ ...q, checked: true }));
        }
        if (!agentOff && t.chosen !== null && t.sentAt === null && !tipSending.current && g.phase === "scout" && g.scoutDone && !g.isLoading) {
          tipSending.current = true;
          g.sendTip(TIP_TEXTS[t.chosen]);
          setTip({ chosen: t.chosen, sentAt: g.messages.length });
          setProg((q) => ({ ...q, checked: true }));
        }
        const scoutBusy = g.phase === "scout" && !g.scoutDone;
        // A report is required before the night: the replay covers scout -> tip -> wave, in that order.
        const tipBusy = (!!hero.conflict && t.chosen === null) || (t.chosen !== null && (t.sentAt === null || g.isLoading));
        if (k.has("KeyE") && (agentOff || (!tipBusy && !scoutBusy && g.phase !== "dusk"))) {
          // Step out: the night begins.
          [p.x, p.z] = ctx.collide(heroDoor[0] + dirOf(hero.door?.facing ?? 180)[0] * 2.5, heroDoor[1] + dirOf(hero.door?.facing ?? 180)[1] * 2.5, 0.5);
          {
            const facing = hero.door?.facing ?? 180;
            const w1 = g.district?.waves.find((x) => x.n === 1);
            let d = w1 ? ((SECTOR_DEG[w1.sector] - facing + 540) % 360) - 180 : 0;
            d = Math.max(-80, Math.min(80, d));
            p.yaw = ((facing + d) * Math.PI) / 180; // toward the horde's side, never into the wall
          }
          p.frozen = false;
          p.hidden = false;
          ctx.input.lock();
          setStep("night");
        }
        return;
      }
      if (s === "night") {
        if (!nightAsked.current && g.phase !== "night" && g.phase !== "aftershock" && !g.isLoading) {
          const at = agentOff ? hero.pid : g.startNight(1);
          if (at) {
            nightAsked.current = true;
            const w = g.district?.waves.find((x) => x.n === 1);
            if (w) {
              ctx.bus.emit("wave:start", { n: 1, sector: w.sector, size: w.size, targetX: heroDoor[0], targetZ: heroDoor[1] });
              ctx.bus.emit("horde:target", { x: heroDoor[0], z: heroDoor[1] });
              setBanner({ title: "Night 1", sub: `The horde is coming from the ${SECTOR_NAME[w.sector] ?? w.sector}.`, tone: "warn" }, 4000);
            }
          }
        }
        if (agentOff) {
          if (k.has("KeyR")) startEscape(ctx, false);
          else if (k.has("KeyH")) startDefend(ctx, heroDoor);
          return;
        }
        if (!g.decision && !g.outcome) {
          if (k.has("KeyH")) g.decide("hold");
          else if (k.has("KeyR")) g.decide("run");
        }
        if (g.decision) {
          if (g.decision.action === "run") {
            ctx.bus.emit("mission:evacuate", { x: heroDoor[0], z: heroDoor[1] });
            startEscape(ctx, false);
          } else startDefend(ctx, heroDoor);
        }
        return;
      }
      if (s === "hold") {
        // Defend the door: stay within 5 m of it.
        const dd = dist(here, heroDoor);
        if (dd > 5) {
          p.x = heroDoor[0] + ((p.x - heroDoor[0]) / dd) * 5;
          p.z = heroDoor[1] + ((p.z - heroDoor[1]) / dd) * 5;
        }
        if (since > 12) fireDebris();
        // When the roll says the walls hold, the barricade doesn't visibly break (keep it above 15).
        if (g.outcome?.held && ctx.mission.barricade.active) ctx.mission.barricade.hp = Math.max(ctx.mission.barricade.hp, 15);
        // When the roll says the walls fail, the barricade gives way over the last 5 s (the code roll, made visible).
        if (g.outcome && !g.outcome.held && since > DEFEND_MIN_S - 5 && ctx.mission.barricade.active) {
          ctx.mission.barricade.hp = Math.max(0, ctx.mission.barricade.hp - 22 * dt);
        }
        if ((g.outcome || agentOff) && since > DEFEND_MIN_S && !defendEnded.current) {
          defendEnded.current = true;
          const held = !!g.outcome?.held;
          ctx.bus.emit("mission:defend-end", { held });
          ctx.bus.emit("world:barricade", { pid: null });
          if (held) {
            setBanner({ title: "The walls held.", sub: `${labelOf(g.outcome?.pid_final)} kept them out.`, tone: "good" });
            setStep("result");
          } else {
            const f = dirOf(hero.door?.facing ?? 180);
            [p.x, p.z] = ctx.collide(heroDoor[0] + f[0] * 3, heroDoor[1] + f[1] * 3, 0.5);
            p.yaw = ((hero.door?.facing ?? 180) * Math.PI) / 180;
            ctx.bus.emit("wave:breach", { x: heroDoor[0], z: heroDoor[1], count: 24 });
            ctx.bus.emit("mission:evacuate", { x: heroDoor[0], z: heroDoor[1] });
            startEscape(ctx, true);
          }
        }
        return;
      }
      if (s === "escape") {
        const to = routeTo.current;
        if (to) ctx.bus.emit("world:route", { pts: [here, to] });
        // Adrenaline: the real route goes around a city block (about 356 m on the demo night), so sprint never runs dry.
        p.stamina = Math.max(p.stamina, 0.6);
        if (since > 8) fireDebris();
        // Arrived = next to the fallback's outline anywhere (the route may end on a different side than `to`).
        const fc = fallbackPid ? ctx.colliderOf.get(fallbackPid) : undefined;
        const atFallback = !!fc && closestOnPoly(p.x, p.z, fc.pts).d < 4.2; // C's multi-goal route ends within 3.5 m of the outline
        if ((to && (dist(here, to) < DOOR_R + 1 || atFallback)) || (!to && since > 25)) {
          if (to) ctx.bus.emit("mission:shelter", { pid: fallbackPid ?? "", x: to[0], z: to[1] });
          p.frozen = true;
          p.hidden = true;
          ctx.bus.emit("world:route", { pts: null });
          ctx.bus.emit("world:barricade", { pid: fallbackPid });
          setBanner({ title: to ? `Inside ${labelOf(fallbackPid)}` : "You made it.", sub: "Doors shut.", tone: "good" });
          setStep("safe");
        }
        return;
      }
      if (s === "safe") {
        if ((g.outcome || agentOff) && since > 3) setStep("result");
        return;
      }
      if (s === "result" || s === "dawn") ctx.input.unlock(); // the dawn buttons must be clickable
      if (s === "result") {
        if (!shockFired.current && g.outcome) {
          shockFired.current = true;
          const quakeOk = g.outcome.quake_roll <= Math.min(95, g.outcome.quake + 40);
          if (!quakeOk) ctx.bus.emit("fx:crack", { pid: g.outcome.pid_final });
          const why = (g.outcome.why ?? "").split("; ").find((x) => x.startsWith("aftershock")) ?? "";
          setBanner({ title: quakeOk ? "The building rode out the aftershock" : "The building cracked", sub: why.replace(/\.\s*Game outcome.*$/, ""), tone: quakeOk ? "info" : "bad" }, 4500);
        }
        if (since > 5) {
          ctx.bus.emit("horde:clear", {});
          if (!agentOff) g.goDawn();
          // The AI drafts tonight's corrections live (citing your reports) while dawn comes up.
          if (!agentOff && !g.stub && !debriefAsked.current && (g.district?.features ?? []).includes("debrief")) debriefAsked.current = true;
          const m = ctx.mission;
          const saved = m.survivors.filter((v) => v.state === "safe").length;
          const total = m.survivors.length;
          const secs = Math.round(ctx.time - startedAt.current);
          // Records verified (your reports logged as evidence on real cases) count most; then the people you brought in.
          const verified = (tipRef.current.sentAt !== null ? 1 : 0) + (suiteTipRef.current.sentAt !== null ? 1 : 0) + sweepRef.current.right + solarRightRef.current;
          const points = Math.max(0, verified * 300 + saved * 150 + m.found * 40 + Math.round(p.health) * 2 + Math.max(0, 300 - secs) - downedCount.current * 100);
          const rank = points >= 900 ? "S" : points >= 700 ? "A" : points >= 450 ? "B" : "C";
          setScore({ saved, total, found: m.found, health: p.health, secs, points, rank, downed: downedCount.current });
          setProg((q) => ({ ...q, survived: true }));
          setStep("dawn");
        }
        return;
      }
      if (s === "dawn") {
        ctx.dawn = Math.min(1, ctx.dawn + dt / 3);
        if (debriefAsked.current && !debriefSent.current && g.runDone && g.say("Debrief the night shift")) debriefSent.current = true;
        if (k.has("Enter")) playAgain();
      }
    };
  });

  // HUD snapshot (10 Hz) + feed captions.
  const hudRef = useRef<() => void>(() => {});
  useEffect(() => {
    hudRef.current = () => {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const p = ctx.player;
      const o = objectivePoint(ctx);
      const here: Pt = [p.x, p.z];
      const st0 = stepRef.current;
      {
        const free = st0 === "office" || st0 === "approach";
        const near = free ? solarRef.current.find((r) => Math.hypot(r.x - p.x, r.z - p.z) < 38) ?? null : null;
        setNearSolar((v) => (v === (near?.pid ?? null) ? v : near?.pid ?? null));
        const ns = free ? staleRef.current.find((c) => Math.hypot(c.x - p.x, c.z - p.z) < 40) ?? null : null;
        setNearStale((v) => (v === (ns?.pid ?? null) ? v : ns?.pid ?? null));
      }
      const visitDoor = (st0 === "office" || st0 === "approach") && hero
        ? ctx.district.buildings.find((b) => b.door && b.pid !== hero.pid && (st0 !== "office" || b.pid !== office?.pid) && dist(here, [b.door.x, b.door.z]) < DOOR_R) ?? null
        : null;
      setNearVisit((v) => (v === (visitDoor?.label ?? null) ? v : visitDoor?.label ?? null));
      // Walking past a building with real aerial imagery on file: show it in the camera slot (labelled as such).
      if (!ctx.stub && (st0 === "office" || st0 === "approach" || st0 === "night" || st0 === "escape") && ctx.time - nearAt.current > 4) {
        let best: { pid: string; label: string; d: number } | null = null;
        for (const b of ctx.district.buildings) {
          const d = Math.hypot(b.x - p.x, b.z - p.z);
          if (d < 60 && (!best || d < best.d)) best = { pid: b.pid, label: b.label, d };
        }
        if (best?.pid !== nearPid.current) {
          nearPid.current = best?.pid ?? null;
          nearAt.current = ctx.time;
          const ds = best ? gRef.current.dossiers[best.pid] : undefined;
          if (best && !ds) gRef.current.loadDossier(best.pid);
          const img = ds && ds !== "loading" && ds !== "error" ? ds.images.drone?.[0] : undefined;
          const next = best && img ? { src: evidenceUrl(img), caption: `Nearby aerial: ${best.label}` } : null;
          nearPhotoOn.current = !!next;
          setNearPhoto(next);
          if (best && !img) nearPid.current = null; // retry once its dossier arrives
        }
      }
      const nearDoor = (st0 === "approach" && !!hero && dist(here, doorOf(ctx, hero)!) < DOOR_R) || (st0 === "office" && !!office && dist(here, doorOf(ctx, office)!) < DOOR_R);
      const n = ctx.horde.nearest;
      const threat = n < 12 ? 3 : n < 35 ? 2 : ctx.horde.alive > 0 ? 1 : 0;
      const hx = ctx.horde.nearestX, hz = ctx.horde.nearestZ;
      const yawDeg0 = (((p.yaw * 180) / Math.PI) % 360 + 360) % 360;
      const threatDir = Number.isFinite(hx) && Number.isFinite(hz) && Math.hypot(hx - p.x, hz - p.z) < 25 && !p.hidden
        ? ((bearing(here, [hx, hz]) - yawDeg0 + 540) % 360) - 180
        : null;
      setHud({
        health: p.health,
        stamina: p.stamina,
        yawDeg: (((p.yaw * 180) / Math.PI) % 360 + 360) % 360,
        threat,
        threatDir,
        nearDoor,
        target: o ? { label: o.label, bearingDeg: bearing(here, o.at), dist: dist(here, o.at) } : null,
      });
      const m = ctx.mission;
      const st = stepRef.current;
      const left = nightfallAt.current - ctx.time;
      const timer = st === "office" || st === "suite" || st === "approach" || st === "inside" ? (nightFallen.current ? { label: "Night has fallen", secs: 0, urgent: true } : { label: "Nightfall", secs: Math.max(0, Math.round(left)), urgent: left < 30 }) : null;
      const next = { flares: m.flares, boards: m.boards, medkits: m.medkits, found: m.found, crates: cratesTotal.current, survivors: m.survivors.map((v) => ({ name: v.name, state: v.state })), barricade: m.barricade.active ? { hp: Math.round(m.barricade.hp), max: m.barricade.max } : null, timer };
      setMhud((c) => (JSON.stringify(c) === JSON.stringify(next) ? c : next));
      const f = feedsRef.current;
      if (f) {
        const nightish = st === "night" || st === "hold" || st === "escape";
        f.setOverride("cctv", cctvPhotoOn.current || nearPhotoOn.current || (nightish && window.innerWidth < 1366));
      }
      if (f) setFeedCaps((c) => (c.drone === f.caption("drone") && c.cctv === f.caption("cctv") ? c : { drone: f.caption("drone"), cctv: f.caption("cctv") }));
    };
  });

  // ------------------------------------------------------------------ reactions to the agent stream
  // (The scout is started from the loop: an effect keyed on the `game` prop never re-ran on night 2, when the dossier
  // was cached and nothing re-rendered the parent.)

  // The roll is the night's reveal: the radio, HQ panel and moments don't see commit_plan's result (or anything after it)
  // until the result step. The director itself still reads game.outcome to run the night.
  const revealed = step === "result" || step === "dawn";
  const shownMessages = useMemo(() => {
    if (revealed) return game.messages;
    const idx = game.messages.findIndex((m) => kind(m as Msg) === "tool" && (m as Msg).name === "commit_plan");
    if (idx < 0) return game.messages;
    // Keep the answer's slot (so HQ stops "waiting for your call"), hide what it says until the reveal.
    const placeholder = { ...(game.messages[idx] as Msg), type: "tool", content: "Orders received." };
    return [...game.messages.slice(0, idx), placeholder];
  }, [game.messages, revealed]);

  // New radio lines go on the bus (spoken + crackle by the audio system).
  const radioSeen = useRef(0);
  const radioNow = useMemo(() => radioLines(shownMessages), [shownMessages]);
  useEffect(() => {
    const ctx = ctxRef.current;
    if (radioNow.length < radioSeen.current) radioSeen.current = 0; // play again: a fresh thread
    // While a run streams, hold back the newest line (it may still be growing); it goes out when the run ends.
    const upto = game.isLoading ? Math.max(radioSeen.current, radioNow.length - 1) : radioNow.length;
    for (const l of radioNow.slice(radioSeen.current, upto)) ctx?.bus.emit("radio:line", { who: l.who, text: l.text, tone: l.tone });
    radioSeen.current = upto;
  }, [radioNow, game.isLoading]);

  // The walls settle as the agent weighs the case.
  const wallsNote = useMemo(() => {
    if (!hero) return null;
    for (let i = game.messages.length - 1; i >= 0; i--) {
      const m = game.messages[i] as Msg;
      if (kind(m) !== "tool" || m.name !== "weigh_case") continue;
      const w = parse<{ property_id?: string; verdict?: { text?: string; label?: string; confidence?: number } }>(m);
      if (String(w?.property_id) !== hero.pid) continue;
      const v = w?.verdict;
      return v?.text ? `${v.text}${typeof v.confidence === "number" ? ` (${v.confidence.toFixed(2)})` : ""}` : null;
    }
    return null;
  }, [game.messages, hero]);
  // After each verdict on the fortress, ask the server for the walls recomputed with the checks so far (and your report).
  const heroWeighs = useMemo(() => (hero ? game.messages.filter((m) => kind(m as Msg) === "tool" && (m as Msg).name === "weigh_case" && String(parse<{ property_id?: string }>(m as Msg)?.property_id) === hero.pid).length : 0), [game.messages, hero]);
  const { refreshDossier } = game;
  useEffect(() => {
    if (hero && heroWeighs > 0) refreshDossier(hero.pid, checksFor(game.messages, hero.pid));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [heroWeighs, hero, refreshDossier]);
  const heroRoofD = hero ? game.dossiers[hero.pid] : undefined;
  const heroRoof = heroRoofD && heroRoofD !== "loading" && heroRoofD !== "error" ? heroRoofD.roof ?? null : null;
  useEffect(() => {
    if (hero && heroRoof) roofRef.current?.setRoof(hero.pid, heroRoof);
  }, [hero, heroRoof]);
  const lean = hero ? game.conflictMaterials[hero.pid] ?? null : null;
  useEffect(() => {
    if (hero) ctxRef.current?.bus.emit("world:lean", { pid: hero.pid, material: lean });
  }, [hero, lean]);

  // The agent's own vision checks pop up for 10 s: the real aerial it read for case #6 (drone slot), and the real
  // Matterport tour of suite 1100 it read for case #7 (camera slot), so the judge sees the evidence even when the player
  // isn't standing there (the stage cut never walks case #7).
  const lastPhotoId = useRef<string | null>(null);
  const photoTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => photoTimers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!hero) return;
    for (let i = game.messages.length - 1; i >= 0; i--) {
      const m = game.messages[i] as Msg;
      if (kind(m) !== "tool" || m.name !== "check_evidence") continue;
      const r = parse<{ property_id?: string; suite?: string; images?: string[]; callout?: string; finding?: string }>(m);
      const pid = String(r?.property_id ?? hero.pid);
      if (!r?.images?.length || (pid !== hero.pid && pid !== office?.pid)) continue;
      const id = String(m.id ?? i);
      if (id === lastPhotoId.current) return;
      lastPhotoId.current = id;
      const slot = pid === hero.pid ? "drone" : "cctv";
      const photo = slot === "drone"
        ? { src: evidenceUrl(r.images[0]), caption: `HQ looked from above: ${r.callout || r.finding || "aerial"}` }
        : { src: evidenceUrl(r.images[0]), caption: `HQ looked inside${case7?.suite ? ` suite ${case7.suite}` : ""}: ${r.callout || r.finding || "its 3D scan"}` };
      (slot === "drone" ? setDronePhoto : setCctvPhoto)(photo);
      feedsRef.current?.setOverride(slot, true);
      // Not cleared when messages change (the old cleanup did that, so the photo never went away).
      photoTimers.current.push(setTimeout(() => {
        (slot === "drone" ? setDronePhoto : setCctvPhoto)(null);
        feedsRef.current?.setOverride(slot, false);
      }, 10_000));
      return;
    }
  }, [game.messages, hero, office, case7]);

  // ------------------------------------------------------------------ actions
  function begin() {
    const ctx = ctxRef.current;
    if (!ctx || !hero) return;
    ctx.camera.far = 4000; // street level again (the city map stays as the skyline beyond the play area)
    ctx.camera.updateProjectionMatrix();
    ctx.cameraOwner = "player";
    ctx.player.frozen = false;
    ctx.input.lock();
    ctx.bus.emit("horde:ambient", { count: 14 });
    const door = doorOf(ctx, hero)!;
    const plan = planMission(ctx, hero.pid, door, [ctx.player.x, ctx.player.z]);
    plan.survivors = []; // survivors are the office on record (case #7), spawned only if the agent says they're still there
    cratesTotal.current = plan.supplies.length;
    ctx.bus.emit("mission:setup", plan);
    ctx.mission.flares = 3;
    downedCount.current = 0;
    for (const sv of plan.survivors) ctx.bus.emit("horde:pack", { x: sv.x, z: sv.z, count: 4 });
    nightfallAt.current = ctx.time + NIGHTFALL_S;
    if (!ctx.stub && !staleRef.current.length) {
      fetch("/api/game/stale").then((r) => (r.ok ? r.json() : null)).then((d: { cases?: StaleCase[] } | null) => d?.cases && setStale(d.cases)).catch(() => {});
    }
    if (!ctx.stub && !solarRef.current.length) {
      fetch("/api/game/solar").then((r) => (r.ok ? r.json() : null)).then((d: { roofs?: SolarRoof[] } | null) => d?.roofs && setSolar(d.roofs)).catch(() => {});
    }
    nightFallen.current = false;
    startedAt.current = ctx.time;
    if (office) {
      // The Night Shift: the agent briefs the night from the real queue (fresh thread), then case #7 at the office.
      briefAsked.current = gRef.current.say("Brief the night shift", true);
      gRef.current.select(office.pid);
      ctx.bus.emit("world:beacon", { pid: office.pid });
      setStep("office");
      setBanner({ title: "Settle tonight's cases. Make it to dawn.", sub: `HQ is picking tonight's cases from the open-case queue. Start at ${office.label}.`, tone: "info" }, 5500);
      return;
    }
    gRef.current.select(hero.pid); // the fortress card loads while you walk
    setStep("approach");
    setBanner({ title: `Reach ${hero.label}`, sub: "The records disagree about its walls. Find out before dark.", tone: "info" }, 5000);
  }

  const resetting = useRef(false);
  function playAgain() {
    if (resetting.current) return;
    if (game.stub || agentOff) return startOver();
    // Clear people's notes first (night 1's reports would change night 2's evidence, and strict replay would miss).
    const replaying = !!replay && !replay.startsWith("recording");
    resetting.current = true;
    fetch("/api/game/demo/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: "reset" }) })
      .then((r) => r.ok)
      .catch(() => false)
      .then((ok) => {
        resetting.current = false;
        if (ok || !replaying) startOver();
        else setBanner({ title: "Replay mode: reset first", sub: "Operator: run scripts/demo_reset.py, then reload this page for a fresh night.", tone: "warn" }, 8000);
      });
  }

  function startOver() {
    const ctx = ctxRef.current;
    if (!ctx || !hero) return;
    photoTimers.current.forEach(clearTimeout);
    photoTimers.current = [];
    lastPhotoId.current = null;
    setDronePhoto(null);
    setCctvPhoto(null);
    feedsRef.current?.setOverride("drone", false);
    feedsRef.current?.setOverride("cctv", false);
    gRef.current.reset();
    scoutAsked.current = false;
    scoutStarted.current = false;
    nightAsked.current = false;
    shockFired.current = false;
    tipSending.current = false;
    debrisFired.current = false;
    defendEnded.current = false;
    briefAsked.current = false;
    suiteAsked.current = false;
    suiteSending.current = false;
    officeSpawned.current = false;
    debriefAsked.current = false;
    debriefSent.current = false;
    setSuiteTip({ chosen: null, sentAt: null });
    setSweep({ stamped: 0, right: 0 });
    setSolarStamps({});
    setStaleStamps({});
    setStaleOpen(null);
    setSolarOpen(null);
    setProg({ reached: false, checked: false, survived: false, filed: false });
    ctx.bus.emit("mission:reset", {});
    routeTo.current = null;
    setTip({ chosen: null, sentAt: null });
    ctx.dawn = 0;
    ctx.bus.emit("horde:clear", {});
    ctx.bus.emit("world:route", { pts: null });
    ctx.bus.emit("world:barricade", { pid: null });
    ctx.bus.emit("world:beacon", { pid: hero.pid });
    const first = office && !presenter ? office : hero;
    const door = doorOf(ctx, first)!;
    const sp = spawnFor(ctx, door, first.door?.facing ?? 180);
    Object.assign(ctx.player, { x: sp.at[0], z: sp.at[1], yaw: sp.yaw, health: 100, stamina: 1, frozen: false, hidden: false });
    setTimeout(() => begin(), 0);
  }

  // ------------------------------------------------------------------ render
  if (!district) {
    return (
      <main style={{ position: "fixed", inset: 0, display: "grid", placeItems: "center", background: "#05070d", color: "#cbd5e1" }}>
        {game.districtError ? (
          <p>
            The agent server didn&apos;t answer ({game.districtError}). <a href="/play?mode=foot&stub=1">Try synthetic data</a>.
          </p>
        ) : (
          <p>Loading the district…</p>
        )}
      </main>
    );
  }

  const radio = radioNow;
  const heroDossier = game.dossier && game.dossier !== "loading" && game.dossier !== "error" ? game.dossier : null;
  const insideFaces = heroDossier?.images.inside?.length ? heroDossier.images.inside : heroDossier?.images.pano ?? [];
  const runLabel = fallbackPid ? labelOf(fallbackPid) : null;

  const hints: Hint[] = [];
  // Movement and the full controls live in the pause menu; the HUD only shows what matters right now (menu hint last).
  if (step === "approach" && hud.nearDoor) hints.push({ key: "E", label: `go inside ${heroLabel}` });
  if ((step === "office" || step === "approach") && nearStale && !staleOpen) hints.push({ key: "C", label: "Optional: same building?" });
  if ((step === "office" || step === "approach") && nearSolar && !solarOpen) hints.push({ key: "C", label: "Optional: survey the roof for solar" });
  if ((step === "office" || step === "approach") && nearVisit) hints.push({ key: "E", label: `Optional: look inside ${nearVisit}` });
  if (step === "office" && hud.nearDoor && office) hints.push({ key: "E", label: `go up to suite ${case7?.suite ?? ""} at ${office.label}` });
  if (step === "night" && !game.decision) hints.push({ key: "H", label: "hold" }, { key: "R", label: runLabel ? `run to ${runLabel}` : "run", disabled: !runLabel });
  if (step === "hold") hints.push({ key: "E", label: mhud.boards > 0 ? `nail boards (${mhud.boards})` : "no boards left", disabled: mhud.boards === 0 });


  if (step === "dawn") hints.push({ key: "Enter", label: "play again" });
  if (step !== "intro" && step !== "dawn") hints.push({ key: "P", label: "menu" });

  const objective =
    step === "office" ? (case7 ? `Case #${case7.n}: look inside suite ${case7.suite} at ${office?.label ?? "the office"}` : "HQ is picking tonight's cases…")
    : step === "suite" ? "Is anyone still working here?"
    : step === "approach" ? `Reach ${heroLabel}`
    : step === "inside" ? "Look at the walls. Tell HQ what you see."
    : step === "night" ? (game.decision ? "Orders sent" : game.proposal ? "Make the call: hold or run" : "HQ is weighing hold or run…")
    : step === "hold" ? (game.decideError ?? "Hold the door")
    : step === "escape" ? (runLabel ? `Run to ${runLabel}` : "Survive until dawn")
    : step === "safe" ? (game.decideError ?? "Doors shut. Wait for it.")
    : step === "result" ? "The night is decided"
    : step === "dawn" ? "Dawn" : "";

  const saved = mhud.survivors.filter((v) => v.state === "safe").length;
  const withYou = mhud.survivors.filter((v) => v.state === "following").length;
  const case7Weighed = !!office && game.messages.some((m) => {
    if (kind(m as Msg) !== "tool" || (m as Msg).name !== "weigh_case") return false;
    return String(parse<{ property_id?: string }>(m as Msg)?.property_id) === office.pid;
  });
  const caseTag = (c: NightCase | null) => (c ? `Case #${c.n}${queueTotal ? ` of ${queueTotal}` : ""}: ` : "");
  const objectives: Objective[] = [
    ...(office
      ? [presenter
          ? { id: "case7", kind: "main" as const, text: `${caseTag(case7)}HQ works it from the records`, done: case7Weighed }
          : { id: "case7", kind: "main" as const, text: `${caseTag(case7)}${case7?.suite ? `look inside suite ${case7.suite} at ${office.label}` : `check the office at ${office.label}`}`, done: suiteTip.sentAt !== null }]
      : []),
    { id: "reach", kind: "main", text: `${caseTag(case6)}reach ${heroLabel}`, done: prog.reached },
    { id: "walls", kind: "main", text: "Look at its walls from inside", done: prog.checked },
    { id: "night", kind: "main", text: "Survive the night: hold or run", done: prog.survived },
    { id: "report", kind: "main", text: "File the reports at dawn", done: prog.filed },
    ...(mhud.survivors.length
      ? [{ id: "survivors", kind: "side" as const, text: "Bring the office's people to safety", done: saved === mhud.survivors.length, progress: `${saved + withYou}/${mhud.survivors.length}` }]
      : []),
    ...(sweep.stamped ? [{ id: "sweep", kind: "side" as const, text: "Sweep the suites on record", done: false, progress: `${sweep.right} right of ${sweep.stamped}` }] : []),
    ...(stale.some((c) => c.x > -500 && c.x < 140 && c.z > -300 && c.z < 200) ? [{ id: "stale", kind: "side" as const, text: "Same building? Check the city's list", done: stale.some((c) => staleStamps[c.pid]), progress: `${Object.keys(staleStamps).length} checked` }] : []),
    ...(stale.length ? [{ id: "stale-more", kind: "side" as const, text: `${stale.length} more "same building?" cases across LA, in the auditor`, done: false }] : []),
    ...(solar.length ? [{ id: "solar", kind: "side" as const, text: "Survey roofs for solar", done: Object.keys(solarStamps).length >= solar.length, progress: `${Object.keys(solarStamps).length}/${solar.length}` }] : []),
    { id: "crates", kind: "side", text: "Find boards for the barricade", done: mhud.crates > 0 && mhud.found >= mhud.crates, progress: `${mhud.found}/${mhud.crates}` },
  ];

  const decision =
    step === "night"
      ? {
          prompt: game.proposal ? `HQ proposes: ${game.proposal.action === "run" ? `run to ${labelOf(game.proposal.to_pid ?? fallbackPid)}` : `hold ${heroLabel}`}.` : game.isLoading ? "HQ is weighing hold or run…" : "HQ didn't call it. Your call.",
          proposed: game.proposal?.action ?? null,
          runLabel,
          sent: game.decision ? `Orders sent: ${game.decision.action === "run" ? `run to ${labelOf(game.decision.to_pid)}` : game.decision.action === "hold" ? "hold" : "none, holding"}` : null,
          error: game.decideError,
        }
      : null;

  const insideMode: InsideMode = "look";
  const showInside = (step === "inside" && !!hero) || (step === "suite" && !!office) || (step === "visit" && !!visit);
  const visitB = visit ? district?.buildings.find((b) => b.pid === visit) ?? null : null;
  const visitD = visit ? game.dossiers[visit] : undefined;
  const visitBase = visitD && visitD !== "loading" && visitD !== "error" ? visitD : null;
  const hops = (step === "visit" ? visitBase?.images.inside_hops : step === "inside" && heroDossier ? heroDossier.images.inside_hops : undefined) ?? [];
  const hopNow = hops.length ? hops[Math.min(hop, hops.length - 1)] : null;
  const insideMesh = (step === "visit" ? visitBase?.images.inside_mesh : step === "inside" && heroDossier ? heroDossier.images.inside_mesh : null) ?? null;
  const visitFaces = hopNow && step === "visit" ? hopNow.faces : visitBase?.images.inside ?? visitBase?.images.pano ?? [];
  const officeDossier = office ? game.dossiers[office.pid] : undefined;
  const officeFaces = officeDossier && officeDossier !== "loading" && officeDossier !== "error" ? officeDossier.images.inside ?? officeDossier.images.pano ?? [] : [];
  const suiteStatus =
    suiteTip.chosen === null ? (game.isLoading ? "HQ is checking the lease and the listing. Look around." : "HQ weighs your report with the records.")
    : suiteTip.sentAt === null ? "Your report goes when the radio is clear."
    : game.isLoading ? "Sent. HQ is weighing it." : "HQ logged your report.";
  const exitAllowed = step === "inside" && (agentOff || (game.phase !== "dusk" && !(game.phase === "scout" && !game.scoutDone) && !(!!hero?.conflict && tip.chosen === null) && !(tip.chosen !== null && (tip.sentAt === null || game.isLoading))));
  const tipStatus =
    tip.chosen === null ? "HQ weighs your report with the records."
    : tip.sentAt === null ? "Your report goes when the radio is clear."
    : game.isLoading ? "Sent. HQ is weighing it." : "HQ logged your report.";

  const verifiedN = (tip.sentAt !== null ? 1 : 0) + (suiteTip.sentAt !== null ? 1 : 0);
  const outcomeLines = [
    ...(presenter && case7 && case7Weighed ? [`Case #${case7.n}: HQ worked it from the records while you ran.`] : []),
    ...(Object.keys(staleStamps).length ? [`"Same building?": ${stale.filter((c) => staleStamps[c.pid] === c.answer).length} of ${Object.keys(staleStamps).length} stamps match the records.`] : []),
    ...(Object.keys(solarStamps).length ? [`Solar roofs: ${solar.filter((r) => solarStamps[r.pid] === r.answer).length} of ${Object.keys(solarStamps).length} stamped as the screen says.`] : []),
    ...(sweep.stamped ? [`Suite sweep: ${sweep.right} of ${sweep.stamped} stamps match what the records support.`] : []),
    ...(verifiedN ? [`${verifiedN} case${verifiedN === 1 ? "" : "s"} checked tonight${queueTotal ? `, of ${queueTotal} open` : ""}. Your report${verifiedN === 1 ? " is" : "s are"} evidence in ${verifiedN === 1 ? "it" : "them"} now.`] : []),
    ...(step === "dawn" && score.downed > 0 ? [`You went down ${score.downed}× (−${score.downed * 100} points). Your squad dragged you clear each time.`] : []),
    ...(game.outcome ? (game.outcome.why ?? "").split("; ").map((x) => x.replace(/\.\s*Game outcome.*$/, "")) : []),
  ];

  hopCount.current = hops.length;
  return (
    <main style={{ position: "fixed", inset: 0, background: "#05070d", overflow: "hidden" }}>
      <div ref={wrapRef} style={{ position: "absolute", inset: 0 }} />
      {step !== "intro" && step !== "dawn" && !showInside && (
        <FootHud
          objective={objective}
          banner={banner}
          hints={hints}
          health={hud.health}
          stamina={hud.stamina}
          radio={radio}
          busy={game.isLoading}
          dossier={game.dossier}
          wallsNote={wallsNote}
          heroLabel={heroLabel}
          decision={decision}
          compass={{ yawDeg: hud.yawDeg, waveSector: step === "night" || step === "escape" || step === "hold" ? game.wave?.sector ?? null : null, target: hud.target }}
          threat={hud.threat}
          threatDir={hud.threatDir}
          feeds={{ drone: { caption: feedCaps.drone, photo: dronePhoto }, cctv: { caption: feedCaps.cctv, photo: cctvPhoto ?? nearPhoto } }}
          badges={{ stub: game.stub, replay }}
          disclaimer={DISCLAIMER}
          attribution={district.attribution ?? null}
          objectives={objectives.filter((o) => o.kind === "main" && !o.done).slice(0, 1)}
          timer={mhud.timer}
          supplies={{ boards: mhud.boards, medkits: mhud.medkits, flares: mhud.flares }}
          survivors={mhud.survivors}
          barricade={mhud.barricade}
          hq={<HqPanel messages={shownMessages} busy={game.isLoading} heroPid={hero?.pid ?? null} compact={step === "approach" || step === "escape" || step === "hold"} />}
        />
      )}
      {step === "visit" && visitB && (
        <InsideView
          faces={visitFaces}
          title={`${visitB.label} · inside`}
          mode="look"
          question={null}
          note={visitFaces.length ? "Real interior: this building's own 3D tour." : "No 3D tour of this interior on file."}
          walk={hops.length > 1 ? { hops, index: Math.min(hop, hops.length - 1), onIndex: setHop, onHeading: setHopHeading } : null}
          exitHint="[E] step outside"
          onChoose={() => {}}
        />
      )}
      {step === "visit" && visitB && <SuiteSweep pid={visitB.pid} onScore={setSweep} />}
      {step === "suite" && office && (
        <InsideView
          faces={officeFaces}
          title={`${office.label} · suite ${case7?.suite ?? ""}`}
          mode="look"
          question={{ prompt: case7?.question ?? "The records list a tenant here, and the suite is listed for lease. Is the tenant still there?", choices: SUITE_CHOICES, chosen: suiteTip.chosen, status: suiteStatus }}
          note={officeFaces.length ? "Real interior: this suite's own 3D tour." : null}
          exitHint={suiteTip.sentAt !== null && game.runDone ? "[E] step outside" : suiteTip.chosen === null ? "Answer first, then step outside" : "Wait for HQ…"}
          onChoose={(i) => suiteTip.chosen === null && setSuiteTip({ chosen: i, sentAt: null })}
        />
      )}
      {step === "inside" && hero && (
        <InsideView
          faces={hopNow && step === "inside" ? hopNow.faces : insideFaces}
          walk={step === "inside" && hops.length > 1 ? { hops, index: Math.min(hop, hops.length - 1), onIndex: setHop, onHeading: setHopHeading } : null}
          title={`${hero.label} · inside`}
          mode={insideMode}
          question={step === "inside" && hero.conflict ? { prompt: "What are the walls made of?", choices: TIP_CHOICES, chosen: tip.chosen, status: tipStatus } : null}
          note={insideFaces.length ? "Real interior: this building's own 3D tour." : null}
          exitHint={exitAllowed ? "[E] step outside" : step === "inside" ? (hero.conflict && tip.chosen === null ? "Answer first, then step outside" : "Wait for HQ…") : null}
          onChoose={(i) => tip.chosen === null && setTip({ chosen: i, sentAt: null })}
        />
      )}
      {showInside && hops.length > 1 && (insideMesh ? (
        <InsideMesh3D url={insideMesh.url} hops={hops} at={Math.min(hop, hops.length - 1)} heading={hopHeading} />
      ) : (
        <HopMap hops={hops} at={Math.min(hop, hops.length - 1)} heading={hopHeading} onPick={setHop} />
      ))}
      {showInside && (
        // The agent keeps working while you're inside: HQ's strip stays on screen (top-centre), the radio as subtitles.
        <>
          <div className={footStyles.hqInside}>
            <HqPanel messages={shownMessages} busy={game.isLoading} heroPid={hero?.pid ?? null} compact />
          </div>
          <RadioSubs lines={radio} layer />
        </>
      )}
      {/* The AI's big moments (plan, case opened, the aerial it looked at, your report moving the odds, drafting).
          Mounted once for the whole night (a remount would treat earlier moments as history); hidden, not unmounted. */}
      <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", bottom: 230, width: "min(520px, 56vw)", zIndex: 35, pointerEvents: "none", display: step === "intro" || step === "dawn" ? "none" : "block" }}>
        <HqMoments messages={shownMessages} busy={game.isLoading} heroPid={hero?.pid ?? null} />
      </div>
      {(showInside || step === "dawn") && (
        <div style={{ position: "absolute", right: 18, top: 14, zIndex: 40, pointerEvents: "none" }}>
          <Badges stub={game.stub} replay={replay} />
        </div>
      )}
      {step !== "intro" && step !== "dawn" && !paused && (
        <button type="button" aria-label="Pause" onClick={() => {
          ctxRef.current?.input.unlock();
          setPaused(true);
        }} className={footStyles.pauseBtn} style={{ left: "calc(50% + 250px)" }}>
          ❚❚
        </button>
      )}
      {staleOpen && (step === "office" || step === "approach") && (() => {
        const c = stale.find((x) => x.pid === staleOpen);
        return c ? <StaleCheck c={c} stamped={staleStamps[c.pid] ?? null} onStamp={(a) => setStaleStamps((m) => ({ ...m, [c.pid]: a }))} onClose={() => setStaleOpen(null)} /> : null;
      })()}
      {solarOpen && (step === "office" || step === "approach") && (() => {
        const r = solar.find((x) => x.pid === solarOpen);
        return r ? <SolarSurvey roof={r} stamped={solarStamps[r.pid] ?? null} onStamp={(a) => setSolarStamps((m) => ({ ...m, [r.pid]: a }))} onClose={() => setSolarOpen(null)} /> : null;
      })()}
      {paused && (
        <PauseMenu objectives={objectives} onResume={() => {
          setPaused(false);
          if (!showInside) ctxRef.current?.input.lock();
        }} onRestart={() => {
          setPaused(false);
          playAgain();
        }} />
      )}
      {step === "intro" && city && (
        <div className={footStyles.cityLine}>
          Pillars of light: <b>{city.cases.toLocaleString("en-US")} buildings with open cases</b>, of {city.buildings.toLocaleString("en-US")} in CoStar&apos;s LA records
        </div>
      )}
      {step === "intro" && <IntroOverlay heroLabel={heroLabel} ready={!!district} stub={game.stub} replay={replay} attribution={district.attribution ?? null} onStart={begin} />}
      {step === "dawn" && (
        <DawnView
          title="Dawn. You made it."
          lines={outcomeLines}
          messages={game.messages}
          loading={game.isLoading}
          onPlayAgain={playAgain}
          score={score}
          reportFiled={prog.filed}
          onFileReport={() => {
            setProg((q) => ({ ...q, filed: true }));
            // Two doors, one engine: the same agent as the auditor, on this building's case, with the player's report in it.
            if (!game.stub && !agentOff && hero) router.push(`/?check=${encodeURIComponent(hero.pid)}&from=laststand`);
          }}
        />
      )}
    </main>
  );
}

/** A tiny floor plan of the real scan spots (Matterport twin positions). Click a dot, or A/D, to walk between them. */
function HopMap({ hops, at, heading, onPick }: { hops: { id: string; x: number; y: number }[]; at: number; heading: number; onPick(i: number): void }) {
  const xs = hops.map((h) => h.x), ys = hops.map((h) => h.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const W = 260, H = Math.max(90, Math.min(200, (W * (y1 - y0 + 2)) / (x1 - x0 + 2)));
  const px = (x: number) => 14 + ((x - x0) / Math.max(1, x1 - x0)) * (W - 28);
  const py = (y: number) => H - 14 - ((y - y0) / Math.max(1, y1 - y0)) * (H - 28); // plan +y is up
  return (
    <div className={`${footStyles.root} ${footStyles.plan}`}>
      <div className={footStyles.planHead}>
        <b>Floor plan</b> · real 3D scan · W/S to walk, click a spot
      </div>
      <svg width={W} height={H} style={{ display: "block" }}>
        <rect x={4} y={4} width={W - 8} height={H - 8} fill="none" stroke="rgba(244,241,234,.2)" />
        {hops[at] && (() => {
          // Heading arrow (plan +y points up the map, so flip y for screen coordinates).
          const cx = px(hops[at].x), cy = py(hops[at].y), r = (heading * Math.PI) / 180;
          return <line x1={cx} y1={cy} x2={cx + Math.sin(r) * 18} y2={cy - Math.cos(r) * 18} stroke="#f2a33a" strokeWidth={3} />;
        })()}
        {hops.map((h, i) => (
          <circle key={h.id} cx={px(h.x)} cy={py(h.y)} r={i === at ? 7 : 5} fill={i === at ? "#f2a33a" : "rgba(244,241,234,.55)"}
            style={{ cursor: "pointer" }} onClick={() => onPick(i)} />
        ))}
      </svg>
    </div>
  );
}
