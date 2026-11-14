// OWNER: builder C (world). Geometry for real building outlines: walls with UVs in world metres (one bay = BAY_M,
// one floor = FLOOR_M), flat roofs, parapets, ground bands. Buildings are appended into shared buffers and merged
// into one geometry per material, so ~250 buildings cost a handful of draw calls.

import * as THREE from "three";
import { FLOOR_M, type Pt } from "./engine";
import { BAY_M, TILE } from "./worldTex";

export type Buf = { pos: number[]; nrm: number[]; uv: number[]; col: number[]; lit: number[] };
export const newBuf = (): Buf => ({ pos: [], nrm: [], uv: [], col: [], lit: [] });

/** Signed area (shoelace) in the x/z plane; > 0 means outward normal of edge a->b is (dz, -dx). */
function area2(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[(i + 1) % pts.length];
    s += ax * bz - bx * az;
  }
  return s;
}

/** Drop the closing duplicate and near-duplicate points; orient so area2 > 0. Returns [] when degenerate. */
export function cleanRing(raw: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of raw) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = out[out.length - 1];
    if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.05) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 0.05) out.pop();
  if (out.length < 3) return [];
  const a = area2(out);
  if (Math.abs(a) < 1) return [];
  return a > 0 ? out : out.reverse();
}

export const areaOf = (ring: Pt[]): number => Math.abs(area2(ring)) / 2;

export function centroid(ring: Pt[]): Pt {
  let x = 0, z = 0;
  for (const p of ring) {
    x += p[0];
    z += p[1];
  }
  return [x / ring.length, z / ring.length];
}

export function radiusOf(ring: Pt[], c: Pt): number {
  let r = 0;
  for (const p of ring) r = Math.max(r, Math.hypot(p[0] - c[0], p[1] - c[1]));
  return r;
}

/** Offset a (cleaned, area2 > 0) ring outward by d metres with clamped miters. */
export function offsetRing(ring: Pt[], d: number): Pt[] {
  const n = ring.length;
  const nrm = (i: number): Pt => {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    return [(bz - az) / l, -(bx - ax) / l];
  };
  return ring.map((p, i) => {
    const n1 = nrm((i - 1 + n) % n), n2 = nrm(i);
    let mx = n1[0] + n2[0], mz = n1[1] + n2[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml;
    mz /= ml;
    const k = d / Math.max(0.35, mx * n2[0] + mz * n2[1]);
    return [p[0] + mx * k, p[1] + mz * k] as Pt;
  });
}

/**
 * Vertical chunks of a wall and the texture row shift for each: row 0 of the facade tile is the street-level
 * storefront (the ground floor), rows 1..15 are upper floors, repeating every 15 floors above that.
 */
function chunks(y0: number, y1: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const edges = [0, FLOOR_M];
  while (edges[edges.length - 1] < y1) edges.push(edges[edges.length - 1] + 15 * FLOOR_M);
  for (let c = 0; c + 1 < edges.length; c++) {
    const a = Math.max(y0, edges[c]), b = Math.min(y1, edges[c + 1]);
    if (b - a > 1e-3) out.push([a, b, c === 0 ? 0 : 15 * (c - 1)]);
  }
  return out;
}

/**
 * Walls from y0 to y1 around a cleaned ring. u counts bays (each edge snapped to whole bays so windows never wrap a
 * corner), v counts floors from the ground (the ground floor is a storefront). uOff shifts the shared window grid
 * sideways so neighbours look different. UVs are in facade-tile units (TILE bays x TILE floors).
 */
export function addWalls(buf: Buf, ring: Pt[], y0: number, y1: number, color: THREE.Color, lit: number, uOff: number): void {
  let u = uOff;
  const n = ring.length;
  const parts = chunks(y0, y1);
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    const nx = (bz - az) / len, nz = -(bx - ax) / len;
    const bays = len < 2 * BAY_M ? len / BAY_M : Math.round(len / BAY_M);
    const ua = u / TILE, ub = (u + bays) / TILE;
    u = Math.ceil(u + bays);
    for (const [ya, yb, shift] of parts) {
      const v0 = (ya / FLOOR_M - shift) / TILE, v1 = (yb / FLOOR_M - shift) / TILE;
      // (a0, a1, b1), (a0, b1, b0): counter-clockwise seen from outside
      buf.pos.push(ax, ya, az, ax, yb, az, bx, yb, bz, ax, ya, az, bx, yb, bz, bx, ya, bz);
      buf.uv.push(ua, v0, ua, v1, ub, v1, ua, v0, ub, v1, ub, v0);
      for (let k = 0; k < 6; k++) {
        buf.nrm.push(nx, 0, nz);
        buf.col.push(color.r, color.g, color.b);
        buf.lit.push(len < 1.5 ? 0 : lit);
      }
    }
  }
}

/** Plain walls (no window mapping): parapets, rooftop boxes, seams, flashes. */
export function addPlainWalls(buf: Buf, ring: Pt[], y0: number, y1: number, color: THREE.Color): void {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    const nx = (bz - az) / len, nz = -(bx - ax) / len;
    buf.pos.push(ax, y0, az, ax, y1, az, bx, y1, bz, ax, y0, az, bx, y1, bz, bx, y0, bz);
    buf.uv.push(0, 0, 0, 1, 1, 1, 0, 0, 1, 1, 1, 0);
    for (let k = 0; k < 6; k++) {
      buf.nrm.push(nx, 0, nz);
      buf.col.push(color.r, color.g, color.b);
      buf.lit.push(0);
    }
  }
}

