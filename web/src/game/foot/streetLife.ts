// Street life: traffic on the streets and people on the sidewalks, so downtown isn't a dead city. When the simulated
// quake hits (the first "fx:shake", or "fx:crack" in daylight) people run from the buildings to open street space and
// gather there; cars stop with their hazards blinking (a few swerve to the curb first) and stay stopped.
//
// Streets are derived once per load: the dominant grid angle from the building outlines, a clearance field (metres to
// the nearest building) on a 2 m grid, and long straight ridges of that field along both grid axes = road centrelines.
// Sidewalks = cells 1.2..3.8 m from a building. Everything is instanced (no new lights: see flare.ts).
// Bus in: fx:shake, fx:crack, mission:reset. Reads ctx.player, ctx.day, ctx.dawn. Never emits.

import * as THREE from "three";
import type { FootCtx, Pt, System } from "./engine";
import { buildGrid } from "./worldRoute";

// ------------------------------------------------------------------ tuning
const CELL = 2;
const N_PEOPLE = 64;
const NIGHT_SHARE = 0.4; // share of people still out at night (before the quake)
const CAR_MIX: { kind: VKind; n: number }[] = [
  { kind: "car", n: 26 },
  { kind: "truck", n: 4 },
  { kind: "bus", n: 2 },
];
const NEAR_R = 170; // people/cars live within this of Bob (re-spawned out there when they drift away)
const SIDEWALK: [number, number] = [1.2, 3.8];
const LANE_W = 3.3;

type VKind = "car" | "truck" | "bus";
const VSPEC: Record<VKind, { L: number; W: number; H: number; vmax: [number, number] }> = {
  car: { L: 4.4, W: 1.85, H: 1.45, vmax: [9, 13] },
  truck: { L: 7.2, W: 2.4, H: 3.1, vmax: [7.5, 10] },
  bus: { L: 12, W: 2.55, H: 3.15, vmax: [7, 9] },
};
const CAR_COLORS = [0xd8d8d8, 0x1c1c20, 0x8a9099, 0xa31f24, 0x24467a, 0xf2f2ee, 0x3d4a3a, 0xc9a227, 0x5a2d6e, 0x7a8c99, 0xe0e4e8, 0x2f2f33];
const TRUCK_COLORS = [0xf4f4f0, 0xe6e2d6, 0x2b5aa0, 0xc0392b];
const BUS_COLORS = [0xd9a520, 0xe8e8e8, 0xc8402e];
const SHIRTS = [0x2e4a7d, 0xb23a3a, 0xe0d6c2, 0x3a6b4a, 0x222428, 0xd4a017, 0x7d4a8c, 0x5f7f99, 0xf0f0f0, 0x8c5a3c, 0x46a0a8, 0xc46a9a];
const SKINS = [0xf1c8a5, 0xd9a07a, 0xb27a52, 0x8a5634, 0x5e3a22, 0xe8b894];

type Road = { ax: number; a: Pt; dir: Pt; L: number; half: number };
type Lane = { road: Road; a: Pt; dir: Pt; L: number; stops: number[] };
type Car = {
  kind: VKind; lane: Lane | null; s: number; v: number; vmax: number;
  lat: number; latTo: number; // swerve offset toward the curb (m)
  stopAt: number; // ctx.time when this car brakes for the quake (Infinity = normal)
  hazard: boolean; color: THREE.Color;
};
type Person = {
  x: number; z: number; dx: number; dz: number; v: number; phase: number; height: number;
  mode: "walk" | "idle" | "flee" | "gather"; t: number; // seconds left in the current walk/idle leg
  tx: number; tz: number; // flee target
  active: boolean;
};

