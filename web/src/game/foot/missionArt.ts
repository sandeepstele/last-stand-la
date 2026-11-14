// OWNER: builder E (missions). Meshes for the mission layer: crates, survivors, label sprites, the plank wall, debris.
// Pure three.js construction; no game state. Shared geometries live in one MissionArt bundle and are disposed once.
//
// Model convention: every figure faces local -z, so `group.rotation.y = -yaw` points it along the engine's yaw
// (forward = (sin yaw, -cos yaw)).

import * as THREE from "three";

// ------------------------------------------------------------------ palette
export const SURVIVOR_JACKETS = [0x14b8a6, 0x3b82f6, 0x0ea5e9, 0x2dd4bf]; // teal / blue: never amber (player) or grey-green (zombies)
const SKIN = [0xc68a5e, 0x8d5a3b, 0xe0b48f, 0x6b4430];
const HAIR = [0x1f1a17, 0x3b2a1e, 0x111111, 0x5a3b22];
const PANTS = 0x4a5568;
const SHOE = 0x1b1e24;

// ------------------------------------------------------------------ shared geometry
export type MissionArt = {
  box: THREE.BoxGeometry; // unit cube, scaled per mesh
  sphere: THREE.SphereGeometry;
  ring: THREE.RingGeometry; // unit ring 0.82..1, flat on the ground after rotation
  disc: THREE.CircleGeometry; // unit disc, flat
  beam: THREE.CylinderGeometry; // open loot beam, 1 m tall, origin at the bottom
  dustTex: THREE.CanvasTexture;
  dispose(): void;
};

export function createArt(): MissionArt {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const sphere = new THREE.SphereGeometry(1, 10, 8);
  const ring = new THREE.RingGeometry(0.82, 1, 40);
  ring.rotateX(-Math.PI / 2);
  const disc = new THREE.CircleGeometry(1, 40);
  disc.rotateX(-Math.PI / 2);
  const beam = new THREE.CylinderGeometry(0.35, 0.55, 1, 12, 1, true);
  beam.translate(0, 0.5, 0);
  const dustTex = radialTexture("rgba(200,190,170,1)", "rgba(200,190,170,0)");
  return {
    box, sphere, ring, disc, beam, dustTex,
    dispose() {
      box.dispose();
      sphere.dispose();
      ring.dispose();
      disc.dispose();
      beam.dispose();
      dustTex.dispose();
    },
  };
}

function radialTexture(inner: string, outer: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 31);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, outer);
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Dispose every geometry/material/texture under `o` EXCEPT the shared bundle's geometries. */
export function disposeTree(o: THREE.Object3D, art: MissionArt, keepMaterials?: Set<THREE.Material>) {
  const shared = new Set<THREE.BufferGeometry>([art.box, art.sphere, art.ring, art.disc, art.beam]);
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.geometry && !shared.has(m.geometry)) m.geometry.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      if (keepMaterials?.has(mat)) continue;
      const map = (mat as THREE.MeshBasicMaterial).map;
      if (map && map !== art.dustTex) map.dispose();
      mat.dispose();
    }
  });
  o.removeFromParent();
}

function part(geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.scale.set(sx, sy, sz);
  m.position.set(x, y, z);
  return m;
}

// ------------------------------------------------------------------ label sprites (canvas text, redrawn only on change)
export type LabelLine = { text: string; px: number; color: string; weight?: number };
export type Label = {
  sprite: THREE.Sprite;
  /** Redraw (cheap; call on change only). bar = 0..1 draws a health bar under the text, null = none. */
  draw(lines: LabelLine[], opts?: { bg?: string; border?: string; bar?: number | null; icon?: "boards" | "medkit" | null }): void;
  dispose(): void;
};

const LABEL_W = 512;
const LABEL_H = 160;

