// OWNER: builder B. Small readable effects for the horde (PG, no gore), pooled, nothing allocated per frame:
//   - burst(x, y, z): a white flash on a zombie the flashlight just stunned
//   - label(x, y, z): a small floating "STUNNED" tag that rises and fades (~1 s)
//   - dust(x, z): a dust ring on the ground where a shoved zombie was knocked back
//   - halo: a faint glow round the head of a zombie the flashlight is charging (setHalo per zombie, per frame)
// Billboards face the camera by sharing its quaternion.

import * as THREE from "three";

const BURSTS = 10, LABELS = 8, RINGS = 18;
const BURST_S = 0.35, LABEL_S = 1.1, RING_S = 0.55;

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.3, "rgba(255,255,240,0.55)");
  grad.addColorStop(1, "rgba(255,255,230,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function labelTexture(text: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 64;
  const g = c.getContext("2d")!;
  g.font = "800 34px system-ui, -apple-system, Segoe UI, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.lineWidth = 7;
  g.strokeStyle = "rgba(10,14,24,0.85)";
  g.strokeText(text, 128, 34);
  g.fillStyle = "#fff6c8";
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export type HordeFx = {
  burst(x: number, y: number, z: number): void;
  label(x: number, y: number, z: number): void;
  dust(x: number, z: number): void;
  /** Halo strength k in 0..1 (0 hides it) for zombie slot i at its head. */
  setHalo(i: number, x: number, y: number, z: number, k: number): void;
  update(dt: number, cam: THREE.Camera): void;
  dispose(): void;
};

export function createHordeFx(scene: THREE.Scene, max: number): HordeFx {
  const glow = glowTexture();
  const tag = labelTexture("STUNNED");

  // flashes
  const bursts = Array.from({ length: BURSTS }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
    s.visible = false;
    scene.add(s);
    return { s, t: BURST_S };
  });
  // labels
  const labels = Array.from({ length: LABELS }, () => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tag, depthWrite: false, depthTest: false, transparent: true, fog: false }));
    s.renderOrder = 40;
    s.scale.set(1.15, 0.29, 1);
    s.visible = false;
    scene.add(s);
    return { s, t: LABEL_S };
  });
  // dust rings
  const ringGeo = new THREE.RingGeometry(0.55, 1, 28);
  ringGeo.rotateX(-Math.PI / 2);
  const rings = Array.from({ length: RINGS }, () => {
    const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xcdbb9a, transparent: true, depthWrite: false, opacity: 0 }));
    m.visible = false;
    scene.add(m);
    return { m, t: RING_S };
  });
  // halos: one instanced, camera-facing quad per zombie slot
  const haloGeo = new THREE.PlaneGeometry(1, 1);
  const haloMat = new THREE.MeshBasicMaterial({ map: glow, color: 0xffffff, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  const halo = new THREE.InstancedMesh(haloGeo, haloMat, max);
  halo.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  halo.frustumCulled = false;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  const white = new THREE.Color(1, 1, 1);
  for (let i = 0; i < max; i++) {
    halo.setMatrixAt(i, zero);
    halo.setColorAt(i, white);
  }
  scene.add(halo);
  const hx = new Float32Array(max), hy = new Float32Array(max), hz = new Float32Array(max), hk = new Float32Array(max);
  const m4 = new THREE.Matrix4(), pos = new THREE.Vector3(), scl = new THREE.Vector3(), col = new THREE.Color();
  let time = 0;

  const oldest = <T extends { t: number }>(arr: T[]) => arr.reduce((a, b) => (a.t >= b.t ? a : b));

  return {
    burst(x, y, z) {
      const b = oldest(bursts);
      b.t = 0;
      b.s.position.set(x, y, z);
      b.s.visible = true;
    },
    label(x, y, z) {
      const l = oldest(labels);
      l.t = 0;
      // stack tags that pop at once in the same spot, so a crowd stun stays legible
      let lift = 0;
      for (const o of labels) if (o !== l && o.t < 0.5 && Math.hypot(o.s.position.x - x, o.s.position.z - z) < 2.5) lift += 0.32;
      l.s.position.set(x, y + Math.min(lift, 1.3), z);
      l.s.visible = true;
    },
    dust(x, z) {
      const r = oldest(rings);
      r.t = 0;
      r.m.position.set(x, 0.05, z);
      r.m.visible = true;
    },
    setHalo(i, x, y, z, k) {
      hx[i] = x;
      hy[i] = y;
      hz[i] = z;
      hk[i] = k;
    },
    update(dt, cam) {
      time += dt;
      for (const b of bursts) {
        if (b.t >= BURST_S) continue;
        b.t += dt;
        const a = Math.min(1, b.t / BURST_S);
        b.s.scale.setScalar(0.6 + a * 2.6);
        b.s.material.opacity = (1 - a) * (1 - a);
        if (a >= 1) b.s.visible = false;
      }
      for (const l of labels) {
        if (l.t >= LABEL_S) continue;
        l.t += dt;
        const a = Math.min(1, l.t / LABEL_S);
        l.s.position.y += dt * 0.6;
        l.s.material.opacity = a < 0.15 ? a / 0.15 : 1 - Math.max(0, (a - 0.6) / 0.4);
        if (a >= 1) l.s.visible = false;
      }
      for (const r of rings) {
        if (r.t >= RING_S) continue;
        r.t += dt;
        const a = Math.min(1, r.t / RING_S);
        r.m.scale.setScalar(0.35 + a * 1.4);
        (r.m.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - a);
        if (a >= 1) r.m.visible = false;
      }
      // halos face the camera
      for (let i = 0; i < max; i++) {
        const k = hk[i];
        if (k <= 0) {
          halo.setMatrixAt(i, zero);
          continue;
        }
        const flick = 0.8 + 0.2 * Math.sin(time * (18 + 20 * k) + i);
        pos.set(hx[i], hy[i], hz[i]);
        scl.setScalar(0.55 + 0.6 * k);
        m4.compose(pos, cam.quaternion, scl);
        halo.setMatrixAt(i, m4);
        halo.setColorAt(i, col.setRGB(1, 1, 0.92).multiplyScalar((0.1 + 0.38 * k) * flick));
      }
      halo.instanceMatrix.needsUpdate = true;
      halo.instanceColor!.needsUpdate = true;
    },
    dispose() {
      for (const b of bursts) {
        scene.remove(b.s);
        b.s.material.dispose();
      }
      for (const l of labels) {
        scene.remove(l.s);
        l.s.material.dispose();
      }
      for (const r of rings) {
        scene.remove(r.m);
        (r.m.material as THREE.Material).dispose();
      }
      scene.remove(halo);
      halo.dispose();
      haloGeo.dispose();
      haloMat.dispose();
      ringGeo.dispose();
      glow.dispose();
      tag.dispose();
    },
  };
}