// ------------------------------------------------------------------ geometry helpers
function colored(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const n = g.toNonIndexed();
  g.dispose();
  const c = new THREE.Color(hex);
  const cnt = n.getAttribute("position").count;
  const arr = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) arr.set([c.r, c.g, c.b], i * 3);
  n.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  n.deleteAttribute("uv");
  return n;
}
function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of ["position", "normal", "color"]) {
    const total = parts.reduce((a, p) => a + p.getAttribute(name).array.length, 0);
    const arr = new Float32Array(total);
    let o = 0;
    for (const p of parts) {
      arr.set(p.getAttribute(name).array as Float32Array, o);
      o += p.getAttribute(name).array.length;
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
  parts.forEach((p) => p.dispose());
  return out;
}
const box = (w: number, h: number, d: number, x: number, y: number, z: number, hex: number) => colored(new THREE.BoxGeometry(w, h, d).translate(x, y, z), hex);

/** A vehicle along local -z (forward), origin on the ground at its centre. body = body + glass + wheels; lamps = head + tail. */
function vehicleGeo(kind: VKind) {
  const { L, W, H } = VSPEC[kind];
  const wheelR = kind === "car" ? 0.33 : 0.48;
  const parts: THREE.BufferGeometry[] = [];
  const clear = wheelR * 0.9;
  if (kind === "car") {
    parts.push(box(W, 0.62, L, 0, clear + 0.31, 0, 0xffffff)); // lower body
    parts.push(box(W * 0.86, 0.5, L * 0.5, 0, clear + 0.62 + 0.25, L * 0.04, 0x2a3440)); // cabin glass
    parts.push(box(W * 0.84, 0.06, L * 0.46, 0, clear + 0.62 + 0.53, L * 0.04, 0xffffff)); // roof
  } else if (kind === "truck") {
    parts.push(box(W, H - clear - 0.1, L * 0.7, 0, clear + (H - clear) / 2, L * 0.15, 0xffffff)); // box
    parts.push(box(W * 0.96, 1.5, L * 0.28, 0, clear + 0.75, -L * 0.35, 0xffffff)); // cab
    parts.push(box(W * 0.9, 0.6, 0.05, 0, clear + 1.15, -L * 0.49, 0x2a3440)); // windscreen
  } else {
    parts.push(box(W, H - clear, L, 0, clear + (H - clear) / 2, 0, 0xffffff));
    parts.push(box(W + 0.02, 0.9, L * 0.86, 0, clear + 1.55, L * 0.03, 0x24303c)); // window band
    parts.push(box(W * 0.92, 1.2, 0.04, 0, clear + 1.45, -L / 2 - 0.01, 0x24303c)); // windscreen
  }
  const wx = W / 2 - 0.12, wz = L / 2 - (kind === "bus" ? 2.2 : kind === "truck" ? 1.3 : 0.85);
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) parts.push(colored(new THREE.CylinderGeometry(wheelR, wheelR, 0.26, 10).rotateZ(Math.PI / 2).translate(sx * wx, wheelR, sz * wz), 0x111111));
  const body = merge(parts);
  const ly = clear + 0.35;
  const lamps = merge([
    box(0.32, 0.14, 0.06, -W / 2 + 0.3, ly, -L / 2 - 0.02, 0xfff4d8),
    box(0.32, 0.14, 0.06, W / 2 - 0.3, ly, -L / 2 - 0.02, 0xfff4d8),
    box(0.28, 0.14, 0.06, -W / 2 + 0.28, ly, L / 2 + 0.02, 0xd01818),
    box(0.28, 0.14, 0.06, W / 2 - 0.28, ly, L / 2 + 0.02, 0xd01818),
  ]);
  const hz = merge([
    box(0.16, 0.16, 0.08, -W / 2 + 0.06, ly + 0.02, -L / 2 - 0.05, 0xffffff),
    box(0.16, 0.16, 0.08, W / 2 - 0.06, ly + 0.02, -L / 2 - 0.05, 0xffffff),
    box(0.16, 0.16, 0.08, -W / 2 + 0.06, ly + 0.02, L / 2 + 0.05, 0xffffff),
    box(0.16, 0.16, 0.08, W / 2 - 0.06, ly + 0.02, L / 2 + 0.05, 0xffffff),
  ]);
  return { body, lamps, hz };
}

