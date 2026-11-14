// The horde: one InstancedMesh of low-poly figures. Each figure walks a straight line from its wave's compass
// sector to a stop point around the target, deterministic from the district seed. No pathfinding, no rig.

import * as THREE from "three";
import { hash32, mulberry32 } from "./prng";
import type { Sector, Wave } from "./types";

const SECTOR_DEG: Record<Sector, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };
const DEG = Math.PI / 180;

export type SpawnOptions = {
  /** Multiplies arrive_s for the demo (the walk is clamped to 12-45 s). */
  timeScale?: number;
  /** Figures stop on a ring this far from the target's center (metres). */
  stopRadius?: number;
};

export class Horde {
  readonly mesh: THREE.InstancedMesh;
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.MeshStandardMaterial;
  private readonly max: number;
  private readonly sx: Float32Array;
  private readonly sz: Float32Array;
  private readonly ex: Float32Array;
  private readonly ez: Float32Array;
  private readonly delay: Float32Array;
  private readonly dur: Float32Array;
  private readonly phase: Float32Array;
  private count = 0;
  private t = 0;

  constructor(max = 800) {
    this.max = max;
    // ~3.5 m tall: exaggerated so a figure still reads as a dot from the district view.
    this.geo = new THREE.CapsuleGeometry(0.3, 1, 2, 6);
    this.geo.translate(0, 0.8, 0);
    this.geo.scale(2.2, 2.2, 2.2);
    this.mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, emissive: 0x1c2a1a, emissiveIntensity: 0.8 });
    this.mesh = new THREE.InstancedMesh(this.geo, this.mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.sx = new Float32Array(max);
    this.sz = new Float32Array(max);
    this.ex = new Float32Array(max);
    this.ez = new Float32Array(max);
    this.delay = new Float32Array(max);
    this.dur = new Float32Array(max);
    this.phase = new Float32Array(max);
    // Muted green-grey, varied per figure (fixed seed: the palette never changes between runs).
    const rng = mulberry32(0x5eed);
    const c = new THREE.Color();
    for (let i = 0; i < max; i++) {
      c.setHSL(0.2 + rng() * 0.14, 0.08 + rng() * 0.16, 0.3 + rng() * 0.18);
      this.mesh.setColorAt(i, c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  /** Place a wave in a band 300-400 m out on its sector and start the walk toward target. */
  spawnWave(wave: Wave, target: { x: number; z: number }, seed: number, opts: SpawnOptions = {}): void {
    const rng = mulberry32((seed ^ hash32(`wave-${wave.n}-${wave.sector}`)) >>> 0);
    const n = Math.max(0, Math.min(this.max, Math.round(wave.size)));
    const T = Math.min(45, Math.max(12, wave.arrive_s * (opts.timeScale ?? 0.4)));
    const stop = opts.stopRadius ?? 30;
    const base = (SECTOR_DEG[wave.sector] ?? 0) * DEG;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < n; i++) {
      const a = base + (rng() - 0.5) * 40 * DEG;
      const r = 300 + rng() * 100;
      // North is -z, east is +x.
      this.sx[i] = target.x + Math.sin(a) * r;
      this.sz[i] = target.z - Math.cos(a) * r;
      const a2 = a + (rng() - 0.5) * 70 * DEG;
      const s = stop + rng() * 16;
      this.ex[i] = target.x + Math.sin(a2) * s;
      this.ez[i] = target.z - Math.cos(a2) * s;
      this.delay[i] = rng() * 0.15 * T;
      this.dur[i] = T * (0.85 + rng() * 0.15);
      this.phase[i] = rng() * Math.PI * 2;
      const o = i * 16;
      arr.fill(0, o, o + 16);
      arr[o] = 1;
      arr[o + 5] = 1;
      arr[o + 10] = 1;
      arr[o + 15] = 1;
      arr[o + 12] = this.sx[i];
      arr[o + 14] = this.sz[i];
    }
    this.count = n;
    this.t = 0;
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Advance the walk. Writes translations in place (no allocation). */
  update(dt: number): void {
    if (!this.count) return;
    this.t += dt;
    const t = this.t;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    for (let i = 0; i < this.count; i++) {
      const p = Math.min(1, Math.max(0, (t - this.delay[i]) / this.dur[i]));
      const o = i * 16;
      arr[o + 12] = this.sx[i] + (this.ex[i] - this.sx[i]) * p;
      arr[o + 13] = p < 1 ? Math.abs(Math.sin(t * 7 + this.phase[i])) * 0.4 : Math.abs(Math.sin(t * 3 + this.phase[i])) * 0.2;
      arr[o + 14] = this.sz[i] + (this.ez[i] - this.sz[i]) * p;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
    this.mesh.dispose();
  }
}
