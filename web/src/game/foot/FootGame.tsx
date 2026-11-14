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
// Missions ("Night 1"): a nightfall clock, trapped survivors to rescue and escort, supply crates (boards for the barricade,
// medkits), an active door defence on HOLD, an escort run on RUN, aftershock debris zones (game outcome, not an engineering
// assessment), a dawn score and "file the report". None of it adds an agent message: the recorded replay stays valid.
//
// Hard rule: what the player does with their hands (health, sprinting) never feeds the agent or the rolls.
// The building's fate is the server's seeded roll; the player's fate is the arcade layer. No game over.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Game } from "../useGame";
import { evidenceUrl } from "../Pano";
import { kind, parse, radioLines, type Msg } from "../radio";
import { DISCLAIMER, type Building } from "../types";
import { boundsOf, buildColliders, createBus, dirOf, makeCollide, reachPoint, DOOR_R, SCOUT_R, type FootCtx, type Pt, type SupplySpot, type SurvivorSpot, type SurvivorState, type System } from "./engine";
import { createInput, type Input } from "./input";
import { createWorld } from "./world";
import { createPlayer } from "./player";
import { createHorde } from "./horde";
import { createFeeds, type Feeds } from "./feeds";
import { createMission } from "./mission";
import { HqPanel } from "./HqPanel";
import { mulberry32 } from "../prng";
import { IntroOverlay } from "./IntroOverlay";
import { InsideView, type InsideMode } from "./InsideView";
import { FootHud, type Banner, type Hint, type Objective } from "./FootHud";
import { DawnView } from "./DawnView";
import { RadioLog } from "../Hud";

type Step = "intro" | "approach" | "inside" | "night" | "hold" | "escape" | "safe" | "result" | "dawn";