function glowTex(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(0.5, "rgba(255,255,255,0.35)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ------------------------------------------------------------------ the street map (derived once)
function streetMap(ctx: FootCtx) {
  const b = ctx.bounds;
  const g = buildGrid(ctx.colliders, b, CELL, 0);
  const { w, h } = g;
  // clearance (m to the nearest blocked cell): two-pass chamfer
  const D = new Float32Array(w * h);
  for (let k = 0; k < w * h; k++) D[k] = g.walk[k] ? 1e6 : 0;
  const S = CELL, Dg = CELL * Math.SQRT2;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let d = D[k];
      if (!d) continue;
      if (i > 0) d = Math.min(d, D[k - 1] + S);
      if (j > 0) {
        d = Math.min(d, D[k - w] + S);
        if (i > 0) d = Math.min(d, D[k - w - 1] + Dg);
        if (i < w - 1) d = Math.min(d, D[k - w + 1] + Dg);
      }
      D[k] = d;
    }
  for (let j = h - 1; j >= 0; j--)
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let d = D[k];
      if (!d) continue;
      if (i < w - 1) d = Math.min(d, D[k + 1] + S);
      if (j < h - 1) {
        d = Math.min(d, D[k + w] + S);
        if (i < w - 1) d = Math.min(d, D[k + w + 1] + Dg);
        if (i > 0) d = Math.min(d, D[k + w - 1] + Dg);
      }
      D[k] = d;
    }
  const clr = (x: number, z: number) => {
    const i = Math.floor((x - g.x0) / CELL), j = Math.floor((z - g.z0) / CELL);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : Math.min(D[j * w + i], 200);
  };

  // dominant street angle: building edges, length-weighted, folded to 0..90 degrees
  const hist = new Float32Array(90);
  for (const c of ctx.colliders) {
    if (c.maxX < b.x0 || c.minX > b.x1 || c.maxZ < b.z0 || c.minZ > b.z1) continue;
    for (let i = 0; i < c.pts.length; i++) {
      const p = c.pts[i], q = c.pts[(i + 1) % c.pts.length];
      const L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (L < 4) continue;
      let a = (Math.atan2(q[1] - p[1], q[0] - p[0]) * 180) / Math.PI;
      a = ((a % 90) + 90) % 90;
      hist[Math.floor(a) % 90] += L;
    }
  }
  let best = 0, bestV = -1;
  for (let a = 0; a < 90; a++) {
    const v = hist[(a + 89) % 90] + hist[a] * 2 + hist[(a + 1) % 90];
    if (v > bestV) {
      bestV = v;
      best = a;
    }
  }
  const th = ((best + 0.5) * Math.PI) / 180;
  const axes: [Pt, Pt][] = [
    [[Math.cos(th), Math.sin(th)], [-Math.sin(th), Math.cos(th)]],
    [[-Math.sin(th), Math.cos(th)], [Math.cos(th), Math.sin(th)]],
  ];

  // ridges of the clearance field along each axis = road centrelines
  const corners: Pt[] = [[b.x0, b.z0], [b.x1, b.z0], [b.x0, b.z1], [b.x1, b.z1]];
  const roads: Road[] = [];
  const CMIN = 6.5, TSTEP = 2;
  axes.forEach(([u, n], ax) => {
    const ts = corners.map((p) => p[0] * u[0] + p[1] * u[1]), vs = corners.map((p) => p[0] * n[0] + p[1] * n[1]);
    const t0 = Math.min(...ts), t1 = Math.max(...ts), v0 = Math.ceil(Math.min(...vs)), v1 = Math.floor(Math.max(...vs));
    const at = (t: number, v: number) => clr(u[0] * t + n[0] * v, u[1] * t + n[1] * v);
    const prof = new Float32Array(v1 - v0 + 1);
    for (let v = v0 + 4; v <= v1 - 4; v++) {
      let cnt = 0;
      for (let t = t0; t <= t1; t += TSTEP) {
        const c = at(t, v);
        if (c < CMIN) continue;
        if (c >= at(t, v - 2) && c >= at(t, v + 2) && c >= at(t, v - 4) && c >= at(t, v + 4)) cnt++;
      }
      prof[v - v0] = cnt;
    }
    const sm = prof.map((_, i) => (prof[i - 1] ?? 0) + prof[i] * 2 + (prof[i + 1] ?? 0));
    for (let i = 0; i < sm.length; i++) {
      if (sm[i] * TSTEP < 4 * 50) continue;
      let peak = true;
      for (let k = Math.max(0, i - 12); k <= Math.min(sm.length - 1, i + 12) && peak; k++) if (sm[k] > sm[i] || (sm[k] === sm[i] && k < i)) peak = false;
      if (!peak) continue;
      const v = v0 + i;
      // runs along the line where a two-lane road fits, bridging short gaps (intersections)
      let start = NaN, lastOk = NaN, sum = 0, cnt = 0;
      const flush = () => {
        if (Number.isFinite(start) && lastOk - start >= 60) {
          const a: Pt = [u[0] * start + n[0] * v, u[1] * start + n[1] * v];
          roads.push({ ax, a, dir: u, L: lastOk - start, half: sum / cnt });
        }
        start = NaN;
        sum = cnt = 0;
      };
      for (let t = t0; t <= t1 + TSTEP; t += TSTEP) {
        const c = t <= t1 ? at(t, v) : -1;
        if (c >= 5) {
          if (!Number.isFinite(start)) start = t;
          lastOk = t;
          sum += Math.min(c, 14);
          cnt++;
        } else if (Number.isFinite(start) && t - lastOk > 12) flush();
      }
      flush();
    }
  });

  // lanes: right-hand traffic, one lane each way (two on wide roads)
  const lanes: Lane[] = [];
  for (const r of roads) {
    const per = r.half >= 10.5 ? 2 : 1;
    for (const sgn of [1, -1]) {
      const dir: Pt = [r.dir[0] * sgn, r.dir[1] * sgn];
      const right: Pt = [-dir[1], dir[0]];
      const a0: Pt = sgn > 0 ? r.a : [r.a[0] + r.dir[0] * r.L, r.a[1] + r.dir[1] * r.L];
      for (let k = 0; k < per; k++) {
        const off = LANE_W * (k + 0.55);
        lanes.push({ road: r, a: [a0[0] + right[0] * off, a0[1] + right[1] * off], dir, L: r.L, stops: [] });
      }
    }
  }
  // stop lines: where a lane crosses a road of the other axis
  for (const l of lanes)
    for (const r of roads) {
      if (r.ax === l.road.ax) continue;
      // solve l.a + s*l.dir = r.a + q*r.dir
      const det = l.dir[0] * -r.dir[1] - l.dir[1] * -r.dir[0];
      if (Math.abs(det) < 1e-6) continue;
      const dx = r.a[0] - l.a[0], dz = r.a[1] - l.a[1];
      const s = (dx * -r.dir[1] - dz * -r.dir[0]) / det;
      const q = (l.dir[0] * dz - l.dir[1] * dx) / det;
      if (q < -6 || q > r.L + 6) continue;
      const stop = s - r.half - 1;
      if (stop > 4 && stop < l.L - 4) l.stops.push(stop);
    }
  for (const l of lanes) l.stops.sort((x, y) => x - y);

  // sidewalks and open spaces (cell centres)
  const side: number[] = [];
  const open: number[] = [];
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const d = D[j * w + i];
      const x = g.x0 + (i + 0.5) * CELL, z = g.z0 + (j + 0.5) * CELL;
      if (d >= SIDEWALK[0] && d <= SIDEWALK[1]) side.push(x, z);
      else if (d >= 9 && d < 1e5) open.push(x, z);
    }
  return { clr, axes, roads, lanes, side: Float32Array.from(side), open: Float32Array.from(open) };
}

