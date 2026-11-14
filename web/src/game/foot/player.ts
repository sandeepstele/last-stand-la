// OWNER: builder A (player). PLACEHOLDER from the coding lead: a capsule that walks with WASD and a chase camera.
// Replace freely; keep the export signature `createPlayer: SystemFactory` and the ctx/bus contract in engine.ts.

import * as THREE from "three";
import { WALK, PLAYER_R, type FootCtx, type System } from "./engine";

export function createPlayer(ctx: FootCtx): System {
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 1.1, 4, 8), new THREE.MeshLambertMaterial({ color: 0xf5a524 }));
  ctx.scene.add(body);
  return {
    update(dt) {
      const p = ctx.player;
      const k = ctx.input.down;
      p.yaw += ctx.input.mouseDx * 0.0025 + ((k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0)) * 2 * dt;
      if (!p.frozen) {
        const f = (k.has("KeyW") || k.has("ArrowUp") ? 1 : 0) - (k.has("KeyS") || k.has("ArrowDown") ? 1 : 0);
        const s = (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
        const fx = Math.sin(p.yaw), fz = -Math.cos(p.yaw);
        const nx = p.x + (fx * f - fz * s) * WALK * dt, nz = p.z + (fz * f + fx * s) * WALK * dt;
        [p.x, p.z] = ctx.collide(nx, nz, PLAYER_R);
      }
      body.visible = !p.hidden;
      body.position.set(p.x, 1, p.z);
      if (ctx.cameraOwner === "player") {
        ctx.camera.position.set(p.x - Math.sin(p.yaw) * 6, 3.2, p.z + Math.cos(p.yaw) * 6);
        ctx.camera.lookAt(p.x + Math.sin(p.yaw) * 4, 1.6, p.z - Math.cos(p.yaw) * 4);
      }
    },
    dispose() {
      ctx.scene.remove(body);
    },
  };
}
