// OWNER: builder A (player). Over-the-shoulder camera: smoothed follow, a boom that pulls in when a building is in
// the way (the view never goes inside a wall), a FOV kick at a sprint, decaying shake, and a drop-in swoop when the
// director hands the camera over after the intro flyover. Only drives the camera while ctx.cameraOwner === "player".

import * as THREE from "three";
import { blocked } from "./collide";
import type { FootCtx } from "./engine";

const BOOM = 4.5; // m behind
const UP = 0.45; // m above the shoulder pivot (pivot 1.55 + 0.45 = 2.0 m at level pitch)
const SIDE = 0.6; // m to the right
const PIVOT_Y = 1.55;
const MIN_BOOM = 0.5;
const WALL_GAP = 0.35;
const SPRINT_FOV = 7; // degrees added at a sprint
const SWOOP = 1.7; // s, intro flyover -> shoulder

export type CameraRig = {
  update(dt: number, sprinting: boolean): void;
  /** 0 = normal boom .. 1 = camera pressed against the avatar (a wall behind): fade the avatar by this. */
  near(): number;
  /** Teleport: skip smoothing on the next update. */
  snap(): void;
  /** Decaying shake (amp ~0.1..0.6). Stronger shakes replace weaker ones. */
  shake(amp: number, secs: number): void;
  dispose(): void;
};

const ease3 = (u: number) => 1 - (1 - u) ** 3;

