// OWNER: builder B. Allocation-free twin of ctx.collide for the horde: the same push-out as collide.ts pushOut
// (two passes, inside -> boundary + r, overlap -> r out) plus the bounds clamp, but the colliders are bucketed
// in a coarse grid once, and results go into a caller-owned buffer. ~260 calls a frame, zero garbage.

import type { Collider } from "./collide";

const CELL = 24; // metres; bigger than any zombie radius, so a circle touches at most 2x2 cells

export type HordeCollide = {
  /** Push the circle (x, z, r) out of buildings and clamp it to bounds. Writes the result to out[0], out[1]. */
  push(x: number, z: number, r: number, out: Float64Array): void;
};

export function createHordeCollide(colliders: readonly Collider[], bounds: { x0: number; z0: number; x1: number; z1: number }): HordeCollide {
  const gx0 = bounds.x0 - CELL, gz0 = bounds.z0 - CELL;
  const nx = Math.max(1, Math.ceil((bounds.x1 - gx0) / CELL) + 2);
  const nz = Math.max(1, Math.ceil((bounds.z1 - gz0) / CELL) + 2);
  const cellOf = (v: number, o: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor((v - o) / CELL)));

  // CSR buckets: start[c]..start[c+1] index into items (collider indices)
  const counts = new Int32Array(nx * nz + 1);
  const span = (c: Collider) => [cellOf(c.minX, gx0, nx), cellOf(c.maxX, gx0, nx), cellOf(c.minZ, gz0, nz), cellOf(c.maxZ, gz0, nz)];
  for (const c of colliders) {
    const [a, b, d, e] = span(c);
    for (let i = a; i <= b; i++) for (let k = d; k <= e; k++) counts[i * nz + k + 1]++;
  }
  for (let i = 1; i < counts.length; i++) counts[i] += counts[i - 1];
  const start = counts;
  const items = new Int32Array(start[start.length - 1]);
  const fill = new Int32Array(nx * nz);
  colliders.forEach((c, ci) => {
    const [a, b, d, e] = span(c);
    for (let i = a; i <= b; i++)
      for (let k = d; k <= e; k++) {
        const cell = i * nz + k;
        items[start[cell] + fill[cell]++] = ci;
      }
  });
  const stamp = new Int32Array(colliders.length);
  const scratch = new Int32Array(256);
  let tick = 0;

  // flattened polygon coordinates for cache-friendly loops
  const off = new Int32Array(colliders.length + 1);
  colliders.forEach((c, ci) => (off[ci + 1] = off[ci] + c.pts.length));
  const px = new Float64Array(off[colliders.length]), pz = new Float64Array(off[colliders.length]);
  colliders.forEach((c, ci) => c.pts.forEach(([x, z], k) => ((px[off[ci] + k] = x), (pz[off[ci] + k] = z))));

  function resolve(ci: number, x: number, z: number, r: number, out: Float64Array): boolean {
    const c = colliders[ci];
    if (x + r < c.minX || x - r > c.maxX || z + r < c.minZ || z - r > c.maxZ) return false;
    const o = off[ci], n = off[ci + 1] - o;
    let inside = false;
    let bd = Infinity, bx = 0, bz = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = px[o + i], zi = pz[o + i], xj = px[o + j], zj = pz[o + j];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
      // closest point on segment j -> i
      const dx = xi - xj, dz = zi - zj;
      const l2 = dx * dx + dz * dz || 1e-12;
      let t = ((x - xj) * dx + (z - zj) * dz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = xj + t * dx, qz = zj + t * dz;
      const d = Math.hypot(qx - x, qz - z);
      if (d < bd) {
        bd = d;
        bx = qx;
        bz = qz;
      }
    }
    if (inside) {
      const dx = bx - x, dz = bz - z;
      const l = Math.hypot(dx, dz) || 1e-6;
      out[0] = bx + (dx / l) * r;
      out[1] = bz + (dz / l) * r;
      return true;
    }
    if (bd < r) {
      const l = bd || 1e-6;
      out[0] = bx + ((x - bx) / l) * r;
      out[1] = bz + ((z - bz) / l) * r;
      return true;
    }
    return false;
  }

  return {
    push(x, z, r, out) {
      out[0] = x;
      out[1] = z;
      for (let pass = 0; pass < 2; pass++) {
        tick++;
        const a = cellOf(out[0] - r, gx0, nx), b = cellOf(out[0] + r, gx0, nx);
        const d = cellOf(out[1] - r, gz0, nz), e = cellOf(out[1] + r, gz0, nz);
        // gather the candidates, then visit them in collider order (same order as pushOut)
        let m = 0;
        for (let i = a; i <= b; i++) {
          for (let k = d; k <= e; k++) {
            const cell = i * nz + k;
            for (let q = start[cell], end = start[cell + 1]; q < end && m < scratch.length; q++) {
              const ci = items[q];
              if (stamp[ci] === tick) continue;
              stamp[ci] = tick;
              let w = m++;
              while (w > 0 && scratch[w - 1] > ci) {
                scratch[w] = scratch[w - 1];
                w--;
              }
              scratch[w] = ci;
            }
          }
        }
        for (let q = 0; q < m; q++) resolve(scratch[q], out[0], out[1], r, out);
      }
      out[0] = Math.min(bounds.x1 - r, Math.max(bounds.x0 + r, out[0]));
      out[1] = Math.min(bounds.z1 - r, Math.max(bounds.z0 + r, out[1]));
    },
  };
}
