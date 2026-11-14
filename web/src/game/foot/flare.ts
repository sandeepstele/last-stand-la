// OWNER: builder B (horde + flares). Road flares: [G] throws one (ctx.mission.flares, 3 per night) along the camera aim.
// It arcs ~14-18 m (stopping short of walls), lands pushed out of buildings, burns red for BURN_S with a flickering
// light, a hot glow and rising smoke, then fades. On landing it emits "flare:lit" and the horde is drawn to it.
//
// Two flares are pooled; a third throw recycles the oldest. Both PointLights live in the scene from the start
// (intensity 0 when idle): adding or removing a light would recompile every material.

import * as THREE from "three";
import { blocked } from "./collide";
import type { FootCtx, System } from "./engine";

const POOL = 2;
const BURN_S = 8;
const FADE_S = 1.2;
const FLIGHT_S = 0.85;
const ARC_H = 2.8; // metres above the straight line at mid-flight
const THROW_MIN = 14, THROW_MAX = 18;
const LIGHT_I = 55, LIGHT_R = 18, LIGHT_DECAY = 1.6;
const SMOKE_N = 22, SMOKE_EVERY = 0.11, SMOKE_LIFE = 2.6;

type Phase = "idle" | "flying" | "burning";
type Flare = {
  phase: Phase;
  t: number; // seconds in the current phase
  bornAt: number;
  sx: number; sy: number; sz: number; // throw start
  lx: number; lz: number; // landing point
  group: THREE.Group;
  stickMat: THREE.MeshBasicMaterial;
  glow: THREE.Sprite;
  light: THREE.PointLight;
  smoke: { s: THREE.Sprite; age: number; vx: number; vz: number }[];
  smokeT: number;
  smokeNext: number;
};

