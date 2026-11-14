// OWNER: builder B (horde). Low-poly instanced zombies (PG: no gore, no blood) with a small steering brain.
//
// Body: six instanced parts (torso, head, glowing eyes, 2 arms reaching forward, 2 legs) + a red disc per zombie
// on DRONE_LAYER for the drone feed's tactical view. Slots are stable: a zombie keeps its instance index for life.
// Brain: wander (ambient) / march (wave, to the horde target) / chase / attack / staggered (shoved) / leaving (dawn).
// Steering = seek + separation over a hashed 3 m grid (O(n)), ctx.collide for buildings, tangent slide when stuck.
// Everything lives in preallocated typed arrays; the only per-frame garbage is ctx.collide's [x, z] pair.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { blocked } from "./collide";
import { dirOf, NOTICE_R, PLAYER_R, SECTOR_DEG, ZOMBIE_CHASE, ZOMBIE_R, ZOMBIE_WALK, type FootCtx, type System } from "./engine";
import { createHordeCollide } from "./hordeCollide";
import { createFlowGrid, PLAYER_RADIUS_CELLS } from "./hordeFlow";
import { DRONE_LAYER } from "./hordeLayers";

const MAX = 260; // hard cap on live zombies
const WAVE_CAP = 220;

// states
const FREE = 0, PENDING = 1, WANDER = 2, MARCH = 3, CHASE = 4, ATTACK = 5, STAGGER = 6, LEAVING = 7, STUN = 8, LURED = 9;
// kinds
const AMBIENT = 0, WAVE = 1, PACK = 2;

const HIT_R = 1.1, HIT_DAMAGE = 4, HIT_CD = 1; // forgiving for first-time players (was 7)
// Playability: however big the crowd, at most this many hits land on the player per second (the rest jostle).
const PLAYER_HITS_PER_S = 2;
// Flares: zombies within LURE_R that aren't in contact walk to the flare, crowd it and sway until it burns out.
const LURE_R = 35, LURE_NOTICE = 4, LURE_CROWD = 3.2, FLARE_SLOTS = 3, LURE_FIELD_CELLS = 24;
// Flashlight stun: hold the beam (within STUN_R, +-STUN_HALF of the aim, line of sight) on a zombie for STUN_HOLD s.
const STUN_R = 14, STUN_HALF = (12 * Math.PI) / 180, STUN_HOLD = 1.2, STUN_S = 2.5, STUN_CD = 6;
const SHOVE_R = 2.8, SHOVE_COS = Math.cos((70 * Math.PI) / 180), SHOVE_DIST = 3, KB_TAU = 0.25, STAGGER_S = 1.2;
const CLOSE_NOTICE = 6, SPRINT_NOTICE = 1.6, LOSE_R = NOTICE_R * 2.4;
const CELL = 3, GRID_BITS = 6, GRID_MASK = (1 << GRID_BITS) - 1, NB = 1 << (GRID_BITS * 2);
const SEP_D = ZOMBIE_R * 2.15, SEP_D2 = SEP_D * SEP_D;
const RISE_S = 1.2, SINK_S = 4, SINK_DEPTH = 2.1;
const WANDER_SPEED = ZOMBIE_WALK * 0.6;
const MARCH_SPEED = ZOMBIE_WALK * 1.65; // ~2.5 m/s: the wave reaches the door in ~30-45 s
const MOB_R = 7; // marchers this close to the target crowd and pound on it
const AMBIENT_MIN = 45, AMBIENT_MAX = 100, AMBIENT_RECYCLE = 170;
const TRICKLE_S = 8;
const BREACH_RESERVE = 30; // slots a wave leaves free so a breach always has bodies
const AMBIENT_PER_TICK = 3; // ramping up (14 -> 40 at nightfall) spawns a few at a time, out of sight
const PACK_R = 6;
const PRESS_R = 2.5; // ctx.horde.pressing counts zombies this close to the horde target
const QMAX = 17; // the player + up to 16 npcs

// body proportions (metres, before the per-zombie scale)
const HIP_Y = 0.86, HIP_X = 0.12, TORSO_H = 0.62, SHOULDER_X = 0.31;

const SHIRTS = [0x5b4a3a, 0x3f4a5a, 0x6a5f4a, 0x5a3b3b, 0x55604a, 0x6e6e6e, 0x3a3f36, 0x7a6a55, 0x4a5568, 0x6b4f3f, 0x5f5a6e, 0x4f5f5a];
const PANTS = [0x2f3440, 0x3b3226, 0x2a2a2a, 0x40463a, 0x4a3f35, 0x30384a, 0x3c3c44];

/** How far from p you can travel along direction f before leaving [lo, hi] (3 m margin). */
function reach(p: number, f: number, lo: number, hi: number): number {
  if (f > 1e-6) return (hi - 3 - p) / f;
  if (f < -1e-6) return (lo + 3 - p) / f;
  return Infinity;
}

function box(w: number, h: number, d: number, ox: number, oy: number, oz: number) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(ox, oy, oz);
  return g;
}

