// OWNER: builder A (player). The survivor: a low-poly figure built from three.js primitives, posed procedurally.
// The model faces -z (north) at rotation.y = 0, so a world yaw (clockwise from north) maps to rotation.y = -yaw.
// No model files. Every mesh shares one of a handful of geometries and materials; pose() allocates nothing.

import * as THREE from "three";
import { SPRINT, WALK } from "./engine";

export type PoseIn = {
  /** Ground speed, m/s. */
  speed: number;
  /** Turn rate of the facing, rad/s (positive = turning clockwise / right). */
  turn: number;
  /** 0..1 shove weight (arms thrust forward). */
  shove: number;
  /** 0..1 hit flinch, decays after a hit. */
  hit: number;
  /** Camera pitch (radians, + = looking up): the flashlight arm follows it a little. */
  aim: number;
  /** Seconds, for idle motion. */
  time: number;
  /** 0..1, how out of breath (1 - stamina): heavier, faster breathing. */
  tired: number;
};

export type Avatar = {
  /** Place this at the player's feet; rotation.y = -facing. */
  root: THREE.Group;
  /** The tip of the flashlight (read its world position for the spotlight). */
  lens: THREE.Object3D;
  pose(dt: number, s: PoseIn): void;
  /** 1 = solid .. lower = see-through (the camera is pressed against the avatar). */
  setFade(alpha: number): void;
  dispose(): void;
};

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

