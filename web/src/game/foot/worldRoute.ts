// OWNER: builder C (world). The walkable route: a 2 m grid A* around every building, smoothed by line of sight,
// drawn as a glowing amber ribbon with dashes flowing toward the target.

import * as THREE from "three";
import { blocked, closestOnPoly, pointInPoly } from "./collide";
import type { Collider, FootCtx, Pt } from "./engine";

export type Grid = { x0: number; z0: number; cell: number; w: number; h: number; walk: Uint8Array };

/** Walkability once per load: a cell is blocked when its centre is inside a building or within `margin` of one. */
export function buildGrid(colliders: readonly Collider[], b: FootCtx["bounds"], cell = 2, margin = 1): Grid {
  const w = Math.max(1, Math.ceil((b.x1 - b.x0) / cell)), h = Math.max(1, Math.ceil((b.z1 - b.z0) / cell));
  const walk = new Uint8Array(w * h).fill(1);
  for (const c of colliders) {
    const i0 = Math.max(0, Math.floor((c.minX - margin - b.x0) / cell)), i1 = Math.min(w - 1, Math.floor((c.maxX + margin - b.x0) / cell));
    const j0 = Math.max(0, Math.floor((c.minZ - margin - b.z0) / cell)), j1 = Math.min(h - 1, Math.floor((c.maxZ + margin - b.z0) / cell));
    for (let j = j0; j <= j1; j++) {
      const z = b.z0 + (j + 0.5) * cell;
      for (let i = i0; i <= i1; i++) {
        const k = j * w + i;
        if (!walk[k]) continue;
        const x = b.x0 + (i + 0.5) * cell;
        if (pointInPoly(x, z, c.pts) || closestOnPoly(x, z, c.pts).d < margin) walk[k] = 0;
      }
    }
  }
  return { x0: b.x0, z0: b.z0, cell, w, h, walk };
}

export function walkableAt(g: Grid, x: number, z: number): boolean {
  const i = Math.floor((x - g.x0) / g.cell), j = Math.floor((z - g.z0) / g.cell);
  return i >= 0 && j >= 0 && i < g.w && j < g.h && g.walk[j * g.w + i] === 1;
}

function nearestWalkable(g: Grid, x: number, z: number): number {
  const ci = Math.min(g.w - 1, Math.max(0, Math.floor((x - g.x0) / g.cell)));
  const cj = Math.min(g.h - 1, Math.max(0, Math.floor((z - g.z0) / g.cell)));
  for (let r = 0; r < 40; r++) {
    let best = -1, bd = Infinity;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
        if (i < 0 || j < 0 || i >= g.w || j >= g.h || !g.walk[j * g.w + i]) continue;
        const d = (i - ci) ** 2 + (j - cj) ** 2;
        if (d < bd) {
          bd = d;
          best = j * g.w + i;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Grid line of sight: every ~half cell along a->b is walkable, and no building edge is crossed. */
function clear(g: Grid, colliders: readonly Collider[], a: Pt, b: Pt): boolean {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const n = Math.ceil(L / (g.cell * 0.5));
  for (let s = 1; s < n; s++) {
    const t = s / n;
    if (!walkableAt(g, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false;
  }
  return !blocked(a[0], a[1], b[0], b[1], colliders);
}

/** A* (8-connected, no corner cutting) then line-of-sight smoothing. null when there is no path. */
export function findPath(g: Grid, colliders: readonly Collider[], from: Pt, to: Pt): Pt[] | null {
  const s = nearestWalkable(g, from[0], from[1]);
  const t = nearestWalkable(g, to[0], to[1]);
  if (s < 0 || t < 0) return null;
  const N = g.w * g.h;
  const gs = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const ti = t % g.w, tj = Math.floor(t / g.w);
  const hf = (k: number) => {
    const dx = Math.abs((k % g.w) - ti), dz = Math.abs(Math.floor(k / g.w) - tj);
    return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
  };
  // binary heap of (f, k)
  const hk: number[] = [];
  const hfv: number[] = [];
  const push = (k: number, f: number) => {
    let i = hk.length;
    hk.push(k);
    hfv.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hfv[p] <= f) break;
      hk[i] = hk[p];
      hfv[i] = hfv[p];
      i = p;
    }
    hk[i] = k;
    hfv[i] = f;
  };
  const pop = (): number => {
    const top = hk[0];
    const lk = hk.pop()!, lf = hfv.pop()!;
    if (hk.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mf = lf;
        if (l < hk.length && hfv[l] < mf) {
          m = l;
          mf = hfv[l];
        }
        if (r < hk.length && hfv[r] < mf) m = r;
        if (m === i) break;
        hk[i] = hk[m];
        hfv[i] = hfv[m];
        i = m;
      }
      hk[i] = lk;
      hfv[i] = lf;
    }
    return top;
  };
  gs[s] = 0;
  push(s, hf(s));
  const D = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
  ];
  let found = false;
  let iters = 0;
  while (hk.length && iters++ < N) {
    const k = pop();
    if (closed[k]) continue;
    if (k === t) {
      found = true;
      break;
    }
    closed[k] = 1;
    const i = k % g.w, j = Math.floor(k / g.w);
    for (const [di, dj, c] of D) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= g.w || nj >= g.h) continue;
      const nk = nj * g.w + ni;
      if (!g.walk[nk] || closed[nk]) continue;
      if (di && dj && (!g.walk[j * g.w + ni] || !g.walk[nj * g.w + i])) continue;
      const ng = gs[k] + c;
      if (ng < gs[nk]) {
        gs[nk] = ng;
        came[nk] = k;
        push(nk, ng + hf(nk));
      }
    }
  }
  if (!found) return null;
  const cells: Pt[] = [];
  for (let k = t; k >= 0; k = came[k]) cells.push([g.x0 + ((k % g.w) + 0.5) * g.cell, g.z0 + (Math.floor(k / g.w) + 0.5) * g.cell]);
  cells.reverse();
  const raw: Pt[] = [from, ...cells, to];
  // greedy line-of-sight shortcutting
  const out: Pt[] = [raw[0]];
  let a = 0;
  while (a < raw.length - 1) {
    let b = a + 1;
    while (b + 1 < raw.length && clear(g, colliders, raw[a], raw[b + 1])) b++;
    out.push(raw[b]);
    a = b;
  }
  return out;
}

