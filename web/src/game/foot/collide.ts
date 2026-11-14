// 2D collision on the ground plane (x east, z south, metres). No physics library.
// Every building (kit footprint, kit box, or backdrop block) becomes one convex-or-not polygon collider.
// Circles (player, zombies) are pushed out of polygons along the shortest exit.

export type Pt = [number, number];

export type Collider = {
  pts: Pt[]; // closed implicitly, absolute metres
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  height: number;
  pid: string | null; // kit building id, null for backdrop blocks
};

export function makeCollider(pts: Pt[], height: number, pid: string | null): Collider {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { pts, minX, maxX, minZ, maxZ, height, pid };
}

export function pointInPoly(x: number, z: number, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i];
    const [xj, zj] = pts[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Closest point on segment ab to p. */
function closestOnSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): Pt {
  const dx = bx - ax, dz = bz - az;
  const l2 = dx * dx + dz * dz || 1e-12;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  return [ax + t * dx, az + t * dz];
}

/** Closest point on the polygon boundary to p, and its distance. */
export function closestOnPoly(x: number, z: number, pts: Pt[]): { p: Pt; d: number } {
  let best: Pt = pts[0];
  let bd = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const c = closestOnSeg(x, z, pts[j][0], pts[j][1], pts[i][0], pts[i][1]);
    const d = Math.hypot(c[0] - x, c[1] - z);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return { p: best, d: bd };
}

/**
 * Push a circle (x, z, r) out of every collider it overlaps. Returns the corrected position.
 * Cheap enough for ~300 circles x ~400 colliders per frame thanks to the bbox reject.
 */
export function pushOut(x: number, z: number, r: number, colliders: readonly Collider[]): Pt {
  let px = x, pz = z;
  for (let pass = 0; pass < 2; pass++) {
    for (const c of colliders) {
      if (px + r < c.minX || px - r > c.maxX || pz + r < c.minZ || pz - r > c.maxZ) continue;
      const inside = pointInPoly(px, pz, c.pts);
      const { p, d } = closestOnPoly(px, pz, c.pts);
      if (inside) {
        // move to the boundary, then r further out
        const dx = p[0] - px, dz = p[1] - pz;
        const l = Math.hypot(dx, dz) || 1e-6;
        px = p[0] + (dx / l) * r;
        pz = p[1] + (dz / l) * r;
      } else if (d < r) {
        const dx = px - p[0], dz = pz - p[1];
        const l = d || 1e-6;
        px = p[0] + (dx / l) * r;
        pz = p[1] + (dz / l) * r;
      }
    }
  }
  return [px, pz];
}

/** True when the segment a->b crosses any collider edge (line of sight on the ground). */
export function blocked(ax: number, az: number, bx: number, bz: number, colliders: readonly Collider[]): boolean {
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minZ = Math.min(az, bz), maxZ = Math.max(az, bz);
  for (const c of colliders) {
    if (maxX < c.minX || minX > c.maxX || maxZ < c.minZ || minZ > c.maxZ) continue;
    const pts = c.pts;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (segsCross(ax, az, bx, bz, pts[j][0], pts[j][1], pts[i][0], pts[i][1])) return true;
    }
  }
  return false;
}

function segsCross(ax: number, az: number, bx: number, bz: number, cx: number, cz: number, dx: number, dz: number): boolean {
  const o = (px: number, pz: number, qx: number, qz: number, rx: number, rz: number) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const d1 = o(ax, az, bx, bz, cx, cz), d2 = o(ax, az, bx, bz, dx, dz), d3 = o(cx, cz, dx, dz, ax, az), d4 = o(cx, cz, dx, dz, bx, bz);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** The point just outside a collider closest to `from` (where to stand to "reach" a building without a door). */
export function approachPoint(c: Collider, fromX: number, fromZ: number, gap = 1.5): Pt {
  const { p } = closestOnPoly(fromX, fromZ, c.pts);
  const dx = fromX - p[0], dz = fromZ - p[1];
  const l = Math.hypot(dx, dz) || 1;
  return [p[0] + (dx / l) * gap, p[1] + (dz / l) * gap];
}