export function createAvatar(): Avatar {
  // ---------------------------------------------------------------- shared geometry + materials
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 8);
  const headGeo = new THREE.IcosahedronGeometry(0.125, 1);
  const capGeo = new THREE.SphereGeometry(0.138, 10, 5, 0, Math.PI * 2, 0, Math.PI / 2);
  const blobGeo = new THREE.CircleGeometry(0.62, 20);
  const geos: THREE.BufferGeometry[] = [box, cyl, headGeo, capGeo, blobGeo];

  // High-vis jacket: a little self-glow so it reads at night; the tape strips are unlit (retro-reflective look).
  const jacket = new THREE.MeshLambertMaterial({ color: 0xff7a12, emissive: 0x3a1600 });
  const tape = new THREE.MeshBasicMaterial({ color: 0xd9e2ea });
  const pants = new THREE.MeshLambertMaterial({ color: 0x2c3646 });
  const boots = new THREE.MeshLambertMaterial({ color: 0x1d1814 });
  const skin = new THREE.MeshLambertMaterial({ color: 0xc78d68, flatShading: true });
  const beanie = new THREE.MeshLambertMaterial({ color: 0x8a1f1f, flatShading: true });
  const pack = new THREE.MeshLambertMaterial({ color: 0x3f4b33 });
  const glove = new THREE.MeshLambertMaterial({ color: 0x23201d });
  const torch = new THREE.MeshLambertMaterial({ color: 0x2a2d31 });
  const lensMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
  const blob = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.38, depthWrite: false });
  const mats: THREE.Material[] = [jacket, tape, pants, boots, skin, beanie, pack, glove, torch, lensMat, blob];
  const baseEmissive = jacket.emissive.clone();
  const solid = [jacket, tape, pants, boots, skin, beanie, pack, glove, torch, lensMat];
  let fade = 1;

  const part = (parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(geo, mat);
    m.scale.set(sx, sy, sz);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const pivot = (parent: THREE.Object3D, x: number, y: number, z: number) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  // ---------------------------------------------------------------- skeleton (groups) + skin (meshes)
  const root = new THREE.Group();
  root.name = "player";
  const shadow = new THREE.Mesh(blobGeo, blob);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  shadow.renderOrder = -1;
  root.add(shadow);

  const body = pivot(root, 0, 0, 0); // bob, lean
  const hips = pivot(body, 0, 0.95, 0);
  part(hips, box, pants, 0.36, 0.18, 0.22, 0, 0, 0);

  const leg = (side: number) => {
    const hip = pivot(hips, side * 0.1, -0.03, 0);
    part(hip, box, pants, 0.155, 0.46, 0.175, 0, -0.22, 0);
    const knee = pivot(hip, 0, -0.44, 0);
    part(knee, box, pants, 0.135, 0.44, 0.155, 0, -0.21, 0);
    part(knee, box, boots, 0.155, 0.11, 0.28, 0, -0.43, -0.045);
    return { hip, knee };
  };
  const legL = leg(-1);
  const legR = leg(1);

  const spine = pivot(hips, 0, 0.05, 0);
  const chest = part(spine, box, jacket, 0.46, 0.58, 0.27, 0, 0.3, 0);
  part(spine, box, tape, 0.47, 0.045, 0.28, 0, 0.13, 0);
  part(spine, box, tape, 0.47, 0.045, 0.28, 0, 0.38, 0);
  part(spine, box, glove, 0.3, 0.07, 0.22, 0, 0.6, 0.0); // collar
  // backpack + bedroll on the back (+z): this is what the camera sees most
  part(spine, box, pack, 0.34, 0.4, 0.16, 0, 0.3, 0.2);
  part(spine, box, tape, 0.2, 0.04, 0.012, 0, 0.36, 0.285);
  const roll = part(spine, cyl, pants, 0.075, 0.38, 0.075, 0, 0.55, 0.2);
  roll.rotation.z = Math.PI / 2;
  part(spine, cyl, skin, 0.05, 0.1, 0.05, 0, 0.64, 0); // neck
  const head = pivot(spine, 0, 0.7, 0);
  part(head, headGeo, skin, 1, 1.06, 1, 0, 0.09, 0);
  part(head, capGeo, beanie, 1, 1, 1, 0, 0.11, 0.005);
  part(head, box, beanie, 0.27, 0.05, 0.27, 0, 0.115, 0.0); // beanie fold

  const arm = (side: number) => {
    const shoulder = pivot(spine, side * 0.295, 0.52, 0);
    part(shoulder, box, jacket, 0.125, 0.33, 0.135, 0, -0.15, 0);
    const elbow = pivot(shoulder, 0, -0.3, 0);
    part(elbow, box, jacket, 0.115, 0.27, 0.125, 0, -0.13, 0);
    part(elbow, box, tape, 0.125, 0.035, 0.135, 0, -0.17, 0);
    part(elbow, box, glove, 0.095, 0.1, 0.105, 0, -0.31, 0);
    return { shoulder, elbow };
  };
  const armL = arm(-1);
  const armR = arm(1);
  // the flashlight in the right hand, along the forearm
  part(armR.elbow, cyl, torch, 0.032, 0.24, 0.032, 0, -0.38, -0.02);
  part(armR.elbow, cyl, torch, 0.045, 0.05, 0.045, 0, -0.5, -0.02);
  part(armR.elbow, cyl, lensMat, 0.04, 0.012, 0.04, 0, -0.528, -0.02);
  const lens = pivot(armR.elbow, 0, -0.54, -0.02);

  // ---------------------------------------------------------------- procedural animation state
  let phase = 0;
  let gaitW = 0; // smoothed 0..1 "moving" weight
  let sprintW = 0;
  let lean = 0;
  let breathPh = 0;

  return {
    root,
    lens,
    pose(dt, s) {
      const kGait = 1 - Math.exp(-10 * dt);
      gaitW += (clamp(s.speed / WALK, 0, 1) - gaitW) * kGait;
      sprintW += (clamp((s.speed - WALK) / (SPRINT - WALK), 0, 1) - sprintW) * kGait;
      const g = gaitW, sp = sprintW;
      // one stride cycle (two steps) gets longer with speed: a jog at WALK, a dash at SPRINT
      phase = (phase + (dt * s.speed * Math.PI * 2) / (1.7 + s.speed * 0.22)) % (Math.PI * 2);
      const sn = Math.sin(phase), cs = Math.cos(phase);
      breathPh += dt * (2.1 + 4.2 * s.tired);
      const breath = Math.sin(breathPh) * (1 + 2.2 * s.tired);
      const idle = 1 - g;

      // legs: thighs swing, knees fold on the forward swing
      const legA = g * (0.55 + 0.42 * sp);
      legL.hip.rotation.x = legA * sn;
      legR.hip.rotation.x = -legA * sn;
      const kneeA = g * (0.85 + 0.6 * sp);
      legL.knee.rotation.x = -(kneeA * Math.max(0, cs) + 0.08 * g);
      legR.knee.rotation.x = -(kneeA * Math.max(0, -cs) + 0.08 * g);

      // body: bounce (highest in the flight phase), crouch a touch when running, lean into turns
      body.position.y = g * Math.abs(sn) * (0.035 + 0.045 * sp) - g * (0.02 + 0.04 * sp);
      lean += (clamp(-s.turn * (0.05 + 0.06 * g), -0.32, 0.32) - lean) * (1 - Math.exp(-8 * dt));
      body.rotation.z = lean;
      body.position.z = -0.14 * s.shove;

      // torso: forward lean with speed, counter-twist with the arms, breathing, flinch, shove
      spine.rotation.x = -(0.05 * g + 0.2 * sp) + s.hit * 0.38 - s.shove * 0.28;
      spine.rotation.y = 0.1 * g * sn * (1 - s.shove);
      spine.position.y = 0.05 + idle * 0.008 * breath;
      chest.scale.set(0.46, 0.58 * (1 + 0.012 * breath * idle), 0.27 * (1 + 0.035 * breath * idle));
      head.rotation.y = idle * 0.18 * Math.sin(s.time * 0.37) * (1 - s.shove);
      head.rotation.x = 0.14 * sp + s.hit * 0.25 + 0.12 * clamp(s.aim, -0.5, 0.5); // + = chin up

      // free (left) arm swings against the left leg; elbow bends more when sprinting
      const armA = g * (0.45 + 0.55 * sp);
      const sway = idle * 0.04 * Math.sin(s.time * 1.3);
      const lShoulder = -armA * sn + sway + 0.05;
      const lElbow = 0.2 + g * (0.35 + 0.75 * sp);
      // flashlight (right) arm: held up, aimed with the camera; pumps a little at a sprint
      const aimS = 0.72 + clamp(s.aim, -0.5, 0.5) * 0.7 + 0.03 * breath * idle;
      const rShoulder = aimS * (1 - 0.55 * sp) + armA * sn * 0.55 * sp;
      const rElbow = 0.62 + 0.35 * sp + clamp(s.aim, -0.5, 0.5) * 0.3;
      const w = s.shove; // both arms thrust straight forward
      armL.shoulder.rotation.x = lShoulder + (1.5 - lShoulder) * w;
      armL.elbow.rotation.x = lElbow + (0.08 - lElbow) * w;
      armR.shoulder.rotation.x = rShoulder + (1.5 - rShoulder) * w;
      armR.elbow.rotation.x = rElbow + (0.08 - rElbow) * w;
      armL.shoulder.rotation.z = -0.1 - 0.06 * sp + 0.16 * w;
      armR.shoulder.rotation.z = 0.12 - 0.16 * w;

      // a red flush on the jacket when hit
      jacket.emissive.setRGB(baseEmissive.r + s.hit * 0.55, baseEmissive.g * (1 - s.hit), baseEmissive.b * (1 - s.hit));
    },
    setFade(alpha) {
      const a = Math.round(Math.min(1, Math.max(0.05, alpha)) * 50) / 50;
      if (a === fade) return;
      fade = a;
      for (const m of solid) {
        m.transparent = a < 1;
        m.opacity = a;
        m.depthWrite = a >= 1;
      }
      blob.opacity = 0.38 * a;
    },
    dispose() {
      root.removeFromParent();
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