const RIBBON_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const RIBBON_FS = /* glsl */ `
uniform float uTime;
uniform float uLen;
uniform vec3 uColor;
uniform float uFade;
varying vec2 vUv;
void main() {
  float across = 1.0 - abs(vUv.y * 2.0 - 1.0);
  float edge = smoothstep(0.0, 0.55, across);
  float core = smoothstep(0.55, 1.0, across);
  float ph = fract((vUv.x - uTime * 7.0) / 5.0);
  float dash = smoothstep(0.0, 0.08, ph) * (1.0 - smoothstep(0.42, 0.55, ph));
  // chevron-ish head: brighter leading edge of each dash
  float head = smoothstep(0.30, 0.48, ph) * (1.0 - smoothstep(0.48, 0.55, ph));
  float endFade = smoothstep(0.0, 3.0, uLen - vUv.x) * smoothstep(0.0, 2.0, vUv.x);
  float a = (edge * 0.35 + core * dash * 0.9 + head * core * 0.8) * endFade * uFade;
  gl_FragColor = vec4(uColor * a, a);
}`;

/** The route ribbon. set(pts) on world:route; update() recomputes at most every 0.5 s unless the target moved. */
export function createRoute(ctx: FootCtx, grid: Grid) {
  const uniforms = { uTime: { value: 0 }, uLen: { value: 1 }, uColor: { value: new THREE.Color().setRGB(1.0, 0.66, 0.2) }, uFade: { value: 0 } };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: RIBBON_VS, fragmentShader: RIBBON_FS,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.visible = false;
  ctx.scene.add(mesh);

  let want: Pt[] | null = null;
  let target: Pt | null = null;
  let lastAt = -Infinity;
  let dirty = false;

  const build = (path: Pt[]) => {
    const W = 2.2, y = 0.09;
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    let dist = 0;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const prev = path[Math.max(0, i - 1)], next = path[Math.min(path.length - 1, i + 1)];
      // averaged direction -> miter normal (clamped)
      let d1x = p[0] - prev[0], d1z = p[1] - prev[1];
      let d2x = next[0] - p[0], d2z = next[1] - p[1];
      const l1 = Math.hypot(d1x, d1z) || 1, l2 = Math.hypot(d2x, d2z) || 1;
      d1x /= l1; d1z /= l1; d2x /= l2; d2z /= l2;
      if (i === 0) { d1x = d2x; d1z = d2z; }
      if (i === path.length - 1) { d2x = d1x; d2z = d1z; }
      let tx = d1x + d2x, tz = d1z + d2z;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const k = (W / 2) / Math.max(0.5, nx * -d2z + nz * d2x);
      if (i > 0) dist += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      pos.push(p[0] + nx * k, y, p[1] + nz * k, p[0] - nx * k, y, p[1] - nz * k);
      uv.push(dist, 0, dist, 1);
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    mesh.geometry.dispose();
    mesh.geometry = g;
    uniforms.uLen.value = dist;
  };

  const compute = () => {
    if (!want) return;
    const [from, to] = want;
    const path = findPath(grid, ctx.colliders, from, to) ?? [from, to];
    if (path.length >= 2) build(path);
    mesh.visible = true;
    lastAt = ctx.time;
    dirty = false;
  };

  return {
    set(pts: Pt[] | null) {
      if (!pts || pts.length < 2) {
        want = null;
        target = null;
        return;
      }
      const to = pts[pts.length - 1];
      const moved = !target || Math.hypot(to[0] - target[0], to[1] - target[1]) > 0.5;
      want = [pts[0], to];
      target = to;
      dirty = true;
      if (moved) compute();
    },
    update(dt: number) {
      uniforms.uTime.value += dt;
      const goal = want ? 1 : 0;
      uniforms.uFade.value += (goal - uniforms.uFade.value) * Math.min(1, dt * 4);
      if (!want && uniforms.uFade.value < 0.01) mesh.visible = false;
      if (want && dirty && ctx.time - lastAt >= 0.5) compute();
    },
    dispose() {
      ctx.scene.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    },
  };
}
