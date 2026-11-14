// OWNER: builder B. Flow fields for the horde (no navmesh, no libraries): the play area as a 2 m grid of
// walkable cells, and a breadth-first distance field from a goal. A zombie reads its cell's downhill direction.
//   - target field: the whole map, rebuilt when the horde target moves (a handful of ms, rare).
//   - player field: a 70 m radius around the player, rebuilt a few times a second (cheap), for chasers
//     that lost line of sight.

import { pointInPoly, type Collider } from "./collide";

const CELL = 2;
const INF = 0x3fffffff;
const PLAYER_RADIUS_CELLS = 35;

export type FlowField = {
  /** Rebuild the distance field toward (x, z). radiusCells limits the search (Infinity = whole map). */
  build(x: number, z: number): void;
  /** True when (x, z) or a neighbouring cell is connected to the goal. */
  reachable(x: number, z: number): boolean;
  /** Downhill unit direction at (x, z) into out[0], out[1]; false when there is no path or it's off the grid. */
  dir(x: number, z: number, out: Float64Array): boolean;
  ready: boolean;
};

export type FlowGrid = {
  walkable(x: number, z: number): boolean;
  makeField(radiusCells: number): FlowField;
};

export function createFlowGrid(colliders: readonly Collider[], bounds: { x0: number; z0: number; x1: number; z1: number }): FlowGrid {
  const x0 = bounds.x0, z0 = bounds.z0;
  const nx = Math.max(1, Math.ceil((bounds.x1 - x0) / CELL));
  const nz = Math.max(1, Math.ceil((bounds.z1 - z0) / CELL));
  const N = nx * nz;
  const walk = new Uint8Array(N).fill(1);
  for (const c of colliders) {
    const i0 = Math.max(0, Math.floor((c.minX - x0) / CELL)), i1 = Math.min(nx - 1, Math.floor((c.maxX - x0) / CELL));
    const k0 = Math.max(0, Math.floor((c.minZ - z0) / CELL)), k1 = Math.min(nz - 1, Math.floor((c.maxZ - z0) / CELL));
    for (let i = i0; i <= i1; i++) {
      const cx = x0 + (i + 0.5) * CELL;
      for (let k = k0; k <= k1; k++) {
        const idx = i * nz + k;
        if (walk[idx] && pointInPoly(cx, z0 + (k + 0.5) * CELL, c.pts)) walk[idx] = 0;
      }
    }
  }
  const cellI = (x: number) => Math.floor((x - x0) / CELL);
  const cellK = (z: number) => Math.floor((z - z0) / CELL);
  const DI = [1, -1, 0, 0, 1, 1, -1, -1];
  const DK = [0, 0, 1, -1, 1, -1, 1, -1];

  function makeField(radiusCells: number): FlowField {
    const dist = new Int32Array(N).fill(INF);
    const gen = new Int32Array(N); // dist[c] is valid only when gen[c] === cur (no full clears)
    let cur = 0;
    const queue = new Int32Array(N);
    const f: FlowField = {
      ready: false,
      build(x, z) {
        cur++;
        let head = 0, tail = 0;
        const si = Math.min(nx - 1, Math.max(0, cellI(x))), sk = Math.min(nz - 1, Math.max(0, cellK(z)));
        // the goal often sits on a wall (a door): seed every walkable cell within 2 cells of it
        for (let di = -2; di <= 2; di++) {
          for (let dk = -2; dk <= 2; dk++) {
            const i = si + di, k = sk + dk;
            if (i < 0 || k < 0 || i >= nx || k >= nz) continue;
            const c = i * nz + k;
            if (!walk[c] && (di !== 0 || dk !== 0)) continue;
            gen[c] = cur;
            dist[c] = Math.abs(di) + Math.abs(dk);
            queue[tail++] = c;
          }
        }
        while (head < tail) {
          const c = queue[head++];
          const i = (c / nz) | 0, k = c - i * nz;
          const dn = dist[c] + 1;
          if (dn > radiusCells * 2) continue;
          for (let n = 0; n < 4; n++) {
            const ii = i + DI[n], kk = k + DK[n];
            if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
            if (Math.abs(ii - si) > radiusCells || Math.abs(kk - sk) > radiusCells) continue;
            const cc = ii * nz + kk;
            if (!walk[cc] || gen[cc] === cur) continue;
            gen[cc] = cur;
            dist[cc] = dn;
            queue[tail++] = cc;
          }
        }
        f.ready = true;
      },
      reachable(x, z) {
        if (!f.ready) return true;
        const i = cellI(x), k = cellK(z);
        for (let di = -1; di <= 1; di++)
          for (let dk = -1; dk <= 1; dk++) {
            const ii = i + di, kk = k + dk;
            if (ii >= 0 && kk >= 0 && ii < nx && kk < nz && gen[ii * nz + kk] === cur && walk[ii * nz + kk]) return true;
          }
        return false;
      },
      dir(x, z, out) {
        if (!f.ready) return false;
        const i = cellI(x), k = cellK(z);
        if (i < 0 || k < 0 || i >= nx || k >= nz) return false;
        const c = i * nz + k;
        const here = gen[c] === cur && walk[c] ? dist[c] : INF;
        let best = here, bi = 0, bk = 0;
        for (let n = 0; n < 8; n++) {
          const ii = i + DI[n], kk = k + DK[n];
          if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
          const cc = ii * nz + kk;
          if (!walk[cc] || gen[cc] !== cur) continue;
          // no cutting wall corners on diagonals
          if (n >= 4 && (!walk[ii * nz + k] || !walk[i * nz + kk])) continue;
          const d = dist[cc] - (n >= 4 ? 0.5 : 0); // diagonals cover two Manhattan steps: prefer them a little
          if (d < best) {
            best = d;
            bi = ii;
            bk = kk;
          }
        }
        if (best >= here) return false; // at the goal, or no path
        const dx = x0 + (bi + 0.5) * CELL - x, dz = z0 + (bk + 0.5) * CELL - z;
        const l = Math.hypot(dx, dz) || 1;
        out[0] = dx / l;
        out[1] = dz / l;
        return true;
      },
    };
    return f;
  }

  return {
    walkable(x, z) {
      const i = cellI(x), k = cellK(z);
      return i >= 0 && k >= 0 && i < nx && k < nz && walk[i * nz + k] === 1;
    },
    makeField,
  };
}

export { PLAYER_RADIUS_CELLS };