const TIP_CHOICES = ["Concrete", "Brick", "Can't tell"];
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
    supplies.push({ id: `crate-${supplies.length}`, x: at[0], z: at[1], kind, n: kind === "boards" ? 2 : 1, why: "scavenged", pid: null });
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
export function FootGame({ game, replay, agentOff = false }: { game: Game; replay: string | null; agentOff?: boolean }) {
  const { district } = game;
  const wrapRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<FootCtx | null>(null);
  const feedsRef = useRef<Feeds | null>(null);
  const gRef = useRef(game);
  useEffect(() => {
    gRef.current = game;
  });

  const hero = useMemo(() => (district ? pickHero(district.buildings) : null), [district]);
  const heroLabel = hero?.label ?? "";
  const safeRoom = useMemo(() => district?.buildings.find((b) => b.door && b.pid !== hero?.pid) ?? null, [district, hero]);
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
  const [hud, setHud] = useState({ health: 100, stamina: 1, yawDeg: 0, threat: 0, nearDoor: false, target: null as null | { label: string; bearingDeg: number; dist: number } });
  const [dronePhoto, setDronePhoto] = useState<{ src: string; caption: string } | null>(null);
  const [feedCaps, setFeedCaps] = useState({ drone: "DRONE", cctv: "CCTV" });
  const routeTo = useRef<Pt | null>(null);
  const downed = useRef(false);
  const scoutAsked = useRef(false);
  const nightAsked = useRef(false); // the loop outruns React: send "Wave 1 is coming" exactly once
  const shockFired = useRef(false);
  const tipSending = useRef(false);
  // missions
  const nightfallAt = useRef(Infinity);
  const nightFallen = useRef(false);
  const startedAt = useRef(0);
  const debrisFired = useRef(false);
  const defendEnded = useRef(false);
  const [prog, setProg] = useState({ reached: false, checked: false, survived: false, filed: false });
  const [mhud, setMhud] = useState({ boards: 0, medkits: 0, found: 0, crates: 0, survivors: [] as { name: string; state: SurvivorState }[], barricade: null as null | { hp: number; max: number }, timer: null as null | { label: string; secs: number; urgent: boolean } });
  const cratesTotal = useRef(0);
  const [score, setScore] = useState({ saved: 0, total: 0, found: 0, health: 100, secs: 0, points: 0, rank: "C" });

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
      horde: { alive: 0, chasing: 0, nearest: Infinity, pressing: 0 },
      npcs: [],
      mission: { boards: 0, medkits: 0, found: 0, survivors: [], barricade: { active: false, hp: 100, max: 100 } },
      bus: createBus(),
      cameraOwner: "director",
      time: 0,
      dawn: 0,
      stub: gRef.current.stub,
      imageUrl: evidenceUrl,
      collide: makeCollide(colliders, bounds),
    };
    ctxRef.current = ctx;
    if (process.env.NODE_ENV !== "production") (window as unknown as { __foot?: unknown }).__foot = { ctx, step: () => stepRef.current };
    const door: Pt = hero.door ? [hero.door.x, hero.door.z] : reachPoint(ctx, hero.pid, [hero.x, hero.z + 40]) ?? [hero.x, hero.z];
    const sp = spawnFor(ctx, door, hero.door?.facing ?? 180);
    Object.assign(ctx.player, { x: sp.at[0], z: sp.at[1], yaw: sp.yaw });

    const feeds = createFeeds(ctx);
    feedsRef.current = feeds;
    const systems = [safely("world", createWorld(ctx)), safely("player", createPlayer(ctx)), safely("horde", createHorde(ctx)), safely("mission", createMission(ctx)), safely("feeds", feeds)];
    ctx.bus.emit("world:beacon", { pid: hero.pid });
    const offDown = ctx.bus.on("player:downed", () => (downed.current = true));
    const offMission = [
      ctx.bus.on("mission:pickup", (e) => setBanner({ title: e.kind === "boards" ? `+${e.n} boards` : "+1 medkit", sub: e.why === "scavenged" ? (e.kind === "medkit" ? "[Q] to use it." : "For the barricade.") : e.why, tone: "good" }, 2200)),
      ctx.bus.on("mission:survivor", (e) =>
        setBanner(
          e.state === "following" ? { title: `${e.name} is with you`, sub: "Keep them close. Zombies go for them too.", tone: "good" }
          : e.state === "safe" ? { title: `${e.name} is safe`, tone: "good" }
          : e.state === "lost" ? { title: `${e.name} ran for it`, sub: "Lost in the dark.", tone: "bad" } : null,
          2600,
        ),
      ),
      ctx.bus.on("mission:barricade-broken", () => setBanner({ title: "The barricade is down!", sub: "Shove them back. [E] with boards to rebuild.", tone: "bad" }, 3000)),
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
      ctx.time += dt;
      tickRef.current(dt);
      for (const s of systems) s.update(dt);
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
  }, [district, hero]);

  // ------------------------------------------------------------------ helpers the loop uses
  const doorOf = (ctx: FootCtx, b: Building | null): Pt | null => (b ? (b.door ? [b.door.x, b.door.z] : reachPoint(ctx, b.pid, [ctx.player.x, ctx.player.z])) : null);
  const objectivePoint = (ctx: FootCtx): { at: Pt; label: string } | null => {
    const s = stepRef.current;
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
    if (to) ctx.bus.emit("horde:target", { x: to[0], z: to[1] });
    setStep("escape");
    setBanner(breach ? { title: "They're through!", sub: to ? `Run to ${labelOf(toPid)}.` : "Get clear and survive.", tone: "bad" } : { title: `Run to ${labelOf(toPid)}`, sub: "Shift to sprint. Space to shove.", tone: "warn" });
  };

  const startDefend = (ctx: FootCtx, door: Pt) => {
    const f = dirOf(hero?.door?.facing ?? 180);
    [ctx.player.x, ctx.player.z] = ctx.collide(door[0] + f[0] * 1.5, door[1] + f[1] * 1.5, 0.5);
    ctx.player.frozen = false;
    ctx.player.hidden = false;
    ctx.cameraOwner = "player";
    defendEnded.current = false;
    ctx.bus.emit("world:barricade", { pid: hero?.pid ?? null });
    ctx.bus.emit("mission:defend", { pid: hero?.pid ?? "", x: door[0], z: door[1], facing: hero?.door?.facing ?? 180 });
    ctx.bus.emit("horde:target", { x: door[0] + f[0] * 2.5, z: door[1] + f[1] * 2.5 });
    ctx.input.lock();
    setStep("hold");
    setBanner({ title: "Hold the door", sub: "[Space] shove · hold [E] to nail boards · keep them off until the roll comes in", tone: "warn" }, 4500);
  };

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
      if (!nightFallen.current && ctx.time > nightfallAt.current && (s === "approach" || s === "inside")) {
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
          .map((c) => ({ x: (c.minX + c.maxX) / 2, z: (c.minZ + c.maxZ) / 2, r: Math.max(c.maxX - c.minX, c.maxZ - c.minZ) / 2 + 6 }));
        const b = g.outcome ? ctx.byPid.get(g.outcome.pid_final) : hero;
        const mmi = b?.mmi ?? 7;
        ctx.bus.emit("fx:shake", { amp: Math.max(0.12, Math.min(0.6, (mmi - 5.5) * 0.17)), secs: 4 });
        ctx.bus.emit("mission:debris", { zones, secs: 7 });
        setBanner({ title: "Aftershock!", sub: "Get clear of the red zones: buildings with unfinished city retrofit orders. Game outcome, not an engineering assessment.", tone: "bad" }, 5000);
      };

      if (downed.current) {
        downed.current = false;
        const o = objectivePoint(ctx);
        const at = o?.at ?? heroDoor;
        [p.x, p.z] = ctx.collide(at[0] + 2, at[1] + 2, 0.5);
        p.health = 60;
        ctx.bus.emit("horde:repel", { x: p.x, z: p.z, r: 18 });
        setBanner({ title: "You went down.", sub: "Your squad dragged you clear.", tone: "bad" });
      }

      if (s === "intro") {
        const t = ctx.time * 0.12;
        ctx.camera.position.set(hero.x + Math.sin(t) * 170, 110, hero.z + Math.cos(t) * 170);
        ctx.camera.lookAt(hero.x, 10, hero.z);
        if (k.has("Enter") && g.district) begin();
        return;
      }
      if (s === "approach") {
        if (!scoutAsked.current && dist(here, heroDoor) < SCOUT_R && g.phase === "dusk") {
          scoutAsked.current = true;
          if (g.selected !== hero.pid) g.select(hero.pid);
        }
        if (dist(here, heroDoor) < DOOR_R && k.has("KeyE")) {
          ctx.bus.emit("mission:shelter", { pid: hero.pid, x: heroDoor[0], z: heroDoor[1] });
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
              setBanner({ title: "Night 1", sub: `The horde is coming from the ${w.sector}.`, tone: "warn" }, 4000);
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
        if (since > 8) fireDebris();
        if ((to && dist(here, to) < DOOR_R + 1) || (!to && since > 25)) {
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
      if (s === "result") {
        if (!shockFired.current && g.outcome) {
          shockFired.current = true;
          const quakeOk = g.outcome.quake_roll <= Math.min(95, g.outcome.quake + 40);
          if (!quakeOk) ctx.bus.emit("fx:crack", { pid: g.outcome.pid_final });
          const why = g.outcome.why.split("; ").find((x) => x.startsWith("aftershock")) ?? "";
          setBanner({ title: quakeOk ? "The building rode out the aftershock" : "The building cracked", sub: why.replace(/\.\s*Game outcome.*$/, ""), tone: quakeOk ? "info" : "bad" }, 4500);
        }
        if (since > 5) {
          ctx.bus.emit("horde:clear", {});
          if (!agentOff) g.goDawn();
          const m = ctx.mission;
          const saved = m.survivors.filter((v) => v.state === "safe").length;
          const total = m.survivors.length;
          const secs = Math.round(ctx.time - startedAt.current);
          const points = saved * 250 + m.found * 40 + Math.round(p.health) * 2 + Math.max(0, 240 - secs);
          const rank = points >= 900 ? "S" : points >= 700 ? "A" : points >= 450 ? "B" : "C";
          setScore({ saved, total, found: m.found, health: p.health, secs, points, rank });
          setProg((q) => ({ ...q, survived: true }));
          setStep("dawn");
        }
        return;
      }
      if (s === "dawn") {
        ctx.dawn = Math.min(1, ctx.dawn + dt / 3);
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
      const nearDoor = stepRef.current === "approach" && !!hero && dist(here, doorOf(ctx, hero)!) < DOOR_R;
      const n = ctx.horde.nearest;
      const threat = n < 12 ? 3 : n < 35 ? 2 : ctx.horde.alive > 0 ? 1 : 0;
      setHud({
        health: p.health,
        stamina: p.stamina,
        yawDeg: (((p.yaw * 180) / Math.PI) % 360 + 360) % 360,
        threat,
        nearDoor,
        target: o ? { label: o.label, bearingDeg: bearing(here, o.at), dist: dist(here, o.at) } : null,
      });
      const m = ctx.mission;
      const st = stepRef.current;
      const left = nightfallAt.current - ctx.time;
      const timer = st === "approach" || st === "inside" ? (nightFallen.current ? { label: "Night has fallen", secs: 0, urgent: true } : { label: "Nightfall", secs: Math.max(0, Math.round(left)), urgent: left < 30 }) : null;
      const next = { boards: m.boards, medkits: m.medkits, found: m.found, crates: cratesTotal.current, survivors: m.survivors.map((v) => ({ name: v.name, state: v.state })), barricade: m.barricade.active ? { hp: Math.round(m.barricade.hp), max: m.barricade.max } : null, timer };
      setMhud((c) => (JSON.stringify(c) === JSON.stringify(next) ? c : next));
      const f = feedsRef.current;
      if (f) setFeedCaps((c) => (c.drone === f.caption("drone") && c.cctv === f.caption("cctv") ? c : { drone: f.caption("drone"), cctv: f.caption("cctv") }));
    };
  });

  // ------------------------------------------------------------------ reactions to the agent stream
  // Scout: once the hero is selected (dossier loading), start the scout run.
  useEffect(() => {
    if (agentOff) return;
    if (scoutAsked.current && hero && game.selected === hero.pid && game.phase === "dusk" && !game.isLoading) game.startScout();
  }, [game, hero, agentOff]);

  // New radio lines go on the bus (spoken + crackle by the audio system).
  const radioSeen = useRef(0);
  const radioNow = useMemo(() => radioLines(game.messages), [game.messages]);
  useEffect(() => {
    const ctx = ctxRef.current;
    if (radioNow.length < radioSeen.current) radioSeen.current = 0; // play again: a fresh thread
    for (const l of radioNow.slice(radioSeen.current)) ctx?.bus.emit("radio:line", { who: l.who, text: l.text, tone: l.tone });
    radioSeen.current = radioNow.length;
  }, [radioNow]);

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
  const lean = hero ? game.conflictMaterials[hero.pid] ?? null : null;
  useEffect(() => {
    if (hero) ctxRef.current?.bus.emit("world:lean", { pid: hero.pid, material: lean });
  }, [hero, lean]);

  // The drone feed shows the agent's own vision check (the real aerial it looked at) for 10 s.
  const lastPhotoId = useRef<string | null>(null);
  useEffect(() => {
    if (!hero) return;
    for (let i = game.messages.length - 1; i >= 0; i--) {
      const m = game.messages[i] as Msg;
      if (kind(m) !== "tool" || m.name !== "check_evidence") continue;
      const r = parse<{ property_id?: string; images?: string[]; callout?: string; finding?: string }>(m);
      if (!r?.images?.length || String(r.property_id ?? hero.pid) !== hero.pid) continue;
      const id = String(m.id ?? i);
      if (id === lastPhotoId.current) return;
      lastPhotoId.current = id;
      setDronePhoto({ src: evidenceUrl(r.images[0]), caption: `HQ looked: ${r.callout || r.finding || "aerial"}` });
      feedsRef.current?.setOverride("drone", true);
      const t = setTimeout(() => {
        setDronePhoto(null);
        feedsRef.current?.setOverride("drone", false);
      }, 10_000);
      return () => clearTimeout(t);
    }
  }, [game.messages, hero]);

  // ------------------------------------------------------------------ actions
  function begin() {
    const ctx = ctxRef.current;
    if (!ctx || !hero) return;
    ctx.cameraOwner = "player";
    ctx.player.frozen = false;
    ctx.input.lock();
    ctx.bus.emit("horde:ambient", { count: 14 });
    const door = doorOf(ctx, hero)!;
    const plan = planMission(ctx, hero.pid, door, [ctx.player.x, ctx.player.z]);
    cratesTotal.current = plan.supplies.length;
    ctx.bus.emit("mission:setup", plan);
    for (const sv of plan.survivors) ctx.bus.emit("horde:pack", { x: sv.x, z: sv.z, count: 4 });
    nightfallAt.current = ctx.time + NIGHTFALL_S;
    nightFallen.current = false;
    startedAt.current = ctx.time;
    gRef.current.select(hero.pid); // the fortress card loads while you walk
    setStep("approach");
    setBanner({ title: `Reach ${hero.label}`, sub: "The records disagree about its walls. Find out before dark.", tone: "info" }, 5000);
  }

  function playAgain() {
    const ctx = ctxRef.current;
    if (!ctx || !hero) return;
    gRef.current.reset();
    scoutAsked.current = false;
    nightAsked.current = false;
    shockFired.current = false;
    tipSending.current = false;
    debrisFired.current = false;
    defendEnded.current = false;
    setProg({ reached: false, checked: false, survived: false, filed: false });
    ctx.bus.emit("mission:reset", {});
    routeTo.current = null;
    setTip({ chosen: null, sentAt: null });
    ctx.dawn = 0;
    ctx.bus.emit("horde:clear", {});
    ctx.bus.emit("world:route", { pts: null });
    ctx.bus.emit("world:barricade", { pid: null });
    ctx.bus.emit("world:beacon", { pid: hero.pid });
    const door = doorOf(ctx, hero)!;
    const sp = spawnFor(ctx, door, hero.door?.facing ?? 180);
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
  if (step === "approach" || step === "escape" || step === "night") hints.push({ key: "WASD", label: "move" }, { key: "Shift", label: "sprint" }, { key: "Space", label: "shove" });
  if (step === "approach" && hud.nearDoor) hints.push({ key: "E", label: `go inside ${heroLabel}` });
  if (step === "night" && !game.decision) hints.push({ key: "H", label: "hold" }, { key: "R", label: runLabel ? `run to ${runLabel}` : "run", disabled: !runLabel });
  if (step === "hold") hints.push({ key: "E", label: mhud.boards > 0 ? `nail boards (${mhud.boards})` : "no boards left", disabled: mhud.boards === 0 });
  if ((step === "approach" || step === "escape" || step === "hold" || step === "night") && mhud.medkits > 0) hints.push({ key: "Q", label: `medkit (${mhud.medkits})` });
  if (step === "dawn") hints.push({ key: "Enter", label: "play again" });

  const objective =
    step === "approach" ? (game.phase === "scout" ? `Get to ${heroLabel}. Your squads are reading its records.` : `Reach ${heroLabel}.`)
    : step === "inside" ? "Look at the walls. Tell HQ what you see."
    : step === "night" ? (game.decision ? "Orders sent." : game.proposal ? "HQ made a call. Yours is final." : "HQ is weighing HOLD or RUN…")
    : step === "hold" ? "Hold the door until the roll comes in."
    : step === "escape" ? (runLabel ? `Run to ${runLabel}.` : "Survive until dawn.")
    : step === "safe" ? "Doors shut. Wait for it."
    : step === "result" ? "The roll is in."
    : step === "dawn" ? "Dawn." : "";

  const saved = mhud.survivors.filter((v) => v.state === "safe").length;
  const withYou = mhud.survivors.filter((v) => v.state === "following").length;
  const objectives: Objective[] = [
    { id: "reach", kind: "main", text: `Reach ${heroLabel}`, done: prog.reached },
    { id: "walls", kind: "main", text: "Check the walls inside", done: prog.checked },
    { id: "night", kind: "main", text: "Survive the night: HOLD or RUN", done: prog.survived },
    { id: "report", kind: "main", text: "File the report at dawn", done: prog.filed },
    { id: "survivors", kind: "side", text: "Rescue the survivors", done: mhud.survivors.length > 0 && saved === mhud.survivors.length, progress: `${saved + withYou}/${mhud.survivors.length}` },
    { id: "crates", kind: "side", text: "Scavenge supplies", done: mhud.crates > 0 && mhud.found >= mhud.crates, progress: `${mhud.found}/${mhud.crates}` },
  ];

  const decision =
    step === "night"
      ? {
          prompt: game.proposal ? `HQ proposes: ${game.proposal.action === "run" ? `RUN to ${labelOf(game.proposal.to_pid ?? fallbackPid)}` : `HOLD ${heroLabel}`}.` : game.isLoading ? "HQ is weighing HOLD or RUN…" : "HQ didn't call it. Your call.",
          proposed: game.proposal?.action ?? null,
          runLabel,
          sent: game.decision ? `Orders sent: ${game.decision.action === "run" ? `RUN to ${labelOf(game.decision.to_pid)}` : game.decision.action === "hold" ? "HOLD" : "no orders, holding"}` : null,
          error: game.decideError,
        }
      : null;

  const insideMode: InsideMode = "look";
  const showInside = step === "inside" && !!hero;
  const exitAllowed = step === "inside" && (agentOff || (game.phase !== "dusk" && !(game.phase === "scout" && !game.scoutDone) && !(!!hero?.conflict && tip.chosen === null) && !(tip.chosen !== null && (tip.sentAt === null || game.isLoading))));
  const tipStatus =
    tip.chosen === null ? "Your report is testimony: strong, capped, never final."
    : tip.sentAt === null ? "HQ is still on the radio. Your report goes when the line is clear."
    : game.isLoading ? "Sent. HQ is weighing it." : "HQ logged it.";

  const outcomeLines = game.outcome ? game.outcome.why.split("; ").map((x) => x.replace(/\.\s*Game outcome.*$/, "")) : [];

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
          feeds={{ drone: { caption: feedCaps.drone, photo: dronePhoto }, cctv: { caption: feedCaps.cctv, photo: null } }}
          badges={{ stub: game.stub, replay }}
          disclaimer={DISCLAIMER}
          attribution={district.attribution ?? null}
          objectives={objectives}
          timer={mhud.timer}
          supplies={{ boards: mhud.boards, medkits: mhud.medkits }}
          survivors={mhud.survivors}
          barricade={mhud.barricade}
          hq={<HqPanel messages={game.messages} busy={game.isLoading} heroPid={hero?.pid ?? null} compact={step === "approach" || step === "escape" || step === "hold"} />}
        />
      )}
      {showInside && hero && (
        <InsideView
          faces={insideFaces}
          title={`${hero.label} · inside`}
          mode={insideMode}
          question={step === "inside" && hero.conflict ? { prompt: "What are the walls made of?", choices: TIP_CHOICES, chosen: tip.chosen, status: tipStatus } : null}
          note={insideFaces.length ? "Real interior: this building's own 3D tour." : null}
          exitHint={exitAllowed ? "[E] step outside" : step === "inside" ? (hero.conflict && tip.chosen === null ? "Answer first: what do the walls look like?" : "Wait for HQ…") : null}
          onChoose={(i) => tip.chosen === null && setTip({ chosen: i, sentAt: null })}
        />
      )}
      {showInside && (
        // The agent keeps talking while you're inside: the radio stays on screen (top-right is kept free by InsideView).
        <div style={{ position: "absolute", top: 16, right: 16, width: 360, maxHeight: 260, overflow: "hidden", zIndex: 30, pointerEvents: "none" }}>
          <RadioLog lines={radio.slice(-5)} busy={game.isLoading} />
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
          onFileReport={() => setProg((q) => ({ ...q, filed: true }))}
        />
      )}
    </main>
  );
}
