"use client";

// STEP INSIDE: a look-around panorama from cube-face JPEGs (f0 top, f1-f4 sides, f5 bottom).
// Missing or failed faces fall back to a dark gradient. Rotate only: no pan, no zoom.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { PanoFace } from "./types";
import styles from "./hud.module.css";

export const evidenceUrl = (name: string) => `/api/backend/evidence/image/${encodeURIComponent(name.split("/").pop() ?? name)}`;

// BoxGeometry material order: +x, -x, +y, -y, +z, -z. Sides assumed f1 front (-z), f2 right, f3 back, f4 left.
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

export function Pano({ faces, title, onClose }: { faces: PanoFace[]; title: string; onClose(): void }) {
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    wrap.appendChild(renderer.domElement);
    renderer.domElement.className = styles.panoCanvas;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070d);
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.position.set(0, 0, 0.01);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableZoom = false;
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.rotateSpeed = -0.35;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.minPolarAngle = Math.PI * 0.32;
    controls.maxPolarAngle = Math.PI * 0.68;
    controls.target.set(0, 0, 0);
    controls.update();

    const grad = gradientTexture();
    const mats = Array.from({ length: 6 }, (_, i) =>
      i === 2 ? new THREE.MeshBasicMaterial({ color: 0x141a2e, side: THREE.BackSide })
        : i === 3 ? new THREE.MeshBasicMaterial({ color: 0x05070d, side: THREE.BackSide })
          : new THREE.MeshBasicMaterial({ map: grad, side: THREE.BackSide }),
    );
    const geo = new THREE.BoxGeometry(10, 10, 10);
    const box = new THREE.Mesh(geo, mats);
    scene.add(box);

    const loaded: THREE.Texture[] = [];
    const loader = new THREE.TextureLoader();
    let alive = true;
    for (const f of faces) {
      const slot = FACE_SLOT[f.face];
      if (slot === undefined || !f.name) continue;
      loader.load(evidenceUrl(f.name), (tex) => {
        if (!alive) {
          tex.dispose();
          return;
        }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.wrapS = THREE.RepeatWrapping;
        tex.repeat.x = -1; // seen from inside the box: un-mirror
        loaded.push(tex);
        mats[slot].map = tex;
        mats[slot].color.set(0xffffff);
        mats[slot].needsUpdate = true;
      }, undefined, () => { /* keep the gradient */ });
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
      controls.dispose();
      geo.dispose();
      mats.forEach((m) => m.dispose());
      loaded.forEach((t) => t.dispose());
      grad.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [faces]);

  return (
    <div className={styles.panoOverlay} role="dialog" aria-label={`Inside ${title}`}>
      <div className={styles.panoFrame}>
        <div className={styles.panoHead}>
          <span className={styles.pipTag}>INSIDE THE FORTRESS</span>
          <strong>{title}</strong>
          <span className={styles.muted}>drag to look around</span>
          <button type="button" className={styles.ghostBtn} onClick={onClose}>Close</button>
        </div>
        <div ref={wrapRef} className={styles.panoView} />
      </div>
    </div>
  );
}
