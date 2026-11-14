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
// Hard rule: what the player does with their hands (health, sprinting) never feeds the agent or the rolls.
// The building's fate is the server's seeded roll; the player's fate is the arcade layer. No game over.

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { Game } from "../useGame";
import { evidenceUrl } from "../Pano";
import { kind, parse, radioLines, type Msg } from "../radio";
import { DISCLAIMER, type Building } from "../types";
import { boundsOf, buildColliders, createBus, dirOf, makeCollide, reachPoint, DOOR_R, SCOUT_R, type FootCtx, type Pt, type System } from "./engine";
import { createInput, type Input } from "./input";
import { createWorld } from "./world";
import { createPlayer } from "./player";
import { createHorde } from "./horde";
import { createFeeds, type Feeds } from "./feeds";
import { IntroOverlay } from "./IntroOverlay";
import { InsideView, type InsideMode } from "./InsideView";
import { FootHud, type Banner, type Hint } from "./FootHud";
import { DawnView } from "./DawnView";

type Step = "intro" | "approach" | "inside" | "night" | "hold" | "escape" | "safe" | "aftershock" | "dawn";

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

export function FootGame({ game, replay }: { game: Game; replay: string | null }) {
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
      horde: { alive: 0, chasing: 0, nearest: Infinity },
      bus: createBus(),
      cameraOwner: "director",
      time: 0,
      dawn: 0,
      stub: gRef.current.stub,
      imageUrl: evidenceUrl,
      collide: makeCollide(colliders, bounds),
    };
    ctxRef.current = ctx;
    const door: Pt = hero.door ? [hero.door.x, hero.door.z] : reachPoint(ctx, hero.pid, [hero.x, hero.z + 40]) ?? [hero.x, hero.z];
    const sp = spawnFor(ctx, door, hero.door?.facing ?? 180);
    Object.assign(ctx.player, { x: sp.at[0], z: sp.at[1], yaw: sp.yaw });

    const feeds = createFeeds(ctx);
    feedsRef.current = feeds;
    const systems = [safely("world", createWorld(ctx)), safely("player", createPlayer(ctx)), safely("horde", createHorde(ctx)), safely("feeds", feeds)];
    ctx.bus.emit("world:beacon", { pid: hero.pid });
    const offDown = ctx.bus.on("player:downed", () => (downed.current = true));

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
      const dt = Math.min(0.05, (now - last) / 1000);
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
        if (t.chosen !== null && t.sentAt === null && !tipSending.current && g.phase === "scout" && g.scoutDone && !g.isLoading) {
          tipSending.current = true;
          g.sendTip(TIP_TEXTS[t.chosen]);
          setTip({ chosen: t.chosen, sentAt: g.messages.length });
        }
        const scoutBusy = g.phase === "scout" && !g.scoutDone;
        const tipBusy = t.chosen !== null && (t.sentAt === null || g.isLoading);
        if (k.has("KeyE") && !tipBusy && !scoutBusy && g.phase !== "dusk") {
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
          const at = g.startNight(1);
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
        if (!g.decision && !g.outcome) {
          if (k.has("KeyH")) g.decide("hold");
          else if (k.has("KeyR")) g.decide("run");
          else if (k.has("KeyN")) g.decide("none");
        }
        if (g.decision) {
          if (g.decision.action === "run") startEscape(ctx, false);
          else {
            p.frozen = true;
            p.hidden = true;
            ctx.bus.emit("world:barricade", { pid: hero.pid });
            ctx.bus.emit("horde:target", { x: heroDoor[0], z: heroDoor[1] });
            setStep("hold");
          }
        }
        return;
      }
      if (s === "hold") {
        if (g.outcome && since > 5) {
          if (g.outcome.held) {
            setBanner({ title: "The walls held.", sub: `${labelOf(g.outcome.pid_final)} kept them out.`, tone: "good" });
            setStep("aftershock");
          } else {
            ctx.bus.emit("world:barricade", { pid: null });
            const f = dirOf(hero.door?.facing ?? 180);
            [p.x, p.z] = ctx.collide(heroDoor[0] + f[0] * 3, heroDoor[1] + f[1] * 3, 0.5);
            ctx.bus.emit("wave:breach", { x: heroDoor[0], z: heroDoor[1], count: 24 });
            ctx.input.lock();
            startEscape(ctx, true);
          }
        }
        return;
      }
      if (s === "escape") {
        const to = routeTo.current;
        if (to) ctx.bus.emit("world:route", { pts: [here, to] });
        if ((to && dist(here, to) < DOOR_R + 1) || (!to && since > 25)) {
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
        if (g.outcome && since > 3) setStep("aftershock");
        return;
      }
      if (s === "aftershock") {
        if (!shockFired.current && g.outcome) {
          shockFired.current = true;
          const b = ctx.byPid.get(g.outcome.pid_final);
          const mmi = b?.mmi ?? 7;
          ctx.bus.emit("fx:shake", { amp: Math.max(0.1, Math.min(0.6, (mmi - 5.5) * 0.17)), secs: 3 });
          const quakeOk = g.outcome.quake_roll <= Math.min(95, g.outcome.quake + 40);
          if (!quakeOk) ctx.bus.emit("fx:crack", { pid: g.outcome.pid_final });
          const why = g.outcome.why.split("; ").find((x) => x.startsWith("aftershock")) ?? "";
          setBanner({ title: "Aftershock", sub: why.replace(/\.\s*Game outcome.*$/, ""), tone: quakeOk ? "info" : "bad" }, 4500);
        }
        if (since > 5) {
          ctx.bus.emit("horde:clear", {});
          g.goDawn();
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
      const f = feedsRef.current;
      if (f) setFeedCaps((c) => (c.drone === f.caption("drone") && c.cctv === f.caption("cctv") ? c : { drone: f.caption("drone"), cctv: f.caption("cctv") }));
    };
  });

  // ------------------------------------------------------------------ reactions to the agent stream
  // Scout: once the hero is selected (dossier loading), start the scout run.
  useEffect(() => {
    if (scoutAsked.current && hero && game.selected === hero.pid && game.phase === "dusk" && !game.isLoading) game.startScout();
  }, [game, hero]);

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

  const radio = radioLines(game.messages);
  const heroDossier = game.dossier && game.dossier !== "loading" && game.dossier !== "error" ? game.dossier : null;
  const insideFaces = heroDossier?.images.inside?.length ? heroDossier.images.inside : heroDossier?.images.pano ?? [];
  const runLabel = fallbackPid ? labelOf(fallbackPid) : null;

  const hints: Hint[] = [];
  if (step === "approach" || step === "escape" || step === "night") hints.push({ key: "WASD", label: "move" }, { key: "Shift", label: "sprint" }, { key: "Space", label: "shove" });
  if (step === "approach" && hud.nearDoor) hints.push({ key: "E", label: `go inside ${heroLabel}` });
  if (step === "night" && !game.decision) hints.push({ key: "H", label: "hold" }, { key: "R", label: runLabel ? `run to ${runLabel}` : "run", disabled: !runLabel }, { key: "N", label: "no orders" });
  if (step === "dawn") hints.push({ key: "Enter", label: "play again" });

  const objective =
    step === "approach" ? (game.phase === "scout" ? `Get to ${heroLabel}. Your squads are reading its records.` : `Reach ${heroLabel}.`)
    : step === "inside" ? "Look at the walls. Tell HQ what you see."
    : step === "night" ? (game.decision ? "Orders sent." : game.proposal ? "HQ made a call. Yours is final." : "HQ is weighing HOLD or RUN…")
    : step === "hold" ? "Barricaded. Hold on."
    : step === "escape" ? (runLabel ? `Run to ${runLabel}.` : "Survive until dawn.")
    : step === "safe" ? "Doors shut. Wait for it."
    : step === "aftershock" ? "Aftershock!"
    : step === "dawn" ? "Dawn." : "";

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

  const insideMode: InsideMode = step === "hold" ? "barricade" : "look";
  const showInside = (step === "inside" || step === "hold") && !!hero;
  const exitAllowed = step === "inside" && game.phase !== "dusk" && !(game.phase === "scout" && !game.scoutDone) && !(tip.chosen !== null && (tip.sentAt === null || game.isLoading));
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
        />
      )}
      {showInside && hero && (
        <InsideView
          faces={insideFaces}
          title={`${hero.label} · inside`}
          mode={insideMode}
          question={step === "inside" && hero.conflict ? { prompt: "What are the walls made of?", choices: TIP_CHOICES, chosen: tip.chosen, status: tipStatus } : null}
          note={step === "hold" ? (game.outcome ? "Something gives…" : "Barricaded. The horde is at the door. HQ is rolling the night…") : insideFaces.length ? "Real interior: this building's own 3D tour." : null}
          exitHint={exitAllowed ? "[E] step outside" : step === "inside" ? "Wait for HQ…" : null}
          onChoose={(i) => tip.chosen === null && setTip({ chosen: i, sentAt: null })}
        />
      )}
      {step === "intro" && <IntroOverlay heroLabel={heroLabel} ready={!!district} stub={game.stub} replay={replay} onStart={begin} />}
      {step === "dawn" && (
        <DawnView
          title="Dawn. You made it."
          lines={outcomeLines}
          messages={game.messages}
          loading={game.isLoading}
          onPlayAgain={playAgain}
        />
      )}
    </main>
  );
}
