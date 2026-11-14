// What Vexcel counted on the fortress roof (skylights, AC units, vents), drawn on the roof. The COUNTS are real
// (dossier.roof.objects, with the capture date); the POSITIONS are illustrative, and the label says so. OWNER: coding lead.

import * as THREE from "three";
import { pointInPoly } from "./collide";
import { buildingHeight, outlineOf, type FootCtx, type System } from "./engine";

export type Roof = { shape?: string; material?: string; objects?: Record<string, number>; capture?: string; note?: string } | null;
export type RoofSystem = System & { setRoof(pid: string, roof: Roof): void };

function label(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  const probe = c.getContext("2d")!;
  probe.font = "600 40px ui-monospace, monospace";
  c.width = Math.ceil(probe.measureText(text).width) + 40; // fit the whole sentence (counts + "positions illustrative")
  c.height = 96;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(5,7,13,0.8)";
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#f5a524";
  g.font = "600 40px ui-monospace, monospace";
  g.textBaseline = "middle";
  g.fillText(text, 20, 48);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false }));
  s.scale.set((c.width / c.height) * 3, 3, 1);
  return s;
}

export function createRoofObjects(ctx: FootCtx): RoofSystem {
  const group = new THREE.Group();
  ctx.scene.add(group);
  let done: string | null = null;
  const clear = () => {
    group.children.slice().forEach((o) => {
      group.remove(o);
      (o as THREE.Mesh).geometry?.dispose?.();
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      m?.dispose?.();
    });
  };
  return {
    setRoof(pid, roof) {
      if (done === pid || !roof?.objects) return;
      const b = ctx.byPid.get(pid);
      if (!b) return;
      done = pid;
      clear();
      const pts = outlineOf(b);
      const h = buildingHeight(b) + 0.15;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of pts) {
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      }
      // Candidate spots on a grid inside the outline (illustrative positions).
      const spots: [number, number][] = [];
      for (let x = x0 + 3; x < x1 - 2; x += 3.2) for (let z = z0 + 3; z < z1 - 2; z += 3.2) if (pointInPoly(x, z, pts)) spots.push([x, z]);
      let k = 0;
      const take = () => spots[(k++ * 7) % Math.max(1, spots.length)];
      const sky = Math.min(roof.objects["skylight"] ?? 0, 40);
      const ac = Math.min(roof.objects["ac-unit"] ?? 0, 40);
      if (sky && spots.length) {
        const m = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 0.3, 1.4), new THREE.MeshBasicMaterial({ color: 0x9fd8ff }), sky);
        const mx = new THREE.Matrix4();
        for (let i = 0; i < sky; i++) {
          const [x, z] = take();
          m.setMatrixAt(i, mx.makeTranslation(x, h, z));
        }
        group.add(m);
      }
      if (ac && spots.length) {
        const m = new THREE.InstancedMesh(new THREE.BoxGeometry(1.4, 1.1, 1.4), new THREE.MeshLambertMaterial({ color: 0x8a919c }), ac);
        const mx = new THREE.Matrix4();
        for (let i = 0; i < ac; i++) {
          const [x, z] = take();
          m.setMatrixAt(i, mx.makeTranslation(x + 1.2, h + 0.55, z + 1.0));
        }
        group.add(m);
      }
      const parts = Object.entries(roof.objects).filter(([, n]) => n > 0).map(([kName, n]) => `${n} ${kName.replace("-", " ")}${n === 1 ? "" : "s"}`);
      const tag = label(`Roof (Vexcel ${roof.capture ?? ""}): ${parts.join(" · ")} · positions illustrative`);
      tag.position.set((x0 + x1) / 2, h + 6, (z0 + z1) / 2);
      group.add(tag);
    },
    update() {
      // The roof tag is for the view from above (drone, intro); at street level it would float in the sky.
      const tag = group.children.find((o) => (o as THREE.Sprite).isSprite);
      if (tag) tag.visible = ctx.camera.position.y > 40 || ctx.cameraOwner === "director";
    },
    dispose() {
      clear();
      ctx.scene.remove(group);
    },
  };
}
