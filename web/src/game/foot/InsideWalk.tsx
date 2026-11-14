"use client";
// Walk INSIDE a real building: Matterport scan spots (x/y metres in the twin's floor plan, 6 cube faces each).
// W / ↑ steps to the nearest spot ahead (±35° of where you look, 0.8-4 m), S / ↓ to the nearest behind. Each step is a short
// zoom toward the target, then a crossfade to the next spot's cube, keeping your heading. Textures are cached and the
// nearest neighbours preloaded, so a step never shows a blank frame. Drag to look. OWNER: coding lead.
// Assumption (stated): the floor plan's +y is the cube's -z (face f1), x is x. If a scan is rotated, "ahead" may skew.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { evidenceUrl } from "../Pano";
import type { InsideHop, PanoFace } from "../types";

const FACE_SLOT: Record<PanoFace["face"], number> = { f2: 0, f4: 1, f0: 2, f5: 3, f3: 4, f1: 5 };
const FOV = 78;

export type WalkProps = {
  hops: InsideHop[];
  index: number;
  onIndex(i: number): void;
  onHeading?(deg: number): void; // plan heading, degrees clockwise from the plan's +y
  className?: string;
};

export function InsideWalk({ hops, index, onIndex, onHeading, className }: WalkProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const api = useRef<{ goTo(i: number): void } | null>(null);
  const cb = useRef({ onIndex, onHeading, hops });
  useEffect(() => {
    cb.current = { onIndex, onHeading, hops };
  });
  const key = hops.map((h) => h.id).join("|");

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    wrap.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070d);
    const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);
    camera.position.set(0, 0, 0.01);
    const controls = new OrbitControls(camera, renderer.domElement);
    Object.assign(controls, { enableZoom: false, enablePan: false, enableDamping: true, rotateSpeed: -0.35, minPolarAngle: Math.PI * 0.3, maxPolarAngle: Math.PI * 0.7 });
    controls.target.set(0, 0, 0);
    controls.update();

    const cache = new Map<string, THREE.Texture>();
    const pending = new Map<string, Promise<THREE.Texture | null>>();
    const loader = new THREE.TextureLoader();
    let alive = true;
    const load = (name: string): Promise<THREE.Texture | null> => {
      const hit = cache.get(name);
      if (hit) return Promise.resolve(hit);
      const p = pending.get(name);
      if (p) return p;
      const q = new Promise<THREE.Texture | null>((res) => {
        loader.load(evidenceUrl(name), (tex) => {
          if (!alive) return res(null);
          tex.colorSpace = THREE.SRGBColorSpace;
          const img = tex.image as { width?: number; height?: number } | undefined;
          const eu = 0.5 / Math.max(1, img?.width ?? 1024), ev = 0.5 / Math.max(1, img?.height ?? 1024);
          tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.repeat.set(-(1 - 2 * eu), 1 - 2 * ev);
          tex.offset.set(1 - eu, ev);
          cache.set(name, tex);
          res(tex);
        }, undefined, () => res(null));
      });
      pending.set(name, q);
      return q;
    };
    const loadHop = (h: InsideHop) => Promise.all(h.faces.map((f) => load(f.name)));

    // Two cubes: the one you're in, and the next one fading in.
    const geo = new THREE.BoxGeometry(10, 10, 10);
    const makeCube = () => {
      const mats = Array.from({ length: 6 }, () => new THREE.MeshBasicMaterial({ color: 0x0d1222, side: THREE.BackSide, transparent: true, opacity: 1, depthWrite: false }));
      const mesh = new THREE.Mesh(geo, mats);
      scene.add(mesh);
      return { mesh, mats };
    };
    const cubes = [makeCube(), makeCube()];
    let front = 0; // index into cubes
    cubes[1].mesh.visible = false;
    const paint = (c: { mats: THREE.MeshBasicMaterial[] }, h: InsideHop) => {
      for (const f of h.faces) {
        const slot = FACE_SLOT[f.face];
        const tex = cache.get(f.name);
        if (slot === undefined) continue;
        c.mats[slot].map = tex ?? null;
        c.mats[slot].color.set(tex ? 0xffffff : 0x0d1222);
        c.mats[slot].needsUpdate = true;
      }
    };

    let cur = Math.max(0, Math.min(cb.current.hops.length - 1, index));
    const preloadNear = (i: number) => {
      const hs = cb.current.hops, h = hs[i];
      hs.map((o, j) => ({ j, d: Math.hypot(o.x - h.x, o.y - h.y) })).filter((o) => o.j !== i).sort((a, b) => a.d - b.d).slice(0, 3).forEach((o) => void loadHop(hs[o.j]));
    };
    void loadHop(cb.current.hops[cur]).then(() => {
      if (!alive) return;
      paint(cubes[front], cb.current.hops[cur]);
      preloadNear(cur);
    });

    // Plan heading from the camera's look direction (plan +y = cube -z).
    const dir = new THREE.Vector3();
    const heading = () => {
      camera.getWorldDirection(dir);
      return ((Math.atan2(dir.x, -dir.z) * 180) / Math.PI + 360) % 360;
    };

    let busy = false;
    const step = (sign: 1 | -1) => {
      if (busy) return;
      const hs = cb.current.hops, h = hs[cur];
      const hd = (heading() + (sign < 0 ? 180 : 0)) % 360;
      let best = -1, bd = Infinity;
      // Close and straight ahead first; then wider; then the nearest spot anywhere in front (sparse scans).
      const passes = [{ maxD: 4, cone: 35 }, { maxD: 7, cone: 60 }, { maxD: Infinity, cone: 90 }];
      for (let pass = 0; pass < passes.length && best < 0; pass++) {
        const { maxD, cone } = passes[pass];
        hs.forEach((o, j) => {
          if (j === cur) return;
          const d = Math.hypot(o.x - h.x, o.y - h.y);
          if (d < 0.8 || d > maxD) return;
          const b = ((Math.atan2(o.x - h.x, o.y - h.y) * 180) / Math.PI + 360) % 360;
          const diff = Math.abs(((b - hd + 540) % 360) - 180);
          if (diff <= cone && d < bd) {
            bd = d;
            best = j;
          }
        });
      }
      if (best >= 0) goTo(best);
    };

    const goTo = (j: number) => {
      if (busy || j === cur || !cb.current.hops[j]) return;
      busy = true;
      const hs = cb.current.hops;
      const t0 = performance.now();
      const ready = loadHop(hs[j]);
      // 1) zoom toward the target (a "step"), 2) crossfade once its faces are in, 3) settle.
      const zoom = (now: number) => {
        const k = Math.min(1, (now - t0) / 250);
        camera.fov = FOV - 16 * k;
        camera.updateProjectionMatrix();
        if (k < 1) requestAnimationFrame(zoom);
      };
      requestAnimationFrame(zoom);
      void ready.then(() => {
        if (!alive) return;
        const back = 1 - front;
        paint(cubes[back], hs[j]);
        cubes[back].mesh.visible = true;
        cubes[back].mats.forEach((m) => (m.opacity = 0));
        cubes[back].mesh.renderOrder = 2;
        cubes[front].mesh.renderOrder = 1;
        const f0 = performance.now();
        const fade = (now: number) => {
          const k = Math.min(1, (now - f0) / 200);
          cubes[back].mats.forEach((m) => (m.opacity = k));
          camera.fov = FOV - 16 * (1 - k);
          camera.updateProjectionMatrix();
          if (k < 1) return requestAnimationFrame(fade);
          cubes[front].mesh.visible = false;
          front = back;
          cur = j;
          busy = false;
          cb.current.onIndex(j);
          preloadNear(j);
        };
        requestAnimationFrame(fade);
      });
    };
    api.current = { goTo };

    const kd = (e: KeyboardEvent) => {
      if (e.code === "KeyW" || e.code === "ArrowUp") step(1);
      else if (e.code === "KeyS" || e.code === "ArrowDown") step(-1);
    };
    window.addEventListener("keydown", kd);

    const resize = () => {
      const w = wrap.clientWidth || 1, h = wrap.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    let raf = 0, lastH = -1, lastHAt = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
      if (now - lastHAt > 150) {
        lastHAt = now;
        const hd = Math.round(heading());
        if (hd !== lastH) {
          lastH = hd;
          cb.current.onHeading?.(hd);
        }
      }
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      api.current = null;
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", kd);
      ro.disconnect();
      controls.dispose();
      geo.dispose();
      cubes.forEach((c) => c.mats.forEach((m) => m.dispose()));
      cache.forEach((t) => t.dispose());
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // Rebuild only for a different building's spot set; index changes from outside go through goTo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // A click on the floor plan (outside) changes `index`: walk there.
  useEffect(() => {
    api.current?.goTo(index);
  }, [index]);

  return <div ref={wrapRef} className={className} />;
}
