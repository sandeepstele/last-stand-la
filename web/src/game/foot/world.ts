// OWNER: builder C (world). PLACEHOLDER from the coding lead: flat ground + extruded outlines + one light.
// Replace freely; keep the export signature `createWorld: SystemFactory` and the bus events in engine.ts.

import * as THREE from "three";
import { buildingHeight, outlineOf, type FootCtx, type System } from "./engine";

export function createWorld(ctx: FootCtx): System {
  const { scene, district, bounds } = ctx;
  scene.background = new THREE.Color(0x0b1020);
  scene.fog = new THREE.Fog(0x0b1020, 60, 260);
  scene.add(new THREE.HemisphereLight(0x8090c0, 0x202020, 0.9));
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(bounds.x1 - bounds.x0, bounds.z1 - bounds.z0),
    new THREE.MeshLambertMaterial({ color: 0x1a1f2b }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((bounds.x0 + bounds.x1) / 2, 0, (bounds.z0 + bounds.z1) / 2);
  scene.add(ground);
  const mat = new THREE.MeshLambertMaterial({ color: 0x6b7280 });
  const objs: THREE.Object3D[] = [ground];
  for (const b of district.buildings) {
    const pts = outlineOf(b);
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: buildingHeight(b), bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    scene.add(m);
    objs.push(m);
  }
  return {
    update() {},
    dispose() {
      for (const o of objs) scene.remove(o);
    },
  };
}
