// OWNER: builder A (player). The survivor you play: controls, stamina, health, the shove, the flashlight, and the
// over-the-shoulder camera (playerCamera.ts) around a procedural low-poly avatar (playerAvatar.ts).
//
// Controls: WASD move relative to the camera, arrows turn + move, mouse (pointer lock or drag) looks,
// Shift sprints (stamina), Space shoves. Writes ctx.player.{x,z,yaw,pitch,speed,sprinting,stamina,health}.
// Health: "player:hit" -> damage, 0.6 s invulnerable, knockback, red edge flash; regen after 4 s; at 0 emits
// "player:downed" once (the director rescues and resets health; re-armed when health > 0).

import * as THREE from "three";
import { PLAYER_R, SPRINT, WALK, type FootCtx, type System } from "./engine";
import { createAvatar } from "./playerAvatar";
import { createCameraRig } from "./playerCamera";
import { createBeam, createShoveArc } from "./playerFx";

const MOUSE_YAW = 0.0024; // rad per px
const MOUSE_PITCH = 0.002;
const KEY_TURN = 2.2; // rad/s with the arrow keys
const PITCH_MIN = -0.6; // looking down
const PITCH_MAX = 0.42; // looking up
const ACCEL = 9; // 1/s, exponential approach to the target velocity
const DECEL = 12;
const STAMINA_DRAIN = 0.25; // per s at a sprint
const STAMINA_REGEN = 0.15; // per s otherwise
const SPRINT_MIN = 0.1; // no sprint below this...
const WINDED_UNTIL = 0.3; // ...and once winded, not until this
const INVULN = 0.6; // s after each hit
const KNOCK_M = 1.2; // knockback distance
const KNOCK_RATE = 10; // 1/s decay of the knockback velocity (distance = v0 / rate)
const REGEN_DELAY = 4; // s without a hit
const REGEN_HP = 2; // per s
const SHOVE_CD = 0.8;
const SHOVE_ANIM = 0.34;
const TURN_RATE = 11; // 1/s, how fast the avatar turns to face its movement
const SPOT_ANGLE = 0.45;
const SPOT_I = 40; // flashlight intensity (decay 1)
const WARM_I = 2.4; // fill light around the avatar