/** Bearing of the ring's longest edge (radians, atan2(dz, dx)), so rooftop boxes follow the street grid. */
export function gridAngle(ring: Pt[]): number {
  let best = 0, bl = -1;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    const l = Math.hypot(bx - ax, bz - az);
    if (l > bl) {
      bl = l;
      best = Math.atan2(bz - az, bx - ax);
    }
  }
  return best;
}

/** A rotated rectangle ring (area2 > 0) centred at (x, z). */
export function rectRing(x: number, z: number, w: number, d: number, ang: number): Pt[] {
  const c = Math.cos(ang), s = Math.sin(ang);
  const pts: Pt[] = [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([u, v]) => [x + u * c - v * s, z + u * s + v * c] as Pt);
  return cleanRing(pts);
}

/** A flat horizontal cap at height y (roof), facing up. */
export function addCap(buf: Buf, ring: Pt[], y: number, color: THREE.Color): void {
  const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
  let tris: number[][];
  try {
    tris = THREE.ShapeUtils.triangulateShape(contour, []);
  } catch {
    return;
  }
  for (const [i, j, k] of tris) {
    const p = ring[i], q = ring[j], r = ring[k];
    // cross product y-component: want > 0 (facing up)
    const cy = (q[1] - p[1]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[1] - p[1]);
    const order = cy >= 0 ? [p, q, r] : [p, r, q];
    for (const [x, z] of order) {
      buf.pos.push(x, y, z);
      buf.nrm.push(0, 1, 0);
      buf.uv.push(0, 0);
      buf.col.push(color.r, color.g, color.b);
      buf.lit.push(0);
    }
  }
}

/** A flat band on the ground between two offsets of a ring (retrofit rings). uv = (metres along, 0 inner .. 1 outer). */
export function addBand(buf: Buf, ring: Pt[], dIn: number, dOut: number, y: number): void {
  const a = offsetRing(ring, dIn), b = offsetRing(ring, dOut);
  const n = ring.length;
  let u = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.hypot(a[j][0] - a[i][0], a[j][1] - a[i][1]);
    const V: [Pt, number, number][] = [
      [a[i], u, 0], [b[i], u, 1], [b[j], u + len, 1],
      [a[i], u, 0], [b[j], u + len, 1], [a[j], u + len, 0],
    ];
    u += len;
    const [p, q, r] = V;
    const cy = (q[0][1] - p[0][1]) * (r[0][0] - p[0][0]) - (q[0][0] - p[0][0]) * (r[0][1] - p[0][1]);
    const tri = cy >= 0 ? V : [V[0], V[2], V[1], V[3], V[5], V[4]];
    for (const [[x, z], tu, tv] of tri) {
      buf.pos.push(x, y, z);
      buf.nrm.push(0, 1, 0);
      buf.uv.push(tu, tv);
      buf.col.push(1, 1, 1);
      buf.lit.push(0);
    }
  }
}

/** Roof edge lines (pairs of points) at height y. */
export function addOutline(lines: number[], ring: Pt[], y: number): void {
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % ring.length];
    lines.push(ax, y, az, bx, y, bz);
  }
}

export function toGeometry(buf: Buf, opts: { uv?: boolean; color?: boolean; lit?: boolean } = {}): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(buf.nrm, 3));
  if (opts.uv !== false) g.setAttribute("uv", new THREE.Float32BufferAttribute(buf.uv, 2));
  if (opts.color !== false) g.setAttribute("color", new THREE.Float32BufferAttribute(buf.col, 3));
  if (opts.lit) g.setAttribute("lit", new THREE.Float32BufferAttribute(buf.lit, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/**
 * The facade material: albedo x vertex colour, plus window light from the shared light map, scaled per building by
 * the `lit` attribute (0 = dark, 1 = the sparse set, 2 = sparse + busy set). uniforms.night fades the windows at dawn.
 */
export function facadeMaterial(map: THREE.Texture, light: THREE.Texture, night: { value: number }): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ map, emissiveMap: light, emissive: 0xffffff, vertexColors: true });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = night;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float lit;\nvarying float vLit;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvLit = lit;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying float vLit;\nuniform float uNight;")
      .replace(
        "#include <emissivemap_fragment>",
        `#ifdef USE_EMISSIVEMAP
  vec4 eTex = texture2D( emissiveMap, vEmissiveMapUv );
  float a = min( vLit, 1.0 );
  float wl = eTex.r * a + eTex.g * clamp( vLit - 1.0, 0.0, 1.0 );
  totalEmissiveRadiance *= ( vec3( 1.0, 0.62, 0.30 ) * wl + vec3( 0.45, 0.68, 1.0 ) * eTex.b * a * 0.8 ) * uNight;
#endif`,
      );
  };
  m.customProgramCacheKey = () => "foot-facade-v1";
  return m;
}