export function createHorde(ctx: FootCtx): System {
  const { scene, bus } = ctx;
  const P = ctx.player;

  // ------------------------------------------------------------------ meshes
  const geoTorso = box(0.5, TORSO_H, 0.27, 0, TORSO_H / 2, 0);
  const geoHead = box(0.25, 0.28, 0.26, 0, 0.14, 0);
  const eyeL = box(0.055, 0.035, 0.02, -0.06, 0.165, -0.135);
  const eyeR = box(0.055, 0.035, 0.02, 0.06, 0.165, -0.135);
  const geoEyes = mergeGeometries([eyeL, eyeR]) ?? eyeL;
  const geoArm = box(0.12, 0.64, 0.13, 0, -0.3, 0);
  const geoLeg = box(0.17, 0.84, 0.19, 0, -0.42, 0);
  const geoDisc = new THREE.CircleGeometry(1.25, 10);
  geoDisc.rotateX(-Math.PI / 2);

  const matCloth = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x151515 });
  const matSkin = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x223018 });
  // a faint cool rim on the silhouettes, so a crowd reads against the dark street beyond the flashlight
  for (const m of [matCloth, matSkin]) {
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\n  float rimK = 1.0 - abs(dot(normal, normalize(vViewPosition)));\n  totalEmissiveRadiance += vec3(0.10, 0.15, 0.13) * rimK * rimK * rimK;",
      );
    };
  }
  const matEyes = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false }); // the eye colour is per instance
  const matDisc = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, fog: false });

  const mk = (g: THREE.BufferGeometry, m: THREE.Material, n: number) => {
    const im = new THREE.InstancedMesh(g, m, n);
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.frustumCulled = false; // instances move; the cached bounding sphere would go stale
    im.castShadow = false;
    im.receiveShadow = false;
    const white = new THREE.Color(1, 1, 1);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let k = 0; k < n; k++) {
      im.setMatrixAt(k, zero);
      im.setColorAt(k, white); // create instanceColor up front so the program compiles with it
    }
    scene.add(im);
    return im;
  };
  const torso = mk(geoTorso, matCloth, MAX);
  const legs = mk(geoLeg, matCloth, MAX * 2);
  const head = mk(geoHead, matSkin, MAX);
  const arms = mk(geoArm, matSkin, MAX * 2);
  const eyes = mk(geoEyes, matEyes, MAX);
  const discs = mk(geoDisc, matDisc, MAX);
  discs.layers.set(DRONE_LAYER);
  discs.renderOrder = 60; // over the player's amber marker, so a crowd on you shows
  const meshes = [torso, legs, head, arms, eyes, discs];

  // ------------------------------------------------------------------ state (typed arrays, one slot per zombie)
  const st = new Uint8Array(MAX);
  const after = new Uint8Array(MAX); // state to enter when a PENDING zombie wakes
  const kind = new Uint8Array(MAX);
  const x = new Float32Array(MAX), z = new Float32Array(MAX);
  const vx = new Float32Array(MAX), vz = new Float32Array(MAX);
  const kvx = new Float32Array(MAX), kvz = new Float32Array(MAX); // knockback velocity
  const yaw = new Float32Array(MAX), spd = new Float32Array(MAX), phase = new Float32Array(MAX);
  const wakeAt = new Float32Array(MAX), rise = new Float32Array(MAX), sink = new Float32Array(MAX);
  const timer = new Float32Array(MAX), hitCd = new Float32Array(MAX), noticeT = new Float32Array(MAX);
  const stuckT = new Float32Array(MAX), lastX = new Float32Array(MAX), lastZ = new Float32Array(MAX);
  const slideT = new Float32Array(MAX), slideSign = new Int8Array(MAX);
  const wx = new Float32Array(MAX), wz = new Float32Array(MAX);
  const mob = new Uint8Array(MAX);
  const los = new Uint8Array(MAX);
  const lit = new Float32Array(MAX), stunCd = new Float32Array(MAX); // flashlight: seconds held in the beam, cooldown
  const lure = new Int8Array(MAX).fill(-1); // flare slot a LURED zombie walks to
  const hx = new Float32Array(MAX), hz = new Float32Array(MAX); // a pack's home (the survivor it guards) // chasers: can they see the player (refreshed a few times a second)
  // looks (fixed per zombie)
  const scale = new Float32Array(MAX), seed = new Float32Array(MAX), hunch = new Float32Array(MAX);
  const armL0 = new Float32Array(MAX), armR0 = new Float32Array(MAX), headRoll = new Float32Array(MAX), speedMul = new Float32Array(MAX);
  // separation
  const cx = new Float32Array(MAX), cz = new Float32Array(MAX);
  const gridHead = new Int32Array(NB), gridNext = new Int32Array(MAX);
  // free list
  const freeStack = new Int16Array(MAX);
  let freeTop = 0;
  for (let i = MAX - 1; i >= 0; i--) freeStack[freeTop++] = i;

  let ambWant = 0, ambT = 0;
  // navigation: grid push-out (no garbage) + flow fields around the blocks
  const hc = createHordeCollide(ctx.colliders, ctx.bounds);
  const grid = createFlowGrid(ctx.colliders, ctx.bounds);
  const toTarget = grid.makeField(Infinity);
  const toPlayer = grid.makeField(PLAYER_RADIUS_CELLS);
  // lit road flares (slots recycled; flEnd = burn-out time)
  const flX = new Float64Array(FLARE_SLOTS), flZ = new Float64Array(FLARE_SLOTS), flEnd = new Float64Array(FLARE_SLOTS).fill(-1);
  const flField = Array.from({ length: FLARE_SLOTS }, () => grid.makeField(LURE_FIELD_CELLS));
  let playerFieldT = 0, needPlayerField = false;
  const cbuf = new Float64Array(2), fbuf = new Float64Array(2);
  let hasTarget = false, tx = 0, tz = 0;
  // who the horde can go after this frame: the player (when not hidden) + live, visible npcs
  const qX = new Float64Array(QMAX), qZ = new Float64Array(QMAX), qNpc = new Int16Array(QMAX);
  const hitLog = new Float64Array(PLAYER_HITS_PER_S).fill(-99); // ring of the last player-hit times
  let hitAt = 0;

  const col = new THREE.Color();
  const markColor = { calm: new THREE.Color(0xc21d1d), hot: new THREE.Color(0xff3b30) };
  const eyeBase = new THREE.Color(0xc8ff7a), eyeHot = new THREE.Color(1.6, 1.6, 1.3), eyeDim = new THREE.Color(0x1d2a12), eyeTmp = new THREE.Color();

  function paint(i: number) {
    const skin = col.setHSL(0.2 + Math.random() * 0.11, 0.14 + Math.random() * 0.16, 0.36 + Math.random() * 0.16);
    head.setColorAt(i, skin);
    const shirt = SHIRTS[(Math.random() * SHIRTS.length) | 0];
    const sleeves = Math.random() < 0.45;
    if (!sleeves) {
      arms.setColorAt(i * 2, skin);
      arms.setColorAt(i * 2 + 1, skin);
    }
    col.setHex(shirt).multiplyScalar(0.85 + Math.random() * 0.3);
    torso.setColorAt(i, col);
    if (sleeves) {
      arms.setColorAt(i * 2, col);
      arms.setColorAt(i * 2 + 1, col);
    }
    col.setHex(PANTS[(Math.random() * PANTS.length) | 0]).multiplyScalar(0.85 + Math.random() * 0.3);
    legs.setColorAt(i * 2, col);
    legs.setColorAt(i * 2 + 1, col);
    torso.instanceColor!.needsUpdate = true;
    head.instanceColor!.needsUpdate = true;
    arms.instanceColor!.needsUpdate = true;
    legs.instanceColor!.needsUpdate = true;
  }

  /** Take a free slot and set a zombie up at (px, pz). Returns -1 when the cap is reached. */
  function spawn(px: number, pz: number, k: number, state: number, wake: number, rising: boolean): number {
    if (freeTop === 0) return -1;
    const i = freeStack[--freeTop];
    st[i] = wake > ctx.time ? PENDING : state;
    after[i] = state;
    kind[i] = k;
    x[i] = px;
    z[i] = pz;
    vx[i] = vz[i] = kvx[i] = kvz[i] = 0;
    yaw[i] = Math.random() * Math.PI * 2;
    if (hasTarget && state === MARCH) yaw[i] = Math.atan2(tx - px, -(tz - pz));
    spd[i] = 0;
    phase[i] = Math.random() * 6.28;
    wakeAt[i] = wake;
    rise[i] = rising ? 1 : 0;
    sink[i] = 0;
    timer[i] = 0;
    hitCd[i] = 0.4;
    noticeT[i] = Math.random() * 0.3;
    stuckT[i] = 0;
    lastX[i] = px;
    lastZ[i] = pz;
    slideT[i] = 0;
    slideSign[i] = Math.random() < 0.5 ? -1 : 1;
    wx[i] = px;
    wz[i] = pz;
    mob[i] = 0;
    los[i] = 1;
    lit[i] = 0;
    stunCd[i] = 0;
    lure[i] = -1;
    scale[i] = 0.9 + Math.random() * 0.2;
    seed[i] = Math.random();
    hunch[i] = 0.12 + Math.random() * 0.3;
    armL0[i] = 1.05 + Math.random() * 0.45;
    armR0[i] = Math.random() < 0.2 ? 0.35 + Math.random() * 0.4 : 1.05 + Math.random() * 0.45; // a few dangle one arm
    headRoll[i] = (Math.random() * 2 - 1) * 0.35;
    speedMul[i] = 0.85 + Math.random() * 0.3;
    paint(i);
    return i;
  }

  function free(i: number) {
    st[i] = FREE;
    freeStack[freeTop++] = i;
  }

  /** Where a zombie goes when it loses its quarry: packs go home, wave zombies (and everyone while the player hides) to the target. */
  const fallbackState = (i: number) => (kind[i] === PACK ? WANDER : hasTarget && (kind[i] === WAVE || P.hidden) ? MARCH : WANDER);

  /** Free k slots by dropping the zombies farthest from the player that aren't after anyone (ambient first). */
  function reclaim(k: number) {
    for (; k > 0; k--) {
      let best = -1, bd = 30, bAmb = false;
      for (let i = 0; i < MAX; i++) {
        const s = st[i];
        if ((s !== WANDER && s !== MARCH && s !== PENDING) || kind[i] === PACK) continue;
        const d = Math.hypot(x[i] - P.x, z[i] - P.z);
        const amb = kind[i] === AMBIENT;
        if ((amb && !bAmb) || (amb === bAmb && d > bd)) {
          best = i;
          bd = d;
          bAmb = amb;
        }
      }
      if (best < 0) return;
      free(best);
    }
  }

  /** A street point AMBIENT_MIN..AMBIENT_MAX m from the player, pushed out of buildings (null when none found). */
  function ambientPoint(): [number, number] | null {
    const fx = Math.sin(P.yaw), fz = -Math.cos(P.yaw);
    let fallback: [number, number] | null = null;
    for (let t = 0; t < 12; t++) {
      const a = Math.random() * Math.PI * 2;
      const r = AMBIENT_MIN + Math.random() * (AMBIENT_MAX - AMBIENT_MIN);
      const [px, pz] = ctx.collide(P.x + Math.sin(a) * r, P.z - Math.cos(a) * r, ZOMBIE_R);
      if (Math.hypot(px - P.x, pz - P.z) < AMBIENT_MIN || !grid.walkable(px, pz)) continue;
      // prefer a spot the player can't see: behind them, or around a corner
      if ((px - P.x) * fx + (pz - P.z) * fz < 0 || blocked(P.x, P.z, px, pz, ctx.colliders)) return [px, pz];
      fallback ??= [px, pz];
    }
    return fallback;
  }

  /** The horde target, nudged out of any wall it sits on (a door), so the crowd (and `pressing`) can reach it. */
  function setTarget(x0: number, z0: number) {
    const [x1, z1] = ctx.collide(x0, z0, ZOMBIE_R);
    const moved = !hasTarget || Math.hypot(x1 - tx, z1 - tz) > 1;
    tx = x1;
    tz = z1;
    hasTarget = true;
    if (moved || !toTarget.ready) toTarget.build(tx, tz);
  }

  // ------------------------------------------------------------------ events
  const offs: (() => void)[] = [];

  offs.push(
    bus.on("horde:ambient", (e) => {
      ambWant = Math.max(0, Math.min(60, e.count | 0));
      ambT = 0;
    }),
  );

  offs.push(
    bus.on("wave:start", (e) => {
      const n = Math.min(Math.round(e.size * 0.3), WAVE_CAP, freeTop - BREACH_RESERVE);
      if (n <= 0) return;
      setTarget(e.targetX, e.targetZ);
      const [fx, fz] = dirOf(SECTOR_DEG[e.sector] ?? 0);
      const lx = -fz, lz = fx;
      // Over-sample, then put the nearest (to the player) first, and of those the ones the player can see.
      const cand: { x: number; z: number; d: number; los: boolean }[] = [];
      for (let k = 0, tries = 0; k < n * 2 && tries < n * 8; tries++) {
        const lat = (Math.random() * 2 - 1) * 45;
        let along = 70 + Math.random() * 45;
        // a sector that points off the map would pile everyone on the boundary: shorten the reach to fit
        const bx = tx + lx * lat, bz = tz + lz * lat;
        const room = Math.min(reach(bx, fx, ctx.bounds.x0, ctx.bounds.x1), reach(bz, fz, ctx.bounds.z0, ctx.bounds.z1));
        if (along > room) along = Math.max(30, room * (0.55 + Math.random() * 0.45));
        const [px, pz] = ctx.collide(bx + fx * along, bz + fz * along, ZOMBIE_R);
        if (tries < n * 6 && !toTarget.reachable(px, pz)) continue; // a courtyard with no way out
        cand.push({ x: px, z: pz, d: Math.hypot(px - P.x, pz - P.z), los: false });
        k++;
      }
      cand.sort((a, b) => a.d - b.d);
      const near = cand.slice(0, Math.min(cand.length, 60));
      for (const c of near) c.los = !blocked(c.x, c.z, P.x, P.z, ctx.colliders);
      const seen = near.filter((c) => c.los).slice(0, 10);
      // every other remaining candidate keeps the band's spread (still sorted nearest first)
      const rest = cand.filter((c) => !seen.includes(c));
      const pick = seen.concat(rest.filter((_, k) => k % 2 === 0), rest.filter((_, k) => k % 2 === 1)).slice(0, n);
      const now = ctx.time;
      pick.forEach((c, k) => {
        // front-load: the first handful wake almost at once, the rest trickle in over TRICKLE_S
        const t = k < 6 ? k * 0.25 : 1.5 + ((k - 6) / Math.max(1, n - 6)) * (TRICKLE_S - 1.5);
        spawn(c.x, c.z, WAVE, MARCH, now + t, true);
      });
    }),
  );

  offs.push(
    bus.on("horde:target", (e) => {
      setTarget(e.x, e.z);
    }),
  );

  offs.push(
    bus.on("wave:breach", (e) => {
      const now = ctx.time;
      // the crowd at the door reacts a beat late, so the player gets a head start
      for (let i = 0; i < MAX; i++) {
        if (st[i] < WANDER || st[i] === LEAVING) continue;
        if (Math.hypot(x[i] - e.x, z[i] - e.z) < 16) {
          st[i] = STAGGER;
          timer[i] = 0.5 + Math.random() * 0.9;
        }
      }
      const n = Math.max(0, Math.min(e.count | 0, 80));
      if (freeTop < n) reclaim(n - freeTop);
      for (let k = 0; k < n; k++) {
        const [px, pz] = ctx.collide(e.x + (Math.random() * 2 - 1) * 1.5, e.z + (Math.random() * 2 - 1) * 1.5, ZOMBIE_R);
        spawn(px, pz, WAVE, CHASE, now + 0.35 + k * 0.07, false);
      }
    }),
  );

  offs.push(
    bus.on("horde:pack", (e) => {
      const n = Math.max(0, Math.min(e.count | 0, 20));
      if (freeTop < n) reclaim(n - freeTop);
      for (let k = 0; k < n; k++) {
        const a = Math.random() * Math.PI * 2, r = 1.5 + Math.random() * (PACK_R - 1.5);
        const [px, pz] = ctx.collide(e.x + Math.sin(a) * r, e.z - Math.cos(a) * r, ZOMBIE_R);
        const i = spawn(px, pz, PACK, WANDER, 0, false);
        if (i < 0) break;
        hx[i] = e.x;
        hz[i] = e.z;
        timer[i] = Math.random() * 2;
      }
    }),
  );

  offs.push(
    bus.on("flare:lit", (e) => {
      // take an expired slot, else the one burning out soonest (its crowd resumes, or is re-lured below)
      let k = 0;
      for (let j = 1; j < FLARE_SLOTS; j++) if (flEnd[j] < flEnd[k]) k = j;
      for (let i = 0; i < MAX; i++) if (st[i] === LURED && lure[i] === k) st[i] = fallbackState(i);
      flX[k] = e.x;
      flZ[k] = e.z;
      flEnd[k] = ctx.time + Math.max(0.5, Number(e.secs) || 8);
      flField[k].build(e.x, e.z);
      for (let i = 0; i < MAX; i++) {
        const s = st[i];
        if (s !== WANDER && s !== MARCH && s !== CHASE && s !== LURED) continue; // attacking, stunned, staggered: busy
        const fd = Math.hypot(x[i] - e.x, z[i] - e.z);
        if (fd > LURE_R) continue;
        if (s === CHASE && Math.hypot(x[i] - P.x, z[i] - P.z) < HIT_R + 0.6) continue; // in contact: not distracted
        if (s === LURED && lure[i] >= 0 && Math.hypot(x[i] - flX[lure[i]], z[i] - flZ[lure[i]]) < fd) continue; // a nearer flare
        st[i] = LURED;
        lure[i] = k;
        slideT[i] = 0;
      }
    }),
  );

  offs.push(
    bus.on("horde:repel", (e) => {
      for (let i = 0; i < MAX; i++) {
        if (st[i] < WANDER || st[i] === LEAVING) continue;
        let dx = x[i] - e.x, dz = z[i] - e.z;
        const d = Math.hypot(dx, dz);
        if (d >= e.r) continue;
        if (d < 0.01) {
          const a = Math.random() * Math.PI * 2;
          dx = Math.sin(a);
          dz = Math.cos(a);
        } else {
          dx /= d;
          dz /= d;
        }
        const [px, pz] = ctx.collide(e.x + dx * e.r, e.z + dz * e.r, ZOMBIE_R);
        x[i] = px;
        z[i] = pz;
        vx[i] = vz[i] = kvx[i] = kvz[i] = 0;
        st[i] = STAGGER;
        timer[i] = 1.5;
      }
    }),
  );

  offs.push(
    bus.on("player:shove", (e) => {
      const fx = Math.sin(e.yaw), fz = -Math.cos(e.yaw);
      const v0 = SHOVE_DIST / KB_TAU; // exponential decay travels v0 * tau
      for (let i = 0; i < MAX; i++) {
        const s = st[i];
        if (s < WANDER || s === LEAVING) continue;
        const dx = x[i] - e.x, dz = z[i] - e.z;
        const d = Math.hypot(dx, dz);
        if (d > SHOVE_R || d < 1e-3) continue;
        if ((dx * fx + dz * fz) / d < SHOVE_COS) continue;
        kvx[i] = (dx / d) * v0;
        kvz[i] = (dz / d) * v0;
        vx[i] = vz[i] = 0;
        st[i] = STAGGER;
        timer[i] = STAGGER_S;
        rise[i] = 0;
      }
    }),
  );

  offs.push(
    bus.on("horde:clear", () => {
      ambWant = 0;
      hasTarget = false;
      for (let i = 0; i < MAX; i++) {
        if (st[i] === PENDING) free(i);
        else if (st[i] !== FREE && st[i] !== LEAVING) {
          st[i] = LEAVING;
          sink[i] = 0;
          timer[i] = Math.random() * 0.6; // don't all turn on the same frame
        }
      }
    }),
  );

  // ------------------------------------------------------------------ scratch for matrices (no per-frame allocs)
  const mB = new THREE.Matrix4(), mT = new THREE.Matrix4(), mH = new THREE.Matrix4(), mL = new THREE.Matrix4(), mO = new THREE.Matrix4();
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const qa = new THREE.Quaternion(), eu = new THREE.Euler(), va = new THREE.Vector3(), vs = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1);
  const UP = new THREE.Vector3(0, 1, 0);
  const local = (m: THREE.Matrix4, ox: number, oy: number, oz: number, rx: number, rz: number) => {
    eu.set(rx, 0, rz);
    qa.setFromEuler(eu);
    va.set(ox, oy, oz);
    return m.compose(va, qa, ONE);
  };

  // ------------------------------------------------------------------ the loop
  function update(dt: number) {
    const now = ctx.time;
    const seen = !P.hidden;
    const cols = ctx.colliders;

    // ambient upkeep (twice a second)
    ambT -= dt;
    if (ambT <= 0) {
      ambT = 0.5;
      let n = 0;
      for (let i = 0; i < MAX; i++) {
        if (kind[i] !== AMBIENT || st[i] === FREE || st[i] === LEAVING) continue;
        if (st[i] === WANDER && Math.hypot(x[i] - P.x, z[i] - P.z) > AMBIENT_RECYCLE) {
          const q = ambientPoint(); // the player walked away: bring this one back into play
          if (q) {
            x[i] = lastX[i] = wx[i] = q[0];
            z[i] = lastZ[i] = wz[i] = q[1];
            rise[i] = 1;
          }
        }
        if (n >= ambWant) {
          st[i] = st[i] === PENDING ? FREE : LEAVING;
          if (st[i] === FREE) freeStack[freeTop++] = i;
          else sink[i] = 0;
          continue;
        }
        n++;
      }
      for (let made = 0; n < ambWant && made < AMBIENT_PER_TICK; n++, made++) {
        const q = ambientPoint();
        if (!q || spawn(q[0], q[1], AMBIENT, WANDER, 0, true) < 0) break;
      }
    }

    // spatial hash: who is near whom
    gridHead.fill(-1);
    for (let i = 0; i < MAX; i++) {
      cx[i] = 0;
      cz[i] = 0;
      if (st[i] < WANDER) continue;
      const b = ((Math.floor(x[i] / CELL) & GRID_MASK) << GRID_BITS) | (Math.floor(z[i] / CELL) & GRID_MASK);
      gridNext[i] = gridHead[b];
      gridHead[b] = i;
    }
    // separation: split the overlap of every close pair (each pair once: j > i)
    for (let i = 0; i < MAX; i++) {
      if (st[i] < WANDER || rise[i] > 0) continue;
      const gx0 = Math.floor(x[i] / CELL), gz0 = Math.floor(z[i] / CELL);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          let j = gridHead[(((gx0 + ox) & GRID_MASK) << GRID_BITS) | ((gz0 + oz) & GRID_MASK)];
          for (; j !== -1; j = gridNext[j]) {
            if (j <= i || rise[j] > 0) continue;
            const dx = x[i] - x[j], dz = z[i] - z[j];
            const d2 = dx * dx + dz * dz;
            if (d2 >= SEP_D2) continue;
            let d = Math.sqrt(d2);
            let ux = dx, uz = dz;
            if (d < 1e-4) {
              ux = seed[i] - 0.5;
              uz = seed[j] - 0.5;
              d = Math.hypot(ux, uz) || 1;
            }
            const push = (SEP_D - d) * 0.5;
            ux /= d;
            uz /= d;
            cx[i] += ux * push;
            cz[i] += uz * push;
            cx[j] -= ux * push;
            cz[j] -= uz * push;
          }
        }
      }
    }

    // chasers that lost sight of the player follow a local flow field toward them (rebuilt ~4x a second)
    playerFieldT -= dt;
    if (needPlayerField && seen && playerFieldT <= 0) {
      playerFieldT = 0.25;
      toPlayer.build(P.x, P.z);
    }
    needPlayerField = false;

    const kbDecay = Math.exp(-dt / KB_TAU);
    const noticeR = NOTICE_R * (P.sprinting ? SPRINT_NOTICE : 1);
    let alive = 0, chasing = 0, nearest = Infinity, pressing = 0;
    // the player's flashlight (on at night, not inside): aim = yaw (+ pitch, leniently)
    const beamOn = ctx.dawn < 0.5 && !P.hidden;
    const afx = Math.sin(P.yaw), afz = -Math.cos(P.yaw), beamPitch = P.pitch - 0.1;
    let qn = 0;
    if (seen) {
      qX[0] = P.x;
      qZ[0] = P.z;
      qNpc[0] = -1;
      qn = 1;
    }
    const npcs = ctx.npcs;
    for (let k = 0; k < npcs.length && qn < QMAX; k++) {
      const n = npcs[k];
      if (!n.alive || n.hidden) continue;
      qX[qn] = n.x;
      qZ[qn] = n.z;
      qNpc[qn] = k;
      qn++;
    }

    for (let i = 0; i < MAX; i++) {
      let s = st[i];
      if (s === FREE) continue;
      if (s === PENDING) {
        if (now < wakeAt[i]) continue;
        s = st[i] = after[i];
      }
      const zx = x[i], zz = z[i];
      const pdx = P.x - zx, pdz = P.z - zz;
      const pd = Math.hypot(pdx, pdz) || 1e-3;

      if (rise[i] > 0) {
        // climbing out of the ground: no steering yet
        rise[i] = Math.max(0, rise[i] - dt / RISE_S);
        phase[i] += dt * 2;
        if (s !== LEAVING) {
          alive++;
          if (pd < nearest) nearest = pd;
        }
        continue;
      }

      // the nearest quarry (the player or a survivor); d = Infinity when nobody is out
      let qk = -1, d2 = Infinity;
      for (let k = 0; k < qn; k++) {
        const ex = qX[k] - zx, ez = qZ[k] - zz, e2 = ex * ex + ez * ez;
        if (e2 < d2) {
          d2 = e2;
          qk = k;
        }
      }
      const qxx = qk >= 0 ? qX[qk] : P.x, qzz = qk >= 0 ? qZ[qk] : P.z;
      const dx = qxx - zx, dz = qzz - zz;
      const d = qk >= 0 ? Math.sqrt(d2) || 1e-3 : Infinity;
      const onPlayer = qk >= 0 && qNpc[qk] < 0;

      hitCd[i] -= dt;
      mob[i] = 0;

      // flashlight: held on a zombie long enough, it's dazzled (stunned) for a moment
      stunCd[i] -= dt;
      let inBeam = false;
      if (beamOn && s !== STUN && s !== LEAVING && stunCd[i] <= 0 && pd < STUN_R && pd > 0.3) {
        const cosH = -(pdx * afx + pdz * afz) / pd; // the zombie is at -pd from the player
        const half = STUN_HALF + Math.atan(0.35 / pd); // its body has width: easier up close
        if (cosH > Math.cos(half) && Math.abs(beamPitch - Math.atan2(-0.1, pd)) < half + 0.25) inBeam = !blocked(P.x, P.z, zx, zz, cols);
      }
      lit[i] = inBeam ? lit[i] + dt : Math.max(0, lit[i] - dt * 2);
      if (lit[i] >= STUN_HOLD) {
        s = STUN;
        timer[i] = STUN_S;
        lit[i] = 0;
        stunCd[i] = STUN_S + STUN_CD;
        vx[i] = vz[i] = 0;
        bus.emit("zombie:stunned", { x: zx, z: zz });
      }

      // noticing / losing the player
      if (s === LURED) {
        // mesmerised: only someone right next to it breaks the spell
        if (qk >= 0 && d < LURE_NOTICE) {
          s = CHASE;
          los[i] = 1;
        } else if (lure[i] < 0 || now >= flEnd[lure[i]]) s = fallbackState(i);
      }
      if (s === WANDER || s === MARCH) {
        noticeT[i] -= dt;
        if (noticeT[i] <= 0) {
          noticeT[i] = 0.2 + Math.random() * 0.15;
          if (s === MARCH && hasTarget) {
            // marchers near the target: can they walk straight at it? (end the ray just short of the wall)
            const tdx = tx - zx, tdz = tz - zz, td = Math.hypot(tdx, tdz) || 1;
            los[i] = td < 35 && !blocked(zx, zz, tx - (tdx / td) * 1.2, tz - (tdz / td) * 1.2, cols) ? 1 : 0;
          }
          if (qk >= 0 && (d < CLOSE_NOTICE || (d < (onPlayer ? noticeR : NOTICE_R) && !blocked(zx, zz, qxx, qzz, cols)))) {
            s = CHASE;
            los[i] = 1;
          }
        }
      } else if ((s === CHASE || s === ATTACK) && d > LOSE_R) {
        s = fallbackState(i);
      } else if (s === CHASE) {
        noticeT[i] -= dt;
        if (noticeT[i] <= 0) {
          noticeT[i] = 0.25 + Math.random() * 0.15;
          los[i] = d < 4 || !blocked(zx, zz, qxx, qzz, cols) ? 1 : 0;
        }
      }

      // desired direction (gx, gz) and speed sp
      let gx = 0, gz = 0, sp = 0;
      if (s === WANDER) {
        timer[i] -= dt;
        const wdx = wx[i] - zx, wdz = wz[i] - zz;
        const wd = Math.hypot(wdx, wdz);
        if (timer[i] <= 0 || wd < 0.8) {
          if (Math.random() < 0.3) {
            wx[i] = zx;
            wz[i] = zz;
            timer[i] = 1.5 + Math.random() * 2.5; // stand and sway
          } else {
            const pack = kind[i] === PACK;
            for (let t = 0; t < 4; t++) {
              const a = Math.random() * Math.PI * 2, r = pack ? 1.5 + Math.random() * (PACK_R - 1.5) : 5 + Math.random() * 12;
              wx[i] = (pack ? hx[i] : zx) + Math.sin(a) * r;
              wz[i] = (pack ? hz[i] : zz) - Math.cos(a) * r;
              if (grid.walkable(wx[i], wz[i])) break;
            }
            timer[i] = 6 + Math.random() * 6;
          }
        } else if (wd > 0.8) {
          gx = wdx / wd;
          gz = wdz / wd;
          sp = WANDER_SPEED * speedMul[i];
        }
      } else if (s === MARCH) {
        if (!hasTarget) s = WANDER;
        else {
          const tdx = tx - zx, tdz = tz - zz;
          const td = Math.hypot(tdx, tdz) || 1e-3;
          gx = tdx / td;
          gz = tdz / td;
          const lane = (seed[i] - 0.5) * 2; // -1..1: each zombie keeps its own lane, so they arrive as a crowd, not a queue
          if (td > MOB_R && los[i]) {
            const ox = tx - tdz / td * lane * 4 - zx, oz = tz + tdx / td * lane * 4 - zz; // aim a few metres either side
            const ol = Math.hypot(ox, oz) || 1;
            gx = ox / ol;
            gz = oz / ol;
          } else if (td > MOB_R + 2 && toTarget.dir(zx, zz, fbuf)) {
            // around the blocks, down the streets (fanned out a little)
            const a = lane * 0.3, ca = Math.cos(a), sa = Math.sin(a);
            gx = fbuf[0] * ca - fbuf[1] * sa;
            gz = fbuf[0] * sa + fbuf[1] * ca;
          }
          if (td < MOB_R) {
            mob[i] = 1;
            sp = 0.75; // press into the crowd at the door
          } else sp = MARCH_SPEED * speedMul[i];
        }
      } else if (s === CHASE || s === ATTACK) {
        if (s === CHASE && d < HIT_R) s = ATTACK;
        else if (s === ATTACK && d > HIT_R + 0.5) s = CHASE;
        gx = dx / d;
        gz = dz / d;
        if (s === CHASE && !los[i] && d > 3) {
          needPlayerField = true;
          if (toPlayer.dir(zx, zz, fbuf)) {
            gx = fbuf[0];
            gz = fbuf[1];
          }
        }
        sp = s === ATTACK ? (d > 0.95 ? 0.9 : 0) : ZOMBIE_CHASE * (0.9 + (speedMul[i] - 0.85) * 0.6);
        if (d < HIT_R && hitCd[i] <= 0) {
          if (!onPlayer) {
            hitCd[i] = HIT_CD;
            bus.emit("npc:hit", { id: npcs[qNpc[qk]].id, damage: HIT_DAMAGE, fromX: zx, fromZ: zz });
          } else if (now - hitLog[hitAt] >= 1) {
            hitCd[i] = HIT_CD;
            hitLog[hitAt] = now;
            hitAt = (hitAt + 1) % PLAYER_HITS_PER_S;
            bus.emit("player:hit", { damage: HIT_DAMAGE, fromX: zx, fromZ: zz });
          }
        }
      } else if (s === LURED) {
        const k = lure[i];
        const fdx = flX[k] - zx, fdz = flZ[k] - zz, fd = Math.hypot(fdx, fdz) || 1e-3;
        gx = fdx / fd;
        gz = fdz / fd;
        if (fd > LURE_CROWD) {
          if (fd > 6 && flField[k].dir(zx, zz, fbuf)) {
            gx = fbuf[0];
            gz = fbuf[1];
          }
          sp = ZOMBIE_CHASE * 0.95 * speedMul[i]; // drawn to the light: they hurry
        } else {
          mob[i] = 2; // crowd round it and sway
          sp = 0.35;
        }
      } else if (s === STUN) {
        timer[i] -= dt;
        if (timer[i] <= 0) s = d < NOTICE_R ? CHASE : fallbackState(i);
      } else if (s === STAGGER) {
        timer[i] -= dt;
        if (timer[i] <= 0) s = d < NOTICE_R ? CHASE : fallbackState(i);
      } else if (s === LEAVING) {
        timer[i] -= dt;
        if (timer[i] <= 0) {
          sink[i] += dt / SINK_S;
          if (sink[i] >= 1) {
            free(i);
            continue;
          }
          gx = -pdx / pd;
          gz = -pdz / pd;
          sp = ZOMBIE_WALK * 0.55;
        }
      }
      st[i] = s;
      if (lit[i] > 0) sp *= 1 - 0.45 * Math.min(1, lit[i] / STUN_HOLD); // flinching in the beam

      // stuck against a wall? slide along it (tangent) for a while
      if (sp > 0.3 && !mob[i] && s !== ATTACK) {
        stuckT[i] += dt;
        if (stuckT[i] > 1.2) {
          if (Math.hypot(zx - lastX[i], zz - lastZ[i]) < sp * 0.3) {
            if (slideT[i] > 0) slideSign[i] = -slideSign[i]; // still stuck while sliding: try the other way
            slideT[i] = 1.6;
          }
          stuckT[i] = 0;
          lastX[i] = zx;
          lastZ[i] = zz;
        }
      } else {
        stuckT[i] = 0;
        lastX[i] = zx;
        lastZ[i] = zz;
      }
      if (slideT[i] > 0 && sp > 0) {
        slideT[i] -= dt;
        const sg = slideSign[i];
        const ax = -gz * sg * 0.95 + gx * 0.3, az = gx * sg * 0.95 + gz * 0.3;
        const al = Math.hypot(ax, az) || 1;
        gx = ax / al;
        gz = az / al;
      }

      // integrate
      const acc = Math.min(1, dt * (s === CHASE ? 7 : 4));
      vx[i] += (gx * sp - vx[i]) * acc;
      vz[i] += (gz * sp - vz[i]) * acc;
      kvx[i] *= kbDecay;
      kvz[i] *= kbDecay;
      let nx = zx + (vx[i] + kvx[i]) * dt + cx[i];
      let nz = zz + (vz[i] + kvz[i]) * dt + cz[i];
      if (s !== LEAVING) {
        // don't walk through the player or the survivors
        const minD = PLAYER_R + ZOMBIE_R;
        for (let k = 0; k < qn; k++) {
          const ex = nx - qX[k], ez = nz - qZ[k];
          const el = Math.hypot(ex, ez);
          if (el < minD && el > 1e-4) {
            nx = qX[k] + (ex / el) * minD;
            nz = qZ[k] + (ez / el) * minD;
          }
        }
      }
      if (s === LEAVING) {
        x[i] = nx; // sinking: no need to fight the walls
        z[i] = nz;
      } else {
        hc.push(nx, nz, ZOMBIE_R, cbuf);
        x[i] = cbuf[0];
        z[i] = cbuf[1];
      }
      spd[i] = Math.hypot(vx[i], vz[i]);

      // facing
      let want = yaw[i];
      if ((s === CHASE || s === ATTACK || s === STAGGER) && qk >= 0) want = Math.atan2(dx, -dz);
      else if (mob[i] === 1) want = Math.atan2(tx - zx, -(tz - zz));
      else if (mob[i] === 2) want = Math.atan2(flX[lure[i]] - zx, -(flZ[lure[i]] - zz));
      else if (spd[i] > 0.15) want = Math.atan2(vx[i], -vz[i]);
      let dy = want - yaw[i];
      dy -= Math.round(dy / (Math.PI * 2)) * Math.PI * 2;
      yaw[i] += dy * Math.min(1, dt * (s === CHASE ? 7 : 4));

      phase[i] += dt * (0.7 + spd[i] * 3.1);

      if (s !== LEAVING) {
        alive++;
        if (s === CHASE || s === ATTACK) chasing++;
        if (pd < nearest) nearest = pd;
        if (hasTarget && Math.abs(x[i] - tx) < PRESS_R && Math.abs(z[i] - tz) < PRESS_R && Math.hypot(x[i] - tx, z[i] - tz) < PRESS_R) pressing++;
      }
    }
    ctx.horde.alive = alive;
    ctx.horde.chasing = chasing;
    ctx.horde.nearest = nearest;
    ctx.horde.pressing = pressing;

    draw(now);
  }

  function draw(now: number) {
    for (let i = 0; i < MAX; i++) {
      const s = st[i];
      if (s === FREE || s === PENDING) {
        torso.setMatrixAt(i, ZERO);
        head.setMatrixAt(i, ZERO);
        eyes.setMatrixAt(i, ZERO);
        arms.setMatrixAt(i * 2, ZERO);
        arms.setMatrixAt(i * 2 + 1, ZERO);
        legs.setMatrixAt(i * 2, ZERO);
        legs.setMatrixAt(i * 2 + 1, ZERO);
        discs.setMatrixAt(i, ZERO);
        continue;
      }
      const sd = seed[i];
      const sp = spd[i];
      const ph = phase[i];
      const amp = Math.min(0.62, 0.1 + sp * 0.2);
      const swing = Math.sin(ph) * amp;
      const bob = Math.abs(Math.cos(ph)) * 0.035 * (0.4 + amp);
      let lean = -(hunch[i] + Math.min(sp, 4) * 0.05);
      let roll = Math.sin(ph) * 0.07 + Math.sin(now * 0.9 + sd * 6) * 0.04;
      let aL = armL0[i] + Math.sin(ph * 2 + sd * 3) * 0.08 + Math.sin(now * 2.1 + sd * 9) * 0.06;
      let aR = armR0[i] + Math.sin(ph * 2 + sd * 3 + 1.4) * 0.08 + Math.sin(now * 1.9 + sd * 7) * 0.06;
      let hp = -lean * 0.6 - 0.12 + Math.sin(now * 1.7 + sd * 5) * 0.07;
      const hr = headRoll[i] + Math.sin(now * 1.2 + sd * 4) * 0.12;
      let legA = swing, legB = -swing;
      let y = bob;
      let zL = -0.07, zR = 0.07;
      if (s === ATTACK || mob[i] === 1) {
        // pounding / grabbing (PG): arms rise and fall, alternating
        const t = now * (s === ATTACK ? 9 : 6) + sd * 10;
        aL = 1.3 + Math.sin(t) * 0.55;
        aR = 1.3 + Math.sin(t + 2.4) * 0.55;
        lean -= 0.08;
        roll += Math.sin(t * 0.5) * 0.05;
      } else if (s === STAGGER) {
        const k = Math.min(1, timer[i] / 0.5);
        lean = 0.32 * k + lean * (1 - k);
        aL = 2.1 + Math.sin(now * 14 + sd * 3) * 0.4;
        aR = 1.9 + Math.sin(now * 13 + sd * 5) * 0.4;
        roll += Math.sin(now * 11 + sd) * 0.14;
        hp += 0.25 * k;
      } else if (s === STUN) {
        // dazzled: stagger back, hands over the eyes, face turned down
        const k = Math.min(1, (STUN_S - timer[i]) / 0.25);
        lean = (0.2 + Math.sin(now * 7 + sd * 5) * 0.06) * k + lean * (1 - k);
        aL = 2.05 * k + aL * (1 - k) + Math.sin(now * 17 + sd) * 0.05;
        aR = 2.0 * k + aR * (1 - k) + Math.sin(now * 15 + sd * 3) * 0.05;
        zL = 0.42 * k - 0.07 * (1 - k);
        zR = -0.42 * k + 0.07 * (1 - k);
        hp -= 0.35 * k;
        roll += Math.sin(now * 9 + sd * 2) * 0.08;
        legA = legB = 0;
      } else if (mob[i] === 2) {
        // round the flare: arms lowered, swaying, gazing at the light
        aL = 0.75 + Math.sin(now * 1.3 + sd * 4) * 0.15;
        aR = 0.7 + Math.sin(now * 1.1 + sd * 7) * 0.15;
        roll += Math.sin(now * 1.6 + sd * 6) * 0.14;
        lean -= 0.04;
        hp += 0.3;
      } else if (s === LEAVING) {
        aL = 0.35 + Math.sin(ph) * 0.1;
        aR = 0.3 - Math.sin(ph) * 0.1;
        lean -= 0.15;
        hp -= 0.25;
      }
      if (rise[i] > 0) {
        // clawing up out of the ground
        const r = rise[i];
        y = -SINK_DEPTH * r * r;
        aL = 2.6 + Math.sin(now * 10 + sd * 4) * 0.3;
        aR = 2.5 + Math.sin(now * 9 + sd * 6) * 0.3;
        legA = legB = 0;
      }
      if (s === LEAVING) y -= SINK_DEPTH * sink[i];

      const sc = scale[i];
      qa.setFromAxisAngle(UP, -yaw[i]);
      va.set(x[i], y, z[i]);
      vs.set(sc, sc, sc);
      mB.compose(va, qa, vs);
      // torso (pivot at the hips), head + eyes on top, arms from the shoulders
      mT.multiplyMatrices(mB, local(mL, 0, HIP_Y, 0, lean, roll));
      torso.setMatrixAt(i, mT);
      mH.multiplyMatrices(mT, local(mL, 0, TORSO_H + 0.03, -0.02, hp, hr));
      head.setMatrixAt(i, mH);
      eyes.setMatrixAt(i, mH);
      // eyes: green glow; in the beam they flare white and flicker faster as the stun builds; dazzled = dim
      if (s === STUN) eyes.setColorAt(i, eyeDim);
      else if (lit[i] > 0) {
        const k = Math.min(1, lit[i] / STUN_HOLD);
        const flick = Math.sin(now * (14 + 26 * k) + sd * 9) > 0.15 - 0.6 * k ? 1 : 0.35;
        eyes.setColorAt(i, eyeTmp.copy(eyeBase).lerp(eyeHot, k).multiplyScalar(flick * (1 + k)));
      } else eyes.setColorAt(i, eyeBase);
      mO.multiplyMatrices(mT, local(mL, -SHOULDER_X, TORSO_H - 0.07, 0, aL, zL));
      arms.setMatrixAt(i * 2, mO);
      mO.multiplyMatrices(mT, local(mL, SHOULDER_X, TORSO_H - 0.07, 0, aR, zR));
      arms.setMatrixAt(i * 2 + 1, mO);
      mO.multiplyMatrices(mB, local(mL, -HIP_X, HIP_Y, 0, legA, 0));
      legs.setMatrixAt(i * 2, mO);
      mO.multiplyMatrices(mB, local(mL, HIP_X, HIP_Y, 0, legB, 0));
      legs.setMatrixAt(i * 2 + 1, mO);
      // drone marker
      if (s === LEAVING) discs.setMatrixAt(i, ZERO);
      else {
        mO.makeTranslation(x[i], 0.6, z[i]);
        discs.setMatrixAt(i, mO);
        discs.setColorAt(i, s === CHASE || s === ATTACK ? markColor.hot : markColor.calm);
      }
    }
    for (const m of meshes) m.instanceMatrix.needsUpdate = true;
    discs.instanceColor!.needsUpdate = true;
    eyes.instanceColor!.needsUpdate = true;
  }

  ctx.horde.alive = 0;
  ctx.horde.chasing = 0;
  ctx.horde.nearest = Infinity;
  ctx.horde.pressing = 0;
  // dev only: test scripts read the horde's state (window.__horde)
  if (process.env.NODE_ENV !== "production") (window as unknown as { __horde?: unknown }).__horde = { st, kind, x, z, lit, target: () => (hasTarget ? [tx, tz] : null) };

  return {
    update,
    dispose() {
      for (const off of offs) off();
      for (const m of meshes) {
        scene.remove(m);
        m.dispose();
      }
      for (const g of [geoTorso, geoHead, eyeL, eyeR, geoEyes, geoArm, geoLeg, geoDisc]) g.dispose();
      for (const m of [matCloth, matSkin, matEyes, matDisc]) m.dispose();
    },
  };
}