// ------------------------------------------------------------------ the system
/** Never takes the game down: if the street map can't be built, the city is just empty again. */
export function createStreetLife(ctx: FootCtx): System {
  try {
    return build(ctx);
  } catch (e) {
    console.error("[foot] streetLife", e);
    return { update() {}, dispose() {} };
  }
}

function build(ctx: FootCtx): System {
  const built = performance.now();
  const map = streetMap(ctx);
  const { clr, axes, lanes } = map;
  const rnd = Math.random;
  const group = new THREE.Group();
  group.name = "streetLife";
  ctx.scene.add(group);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);
  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number) => {
    const m = new THREE.InstancedMesh(keep(geo), keep(mat), Math.max(1, n));
    m.frustumCulled = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(m);
    return m;
  };
  const dummy = new THREE.Object3D();
  dummy.rotation.order = "YXZ";
  const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
  const p = ctx.player;
  const distP = (x: number, z: number) => Math.hypot(x - p.x, z - p.z);
  const dbg = { roads: map.roads.length, lanes: lanes.length, side: map.side.length / 2, open: map.open.length / 2, quake: -1, buildMs: Math.round(performance.now() - built), updMs: 0 };

  // ================================================================== traffic
  const cars: Car[] = [];
  const meshes = new Map<VKind, { body: THREE.InstancedMesh; lamps: THREE.InstancedMesh; hz: THREE.InstancedMesh; idx: number[] }>();
  const lampMat = keep(new THREE.MeshBasicMaterial({ vertexColors: true, color: 0x888888 }));
  const hzMat = keep(new THREE.MeshBasicMaterial({ color: 0xff9a1a }));
  const total = CAR_MIX.reduce((a, c) => a + c.n, 0);
  const beams = inst(new THREE.PlaneGeometry(4.2, 9).rotateX(-Math.PI / 2).translate(0, 0.06, -9), new THREE.MeshBasicMaterial({ map: keep(glowTex()), color: 0xffe6b0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), total);
  for (const { kind, n } of CAR_MIX) {
    const geo = vehicleGeo(kind);
    const body = inst(geo.body, new THREE.MeshLambertMaterial({ vertexColors: true }), n);
    const lamps = inst(geo.lamps, lampMat, n);
    const hz = inst(geo.hz, hzMat, n);
    const idx: number[] = [];
    const pal = kind === "car" ? CAR_COLORS : kind === "truck" ? TRUCK_COLORS : BUS_COLORS;
    for (let i = 0; i < n; i++) {
      const color = new THREE.Color(pal[Math.floor(rnd() * pal.length)]);
      body.setColorAt(i, color);
      idx.push(cars.length);
      const sp = VSPEC[kind].vmax;
      cars.push({ kind, lane: null, s: 0, v: 0, vmax: sp[0] + rnd() * (sp[1] - sp[0]), lat: 0, latTo: 0, stopAt: Infinity, hazard: false, color });
    }
    if (body.instanceColor) body.instanceColor.needsUpdate = true;
    meshes.set(kind, { body, lamps, hz, idx });
  }
  const laneDist = (l: Lane) => {
    const dx = p.x - l.a[0], dz = p.z - l.a[1];
    const s = Math.max(0, Math.min(l.L, dx * l.dir[0] + dz * l.dir[1]));
    return Math.hypot(l.a[0] + l.dir[0] * s - p.x, l.a[1] + l.dir[1] * s - p.z);
  };
  const free = (l: Lane, s: number, len: number, self: Car) => cars.every((c) => c === self || c.lane !== l || Math.abs(c.s - s) > (VSPEC[c.kind].L + len) / 2 + 6);
  /** Put a car on a lane near Bob: anywhere along it when out of his sight range, else at the lane's start. */
  const placeCar = (c: Car, anywhere: boolean) => {
    const near = lanes.filter((l) => laneDist(l) < NEAR_R && (c.kind !== "bus" || l.L > 120));
    const pool = near.length ? near : lanes;
    if (!pool.length) return;
    const len = VSPEC[c.kind].L;
    for (let tries = 0; tries < 12; tries++) {
      const l = pool[Math.floor(rnd() * pool.length)];
      let s = len / 2;
      if (anywhere) s = len / 2 + rnd() * Math.max(0, l.L - len);
      else if (distP(l.a[0], l.a[1]) < 45) continue;
      if (!free(l, s, len, c)) continue;
      Object.assign(c, { lane: l, s, v: anywhere ? c.vmax * 0.8 : c.vmax * 0.6, lat: 0, latTo: 0 });
      return;
    }
    c.lane = null;
  };
  const resetCars = () => {
    for (const c of cars) Object.assign(c, { lane: null, stopAt: Infinity, hazard: false });
    for (const c of cars) placeCar(c, true);
  };

  // ================================================================== people
  const people: Person[] = [];
  const bodyGeo = merge([box(0.34, 0.84, 0.2, 0, 0.42, 0, 0x3a3a40), box(0.44, 0.62, 0.25, 0, 1.15, 0, 0xffffff)]);
  const pBody = inst(bodyGeo, new THREE.MeshLambertMaterial({ vertexColors: true }), N_PEOPLE);
  const pHead = inst(colored(new THREE.SphereGeometry(0.13, 8, 6).translate(0, 1.6, 0), 0xffffff), new THREE.MeshLambertMaterial({ vertexColors: true }), N_PEOPLE);
  const armGeo = (sx: number) => colored(new THREE.BoxGeometry(0.11, 0.6, 0.12).translate(sx * 0.28, -0.3, 0), 0xffffff);
  const armMat = keep(new THREE.MeshLambertMaterial({ vertexColors: true }));
  const pArmL = inst(armGeo(-1), armMat, N_PEOPLE);
  const pArmR = inst(armGeo(1), armMat, N_PEOPLE);
  const randSide = (minD: number, maxD: number): Pt | null => {
    const n = map.side.length / 2;
    for (let t = 0; t < 40 && n; t++) {
      const k = Math.floor(rnd() * n) * 2;
      const x = map.side[k], z = map.side[k + 1];
      const d = distP(x, z);
      if (d >= minD && d <= maxD) return [x, z];
    }
    return null;
  };
  const okWalk = (x: number, z: number) => {
    const c = clr(x, z);
    return c >= SIDEWALK[0] - 0.4 && c <= SIDEWALK[1] + 0.6;
  };
  /** A new heading along the street grid that stays on the sidewalk. */
  const turn = (q: Person) => {
    const dirs: Pt[] = [axes[0][0], axes[1][0], [-axes[0][0][0], -axes[0][0][1]], [-axes[1][0][0], -axes[1][0][1]]];
    const ok = dirs.filter((d) => okWalk(q.x + d[0] * 3, q.z + d[1] * 3) && okWalk(q.x + d[0] * 1.5, q.z + d[1] * 1.5));
    const fwd = ok.filter((d) => d[0] * q.dx + d[1] * q.dz > -0.5);
    const pick = (fwd.length ? fwd : ok)[Math.floor(rnd() * (fwd.length || ok.length))];
    if (pick) [q.dx, q.dz] = pick;
    return !!pick;
  };
  const spawnPerson = (q: Person, minD: number) => {
    const at = randSide(minD, NEAR_R - 20) ?? randSide(0, 1e9);
    if (!at) return;
    [q.x, q.z] = at;
    q.mode = "walk";
    q.t = 10 + rnd() * 30;
    turn(q);
  };
  for (let i = 0; i < N_PEOPLE; i++) {
    const q: Person = { x: 0, z: 0, dx: 1, dz: 0, v: 1.15 + rnd() * 0.45, phase: rnd() * 6, height: 0.9 + rnd() * 0.18, mode: "walk", t: 0, tx: 0, tz: 0, active: true };
    const shirt = new THREE.Color(SHIRTS[Math.floor(rnd() * SHIRTS.length)]);
    pBody.setColorAt(i, shirt);
    pArmL.setColorAt(i, shirt);
    pArmR.setColorAt(i, shirt);
    pHead.setColorAt(i, new THREE.Color(SKINS[Math.floor(rnd() * SKINS.length)]));
    people.push(q);
  }
  for (const m of [pBody, pHead, pArmL, pArmR]) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  const resetPeople = () => people.forEach((q) => spawnPerson(q, 0));

  // ================================================================== the quake
  let quakeAt = -1;
  const quake = () => {
    if (quakeAt >= 0) return;
    quakeAt = ctx.time;
    dbg.quake = quakeAt;
    for (const c of cars) {
      c.stopAt = ctx.time + rnd() * 1.6;
      c.hazard = rnd() < 0.8;
      if (rnd() < 0.3) c.latTo = 1.2 + rnd() * 1.1; // swerve toward the curb
    }
    const n = map.open.length / 2;
    for (const q of people) {
      if (!q.active || !n) continue;
      // the nearest open space (sampled), away from the buildings
      let bx = q.x, bz = q.z, bd = Infinity;
      for (let t = 0; t < 260; t++) {
        const k = Math.floor(rnd() * n) * 2;
        const d = Math.hypot(map.open[k] - q.x, map.open[k + 1] - q.z);
        if (d < bd && d > 4) {
          bd = d;
          bx = map.open[k];
          bz = map.open[k + 1];
        }
      }
      Object.assign(q, { mode: "flee", tx: bx + (rnd() - 0.5) * 6, tz: bz + (rnd() - 0.5) * 6, v: 3.6 + rnd() * 1.6, t: 0.2 + rnd() * 0.7 });
    }
  };
  const offs = [
    ctx.bus.on("fx:shake", quake),
    ctx.bus.on("fx:crack", () => ctx.day > 0.5 && quake()),
    ctx.bus.on("mission:reset", () => {
      quakeAt = -1;
      dbg.quake = -1;
      people.forEach((q) => (q.v = 1.15 + rnd() * 0.45));
      resetPeople();
      resetCars();
    }),
  ];
  resetPeople();
  resetCars();
  if (process.env.NODE_ENV !== "production") (window as unknown as { __street?: unknown }).__street = { dbg, map, cars, people, quake };

  // ================================================================== per frame
  let blink = 0;
  const updateCars = (dt: number) => {
    const t = ctx.time;
    const cyc = t % 26; // signals: axis 0 green 0-11, all red 11-13, axis 1 green 13-24, all red 24-26
    const green = (ax: number) => (ax === 0 ? cyc < 11 : cyc >= 13 && cyc < 24);
    for (const c of cars) {
      const l = c.lane;
      if (!l) {
        if (quakeAt < 0 && rnd() < dt) placeCar(c, false);
        continue;
      }
      const len = VSPEC[c.kind].L;
      let vDes = c.vmax;
      if (t >= c.stopAt) vDes = 0;
      else {
        // leader in lane
        let gap = Infinity;
        for (const o of cars) if (o !== c && o.lane === l && o.s > c.s) gap = Math.min(gap, o.s - c.s - (len + VSPEC[o.kind].L) / 2);
        // Bob in the lane ahead
        const dx = p.x - l.a[0], dz = p.z - l.a[1];
        const ps = dx * l.dir[0] + dz * l.dir[1], latOff = Math.abs(dx * -l.dir[1] + dz * l.dir[0]);
        if (!p.hidden && latOff < 2.6 && ps > c.s) gap = Math.min(gap, ps - c.s - len / 2 - 2.5);
        // red light
        if (!green(l.road.ax))
          for (const st of l.stops) {
            const d = st - (c.s + len / 2);
            if (d < -1) continue;
            if (d > c.v * c.v / 8 - 1 || c.v < 4) gap = Math.min(gap, d + 0.5);
            break;
          }
        vDes = Math.min(vDes, Math.max(0, (gap - 1.5) * 0.9));
      }
      c.v = c.v < vDes ? Math.min(vDes, c.v + 2.6 * dt) : Math.max(vDes, c.v - (t >= c.stopAt ? 5.5 : 8) * dt);
      c.s += c.v * dt;
      if (t >= c.stopAt) c.lat += (c.latTo - c.lat) * Math.min(1, dt * 1.6);
      if (c.s > l.L - len / 2) {
        if (quakeAt >= 0) c.s = l.L - len / 2;
        else placeCar(c, false);
      }
      if (quakeAt < 0 && c.lane && laneDist(c.lane) > NEAR_R + 60) placeCar(c, false);
    }
  };
  const drawCars = () => {
    const lit = Math.max(Math.min(1, ctx.day ?? 0), Math.min(1, ctx.dawn));
    const night = 1 - lit;
    lampMat.color.setScalar(0.45 + 0.55 * night);
    (beams.material as THREE.MeshBasicMaterial).opacity = 0.55 * night;
    beams.visible = night > 0.05;
    const on = blink % 0.8 < 0.4;
    let bi = 0;
    for (const [kind, m] of meshes) {
      const len = VSPEC[kind].L;
      m.idx.forEach((ci, i) => {
        const c = cars[ci];
        const l = c.lane;
        if (!l) {
          m.body.setMatrixAt(i, ZERO);
          m.lamps.setMatrixAt(i, ZERO);
          m.hz.setMatrixAt(i, ZERO);
          beams.setMatrixAt(bi++, ZERO);
          return;
        }
        const right: Pt = [-l.dir[1], l.dir[0]];
        const x = l.a[0] + l.dir[0] * c.s + right[0] * c.lat, z = l.a[1] + l.dir[1] * c.s + right[1] * c.lat;
        const yaw = Math.atan2(l.dir[0], -l.dir[1]) + (c.latTo - c.lat) * 0.25 * (c.v > 0.5 ? 1 : 0) + c.latTo * 0.06;
        const fade = quakeAt >= 0 ? 1 : Math.max(0, Math.min(1, (c.s - len / 2) / 6, (l.L - len / 2 - c.s) / 6 + 0.001));
        dummy.position.set(x, 0, z);
        dummy.rotation.set(0, -yaw, 0);
        dummy.scale.set(fade, fade, fade);
        dummy.updateMatrix();
        m.body.setMatrixAt(i, dummy.matrix);
        m.lamps.setMatrixAt(i, dummy.matrix);
        m.hz.setMatrixAt(i, c.hazard && ctx.time >= c.stopAt && on ? dummy.matrix : ZERO);
        beams.setMatrixAt(bi++, dummy.matrix);
      });
      m.body.instanceMatrix.needsUpdate = m.lamps.instanceMatrix.needsUpdate = m.hz.instanceMatrix.needsUpdate = true;
    }
    beams.instanceMatrix.needsUpdate = true;
  };

  const updatePeople = (dt: number) => {
    const lit = Math.max(Math.min(1, ctx.day ?? 0), Math.min(1, ctx.dawn));
    const want = quakeAt >= 0 ? N_PEOPLE : Math.round(N_PEOPLE * (NIGHT_SHARE + (1 - NIGHT_SHARE) * lit));
    const since = quakeAt >= 0 ? ctx.time - quakeAt : -1;
    people.forEach((q, i) => {
      // night thins the streets: the extra people step out of sight (far from Bob) and come back by day
      const should = i < want;
      if (should !== q.active && (should || distP(q.x, q.z) > 45)) {
        q.active = should;
        if (should) spawnPerson(q, 50);
      }
      if (!q.active) return;
      if (q.mode === "walk" || q.mode === "idle") {
        q.t -= dt;
        if (q.t <= 0) {
          if (q.mode === "walk" && rnd() < 0.3) Object.assign(q, { mode: "idle", t: 2 + rnd() * 6 });
          else Object.assign(q, { mode: "walk", t: 8 + rnd() * 25 });
        }
        if (q.mode === "walk") {
          const nx = q.x + q.dx * q.v * dt, nz = q.z + q.dz * q.v * dt;
          if (okWalk(nx + q.dx * 0.8, nz + q.dz * 0.8)) {
            q.x = nx;
            q.z = nz;
          } else if (!turn(q)) spawnPerson(q, 50);
          // corners: sometimes take the side street
          if (rnd() < dt * 0.05) turn(q);
        }
        if (distP(q.x, q.z) > NEAR_R + 30 && quakeAt < 0) spawnPerson(q, 60);
      } else if (q.mode === "flee") {
        q.t -= dt; // a startled beat before running
        if (q.t < 0) {
          const dx = q.tx - q.x, dz = q.tz - q.z, d = Math.hypot(dx, dz);
          if (d < 1) Object.assign(q, { mode: "gather", t: 0 });
          else {
            const v = Math.min(q.v, d * 2);
            [q.dx, q.dz] = [dx / d, dz / d];
            [q.x, q.z] = ctx.collide(q.x + q.dx * v * dt, q.z + q.dz * v * dt, 0.3);
            if (since > 25) Object.assign(q, { mode: "gather", t: 0 }); // stuck: stop where they are
          }
        }
      } else {
        // gathered: mill about a little, calming over ~30 s; face the buildings they ran from
        q.t += dt;
        const calm = Math.min(1, since / 35);
        if (rnd() < dt * (0.6 - 0.45 * calm)) {
          const a = rnd() * Math.PI * 2;
          [q.tx, q.tz] = [q.x + Math.cos(a) * 1.5, q.z + Math.sin(a) * 1.5];
        }
        const dx = q.tx - q.x, dz = q.tz - q.z, d = Math.hypot(dx, dz);
        if (d > 0.2) {
          [q.x, q.z] = ctx.collide(q.x + (dx / d) * 0.9 * dt, q.z + (dz / d) * 0.9 * dt, 0.3);
          [q.dx, q.dz] = [dx / d, dz / d];
        }
      }
      // never block Bob: step aside
      const bx = q.x - p.x, bz = q.z - p.z, bd = Math.hypot(bx, bz);
      if (bd < 0.9 && !p.hidden) {
        const k = (0.9 - bd) / (bd || 1e-3);
        q.x += bx * k;
        q.z += bz * k;
      }
    });
  };
  const drawPeople = (dt: number) => {
    const since = quakeAt >= 0 ? ctx.time - quakeAt : -1;
    people.forEach((q, i) => {
      if (!q.active) {
        for (const m of [pBody, pHead, pArmL, pArmR]) m.setMatrixAt(i, ZERO);
        return;
      }
      const moving = q.mode === "walk" || (q.mode === "flee" && q.t < 0) || (q.mode === "gather" && Math.hypot(q.tx - q.x, q.tz - q.z) > 0.2);
      const running = q.mode === "flee" && q.t < 0;
      const speed = running ? q.v : moving ? (q.mode === "walk" ? q.v : 0.9) : 0;
      q.phase += speed * dt * 3.6;
      const bob = moving ? Math.abs(Math.sin(q.phase)) * (running ? 0.12 : 0.05) : 0;
      const yaw = Math.atan2(q.dx, -q.dz);
      dummy.position.set(q.x, bob, q.z);
      dummy.rotation.set(running ? -0.22 : 0, -yaw, 0);
      dummy.scale.setScalar(q.height);
      dummy.updateMatrix();
      pBody.setMatrixAt(i, dummy.matrix);
      pHead.setMatrixAt(i, dummy.matrix);
      // arms: swing when walking; up and flailing when running or panicked
      const panic = q.mode === "flee" || (q.mode === "gather" && since < 12 && (i % 3 === 0));
      const sw = Math.sin(q.phase) * (moving ? 0.45 : 0.04);
      const sh = 1.45 * q.height;
      for (const [m, sgn] of [[pArmL, 1], [pArmR, -1]] as const) {
        dummy.position.set(q.x, bob + sh, q.z);
        dummy.rotation.set(panic ? 2.6 + Math.sin(q.phase * 1.7 + sgn) * 0.35 : sw * sgn, -yaw, panic ? -sgn * 0.25 : 0);
        dummy.updateMatrix();
        m.setMatrixAt(i, dummy.matrix);
      }
    });
    for (const m of [pBody, pHead, pArmL, pArmR]) m.instanceMatrix.needsUpdate = true;
  };

  return {
    update(dt) {
      const t0 = performance.now();
      blink += dt;
      updateCars(dt);
      updatePeople(dt);
      drawCars();
      drawPeople(dt);
      dbg.updMs = dbg.updMs * 0.95 + (performance.now() - t0) * 0.05;
    },
    dispose() {
      offs.forEach((o) => o());
      ctx.scene.remove(group);
      disposables.forEach((d) => d.dispose());
    },
  };
}
