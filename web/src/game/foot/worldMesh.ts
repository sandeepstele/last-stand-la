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
 * Walls from y0 to y1 around a cleaned ring. u counts bays (each edge snapped to whole bays so windows never wrap a
 * corner), v counts floors from the ground. uOff/vOff shift the shared window grid so neighbours look different.
 */
export function addWalls(buf: Buf, ring: Pt[], y0: number, y1: number, color: THREE.Color, lit: number, uOff: number, vOff: number): void {
  let u = uOff;
  const n = ring.length;
  const v0 = (y0 / FLOOR_M + vOff) / TILE, v1 = (y1 / FLOOR_M + vOff) / TILE;
  for (let i = 0; i < n; i++) {
    const [ax, az] = ring[i];
    const [bx, bz] = ring[(i + 1) % n];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    const nx = (bz - az) / len, nz = -(bx - ax) / len;
    const bays = len < 2 * BAY_M ? len / BAY_M : Math.round(len / BAY_M);
    const ua = u / TILE, ub = (u + bays) / TILE;
    u = Math.ceil(u + bays);
    // (a0, a1, b1), (a0, b1, b0): counter-clockwise seen from outside
    const P = [ax, y0, az, ax, y1, az, bx, y1, bz, ax, y0, az, bx, y1, bz, bx, y0, bz];
    const UV = [ua, v0, ua, v1, ub, v1, ua, v0, ub, v1, ub, v0];
    buf.pos.push(...P);
    buf.uv.push(...UV);
    for (let k = 0; k < 6; k++) {
      buf.nrm.push(nx, 0, nz);
      buf.col.push(color.r, color.g, color.b);
      buf.lit.push(len < 1.5 ? 0 : lit);
    }
  }
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

/** A flat band on the ground between two offsets of a ring (retrofit rings). */
export function addBand(buf: Buf, ring: Pt[], dIn: number, dOut: number, y: number): void {
  const a = offsetRing(ring, dIn), b = offsetRing(ring, dOut);
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    // quad a[i], b[i], b[j], a[j]; facing up
    const quad: Pt[] = [a[i], b[i], b[j], a[i], b[j], a[j]];
    const cy = (quad[1][1] - quad[0][1]) * (quad[2][0] - quad[0][0]) - (quad[1][0] - quad[0][0]) * (quad[2][1] - quad[0][1]);
    const tri = cy >= 0 ? quad : [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]];
    for (const [x, z] of tri) {
      buf.pos.push(x, y, z);
      buf.nrm.push(0, 1, 0);
      buf.uv.push(0, 0);
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
