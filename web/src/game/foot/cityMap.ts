// The whole city: every LA building in CoStar's kit as an instanced bar at its real position and height, coloured by
// what the records say (material; red if the city's retrofit order is unfinished), with a pillar of light on every open
// case in the queue. Seen from the intro flyover (the camera dives from the city into tonight's district) and, beyond the
// play area, as the real skyline. Data: GET /game/city (code-computed on the server; no addresses). OWNER: coding lead.

import * as THREE from "three";
import { MATERIAL_COLOR } from "../District3D";
import type { FootCtx, System } from "./engine";
import type { Material } from "../types";

export type CityBuilding = {
  pid: string; x: number; z: number; height_m: number; material: string;
  list?: string | null; unfinished?: boolean; case?: string | null; queue_n?: number | null;
  has_aerial?: boolean; has_tour?: boolean;
};
export type City = { buildings: CityBuilding[]; total_cases?: number | null; total_buildings?: number | null };

const CASE_COLOR: Record<string, number> = { material_conflict: 0xf5a524, ghost_tenant: 0x2dd4bf, stale_entry: 0xe5484d };

export function createCityMap(ctx: FootCtx, onLoad: (c: City) => void): System {
  const group = new THREE.Group();
  ctx.scene.add(group);
  const disposables: { dispose(): void }[] = [];
  let pillars: THREE.InstancedMesh | null = null;
  let alive = true;

  // A dark city floor far beyond the play area, so distant buildings stand on something.
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(80000, 80000), new THREE.MeshBasicMaterial({ color: 0x0a0f1c }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.6;
  group.add(floor);
  disposables.push(floor.geometry, floor.material as THREE.Material);

  if (!ctx.stub) {
    fetch("/api/game/city")
      .then((r) => (r.ok ? r.json() : null))
      .then((c: City | null) => {
        if (!alive || !c || !Array.isArray(c.buildings)) return;
        build(c);
        onLoad(c);
      })
      .catch(() => {});
  }

  function build(c: City) {
    const b = ctx.bounds;
    const inPlay = (x: number, z: number) => x > b.x0 - 20 && x < b.x1 + 20 && z > b.z0 - 20 && z < b.z1 + 20;
    const rows = c.buildings.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.z));
    const outside = rows.filter((r) => !inPlay(r.x, r.z)); // the play area already draws its own buildings
    const box = new THREE.BoxGeometry(1, 1, 1);
    box.translate(0, 0.5, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff }); // unlit: readable from 2 km up at dusk
    const bars = new THREE.InstancedMesh(box, mat, Math.max(1, outside.length));
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const col = new THREE.Color();
    outside.forEach((r, i) => {
      const h = Math.max(6, Math.min(300, Number(r.height_m) || 12));
      const w = h > 80 ? 60 : 45; // exaggerated footprints so the city reads from the air (heights stay real)
      m.compose(new THREE.Vector3(r.x, 0, r.z), q, new THREE.Vector3(w, h, w));
      bars.setMatrixAt(i, m);
      col.setHex(r.unfinished ? 0xc0392b : MATERIAL_COLOR[(r.material as Material) ?? "unknown"] ?? MATERIAL_COLOR.unknown);
      bars.setColorAt(i, col);
    });
    bars.count = outside.length;
    bars.instanceMatrix.needsUpdate = true;
    if (bars.instanceColor) bars.instanceColor.needsUpdate = true;
    group.add(bars);
    disposables.push(box, mat, bars);

    const cases = rows.filter((r) => r.case);
    if (cases.length) {
      const geo = new THREE.CylinderGeometry(28, 28, 1, 10, 1, true);
      geo.translate(0, 0.5, 0);
      const pm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
      pillars = new THREE.InstancedMesh(geo, pm, cases.length);
      cases.forEach((r, i) => {
        m.compose(new THREE.Vector3(r.x, 0, r.z), q, new THREE.Vector3(1, 900, 1));
        pillars!.setMatrixAt(i, m);
        pillars!.setColorAt(i, col.setHex(CASE_COLOR[r.case ?? ""] ?? 0xf5a524));
      });
      pillars.instanceMatrix.needsUpdate = true;
      if (pillars.instanceColor) pillars.instanceColor.needsUpdate = true;
      group.add(pillars);
      disposables.push(geo, pm, pillars);
    }
  }

  return {
    update() {
      // Case pillars are for the view from above (the intro dive); at street level they would only clutter the sky.
      if (pillars) {
        const high = ctx.camera.position.y > 90;
        pillars.visible = high;
      }
    },
    dispose() {
      alive = false;
      ctx.scene.remove(group);
      disposables.forEach((d) => d.dispose());
    },
  };
}
