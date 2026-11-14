"use client";
// OWNER: builder D. A full-screen look-around of a REAL interior from cube-face JPEGs (f0 top, f1-f4 sides, f5 bottom).
// Same technique as ../Pano.tsx (a box seen from inside, rotate-only orbit controls), without the dialog chrome,
// so InsideView owns the overlay. A slow drift until the player drags; missing faces fall back to a dark gradient.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { evidenceUrl } from "../Pano";
import type { PanoFace } from "../types";

// BoxGeometry material order: +x, -x, +y, -y, +z, -z. Sides assumed f1 front (-z), f2 right, f3 back, f4 left (as Pano.tsx).
const FACE_SLOT: Record<PanoFace["face"], number> = { f2: 0, f4: 1, f0: 2, f5: 3, f3: 4, f1: 5 };

function gradientTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 256;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, "#1b2440");
  grad.addColorStop(0.55, "#0d1222");
  grad.addColorStop(1, "#05070d");
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function InsidePano({ faces, drift = true, className }: { faces: PanoFace[]; drift?: boolean; className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  // The director rebuilds the faces array on every render; key the scene on its content instead.
  const key = JSON.stringify(faces.map((f) => [f.face, f.name]));

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const list = JSON.parse(key) as [PanoFace["face"], string][];
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    wrap.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070d);
    const camera = new THREE.PerspectiveCamera(78, 1, 0.1, 100);
    camera.position.set(0, 0, 0.01);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.rotateSpeed = -0.35;
    controls.autoRotate = drift;
    controls.autoRotateSpeed = 0.45;
    controls.minPolarAngle = Math.PI * 0.3;
    controls.maxPolarAngle = Math.PI * 0.7;
    controls.target.set(0, 0, 0);
    controls.update();
    const stopDrift = () => (controls.autoRotate = false);
    controls.addEventListener("start", stopDrift);

    const grad = gradientTexture();
    const mats = Array.from({ length: 6 }, (_, i) =>
      i === 2
        ? new THREE.MeshBasicMaterial({ color: 0x141a2e, side: THREE.BackSide })
        : i === 3
          ? new THREE.MeshBasicMaterial({ color: 0x05070d, side: THREE.BackSide })
          : new THREE.MeshBasicMaterial({ map: grad, side: THREE.BackSide }),
    );
    const geo = new THREE.BoxGeometry(10, 10, 10);
    scene.add(new THREE.Mesh(geo, mats));

    const loaded: THREE.Texture[] = [];
    const loader = new THREE.TextureLoader();
    let alive = true;
    for (const [face, name] of list) {
      const slot = FACE_SLOT[face];
      if (slot === undefined || !name) continue;
      loader.load(
        evidenceUrl(name),
        (tex) => {
          if (!alive) {
            tex.dispose();
            return;
          }
          tex.colorSpace = THREE.SRGBColorSpace;
          // Seen from inside the box: un-mirror with repeat -1 / offset 1, clamped to the edge, and inset by half a
          // texel so filtering never samples the opposite edge (that was the thin seam line between faces).
          const img = tex.image as { width?: number; height?: number } | undefined;
          const eu = 0.5 / Math.max(1, img?.width ?? 1024);
          const ev = 0.5 / Math.max(1, img?.height ?? 1024);
          tex.wrapS = THREE.ClampToEdgeWrapping;
          tex.wrapT = THREE.ClampToEdgeWrapping;
          tex.repeat.set(-(1 - 2 * eu), 1 - 2 * ev);
          tex.offset.set(1 - eu, ev);
          loaded.push(tex);
          mats[slot].map = tex;
          mats[slot].color.set(0xffffff);
          mats[slot].needsUpdate = true;
        },
        undefined,
        () => {
          /* keep the gradient */
        },
      );
    }

    const resize = () => {
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.removeEventListener("start", stopDrift);
      controls.dispose();
      geo.dispose();
      mats.forEach((m) => m.dispose());
      loaded.forEach((t) => t.dispose());
      grad.dispose();
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [key, drift]);

  return <div ref={wrapRef} className={className} />;
}