const TAU = Math.PI * 2;
const wrapPi = (a: number) => ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function createPlayer(ctx: FootCtx): System {
  const p = ctx.player;
  const avatar = createAvatar();
  ctx.scene.add(avatar.root);
  const rig = createCameraRig(ctx);

  // flashlight + a warm fill so the avatar reads in the dark. Never toggled visible (a light count change would
  // recompile every material); intensity goes to 0 instead.
  const spot = new THREE.SpotLight(0xfff0d2, 0, 40, SPOT_ANGLE, 0.5, 1);
  spot.castShadow = false;
  const warm = new THREE.PointLight(0xffb070, 0, 6, 1);
  const beam = createBeam(SPOT_ANGLE);
  const arc = createShoveArc();
  ctx.scene.add(spot, spot.target, warm, beam.mesh, arc.mesh);

  // red screen-edge flash (a DOM layer over the canvas, under the HUD)
  const host = ctx.renderer.domElement.parentElement;
  const flash = document.createElement("div");
  Object.assign(flash.style, {
    position: "absolute",
    inset: "0",
    pointerEvents: "none",
    opacity: "0",
    background: "radial-gradient(ellipse at center, rgba(0,0,0,0) 48%, rgba(190,12,12,0.45) 78%, rgba(150,0,0,0.9) 100%)",
  } satisfies Partial<CSSStyleDeclaration>);
  host?.appendChild(flash);
  let flashShown = -1;

  // ---------------------------------------------------------------- state (no allocation in update)
  let vx = 0, vz = 0; // walking velocity
  let kx = 0, kz = 0; // knockback velocity
  let lastX = p.x, lastZ = p.z;
  let facing = p.yaw;
  let turn = 0;
  let speedSm = 0;
  let winded = false;
  let invuln = 0;
  let lastHitAt = -1e9;
  let hitFx = 0; // avatar flinch 0..1
  let flashV = 0; // screen flash 0..1
  let downedSent = false;
  let shoveCd = 0;
  let shoveT = 99;
  let shoveYaw = 0;
  const lensPos = new THREE.Vector3();
  const beamDir = new THREE.Vector3();

  const offHit = ctx.bus.on("player:hit", (e) => {
    if (p.hidden || p.frozen || invuln > 0 || downedSent) return;
    const dmg = Math.max(0, Number(e.damage) || 0);
    if (!dmg) return;
    p.health = Math.max(0, p.health - dmg);
    invuln = INVULN;
    lastHitAt = ctx.time;
    hitFx = 1;
    flashV = Math.min(1, 0.55 + dmg / 40);
    const fx0 = Number(e.fromX), fz0 = Number(e.fromZ);
    let dx = Number.isFinite(fx0) ? p.x - fx0 : 0, dz = Number.isFinite(fz0) ? p.z - fz0 : 0;
    let l = Math.hypot(dx, dz);
    if (l < 1e-3) {
      dx = -Math.sin(facing);
      dz = Math.cos(facing);
      l = 1;
    }
    kx = (dx / l) * KNOCK_M * KNOCK_RATE;
    kz = (dz / l) * KNOCK_M * KNOCK_RATE;
    rig.shake(0.08, 0.25);
    if (p.health <= 0) {
      downedSent = true;
      ctx.bus.emit("player:downed", { x: p.x, z: p.z });
    }
  });
  const offShake = ctx.bus.on("fx:shake", (e) => rig.shake(Number(e.amp) || 0, Number(e.secs) || 0));

  return {
    update(rawDt) {
      // the first frame's dt can be negative (rAF timestamp earlier than the loop's performance.now() start)
      const dt = rawDt > 0 ? rawDt : 0;
      const inp = ctx.input;
      const k = inp.down;
      const t = ctx.time;

      // the director moved us (spawn, rescue, stepping out): no smoothing across the jump
      if (Math.hypot(p.x - lastX, p.z - lastZ) > 2.5) {
        vx = vz = kx = kz = 0;
        speedSm = 0;
        facing = p.yaw;
        rig.snap();
      }
      if (downedSent && p.health > 0) downedSent = false;

      // ---- look
      if (ctx.cameraOwner === "player" && !p.hidden) {
        const keyTurn = (k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0);
        p.yaw = wrapPi(p.yaw + inp.mouseDx * MOUSE_YAW + keyTurn * KEY_TURN * dt);
        p.pitch = clamp(p.pitch - inp.mouseDy * MOUSE_PITCH, PITCH_MIN, PITCH_MAX);
      }

      // ---- move intent, relative to the camera
      const free = !p.frozen && !p.hidden;
      let f = 0, s = 0;
      if (free) {
        f = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
        s = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
      }
      const len = Math.hypot(f, s);
      const fx = Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      const rx = -fz, rz = fx;
      let dx = 0, dz = 0;
      if (len > 0) {
        dx = (fx * f + rx * s) / len;
        dz = (fz * f + rz * s) / len;
      }

      // ---- sprint + stamina
      if (p.stamina < SPRINT_MIN) winded = true;
      else if (winded && p.stamina >= WINDED_UNTIL) winded = false;
      const sprinting = free && len > 0 && (k.has("ShiftLeft") || k.has("ShiftRight")) && !winded;
      const top = sprinting ? SPRINT : WALK;
      const a = 1 - Math.exp(-(len > 0 ? ACCEL : DECEL) * dt);
      vx += (dx * top - vx) * a;
      vz += (dz * top - vz) * a;
      const kd = Math.exp(-KNOCK_RATE * dt);
      kx *= kd;
      kz *= kd;
      if (!free) vx = vz = kx = kz = 0;

      // ---- shove
      shoveCd = Math.max(0, shoveCd - dt);
      if (free && inp.pressed.has("Space") && shoveCd === 0) {
        shoveCd = SHOVE_CD;
        shoveT = 0;
        shoveYaw = p.yaw;
        kx += fx * 3.5; // a small lunge into it
        kz += fz * 3.5;
        rig.shake(0.05, 0.18);
        arc.fire(p.x + fx * 0.3, p.z + fz * 0.3, p.yaw);
        ctx.bus.emit("player:shove", { x: p.x, z: p.z, yaw: p.yaw });
      }
      shoveT += dt;

      // ---- integrate through collision
      const ox = p.x, oz = p.z;
      if (free && (vx * vx + vz * vz > 1e-6 || kx * kx + kz * kz > 1e-6)) {
        const [nx, nz] = ctx.collide(p.x + (vx + kx) * dt, p.z + (vz + kz) * dt, PLAYER_R);
        p.x = nx;
        p.z = nz;
      }
      const moved = dt > 0 ? Math.hypot(p.x - ox, p.z - oz) / dt : 0;
      speedSm += (moved - speedSm) * (1 - Math.exp(-14 * dt));
      if (speedSm < 0.02) speedSm = 0;
      p.speed = speedSm;
      p.sprinting = sprinting && moved > WALK * 0.5;
      p.stamina = clamp(p.stamina + (p.sprinting ? -STAMINA_DRAIN : STAMINA_REGEN) * dt, 0, 1);
      lastX = p.x;
      lastZ = p.z;

      // ---- health
      invuln = Math.max(0, invuln - dt);
      if (p.health > 0 && p.health < 100 && t - lastHitAt > REGEN_DELAY) p.health = Math.min(100, p.health + REGEN_HP * dt);
      hitFx = Math.max(0, hitFx - dt * 3.2);
      flashV = Math.max(0, flashV - dt * 2.2);

      // ---- avatar: face the movement (or the shove), lean into turns
      const shoving = shoveT < SHOVE_ANIM;
      let want = facing;
      if (shoving) want = shoveYaw;
      else if (len > 0) want = Math.atan2(dx, -dz);
      const before = facing;
      facing = wrapPi(facing + wrapPi(want - facing) * (1 - Math.exp(-(shoving ? 22 : TURN_RATE) * dt)));
      turn += ((dt > 0 ? wrapPi(facing - before) / dt : 0) - turn) * (1 - Math.exp(-10 * dt));
      const u = shoveT / SHOVE_ANIM;
      const shoveW = shoving ? smooth(0, 0.2, u) * (1 - smooth(0.62, 1, u)) : 0;
      avatar.root.visible = !p.hidden;
      avatar.root.position.set(p.x, 0, p.z);
      avatar.root.rotation.y = -facing;
      avatar.pose(dt, { speed: speedSm, turn, shove: shoveW, hit: hitFx, aim: p.pitch, time: t, tired: 1 - p.stamina });

      // ---- lights: the beam goes where the camera looks, from the hand
      const night = 1 - smooth(0, 1, ctx.dawn);
      const on = p.hidden ? 0 : 1;
      avatar.lens.getWorldPosition(lensPos);
      // when the avatar faces away from the view (backing up), light from just in front of the body instead of the
      // hand, so the beam never floods the avatar's own chest
      const ahead = Math.cos(facing - p.yaw);
      const fromHand = smooth(-0.1, 0.7, ahead);
      lensPos.x += (p.x + fx * 0.6 - lensPos.x) * (1 - fromHand);
      lensPos.y += (1.35 - lensPos.y) * (1 - fromHand);
      lensPos.z += (p.z + fz * 0.6 - lensPos.z) * (1 - fromHand);
      spot.position.copy(lensPos);
      const bp = p.pitch - 0.1;
      beamDir.set(fx * Math.cos(bp), Math.sin(bp), fz * Math.cos(bp));
      spot.target.position.copy(lensPos).addScaledVector(beamDir, 10);
      spot.intensity = SPOT_I * night * night * on;
      beam.set(lensPos, beamDir, night * night * on * smooth(0.3, 0.8, ahead) * (1 - rig.near()));
      arc.update(dt);
      warm.position.set(p.x - fx * 1.2, 2.3, p.z - fz * 1.2);
      warm.intensity = WARM_I * night * on;

      // ---- camera + screen flash
      rig.update(dt, p.sprinting);
      // camera pressed against the avatar (wall behind): fade it, and drop it entirely when the lens is in its head
      const near = rig.near();
      avatar.setFade(1 - 0.8 * near);
      if (near > 0.7) avatar.root.visible = false;
      const low = p.health > 0 && p.health < 35 ? (1 - p.health / 35) * (0.32 + 0.12 * Math.sin(t * 4.5)) : 0;
      const op = p.hidden ? 0 : Math.round(Math.max(flashV, low) * 100) / 100;
      if (op !== flashShown) {
        flashShown = op;
        flash.style.opacity = String(op);
      }
    },
    dispose() {
      offHit();
      offShake();
      rig.dispose();
      avatar.dispose();
      ctx.scene.remove(spot, spot.target, warm);
      beam.dispose();
      arc.dispose();
      spot.dispose();
      warm.dispose();
      flash.remove();
    },
  };
}