/** A billboard label. heightM = world height of the full canvas. */
export function makeLabel(heightM: number): Label {
  const c = document.createElement("canvas");
  c.width = LABEL_W;
  c.height = LABEL_H;
  const g = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set((heightM * LABEL_W) / LABEL_H, heightM, 1);
  sprite.renderOrder = 10;
  return {
    sprite,
    draw(lines, opts = {}) {
      g.clearRect(0, 0, LABEL_W, LABEL_H);
      g.textAlign = "center";
      g.textBaseline = "middle";
      const iconW = opts.icon ? 70 : 0;
      let w = 0;
      for (const l of lines) {
        g.font = `${l.weight ?? 700} ${l.px}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
        w = Math.max(w, g.measureText(l.text).width);
      }
      const totalH = lines.reduce((s, l) => s + l.px * 1.18, 0) + (opts.bar != null ? 22 : 0);
      const boxW = Math.min(LABEL_W - 8, w + iconW + 44);
      const boxH = Math.min(LABEL_H - 8, totalH + 24);
      const x0 = (LABEL_W - boxW) / 2;
      const y0 = (LABEL_H - boxH) / 2;
      if (opts.bg) {
        g.fillStyle = opts.bg;
        roundRect(g, x0, y0, boxW, boxH, 18);
        g.fill();
        if (opts.border) {
          g.lineWidth = 4;
          g.strokeStyle = opts.border;
          g.stroke();
        }
      }
      if (opts.icon) drawIcon(g, opts.icon, x0 + 22 + 26, LABEL_H / 2, 26);
      let y = y0 + 12;
      const cx = LABEL_W / 2 + iconW / 2;
      for (const l of lines) {
        g.font = `${l.weight ?? 700} ${l.px}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
        g.fillStyle = "rgba(0,0,0,0.65)";
        g.fillText(l.text, cx + 2, y + (l.px * 1.18) / 2 + 2);
        g.fillStyle = l.color;
        g.fillText(l.text, cx, y + (l.px * 1.18) / 2);
        y += l.px * 1.18;
      }
      if (opts.bar != null) {
        const bw = Math.max(120, Math.min(boxW - 40, 220));
        const bx = (LABEL_W - bw) / 2;
        const by = y + 4;
        g.fillStyle = "rgba(0,0,0,0.6)";
        roundRect(g, bx - 3, by - 3, bw + 6, 18, 6);
        g.fill();
        const v = Math.max(0, Math.min(1, opts.bar));
        g.fillStyle = v > 0.5 ? "#34d399" : v > 0.25 ? "#fbbf24" : "#f87171";
        roundRect(g, bx, by, bw * v, 12, 4);
        g.fill();
      }
      tex.needsUpdate = true;
    },
    dispose() {
      tex.dispose();
      mat.dispose();
      sprite.removeFromParent();
    },
  };
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function drawIcon(g: CanvasRenderingContext2D, icon: "boards" | "medkit", cx: number, cy: number, r: number) {
  g.save();
  g.translate(cx, cy);
  if (icon === "medkit") {
    g.fillStyle = "#f8fafc";
    roundRect(g, -r, -r, 2 * r, 2 * r, 8);
    g.fill();
    g.fillStyle = "#dc2626";
    g.fillRect(-r * 0.22, -r * 0.7, r * 0.44, r * 1.4);
    g.fillRect(-r * 0.7, -r * 0.22, r * 1.4, r * 0.44);
  } else {
    // two crossed planks with nail heads
    for (const a of [-0.45, 0.45]) {
      g.save();
      g.rotate(a);
      g.fillStyle = "#c08a4d";
      g.fillRect(-r * 1.1, -r * 0.26, r * 2.2, r * 0.52);
      g.strokeStyle = "#7c5229";
      g.lineWidth = 3;
      g.strokeRect(-r * 1.1, -r * 0.26, r * 2.2, r * 0.52);
      g.fillStyle = "#3f3f46";
      g.beginPath();
      g.arc(-r * 0.8, 0, 3.5, 0, Math.PI * 2);
      g.arc(r * 0.8, 0, 3.5, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  g.restore();
}

// ------------------------------------------------------------------ crates
export type CrateMesh = { group: THREE.Group; body: THREE.Group; ring: THREE.Mesh; beam: THREE.Mesh; label: Label; mats: THREE.Material[] };

export function makeCrate(art: MissionArt, kind: "boards" | "medkit"): CrateMesh {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);
  const mats: THREE.Material[] = [];
  const mat = (c: number, emissive = 0x000000) => {
    const m = new THREE.MeshLambertMaterial({ color: c, emissive });
    mats.push(m);
    return m;
  };
  if (kind === "boards") {
    const wood = mat(0x8b5a2b, 0x1a0d03);
    const slat = mat(0x5f3b17);
    const plank = mat(0xd19a5b, 0x2a1606);
    body.add(part(art.box, wood, 0.9, 0.62, 0.9, 0, 0.31, 0));
    // frame slats on the sides
    for (const sx of [-1, 1]) {
      body.add(part(art.box, slat, 0.08, 0.64, 0.92, sx * 0.43, 0.31, 0));
      body.add(part(art.box, slat, 0.92, 0.64, 0.08, 0, 0.31, sx * 0.43));
    }
    body.add(part(art.box, slat, 0.92, 0.08, 0.92, 0, 0.6, 0));
    // planks stacked on top: the "boards" icon in 3D
    const p1 = part(art.box, plank, 1.25, 0.07, 0.18, 0, 0.7, -0.15);
    p1.rotation.y = 0.18;
    const p2 = part(art.box, plank, 1.25, 0.07, 0.18, 0, 0.77, 0.12);
    p2.rotation.y = -0.22;
    body.add(p1, p2);
  } else {
    const white = mat(0xf1f5f9, 0x202428);
    const red = mat(0xdc2626, 0x3a0505);
    const dark = mat(0x334155);
    body.add(part(art.box, white, 0.72, 0.46, 0.5, 0, 0.23, 0));
    // red crosses on the top and both long faces
    body.add(part(art.box, red, 0.14, 0.02, 0.4, 0, 0.465, 0));
    body.add(part(art.box, red, 0.4, 0.02, 0.14, 0, 0.465, 0));
    for (const s of [-1, 1]) {
      body.add(part(art.box, red, 0.12, 0.34, 0.02, 0, 0.23, s * 0.255));
      body.add(part(art.box, red, 0.34, 0.12, 0.02, 0, 0.23, s * 0.255));
    }
    body.add(part(art.box, dark, 0.3, 0.06, 0.06, 0, 0.5, 0)); // handle
  }
  const glow = kind === "boards" ? 0xffb347 : 0xff6b6b;
  const ringMat = new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  mats.push(ringMat);
  const ring = new THREE.Mesh(art.ring, ringMat);
  ring.scale.setScalar(1.1);
  ring.position.y = 0.05;
  ring.renderOrder = 2;
  const beamMat = new THREE.MeshBasicMaterial({ color: glow, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false });
  mats.push(beamMat);
  const beam = new THREE.Mesh(art.beam, beamMat);
  beam.scale.set(1, 7, 1);
  beam.renderOrder = 2;
  const label = makeLabel(0.95);
  label.draw(
    [
      { text: kind === "boards" ? "BOARDS" : "MEDKIT", px: 50, color: kind === "boards" ? "#fcd34d" : "#fecaca", weight: 800 },
      { text: "game item", px: 24, color: "rgba(226,232,240,0.75)", weight: 500 },
    ],
    { bg: "rgba(10,14,24,0.72)", border: kind === "boards" ? "rgba(251,191,36,0.8)" : "rgba(248,113,113,0.85)", icon: kind },
  );
  label.sprite.position.y = 1.75;
  group.add(ring, beam, label.sprite);
  return { group, body, ring, beam, label, mats };
}

// ------------------------------------------------------------------ survivors
export type Rig = {
  root: THREE.Group; // on the ground; rotation.y = -yaw
  pelvis: THREE.Group;
  torso: THREE.Group;
  head: THREE.Group;
  hipL: THREE.Group;
  hipR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  shL: THREE.Group;
  shR: THREE.Group;
  elL: THREE.Group;
  elR: THREE.Group;
  mats: THREE.MeshLambertMaterial[]; // per survivor, so one can flash / fade alone
  jacket: THREE.MeshLambertMaterial;
  jacketGlow: THREE.Color; // the jacket's resting emissive (hit flashes go back to it)
};

const THIGH = 0.44;
const SHIN = 0.44;
export const HIP_H = 0.95;

export function makeSurvivor(art: MissionArt, i: number): Rig {
  const mats: THREE.MeshLambertMaterial[] = [];
  const mat = (c: number) => {
    const m = new THREE.MeshLambertMaterial({ color: c }); // made transparent only when fading out
    mats.push(m);
    return m;
  };
  const jacket = mat(SURVIVOR_JACKETS[i % SURVIVOR_JACKETS.length]);
  jacket.emissive.setHex(SURVIVOR_JACKETS[i % SURVIVOR_JACKETS.length]).multiplyScalar(0.28); // reads at night
  const jacketDark = mat(new THREE.Color(SURVIVOR_JACKETS[i % SURVIVOR_JACKETS.length]).multiplyScalar(0.6).getHex());
  const skin = mat(SKIN[i % SKIN.length]);
  const hair = mat(HAIR[i % HAIR.length]);
  const pants = mat(PANTS);
  const shoe = mat(SHOE);
  const pack = mat(0x7c2d12);

  const root = new THREE.Group();
  const pelvis = new THREE.Group();
  pelvis.position.y = HIP_H;
  root.add(pelvis);
  pelvis.add(part(art.box, pants, 0.36, 0.16, 0.22, 0, 0, 0));

  const torso = new THREE.Group();
  pelvis.add(torso);
  torso.add(part(art.box, jacket, 0.44, 0.56, 0.26, 0, 0.32, 0));
  torso.add(part(art.box, jacketDark, 0.46, 0.08, 0.28, 0, 0.1, 0)); // jacket hem
  torso.add(part(art.box, jacketDark, 0.2, 0.08, 0.2, 0, 0.62, 0)); // collar
  torso.add(part(art.box, pack, 0.3, 0.34, 0.12, 0, 0.34, 0.19)); // small backpack (behind = +z)

  const head = new THREE.Group();
  head.position.y = 0.76;
  torso.add(head);
  head.add(part(art.sphere, skin, 0.15, 0.17, 0.15, 0, 0.02, 0));
  head.add(part(art.sphere, hair, 0.155, 0.12, 0.155, 0, 0.09, 0.02));

  const limb = (parent: THREE.Object3D, x: number, y: number, len1: number, len2: number, w: number, m1: THREE.Material, m2: THREE.Material, end: THREE.Material | null) => {
    const a = new THREE.Group();
    a.position.set(x, y, 0);
    parent.add(a);
    a.add(part(art.box, m1, w, len1, w, 0, -len1 / 2, 0));
    const b = new THREE.Group();
    b.position.y = -len1;
    a.add(b);
    b.add(part(art.box, m2, w * 0.9, len2, w * 0.9, 0, -len2 / 2, 0));
    if (end) b.add(part(art.box, end, w * 1.05, 0.08, w * 1.7, 0, -len2 - 0.02, -w * 0.35));
    return [a, b] as const;
  };
  const [hipL, kneeL] = limb(pelvis, -0.11, -0.04, THIGH, SHIN, 0.15, pants, pants, shoe);
  const [hipR, kneeR] = limb(pelvis, 0.11, -0.04, THIGH, SHIN, 0.15, pants, pants, shoe);
  const [shL, elL] = limb(torso, -0.29, 0.56, 0.3, 0.28, 0.12, jacket, jacket, null);
  const [shR, elR] = limb(torso, 0.29, 0.56, 0.3, 0.28, 0.12, jacket, jacket, null);
  elL.add(part(art.sphere, skin, 0.06, 0.06, 0.06, 0, -0.3, 0));
  elR.add(part(art.sphere, skin, 0.06, 0.06, 0.06, 0, -0.3, 0));
  return { root, pelvis, torso, head, hipL, hipR, kneeL, kneeR, shL, shR, elL, elR, mats, jacket, jacketGlow: jacket.emissive.clone() };
}

/**
 * Pose a rig. mode: 0 = trapped crouch (t drives the wave), 1 = locomotion (phase, speed m/s), 2 = idle stand.
 * No allocations.
 */
export function poseRig(r: Rig, mode: 0 | 1 | 2, t: number, phase: number, speed: number) {
  if (mode === 0) {
    // Crouched against a wall, one arm waving for help, head looking around.
    const thigh = 1.25, knee = -2.05;
    const drop = THIGH * Math.cos(thigh) + SHIN * Math.cos(thigh + knee) + 0.06;
    r.pelvis.position.y = drop;
    r.pelvis.position.z = 0.05;
    r.hipL.rotation.set(thigh, 0, -0.18);
    r.hipR.rotation.set(thigh - 0.15, 0, 0.18);
    r.kneeL.rotation.x = knee;
    r.kneeR.rotation.x = knee + 0.15;
    r.torso.rotation.set(-0.42, 0, 0);
    r.head.rotation.set(0.25, Math.sin(t * 1.3) * 0.6, 0);
    // left arm over the head (cowering)
    r.shL.rotation.set(2.7, 0, 0.45);
    r.elL.rotation.set(1.4, 0, 0);
    // right arm waves overhead
    const w = Math.sin(t * 7);
    r.shR.rotation.set(2.85, 0, 0.35 + w * 0.35);
    r.elR.rotation.set(0.35 + w * 0.25, 0, 0);
    return;
  }
  r.pelvis.position.z = 0;
  r.head.rotation.set(0, 0, 0);
  if (mode === 2) {
    const b = Math.sin(t * 2.2) * 0.015;
    r.pelvis.position.y = HIP_H - 0.02 + b;
    r.hipL.rotation.set(0.04, 0, -0.04);
    r.hipR.rotation.set(-0.04, 0, 0.04);
    r.kneeL.rotation.x = -0.08;
    r.kneeR.rotation.x = -0.08;
    r.torso.rotation.set(0.02, 0, 0);
    r.shL.rotation.set(0.15, 0, -0.12);
    r.shR.rotation.set(0.1, 0, 0.12);
    r.elL.rotation.set(0.35, 0, 0);
    r.elR.rotation.set(0.3, 0, 0);
    r.head.rotation.set(-0.05, Math.sin(t * 0.7) * 0.5, 0);
    return;
  }
  // locomotion: amplitude grows with speed; a run leans forward and pumps the arms
  const run = Math.min(1, Math.max(0, (speed - 2.5) / 3.5));
  const amp = Math.min(1, speed / 2.5) * (0.5 + run * 0.45);
  const s = Math.sin(phase);
  const c = Math.cos(phase);
  r.pelvis.position.y = HIP_H - 0.03 - run * 0.06 + Math.abs(c) * (0.03 + run * 0.05);
  r.hipL.rotation.set(s * amp, 0, -0.03);
  r.hipR.rotation.set(-s * amp, 0, 0.03);
  r.kneeL.rotation.x = -Math.max(0, -c) * (0.5 + run * 0.9) - 0.1;
  r.kneeR.rotation.x = -Math.max(0, c) * (0.5 + run * 0.9) - 0.1;
  r.torso.rotation.set(-0.06 - run * 0.32, s * 0.08, 0);
  r.shL.rotation.set(-s * amp * 1.1, 0, -0.1);
  r.shR.rotation.set(s * amp * 1.1, 0, 0.1);
  r.elL.rotation.set(0.3 + run * 1.1, 0, 0);
  r.elR.rotation.set(0.3 + run * 1.1, 0, 0);
}

// ------------------------------------------------------------------ the plank wall (door defence damage visual)
export const WALL_PLANKS = 8;
export type PlankWall = {
  group: THREE.Group; // positioned at the door, rotation.y faces outward
  planks: THREE.Mesh[]; // index 0 = bottom
  rest: { y: number; rz: number; x: number }[]; // nailed pose per plank
  cracks: THREE.Mesh[];
  mats: THREE.Material[];
  wood: THREE.MeshLambertMaterial;
};

export function makePlankWall(art: MissionArt, seed: number): PlankWall {
  const group = new THREE.Group();
  const wood = new THREE.MeshLambertMaterial({ color: 0xb98b55, emissive: 0x3a2410 });
  const crackMat = new THREE.MeshBasicMaterial({ color: 0x1a0f07 });
  const nailMat = new THREE.MeshLambertMaterial({ color: 0x52525b });
  const mats: THREE.Material[] = [wood, crackMat, nailMat];
  let r = seed || 7;
  const rnd = () => {
    r = (r * 16807) % 2147483647;
    return (r % 1000) / 1000;
  };
  const planks: THREE.Mesh[] = [];
  const rest: PlankWall["rest"] = [];
  for (let i = 0; i < WALL_PLANKS; i++) {
    const y = 0.4 + i * 0.33;
    const rz = (rnd() - 0.5) * 0.28;
    const x = (rnd() - 0.5) * 0.25;
    const m = part(art.box, wood, 2.9 + rnd() * 0.5, 0.24, 0.07, x, y, 0);
    m.rotation.z = rz;
    // nail heads at both ends (children: scale-independent offsets via inverse scale)
    for (const s of [-1, 1]) {
      const n = part(art.box, nailMat, 0.05 / m.scale.x, 0.05 / m.scale.y, 0.03 / m.scale.z, s * 0.42, 0, -0.6); // local -z faces the street
      m.add(n);
    }
    group.add(m);
    planks.push(m);
    rest.push({ y, rz, x });
  }
  // dark crack strokes across the planks; shown as hp falls
  const cracks: THREE.Mesh[] = [];
  for (let i = 0; i < 6; i++) {
    const c = part(art.box, crackMat, 0.5 + rnd() * 0.5, 0.03, 0.02, (rnd() - 0.5) * 1.8, 0.5 + rnd() * 2.1, -0.05);
    c.rotation.z = (rnd() - 0.5) * 1.6;
    c.visible = false;
    group.add(c);
    cracks.push(c);
  }
  return { group, planks, rest, cracks, mats, wood };
}

// ------------------------------------------------------------------ debris
export const CHUNKS_MAX = 256;

export function makeDebrisMesh(art: MissionArt): { mesh: THREE.InstancedMesh; mat: THREE.MeshLambertMaterial } {
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const mesh = new THREE.InstancedMesh(art.box, mat, CHUNKS_MAX);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const col = new THREE.Color();
  for (let i = 0; i < CHUNKS_MAX; i++) {
    const g = 0.45 + ((i * 37) % 23) / 100;
    col.setRGB(g, g * 0.97, g * 0.92);
    mesh.setColorAt(i, col);
  }
  mesh.count = 0;
  mesh.frustumCulled = false;
  return { mesh, mat };
}
