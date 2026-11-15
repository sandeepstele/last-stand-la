// OWNER: builder E (missions). The arcade layer of "Night 1": supply crates, trapped survivors who follow you once rescued,
// the active door defence on HOLD (boards + [E]), [Q] medkits, and aftershock debris zones.
//
// Nothing here feeds the agent or the server's rolls. Crates are game items (no real data behind them); survivors are
// fictional people; debris is a game dramatisation (the director's banner says "game outcome, not an engineering assessment").
//
// Bus in:  mission:setup, mission:shelter, mission:evacuate, mission:defend, mission:defend-end, mission:debris, mission:reset,
//          npc:hit (horde).
// Bus out: mission:pickup, mission:survivor, mission:medkit, mission:barricade-broken, player:hit (debris).
// ctx out: ctx.npcs (survivors, x/z every frame), ctx.mission (boards, medkits, found, survivors, barricade).

import * as THREE from "three";
import type { FootCtx, Npc, SupplySpot, SurvivorSpot, SurvivorState, System } from "./engine";
import {
  CHUNKS_MAX, WALL_PLANKS, createArt, disposeTree, makeCrate, makeDebrisMesh, makeLabel, makePlankWall, makeSurvivor, poseRig,
  type CrateMesh, type Label, type PlankWall, type Rig,
} from "./missionArt";

// ------------------------------------------------------------------ tuning
const PICKUP_R = 1.6;
const RESCUE_R = 2.5;
const FOLLOW_MAX = 6.8; // m/s
const FOLLOW_GAP0 = 2.6; // trail distance behind the player for the first follower
const FOLLOW_GAP = 2.6; // extra per follower (a loose line, 2-4 m apart)
const SURVIVOR_R = 0.4;
const SURVIVOR_HP = 100;
const LOST_FADE_S = 3;
const SHELTER_TIMEOUT_S = 10;
const REPAIR_R = 4;
const REPAIR_HOLD_S = 0.8;
const REPAIR_HP = 25;
const DRAIN_PER_ZOMBIE = 4; // hp/s
const MEDKIT_HP = 40;
const DEBRIS_WARN_S = 1.5;
const DEBRIS_DPS = 8;
const DEBRIS_TICK_S = 0.5; // ~2 hits/s
const TRAIL_N = 128;
const TRAIL_STEP = 0.5;

// Plank loss order: the wall gets hacked through from the middle out, not top-down.
const LOSS_ORDER = [3, 6, 1, 4, 7, 0, 5, 2]; // LOSS_ORDER[k] = the plank that is k-th from last to go
// present planks = LOSS_ORDER[0..intact-1]

type Crate = { spot: SupplySpot; mesh: CrateMesh; popT: number; spin: number };

type Surv = {
  spot: SurvivorSpot;
  idx: number;
  rig: Rig;
  name: Label;
  help: Label;
  beam: THREE.Mesh;
  beamMat: THREE.MeshBasicMaterial;
  npc: Npc;
  rec: { id: string; name: string; state: SurvivorState };
  health: number;
  yaw: number;
  vx: number;
  vz: number;
  speed: number;
  phase: number;
  order: number; // join order among followers
  sheltering: boolean;
  tx: number;
  tz: number;
  shelterT: number;
  flashT: number;
  fadeT: number;
  hurtT: number; // debris throttle
  barShown: number; // last health drawn on the label (-1 = no bar)
};

type Zone = { x: number; z: number; r: number; ring: THREE.Mesh; fill: THREE.Mesh; ringMat: THREE.MeshBasicMaterial; fillMat: THREE.MeshBasicMaterial };

// scratch (no per-frame allocation)
const V = new THREE.Vector3();
const V2 = new THREE.Vector3();
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
const S = new THREE.Vector3();
const M = new THREE.Matrix4();
const C_WOOD = new THREE.Color(0xb98b55);
const C_WOOD_BAD = new THREE.Color(0x5a3d22);
const C_FLASH = new THREE.Color(0xff3b3b);

