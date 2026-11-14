// OWNER: builder A (player). Cheap visual effects around the survivor: a soft flashlight cone (fake volumetric) and
// the shove's shockwave arc. Unlit, additive, no lights, nothing allocated per frame.

import * as THREE from "three";

export type Beam = {
  mesh: THREE.Mesh;
  /** Place the cone at `from` pointing along the unit vector `dir`, at strength 0..1. */
  set(from: THREE.Vector3, dir: THREE.Vector3, strength: number): void;
  dispose(): void;
};

const DOWN = new THREE.Vector3(0, -1, 0);

export function createBeam(halfAngle: number, length = 13): Beam {
  const geo = new THREE.CylinderGeometry(0.05, Math.tan(halfAngle * 0.8) * length, length, 24, 8, true);
  geo.translate(0, -length / 2, 0); // apex at the origin, opening along -y
  const pos = geo.getAttribute("position");
  const col = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const u = -pos.getY(i) / length; // 0 at the lens .. 1 at the far end
    const a = Math.min(1, (u * length) / 2.5) * (1 - u) ** 1.4; // soft near the hand (the camera sits right behind it)
    col.set([1, 0.95, 0.82, a], i * 4);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "player-beam";
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  return {
    mesh,
    set(from, dir, strength) {
      mat.opacity = 0.07 * strength;
      mesh.visible = strength > 0.01;
      mesh.position.copy(from);
      mesh.quaternion.setFromUnitVectors(DOWN, dir);
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}

export type ShoveArc = {
  mesh: THREE.Mesh;
  /** Start a shockwave at (x, z) facing yaw. */
  fire(x: number, z: number, yaw: number): void;
  update(dt: number): void;
  dispose(): void;
};

export function createShoveArc(): ShoveArc {
  const half = 0.95; // radians either side of forward
  const geo = new THREE.RingGeometry(0.82, 1, 24, 1, Math.PI / 2 - half, half * 2);
  geo.rotateX(-Math.PI / 2); // flat, centred on -z (forward)
  const mat = new THREE.MeshBasicMaterial({
    color: 0xffe2a8,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = "player-shove";
  mesh.visible = false;
  const LIFE = 0.28;
  let t = LIFE;
  return {
    mesh,
    fire(x, z, yaw) {
      t = 0;
      mesh.position.set(x, 1.0, z);
      mesh.rotation.set(0, -yaw, 0);
      mesh.visible = true;
    },
    update(dt) {
      if (t >= LIFE) return;
      t += dt;
      const u = Math.min(1, t / LIFE);
      const s = 0.7 + 1.9 * (1 - (1 - u) ** 2);
      mesh.scale.set(s, 1, s);
      mat.opacity = 0.75 * (1 - u);
      if (u >= 1) mesh.visible = false;
    },
    dispose() {
      mesh.removeFromParent();
      geo.dispose();
      mat.dispose();
    },
  };
}