function radialTexture(stops: [number, string][]): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createFlare(ctx: FootCtx): System {
  const { scene } = ctx;
  const P = ctx.player;

  const glowTex = radialTexture([[0, "rgba(255,255,255,1)"], [0.25, "rgba(255,200,180,0.8)"], [0.6, "rgba(255,80,60,0.25)"], [1, "rgba(255,40,30,0)"]]);
  const smokeTex = radialTexture([[0, "rgba(255,255,255,0.9)"], [0.5, "rgba(255,255,255,0.35)"], [1, "rgba(255,255,255,0)"]]);
  const stickGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.36, 8);
  stickGeo.rotateZ(Math.PI / 2); // lies along x
  const tipGeo = new THREE.SphereGeometry(0.06, 8, 6);
  tipGeo.translate(0.19, 0, 0);
  const tipMat = new THREE.MeshBasicMaterial({ color: 0xfff0d8 });
  const smokeRed = new THREE.Color(0xc0584c), smokeGrey = new THREE.Color(0x5c5a5e);

  const pool: Flare[] = [];
  for (let k = 0; k < POOL; k++) {
    const stickMat = new THREE.MeshBasicMaterial({ color: 0xff2a14 });
    const group = new THREE.Group();
    group.add(new THREE.Mesh(stickGeo, stickMat), new THREE.Mesh(tipGeo, tipMat));
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff3a24, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    glow.scale.setScalar(1.8);
    glow.position.set(0.19, 0, 0);
    group.add(glow);
    group.visible = false;
    scene.add(group);
    const light = new THREE.PointLight(0xff2e1c, 0, LIGHT_R, LIGHT_DECAY);
    light.castShadow = false;
    scene.add(light);
    const smoke: Flare["smoke"] = [];
    for (let s = 0; s < SMOKE_N; s++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: smokeTex, color: 0x777777, transparent: true, depthWrite: false, opacity: 0 }));
      sp.visible = false;
      scene.add(sp);
      smoke.push({ s: sp, age: SMOKE_LIFE, vx: 0, vz: 0 });
    }
    pool.push({ phase: "idle", t: 0, bornAt: 0, sx: 0, sy: 0, sz: 0, lx: 0, lz: 0, group, stickMat, glow, light, smoke, smokeT: 0, smokeNext: 0 });
  }

  const aim = new THREE.Vector3();

  function douse(f: Flare) {
    f.phase = "idle";
    f.group.visible = false;
    f.light.intensity = 0;
    for (const m of f.smoke) {
      m.age = SMOKE_LIFE;
      m.s.visible = false;
    }
  }

  function throwOne() {
    // a free flare, else recycle the oldest
    let f = pool.find((q) => q.phase === "idle");
    if (!f) {
      f = pool.reduce((a, b) => (a.bornAt <= b.bornAt ? a : b));
      douse(f);
    }
    ctx.camera.getWorldDirection(aim);
    let ax = aim.x, az = aim.z;
    const al = Math.hypot(ax, az);
    if (al < 1e-3) {
      ax = Math.sin(P.yaw);
      az = -Math.cos(P.yaw);
    } else {
      ax /= al;
      az /= al;
    }
    // look up a little to throw farther
    const k = Math.min(1, Math.max(0, (P.pitch + 0.15) / 0.5));
    let dist = THROW_MIN + (THROW_MAX - THROW_MIN) * k;
    const cols = ctx.colliders;
    if (blocked(P.x, P.z, P.x + ax * dist, P.z + az * dist, cols)) {
      // stop short of the first wall
      let lo = 0, hi = dist;
      for (let it = 0; it < 10; it++) {
        const mid = (lo + hi) / 2;
        if (blocked(P.x, P.z, P.x + ax * mid, P.z + az * mid, cols)) hi = mid;
        else lo = mid;
      }
      dist = Math.max(1.5, lo - 0.6);
    }
    const [lx, lz] = ctx.collide(P.x + ax * dist, P.z + az * dist, 0.3);
    Object.assign(f, { phase: "flying" as Phase, t: 0, bornAt: ctx.time, sx: P.x + ax * 0.4, sy: 1.5, sz: P.z + az * 0.4, lx, lz, smokeT: 0, smokeNext: 0 });
    f.group.visible = true;
    f.group.position.set(f.sx, f.sy, f.sz);
    f.group.rotation.set(0, Math.random() * Math.PI * 2, 0);
    f.stickMat.color.setHex(0xff2a14);
    f.glow.material.opacity = 1;
    ctx.mission.flares = Math.max(0, ctx.mission.flares - 1);
  }

  function puff(f: Flare) {
    const m = f.smoke.reduce((a, b) => (a.age >= b.age ? a : b)); // the oldest (or unused) sprite
    m.age = 0;
    m.vx = (Math.random() - 0.5) * 0.35 + 0.15; // a light breeze
    m.vz = (Math.random() - 0.5) * 0.35;
    m.s.visible = true;
    m.s.position.set(f.lx + (Math.random() - 0.5) * 0.2, 0.35, f.lz + (Math.random() - 0.5) * 0.2);
  }

  const offs = [
    ctx.bus.on("mission:reset", () => pool.forEach(douse)),
    ctx.bus.on("horde:clear", () => pool.forEach((f) => f.phase === "flying" && douse(f))),
  ];

  return {
    update(dt) {
      if (ctx.input.pressed.has("KeyG") && ctx.mission.flares > 0 && !P.frozen && !P.hidden && ctx.cameraOwner === "player") throwOne();
      const now = ctx.time;
      for (const f of pool) {
        if (f.phase === "idle") continue;
        f.t += dt;
        if (f.phase === "flying") {
          const u = Math.min(1, f.t / FLIGHT_S);
          const y = f.sy + (0.06 - f.sy) * u + ARC_H * 4 * u * (1 - u);
          f.group.position.set(f.sx + (f.lx - f.sx) * u, y, f.sz + (f.lz - f.sz) * u);
          f.group.rotation.z += dt * 13; // tumbling
          f.light.position.set(f.group.position.x, y + 0.2, f.group.position.z);
          f.light.intensity = LIGHT_I * 0.55 * (0.8 + 0.2 * Math.sin(now * 37));
          f.glow.scale.setScalar(1.4);
          if (u >= 1) {
            f.phase = "burning";
            f.t = 0;
            f.group.position.set(f.lx, 0.06, f.lz);
            f.group.rotation.set(0, f.group.rotation.y, 0.12);
            ctx.bus.emit("flare:lit", { x: f.lx, z: f.lz, secs: BURN_S });
          }
          continue;
        }
        // burning, then fading
        const fade = f.t < BURN_S ? 1 : Math.max(0, 1 - (f.t - BURN_S) / FADE_S);
        const flicker = 0.78 + 0.12 * Math.sin(now * 23 + 1.3) + 0.1 * Math.sin(now * 61) + (Math.random() - 0.5) * 0.12;
        f.light.position.set(f.lx, 0.6, f.lz);
        f.light.intensity = LIGHT_I * flicker * fade;
        f.glow.scale.setScalar((1.6 + 0.35 * flicker) * (0.3 + 0.7 * fade));
        f.glow.material.opacity = fade;
        f.stickMat.color.setRGB(1 * (0.25 + 0.75 * fade), 0.16 * fade + 0.05, 0.08 * fade + 0.04);
        if (fade > 0.2) {
          f.smokeT += dt;
          if (f.smokeT >= f.smokeNext) {
            f.smokeNext = f.smokeT + SMOKE_EVERY;
            puff(f);
          }
        }
        let anySmoke = false;
        for (const m of f.smoke) {
          if (m.age >= SMOKE_LIFE) continue;
          m.age += dt;
          const a = m.age / SMOKE_LIFE;
          if (a >= 1) {
            m.s.visible = false;
            continue;
          }
          anySmoke = true;
          m.s.position.x += m.vx * dt;
          m.s.position.z += m.vz * dt;
          m.s.position.y += (1.1 - a * 0.4) * dt;
          m.s.scale.setScalar(0.5 + a * 2.4);
          const mat = m.s.material;
          mat.opacity = 0.32 * Math.sin(Math.min(1, a * 4) * Math.PI * 0.5) * (1 - a) * (0.4 + 0.6 * fade);
          mat.color.copy(smokeRed).lerp(smokeGrey, Math.min(1, a * 1.6));
        }
        if (fade <= 0 && !anySmoke) douse(f);
      }
    },
    dispose() {
      offs.forEach((o) => o());
      for (const f of pool) {
        scene.remove(f.group, f.light);
        f.stickMat.dispose();
        f.glow.material.dispose();
        for (const m of f.smoke) {
          scene.remove(m.s);
          m.s.material.dispose();
        }
      }
      stickGeo.dispose();
      tipGeo.dispose();
      tipMat.dispose();
      glowTex.dispose();
      smokeTex.dispose();
    },
  };
}