function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function createMission(ctx: FootCtx): System {
  const { scene, bus } = ctx;
  const art = createArt();
  const root = new THREE.Group();
  root.name = "mission";
  scene.add(root);

  let crates: Crate[] = [];
  let survs: Surv[] = [];
  let joined = 0;

  // ---------------------------------------------------------------- the player's trail (followers walk it, so they round corners)
  const trailX = new Float32Array(TRAIL_N);
  const trailZ = new Float32Array(TRAIL_N);
  let trailHead = 0; // index of the newest sample
  let trailLen = 0;
  const trailReset = () => {
    trailHead = 0;
    trailLen = 1;
    trailX[0] = ctx.player.x;
    trailZ[0] = ctx.player.z;
  };
  trailReset();
  /** Writes into out the point `dist` metres back along the trail from the player [x, z], and the walking direction there [dx, dz]. */
  const trailPoint = (dist: number, out: [number, number, number, number]) => {
    let px = ctx.player.x, pz = ctx.player.z, left = dist;
    out[2] = Math.sin(ctx.player.yaw);
    out[3] = -Math.cos(ctx.player.yaw);
    for (let k = 0; k < trailLen; k++) {
      const i = (trailHead - k + TRAIL_N) % TRAIL_N;
      const dx = trailX[i] - px, dz = trailZ[i] - pz;
      const l = Math.hypot(dx, dz);
      if (l > 1e-6) {
        out[2] = -dx / l;
        out[3] = -dz / l;
      }
      if (l >= left && l > 1e-6) {
        out[0] = px + (dx / l) * left;
        out[1] = pz + (dz / l) * left;
        return;
      }
      left -= l;
      px = trailX[i];
      pz = trailZ[i];
    }
    out[0] = px;
    out[1] = pz;
  };
  const tp: [number, number, number, number] = [0, 0, 0, 1];
  let pSpeed = 0; // the player's ground speed, measured here (feed-forward for followers)
  let plx = ctx.player.x, plz = ctx.player.z;

  // ---------------------------------------------------------------- fx pools: dust puffs + burst rings
  const PUFFS = 64;
  const puffs: { s: THREE.Sprite; mat: THREE.SpriteMaterial; t: number; dur: number; s0: number; s1: number; vy: number }[] = [];
  for (let i = 0; i < PUFFS; i++) {
    const mat = new THREE.SpriteMaterial({ map: art.dustTex, transparent: true, depthWrite: false, opacity: 0 });
    const s = new THREE.Sprite(mat);
    s.visible = false;
    root.add(s);
    puffs.push({ s, mat, t: 0, dur: 0, s0: 1, s1: 1, vy: 0 });
  }
  let puffNext = 0;
  const puff = (x: number, y: number, z: number, s0: number, s1: number, dur: number, vy = 0.6, tint = 0xffffff) => {
    const p = puffs[puffNext];
    puffNext = (puffNext + 1) % PUFFS;
    p.s.position.set(x, y, z);
    p.t = 0;
    p.dur = dur;
    p.s0 = s0;
    p.s1 = s1;
    p.vy = vy;
    p.mat.color.setHex(tint);
    p.s.visible = true;
  };
  const BURSTS = 10;
  const bursts: { m: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number; dur: number; r0: number; r1: number }[] = [];
  for (let i = 0; i < BURSTS; i++) {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, fog: false });
    const m = new THREE.Mesh(art.ring, mat);
    m.visible = false;
    m.renderOrder = 3;
    root.add(m);
    bursts.push({ m, mat, t: 0, dur: 0, r0: 1, r1: 1 });
  }
  let burstNext = 0;
  const burst = (x: number, z: number, color: number, r0: number, r1: number, dur: number, y = 0.08) => {
    const b = bursts[burstNext];
    burstNext = (burstNext + 1) % BURSTS;
    b.m.position.set(x, y, z);
    b.mat.color.setHex(color);
    b.t = 0;
    b.dur = dur;
    b.r0 = r0;
    b.r1 = r1;
    b.m.visible = true;
  };
  const updateFx = (dt: number) => {
    for (const p of puffs) {
      if (!p.s.visible) continue;
      p.t += dt;
      const k = p.t / p.dur;
      if (k >= 1) {
        p.s.visible = false;
        continue;
      }
      const sc = p.s0 + (p.s1 - p.s0) * (1 - (1 - k) * (1 - k));
      p.s.scale.set(sc, sc, sc);
      p.s.position.y += p.vy * dt;
      p.mat.opacity = 0.75 * (1 - k);
    }
    for (const b of bursts) {
      if (!b.m.visible) continue;
      b.t += dt;
      const k = b.t / b.dur;
      if (k >= 1) {
        b.m.visible = false;
        continue;
      }
      b.m.scale.setScalar(b.r0 + (b.r1 - b.r0) * (1 - (1 - k) * (1 - k)));
      b.mat.opacity = 0.9 * (1 - k);
    }
  };

  // ---------------------------------------------------------------- survivors
  const drawName = (s: Surv) => {
    const st = s.rec.state;
    const hurt = st === "following" && s.health < SURVIVOR_HP;
    s.barShown = hurt ? Math.round(s.health) : -1;
    s.name.draw(
      [
        { text: s.spot.name.toUpperCase(), px: 46, color: "#5eead4", weight: 800 },
        ...(st === "trapped" ? [{ text: "trapped", px: 26, color: "rgba(226,232,240,0.8)", weight: 500 }] : []),
      ],
      { bg: "rgba(6,20,28,0.7)", border: "rgba(45,212,191,0.75)", bar: hurt ? s.health / SURVIVOR_HP : null },
    );
  };
  const setState = (s: Surv, state: SurvivorState) => {
    s.rec.state = state;
    drawName(s);
    bus.emit("mission:survivor", { id: s.spot.id, name: s.spot.name, state });
  };
  const lose = (s: Surv) => {
    s.health = 0;
    s.npc.alive = false;
    s.sheltering = false;
    s.fadeT = 0;
    s.help.sprite.visible = false;
    s.beam.visible = false;
    for (const m of s.rig.mats) {
      m.transparent = true;
      m.depthWrite = false;
      m.needsUpdate = true;
    }
    // bolt away from the player
    const dx = s.npc.x - ctx.player.x, dz = s.npc.z - ctx.player.z;
    const l = Math.hypot(dx, dz) || 1;
    s.vx = (dx / l) * FOLLOW_MAX;
    s.vz = (dz / l) * FOLLOW_MAX;
    setState(s, "lost");
  };
  const hurt = (s: Surv, dmg: number, fromX: number, fromZ: number) => {
    // Trapped survivors are holding the pack off (immune until you reach them); safe ones are indoors.
    if (s.rec.state !== "following" || s.npc.hidden || !s.npc.alive) return;
    s.health -= dmg;
    s.flashT = 0.22;
    const dx = s.npc.x - fromX, dz = s.npc.z - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    [s.npc.x, s.npc.z] = ctx.collide(s.npc.x + (dx / l) * 0.35, s.npc.z + (dz / l) * 0.35, SURVIVOR_R);
    if (s.health <= 0) lose(s);
    else if (Math.round(s.health) !== s.barShown) drawName(s);
  };
  const hideSurvivor = (s: Surv) => {
    s.npc.hidden = true;
    s.rig.root.visible = false;
    s.name.sprite.visible = false;
  };

  const setup = (supplies: SupplySpot[], spots: SurvivorSpot[]) => {
    clearAll();
    trailReset();
    for (const spot of supplies) {
      const mesh = makeCrate(art, spot.kind);
      mesh.group.position.set(spot.x, 0, spot.z);
      root.add(mesh.group);
      crates.push({ spot, mesh, popT: -1, spin: (spot.x * 13.37 + spot.z * 7.1) % (Math.PI * 2) });
    }
    spawnSurvivors(spots, "trapped");
  };

  /** Trapped (mission:setup) or already with the player (found inside a building: they step out and follow). */
  const spawnSurvivors = (spots: SurvivorSpot[], state: "trapped" | "following") => {
    for (const spot of spots) {
      if (!spot || !Number.isFinite(spot.x) || !Number.isFinite(spot.z) || survs.some((o) => o.spot.id === spot.id)) continue;
      const idx = survs.length;
      const rig = makeSurvivor(art, idx);
      const name = makeLabel(0.6);
      const help = makeLabel(0.85);
      help.draw([{ text: "HELP!", px: 72, color: "#ffffff", weight: 900 }], { bg: "rgba(220,38,38,0.92)", border: "rgba(255,255,255,0.9)" });
      const beamMat = new THREE.MeshBasicMaterial({ color: 0x2dd4bf, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
      const beam = new THREE.Mesh(art.beam, beamMat);
      beam.scale.set(1.2, 14, 1.2);
      beam.renderOrder = 2;
      rig.root.add(beam);
      root.add(rig.root, name.sprite, help.sprite);
      const [x, z] = ctx.collide(spot.x, spot.z, SURVIVOR_R);
      const npc: Npc = { id: spot.id, x, z, alive: true, hidden: false };
      const rec = { id: spot.id, name: spot.name, state: "trapped" as SurvivorState };
      ctx.npcs.push(npc);
      ctx.mission.survivors.push(rec);
      const s: Surv = {
        spot, idx, rig, name, help, beam, beamMat, npc, rec,
        health: SURVIVOR_HP, yaw: (idx * 2.3 + spot.x) % (Math.PI * 2), vx: 0, vz: 0, speed: 0, phase: 0, order: 0,
        sheltering: false, tx: 0, tz: 0, shelterT: 0, flashT: 0, fadeT: 0, hurtT: 0, barShown: -1,
      };
      survs.push(s);
      if (state === "following") {
        if (s.order === 0 && joined === 0) trailReset();
        s.order = joined++;
        help.sprite.visible = false;
        beam.visible = false;
        // face the player, then fall in behind them
        s.yaw = Math.atan2(ctx.player.x - x, -(ctx.player.z - z));
        poseRig(rig, 2, ctx.time, 0, 0);
        rig.root.position.set(x, 0, z);
        rig.root.rotation.y = -s.yaw;
        setState(s, "following");
      } else drawName(s);
    }
  };

  const updateSurvivors = (dt: number) => {
    const p = ctx.player;
    const t = ctx.time;
    for (const s of survs) {
      const r = s.rig;
      const st = s.rec.state;
      if (st === "safe" && s.npc.hidden) continue;
      if (s.flashT > 0) s.flashT = Math.max(0, s.flashT - dt);
      if (st === "trapped") {
        // face the player when they're near; wave for help
        const dxp = p.x - s.npc.x, dzp = p.z - s.npc.z;
        const dp = Math.hypot(dxp, dzp);
        if (dp < 40) s.yaw = lerpAngle(s.yaw, Math.atan2(dxp, -dzp), Math.min(1, dt * 3));
        poseRig(r, 0, t + s.idx * 1.7, 0, 0);
        const pulse = 1 + Math.sin(t * 6 + s.idx) * 0.12;
        s.help.sprite.scale.set(0.85 * 3.2 * pulse, 0.85 * pulse, 1);
        s.help.sprite.position.set(s.npc.x, 2.25 + Math.sin(t * 3) * 0.06, s.npc.z);
        s.name.sprite.position.set(s.npc.x, 1.6, s.npc.z);
        s.beamMat.opacity = 0.14 + Math.sin(t * 2.5 + s.idx) * 0.05;
        if (!p.hidden && dp < RESCUE_R) {
          s.order = joined++;
          s.help.sprite.visible = false;
          s.beam.visible = false;
          burst(s.npc.x, s.npc.z, 0x2dd4bf, 0.6, 3.2, 0.7);
          setState(s, "following");
        }
      } else if (st === "following") {
        // where to go: the trail behind the player, or the shelter door
        let tx: number, tz: number;
        if (s.sheltering) {
          s.shelterT += dt;
          tx = s.tx;
          tz = s.tz;
        } else {
          // slot in the line = how many walking followers joined before this one
          let slot = 0;
          for (const o of survs) if (o !== s && o.order < s.order && o.rec.state === "following" && !o.sheltering && !o.npc.hidden) slot++;
          trailPoint(FOLLOW_GAP0 + slot * FOLLOW_GAP, tp);
          // stagger left/right of the trail so nobody stands between the camera and the player
          const side = slot % 2 === 0 ? 0.95 : -0.95;
          tx = tp[0] - tp[3] * side;
          tz = tp[1] + tp[2] * side;
        }
        let dx = tx - s.npc.x, dz = tz - s.npc.z;
        const d = Math.hypot(dx, dz);
        // rubber band: a follower that got hung up far behind catches up off-screen
        if (!s.sheltering && Math.hypot(p.x - s.npc.x, p.z - s.npc.z) > 40) {
          [s.npc.x, s.npc.z] = ctx.collide(tx, tz, SURVIVOR_R);
          dx = dz = 0;
        }
        const want = s.sheltering ? Math.min(FOLLOW_MAX, 3 + d * 1.5) : d > 0.35 ? Math.min(FOLLOW_MAX, pSpeed * 0.9 + (d - 0.25) * 2.8) : 0;
        let wx = d > 1e-3 ? (dx / d) * want : 0;
        let wz = d > 1e-3 ? (dz / d) * want : 0;
        // keep a little personal space from the player and each other
        const sx = s.npc.x - p.x, sz = s.npc.z - p.z;
        const sp = Math.hypot(sx, sz);
        if (!p.hidden && sp < 1.3 && sp > 1e-3 && !s.sheltering) {
          wx += (sx / sp) * (1.3 - sp) * 4;
          wz += (sz / sp) * (1.3 - sp) * 4;
        }
        for (const o of survs) {
          if (o === s || o.npc.hidden || !o.npc.alive) continue;
          const ox = s.npc.x - o.npc.x, oz = s.npc.z - o.npc.z;
          const od = Math.hypot(ox, oz);
          if (od < 1.0 && od > 1e-3) {
            wx += (ox / od) * (1.0 - od) * 4;
            wz += (oz / od) * (1.0 - od) * 4;
          }
        }
        const a = Math.min(1, dt * 7);
        s.vx += (wx - s.vx) * a;
        s.vz += (wz - s.vz) * a;
        const ox = s.npc.x, oz = s.npc.z;
        [s.npc.x, s.npc.z] = ctx.collide(ox + s.vx * dt, oz + s.vz * dt, SURVIVOR_R);
        const moved = dt > 0 ? Math.hypot(s.npc.x - ox, s.npc.z - oz) / dt : 0;
        s.speed += (moved - s.speed) * Math.min(1, dt * 8);
        if (s.speed > 0.4) s.yaw = lerpAngle(s.yaw, Math.atan2(s.vx, -s.vz), Math.min(1, dt * 10));
        else if (!p.hidden) s.yaw = lerpAngle(s.yaw, Math.atan2(p.x - s.npc.x, -(p.z - s.npc.z)), Math.min(1, dt * 3));
        s.phase += s.speed * dt * ((Math.PI * 2) / (s.speed > 4 ? 2.1 : 1.45));
        if (s.speed > 0.35) poseRig(r, 1, t, s.phase, s.speed);
        else poseRig(r, 2, t + s.idx, 0, 0);
        s.name.sprite.position.set(s.npc.x, 2.15, s.npc.z);
        // fade the name tag when it's right in front of the camera
        const cam = ctx.camera.position;
        const dc = Math.hypot(cam.x - s.npc.x, cam.z - s.npc.z);
        (s.name.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(1, (dc - 3) / 3));
        if (s.sheltering && (Math.hypot(s.tx - s.npc.x, s.tz - s.npc.z) < 1.1 || s.shelterT > SHELTER_TIMEOUT_S)) {
          s.sheltering = false;
          puff(s.npc.x, 0.8, s.npc.z, 0.6, 1.6, 0.6, 0.3);
          hideSurvivor(s);
          setState(s, "safe");
        }
      } else if (st === "lost") {
        if (s.fadeT >= LOST_FADE_S) continue;
        s.fadeT += dt;
        const ox = s.npc.x, oz = s.npc.z;
        [s.npc.x, s.npc.z] = ctx.collide(ox + s.vx * dt, oz + s.vz * dt, SURVIVOR_R);
        s.speed = FOLLOW_MAX;
        s.yaw = lerpAngle(s.yaw, Math.atan2(s.vx, -s.vz), Math.min(1, dt * 10));
        s.phase += s.speed * dt * ((Math.PI * 2) / 2.1);
        poseRig(r, 1, t, s.phase, s.speed);
        const o = Math.max(0, 1 - s.fadeT / LOST_FADE_S);
        for (const m of r.mats) m.opacity = o;
        (s.name.sprite.material as THREE.SpriteMaterial).opacity = o;
        s.name.sprite.position.set(s.npc.x, 2.2, s.npc.z);
        if (s.fadeT >= LOST_FADE_S) {
          r.root.visible = false;
          s.name.sprite.visible = false;
        }
      }
      // hit flash
      if (st !== "lost") {
        if (s.flashT > 0) r.jacket.emissive.copy(C_FLASH).multiplyScalar(s.flashT / 0.22);
        else r.jacket.emissive.copy(r.jacketGlow);
      }
      r.root.position.set(s.npc.x, 0, s.npc.z);
      r.root.rotation.y = -s.yaw;
    }
  };

  const shelter = (x: number, z: number) => {
    for (const s of survs) {
      if (s.rec.state !== "following" || s.npc.hidden) continue;
      s.sheltering = true;
      s.shelterT = 0;
      s.tx = x;
      s.tz = z;
    }
  };

  const evacuate = (x: number, z: number) => {
    let i = 0;
    for (const s of survs) {
      if (s.rec.state === "following" && s.sheltering) {
        s.sheltering = false;
        continue;
      }
      if (s.rec.state !== "safe") continue;
      const a = i++ * 2.1;
      [s.npc.x, s.npc.z] = ctx.collide(x + Math.sin(a) * 1.2, z + Math.cos(a) * 1.2, SURVIVOR_R);
      s.npc.hidden = false;
      s.vx = s.vz = 0;
      s.rig.root.visible = true;
      s.name.sprite.visible = true;
      s.order = joined++;
      setState(s, "following");
    }
    trailReset();
  };

  // ---------------------------------------------------------------- crates
  const updateCrates = (dt: number) => {
    const p = ctx.player;
    const t = ctx.time;
    for (let i = crates.length - 1; i >= 0; i--) {
      const c = crates[i];
      const m = c.mesh;
      if (c.popT < 0) {
        m.body.rotation.y = c.spin + t * 0.8;
        m.body.position.y = 0.12 + Math.sin(t * 2.2 + c.spin) * 0.08;
        const pulse = 0.5 + Math.sin(t * 3 + c.spin) * 0.5;
        m.ring.scale.setScalar(1.05 + pulse * 0.25);
        (m.ring.material as THREE.MeshBasicMaterial).opacity = 0.35 + pulse * 0.4;
        if (!p.hidden && Math.hypot(p.x - c.spot.x, p.z - c.spot.z) < PICKUP_R) {
          c.popT = 0;
          const ms = ctx.mission;
          if (c.spot.kind === "boards") ms.boards += c.spot.n;
          else ms.medkits += c.spot.n;
          ms.found += 1;
          burst(c.spot.x, c.spot.z, c.spot.kind === "boards" ? 0xffb347 : 0xff6b6b, 0.8, 3.4, 0.6);
          bus.emit("mission:pickup", { kind: c.spot.kind, n: c.spot.n, why: c.spot.why });
        }
      } else {
        c.popT += dt;
        const k = c.popT;
        const sc = k < 0.12 ? 1 + (k / 0.12) * 0.4 : Math.max(0, 1.4 * (1 - (k - 0.12) / 0.25));
        m.body.scale.setScalar(Math.max(0.001, sc));
        m.body.position.y += dt * 3;
        m.body.rotation.y += dt * 14;
        m.ring.scale.setScalar(1.1 + k * 6);
        const o = Math.max(0, 1 - k / 0.4);
        (m.ring.material as THREE.MeshBasicMaterial).opacity = 0.75 * o;
        (m.beam.material as THREE.MeshBasicMaterial).opacity = 0.16 * o;
        (m.label.sprite.material as THREE.SpriteMaterial).opacity = o;
        m.label.sprite.position.y = 1.75 + k * 2;
        if (k > 0.4) {
          m.label.dispose();
          disposeTree(m.group, art);
          crates.splice(i, 1);
        }
      }
    }
  };

  // ---------------------------------------------------------------- door defence
  let wall: PlankWall | null = null;
  let wallLabel: Label | null = null;
  let door = { x: 0, z: 0, fx: 0, fz: 1 };
  let holdE = 0;
  let broken = false;
  let punch = 0;
  let labelKey = -1;
  const plankState = new Int8Array(WALL_PLANKS); // 0 nailed, 1 falling, 2 gone, 3 flying in
  const plankT = new Float32Array(WALL_PLANKS);
  const plankFrom = new Float32Array(WALL_PLANKS * 3);
  let present = WALL_PLANKS;

  const defend = (x: number, z: number, facing: number) => {
    endDefend();
    // Following survivors duck inside the door you're about to hold.
    shelter(x, z);
    ctx.mission.barricade = { active: true, hp: 100, max: 100 };
    const f = (facing * Math.PI) / 180;
    door = { x, z, fx: Math.sin(f), fz: -Math.cos(f) };
    wall = makePlankWall(art, Math.round(Math.abs(x * 31 + z * 17)) + 3);
    // the door point is ~1 m outside the wall; Builder C's planks sit 0.65-0.73 m in from it, ours just in front of them
    wall.group.position.set(x - door.fx * 0.42, 0, z - door.fz * 0.42);
    wall.group.rotation.y = -f;
    root.add(wall.group);
    wallLabel = makeLabel(0.75);
    wallLabel.sprite.position.set(x + door.fx * 0.3, 4.1, z + door.fz * 0.3);
    // never clipped by the door frame (it only exists while you're standing at this door)
    (wallLabel.sprite.material as THREE.SpriteMaterial).depthTest = false;
    wallLabel.sprite.renderOrder = 20;
    root.add(wallLabel.sprite);
    plankState.fill(0);
    plankT.fill(0);
    present = WALL_PLANKS;
    holdE = 0;
    broken = false;
    punch = 0;
    labelKey = -1;
  };
  const endDefend = () => {
    ctx.mission.barricade = { ...ctx.mission.barricade, active: false };
    if (wall) {
      disposeTree(wall.group, art);
      wall = null;
    }
    if (wallLabel) {
      wallLabel.dispose();
      wallLabel = null;
    }
  };

  const updateDefence = (dt: number) => {
    const b = ctx.mission.barricade;
    if (!b.active || !wall) return;
    const p = ctx.player;
    // Capped at 4 pressing zombies (~16 hp/s): a big crowd still takes ~6 s from full, so a board (+25) is worth nailing.
    b.hp = Math.max(0, b.hp - Math.min(4, Math.max(0, ctx.horde.pressing)) * DRAIN_PER_ZOMBIE * dt);
    // repair: hold [E] within 4 m with boards
    const near = !p.hidden && Math.hypot(p.x - door.x, p.z - door.z) < REPAIR_R;
    const holding = near && ctx.input.down.has("KeyE");
    const canNail = holding && ctx.mission.boards > 0 && b.hp < b.max;
    if (canNail) {
      holdE += dt;
      if (holdE >= REPAIR_HOLD_S) {
        holdE = 0;
        ctx.mission.boards -= 1;
        b.hp = Math.min(b.max, b.hp + REPAIR_HP);
        punch = 1;
      }
    } else holdE = Math.max(0, holdE - dt * 2);
    if (b.hp <= 0 && !broken) {
      broken = true;
      bus.emit("mission:barricade-broken", {});
    } else if (b.hp > 0) broken = false;

    // reconcile the planks with hp
    const target = Math.ceil((b.hp / b.max) * WALL_PLANKS - 1e-6);
    while (present > target) {
      present -= 1;
      const i = LOSS_ORDER[present];
      plankState[i] = 1;
      plankT[i] = 0;
      const pl = wall.planks[i];
      V.copy(pl.position);
      wall.group.localToWorld(V);
      puff(V.x, V.y, V.z, 0.4, 1.4, 0.5, 0.4, 0xd6c3a3);
    }
    while (present < target) {
      const i = LOSS_ORDER[present];
      present += 1;
      plankState[i] = 3;
      plankT[i] = 0;
      // fly in from the player's hands (wall-local coordinates)
      V.set(p.x, 1.3, p.z);
      wall.group.worldToLocal(V);
      plankFrom[i * 3] = V.x;
      plankFrom[i * 3 + 1] = V.y;
      plankFrom[i * 3 + 2] = V.z;
    }
    const t = ctx.time;
    const rattle = Math.min(1, ctx.horde.pressing / 4) * 0.02;
    for (let i = 0; i < WALL_PLANKS; i++) {
      const pl = wall.planks[i];
      const rest = wall.rest[i];
      const st = plankState[i];
      if (st === 0) {
        pl.visible = true;
        pl.position.set(rest.x + Math.sin(t * 43 + i * 1.7) * rattle, rest.y + Math.sin(t * 37 + i) * rattle * 0.5, 0);
        pl.rotation.set(0, 0, rest.rz);
      } else if (st === 1) {
        plankT[i] += dt;
        const k = plankT[i];
        pl.position.set(rest.x + k * 0.4, Math.max(0.05, rest.y - 4.9 * k * k), -k * 1.6); // local -z = outward
        pl.rotation.set(k * 2.5, 0, rest.rz + k * 3);
        if (k > 0.7) {
          plankState[i] = 2;
          pl.visible = false;
        }
      } else if (st === 2) {
        pl.visible = false;
      } else {
        plankT[i] += dt;
        const k = Math.min(1, plankT[i] / 0.28);
        const e = 1 - (1 - k) * (1 - k);
        pl.visible = true;
        pl.position.set(
          plankFrom[i * 3] + (rest.x - plankFrom[i * 3]) * e,
          plankFrom[i * 3 + 1] + (rest.y - plankFrom[i * 3 + 1]) * e + Math.sin(k * Math.PI) * 0.6,
          plankFrom[i * 3 + 2] * (1 - e),
        );
        pl.rotation.set(0, (1 - e) * 1.2, rest.rz + (1 - e) * 2);
        if (k >= 1) {
          plankState[i] = 0;
          V.set(rest.x, rest.y, 0.1);
          wall.group.localToWorld(V);
          puff(V.x, V.y, V.z, 0.3, 1.1, 0.45, 0.2, 0xe7d3b0);
          burst(door.x, door.z, 0xfbbf24, 0.5, 2.2, 0.4, 0.1);
        }
      }
    }
    // cracks + darkening as it weakens; a punch when a board goes on
    const frac = b.hp / b.max;
    for (let i = 0; i < wall.cracks.length; i++) wall.cracks[i].visible = frac < 0.85 - i * 0.12;
    wall.wood.color.lerpColors(C_WOOD_BAD, C_WOOD, 0.35 + frac * 0.65);
    punch = Math.max(0, punch - dt * 5);
    wall.group.scale.set(1 + punch * 0.05, 1 + punch * 0.05, 1);
    // camera-safe: the HOLD camera can back up into the doorway; never fill the screen with planks
    const cam = ctx.camera.position;
    wall.group.visible = (cam.x - wall.group.position.x) * door.fx + (cam.z - wall.group.position.z) * door.fz > 0.6;
    if (wallLabel) {
      // the HUD carries the same numbers up close; the in-world prompt is for when you're looking from the street
      const lp = wallLabel.sprite.position;
      (wallLabel.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(1, (Math.hypot(cam.x - lp.x, cam.y - lp.y, cam.z - lp.z) - 3.5) / 2.5));
    }

    // the prompt above the door (redrawn only when its content changes)
    if (wallLabel) {
      const prog = canNail ? Math.min(7, Math.floor((holdE / REPAIR_HOLD_S) * 8)) : -1;
      const boards = ctx.mission.boards;
      const hpQ = Math.round(b.hp / 5) * 5;
      const key = hpQ * 1e6 + Math.min(999, boards) * 1e3 + (near ? 100 : 0) + (prog + 1) * 10 + (b.hp <= 0 ? 1 : 0);
      if (key !== labelKey) {
        labelKey = key;
        const tip = !near ? "Stay by the door" : boards <= 0 ? "No boards: find crates" : b.hp >= b.max ? `Boards ready: ${boards}` : canNail ? `Nailing${".".repeat(1 + (prog % 3))}` : `Hold [E] to nail a board (${boards})`;
        wallLabel.draw(
          [
            { text: b.hp <= 0 ? "BARRICADE DOWN" : `BARRICADE ${Math.round(b.hp)}%`, px: 40, color: b.hp <= 0 ? "#fca5a5" : "#fde68a", weight: 800 },
            { text: tip, px: 26, color: "rgba(241,245,249,0.9)", weight: 600 },
          ],
          { bg: "rgba(10,14,24,0.75)", border: b.hp < 30 ? "rgba(248,113,113,0.9)" : "rgba(251,191,36,0.8)", bar: frac },
        );
      }
    }
  };

  // ---------------------------------------------------------------- debris
  const { mesh: chunkMesh, mat: chunkMat } = makeDebrisMesh(art);
  root.add(chunkMesh);
  const cx = new Float32Array(CHUNKS_MAX);
  const cy = new Float32Array(CHUNKS_MAX);
  const cz = new Float32Array(CHUNKS_MAX);
  const cvy = new Float32Array(CHUNKS_MAX);
  const csz = new Float32Array(CHUNKS_MAX);
  const crx = new Float32Array(CHUNKS_MAX);
  const cry = new Float32Array(CHUNKS_MAX);
  const cspin = new Float32Array(CHUNKS_MAX);
  const czone = new Int16Array(CHUNKS_MAX);
  const cstate = new Int8Array(CHUNKS_MAX); // 0 falling, 1 resting
  const crest = new Float32Array(CHUNKS_MAX);
  let zones: Zone[] = [];
  let debrisT = -1;
  let debrisSecs = 0;
  let debrisTick = 0;
  let rs = 12345;
  const rnd = () => {
    rs = (rs * 16807) % 2147483647;
    return rs / 2147483647;
  };
  const spawnChunk = (i: number, high: boolean) => {
    const z = zones[czone[i]];
    for (let tries = 0; tries < 4; tries++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * z.r * 0.95;
      const [px, pz] = ctx.collide(z.x + Math.sin(a) * rr, z.z - Math.cos(a) * rr, 0.8); // land on the street, not the roof
      cx[i] = px;
      cz[i] = pz;
      if (Math.hypot(px - z.x, pz - z.z) <= z.r) break;
    }
    csz[i] = 0.35 + rnd() * 0.85;
    cy[i] = high ? 12 + rnd() * 10 : 3 + rnd() * 24;
    cvy[i] = -2 - rnd() * 4;
    crx[i] = rnd() * 6;
    cry[i] = rnd() * 6;
    cspin[i] = (rnd() - 0.5) * 8;
    cstate[i] = 0;
  };
  const clearDebris = () => {
    for (const z of zones) {
      z.ring.removeFromParent();
      z.fill.removeFromParent();
      z.ringMat.dispose();
      z.fillMat.dispose();
    }
    zones = [];
    chunkMesh.count = 0;
    debrisT = -1;
  };
  const startDebris = (list: { x: number; z: number; r: number }[], secs: number) => {
    clearDebris();
    rs = 12345 + list.length * 977;
    // nearest zones first: they get the chunks when the cap bites
    const p = ctx.player;
    const sorted = list.slice().sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - a.r - (Math.hypot(b.x - p.x, b.z - p.z) - b.r));
    for (const q of sorted) {
      if (!Number.isFinite(q.x) || !Number.isFinite(q.z) || !(q.r > 0)) continue;
      const ringMat = new THREE.MeshBasicMaterial({ color: 0xff2d2d, transparent: true, opacity: 0.8, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
      const fillMat = new THREE.MeshBasicMaterial({ color: 0xff1f1f, transparent: true, opacity: 0.12, depthWrite: false, fog: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const ring = new THREE.Mesh(art.ring, ringMat);
      ring.scale.set(q.r, 1, q.r);
      ring.position.set(q.x, 0.08, q.z);
      ring.renderOrder = 2;
      const fill = new THREE.Mesh(art.disc, fillMat);
      fill.scale.set(q.r, 1, q.r);
      fill.position.set(q.x, 0.06, q.z);
      fill.renderOrder = 1;
      root.add(fill, ring);
      zones.push({ x: q.x, z: q.z, r: q.r, ring, fill, ringMat, fillMat });
    }
    // chunks per zone by size, capped overall
    let n = 0;
    for (let zi = 0; zi < zones.length && n < CHUNKS_MAX; zi++) {
      const want = Math.max(12, Math.min(32, Math.round(zones[zi].r * 1.5)));
      for (let j = 0; j < want && n < CHUNKS_MAX; j++) {
        czone[n] = zi;
        spawnChunk(n, false);
        n++;
      }
    }
    chunkMesh.count = n;
    debrisT = 0;
    debrisSecs = Math.max(1, secs);
    debrisTick = 0;
  };
  const updateDebris = (dt: number) => {
    if (debrisT < 0) return;
    debrisT += dt;
    const falling = debrisT >= DEBRIS_WARN_S;
    const live = debrisT < DEBRIS_WARN_S + debrisSecs;
    const end = DEBRIS_WARN_S + debrisSecs + 3;
    if (debrisT > end) {
      clearDebris();
      return;
    }
    const t = debrisT;
    for (const z of zones) {
      let o: number;
      if (!falling) o = 0.55 + 0.45 * Math.sin(t * 14);
      else if (live) o = 0.6 + 0.25 * Math.sin(t * 6);
      else o = Math.max(0, 1 - (t - DEBRIS_WARN_S - debrisSecs) / 2) * 0.6;
      z.ringMat.opacity = o;
      z.fillMat.opacity = o * 0.22;
    }
    if (falling) {
      for (let i = 0; i < chunkMesh.count; i++) {
        if (cstate[i] === 0) {
          cvy[i] -= 22 * dt;
          cy[i] += cvy[i] * dt;
          crx[i] += cspin[i] * dt;
          cry[i] += cspin[i] * 0.7 * dt;
          if (cy[i] <= csz[i] * 0.5) {
            cy[i] = csz[i] * 0.5;
            cstate[i] = 1;
            crest[i] = 0.25 + rnd() * 0.6;
            puff(cx[i], 0.5, cz[i], 0.8, 3 + csz[i] * 2.2, 0.9, 0.6, 0xbfb3a0);
          }
        } else {
          crest[i] -= dt;
          if (crest[i] <= 0 && live) spawnChunk(i, true);
        }
      }
      // damage: the player and survivors standing in a zone, about twice a second
      debrisTick += dt;
      if (live && debrisTick >= DEBRIS_TICK_S) {
        debrisTick = 0;
        const dmg = DEBRIS_DPS * DEBRIS_TICK_S;
        const p = ctx.player;
        if (!p.hidden) {
          for (const z of zones) {
            if (Math.hypot(p.x - z.x, p.z - z.z) < z.r) {
              bus.emit("player:hit", { damage: dmg, fromX: z.x, fromZ: z.z });
              break;
            }
          }
        }
        for (const s of survs) {
          if (s.npc.hidden || !s.npc.alive) continue;
          for (const z of zones) {
            if (Math.hypot(s.npc.x - z.x, s.npc.z - z.z) < z.r) {
              hurt(s, dmg, z.x, z.z);
              break;
            }
          }
        }
      }
    }
    for (let i = 0; i < chunkMesh.count; i++) {
      const sc = falling ? csz[i] : 0.0001; // hidden during the warning
      V2.set(cx[i], falling ? cy[i] : -10, cz[i]);
      E.set(crx[i], cry[i], 0);
      Q.setFromEuler(E);
      S.set(sc, sc * 0.7, sc * 0.9);
      M.compose(V2, Q, S);
      chunkMesh.setMatrixAt(i, M);
    }
    chunkMesh.instanceMatrix.needsUpdate = true;
  };

  // ---------------------------------------------------------------- medkit [Q]
  const updateMedkit = () => {
    if (!ctx.input.pressed.has("KeyQ")) return;
    const p = ctx.player;
    const m = ctx.mission;
    if (p.hidden || m.medkits <= 0 || p.health >= 100) return;
    m.medkits -= 1;
    p.health = Math.min(100, p.health + MEDKIT_HP);
    burst(p.x, p.z, 0x4ade80, 0.4, 2.2, 0.6);
    puff(p.x, 1.2, p.z, 0.4, 1.6, 0.6, 0.8, 0x86efac);
    bus.emit("mission:medkit", { hp: p.health });
  };

  // ---------------------------------------------------------------- lifecycle
  function clearAll() {
    for (const c of crates) {
      c.mesh.label.dispose();
      disposeTree(c.mesh.group, art);
    }
    crates = [];
    for (const s of survs) {
      s.name.dispose();
      s.help.dispose();
      disposeTree(s.rig.root, art);
    }
    survs = [];
    joined = 0;
    endDefend();
    clearDebris();
    for (const p of puffs) p.s.visible = false;
    for (const b of bursts) b.m.visible = false;
    ctx.npcs.length = 0;
    Object.assign(ctx.mission, { boards: 0, medkits: 0, found: 0, survivors: [], barricade: { active: false, hp: 100, max: 100 } });
  }

  const offs = [
    bus.on("mission:setup", (e) => setup(e.supplies ?? [], e.survivors ?? [])),
    bus.on("mission:reset", () => clearAll()),
    // Night Shift: the office on record steps out of the building with the player, already following.
    // Desk aftershock: the people trapped in the cracked building wait at its door (HELP beacon) until Bob reaches them.
    bus.on("mission:survivors", (e) => spawnSurvivors(e.survivors ?? [], e.state ?? "following")),
    bus.on("mission:shelter", (e) => shelter(e.x, e.z)),
    bus.on("mission:evacuate", (e) => evacuate(e.x, e.z)),
    bus.on("mission:defend", (e) => defend(e.x, e.z, e.facing)),
    bus.on("mission:defend-end", () => endDefend()),
    bus.on("mission:debris", (e) => startDebris(e.zones ?? [], e.secs)),
    bus.on("npc:hit", (e) => {
      for (const s of survs) if (s.spot.id === e.id) hurt(s, e.damage, e.fromX, e.fromZ);
    }),
  ];

  return {
    update(dt) {
      // the trail the followers walk
      const p = ctx.player;
      const jump = Math.hypot(p.x - plx, p.z - plz);
      if (dt > 0 && jump < 8) {
        const v = Math.min(12, jump / dt);
        pSpeed += (v - pSpeed) * Math.min(1, dt * 6);
      }
      plx = p.x;
      plz = p.z;
      const lx = trailX[trailHead], lz = trailZ[trailHead];
      const step = Math.hypot(p.x - lx, p.z - lz);
      if (step > 8) trailReset(); // teleported (door, rescue): start a fresh trail
      else if (step >= TRAIL_STEP) {
        trailHead = (trailHead + 1) % TRAIL_N;
        trailX[trailHead] = p.x;
        trailZ[trailHead] = p.z;
        trailLen = Math.min(TRAIL_N, trailLen + 1);
      }
      updateMedkit();
      updateCrates(dt);
      updateSurvivors(dt);
      updateDefence(dt);
      updateDebris(dt);
      updateFx(dt);
    },
    dispose() {
      offs.forEach((f) => f());
      clearAll();
      chunkMesh.dispose();
      chunkMat.dispose();
      for (const p of puffs) p.mat.dispose();
      for (const b of bursts) b.mat.dispose();
      root.removeFromParent();
      art.dispose();
    },
  };
}