export function createCameraRig(ctx: FootCtx): CameraRig {
  const cam = ctx.camera;
  const baseFov = cam.fov;
  const pivot = new THREE.Vector3();
  const look = new THREE.Vector3();
  const pos = new THREE.Vector3();
  const target = new THREE.Vector3();
  const fromPos = new THREE.Vector3();
  const fromQuat = new THREE.Quaternion();
  const toQuat = new THREE.Quaternion();
  let owned = false;
  let snapNext = true;
  let boom = BOOM;
  let side = SIDE;
  let fov = baseFov;
  let swoopT = SWOOP;
  let shakeAmp = 0, shakeDur = 1, shakeT = 0;
  let near = 0;

  /** Longest boom (<= want) whose ground segment from the player to the camera crosses no building edge. */
  const clearBoom = (px: number, pz: number, ox: number, oz: number, dx: number, dz: number, want: number) => {
    const cols = ctx.colliders;
    if (!blocked(px, pz, ox - dx * want, oz - dz * want, cols)) return want;
    let lo = 0, hi = want;
    for (let i = 0; i < 7; i++) {
      const mid = (lo + hi) / 2;
      if (blocked(px, pz, ox - dx * mid, oz - dz * mid, cols)) hi = mid;
      else lo = mid;
    }
    return Math.max(MIN_BOOM, lo - WALL_GAP);
  };

  return {
    update(dt, sprinting) {
      if (ctx.cameraOwner !== "player") {
        owned = false;
        return;
      }
      const p = ctx.player;
      if (!owned) {
        // the director just handed over: fly down from wherever its camera was
        owned = true;
        snapNext = true;
        swoopT = 0;
        fromPos.copy(cam.position);
        fromQuat.copy(cam.quaternion);
      }
      const sy = Math.sin(p.yaw), cy = Math.cos(p.yaw);
      const cp = Math.cos(p.pitch);
      look.set(sy * cp, Math.sin(p.pitch), -cy * cp);
      const rx = cy, rz = sy; // right of the view on the ground

      // shoulder offset: drop it when the right shoulder would be inside a wall
      const wantSide = blocked(p.x, p.z, p.x + rx * (SIDE + 0.3), p.z + rz * (SIDE + 0.3), ctx.colliders) ? 0 : SIDE;
      side = snapNext ? wantSide : side + (wantSide - side) * (1 - Math.exp(-8 * dt));
      const tx = p.x + rx * side, tz = p.z + rz * side;
      if (snapNext) pivot.set(tx, PIVOT_Y, tz);
      else {
        const k = 1 - Math.exp(-16 * dt);
        pivot.x += (tx - pivot.x) * k;
        pivot.z += (tz - pivot.z) * k;
        pivot.y = PIVOT_Y;
      }

      // the boom: pull in fast when a building cuts the line to the camera, ease back out slowly
      const hl = Math.hypot(look.x, look.z) || 1e-6;
      const want = clearBoom(p.x, p.z, pivot.x, pivot.z, look.x / hl, look.z / hl, BOOM * hl) / hl;
      if (snapNext) boom = want;
      else boom += (want - boom) * (1 - Math.exp((want < boom ? -25 : -3) * dt));

      // a wall right behind: the camera tucks in at the shoulder, rises a little, and the avatar fades (see near())
      const tight = Math.min(1, Math.max(0, (BOOM * 0.6 - boom) / (BOOM * 0.6 - MIN_BOOM)));
      near = tight;
      pos.copy(pivot).addScaledVector(look, -boom);
      pos.y += UP + tight * 0.5;
      if (pos.y < 0.35) pos.y = 0.35;
      const [cx, cz] = ctx.collide(pos.x, pos.z, 0.15);
      pos.x = cx;
      pos.z = cz;
      target.copy(pivot).addScaledVector(look, 12);
      target.y += 0.15;

      // shake: smooth pseudo-noise from incommensurate sines, envelope decays quadratically
      let roll = 0;
      if (shakeT > 0) {
        shakeT = Math.max(0, shakeT - dt);
        const e = shakeAmp * (shakeT / shakeDur) ** 2;
        const t = ctx.time;
        pos.x += e * 0.6 * (Math.sin(t * 31.7) * 0.6 + Math.sin(t * 17.3 + 1.3) * 0.4);
        pos.y += e * 0.4 * (Math.sin(t * 27.1 + 0.7) * 0.6 + Math.sin(t * 13.9 + 2.1) * 0.4);
        pos.z += e * 0.6 * (Math.sin(t * 23.3 + 2.9) * 0.6 + Math.sin(t * 19.7 + 0.4) * 0.4);
        target.x += e * 0.5 * Math.sin(t * 29.3 + 1.1);
        target.y += e * 0.5 * Math.sin(t * 21.7 + 0.3);
        roll = e * 0.12 * Math.sin(t * 21.9 + 0.5);
        if (shakeT === 0) shakeAmp = 0;
      }

      if (swoopT < SWOOP) {
        // horizontal travel early, height drops late: the camera comes down onto the player from above the roofs
        swoopT += dt;
        const u = Math.min(1, swoopT / SWOOP);
        const eh = ease3(u), ev = u * u * u;
        cam.position.set(fromPos.x + (pos.x - fromPos.x) * eh, fromPos.y + (pos.y - fromPos.y) * ev, fromPos.z + (pos.z - fromPos.z) * eh);
        cam.lookAt(target);
        toQuat.copy(cam.quaternion);
        cam.quaternion.copy(fromQuat).slerp(toQuat, u * u * (3 - 2 * u));
      } else {
        cam.position.copy(pos);
        cam.lookAt(target);
      }
      if (roll) cam.rotateZ(roll);
      snapNext = false;

      const wantFov = baseFov + (sprinting ? SPRINT_FOV : 0);
      fov += (wantFov - fov) * (1 - Math.exp(-5 * dt));
      if (Math.abs(cam.fov - fov) > 0.01) {
        cam.fov = fov;
        cam.updateProjectionMatrix();
      }
    },
    snap() {
      snapNext = true;
    },
    near: () => near,
    shake(amp, secs) {
      const now = shakeDur > 0 ? shakeAmp * (shakeT / shakeDur) ** 2 : 0;
      if (amp <= now || !(secs > 0)) return;
      shakeAmp = amp;
      shakeDur = secs;
      shakeT = secs;
    },
    dispose() {
      if (cam.fov !== baseFov) {
        cam.fov = baseFov;
        cam.updateProjectionMatrix();
      }
    },
  };
}
