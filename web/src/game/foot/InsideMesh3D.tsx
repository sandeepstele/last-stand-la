"use client";
// The building's REAL 3D floor (Matterport's untextured mesh: the actual walls, columns and rooms), drawn as clean lines
// over dark surfaces, with every scan spot, where you are and which way you face. Same x/y frame as the scan spots
// (z up, metres). It's a map of the real geometry; the photos you walk through are the real interior. OWNER: coding lead.

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import type { InsideHop } from "../types";
import { footStyles as styles } from "./ui";

export function InsideMesh3D({ url, hops, at, heading }: { url: string; hops: InsideHop[]; at: number; heading: number }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const live = useRef({ at, heading });
  useEffect(() => {
    live.current = { at, heading };
  }, [at, heading]);
  const key = `${url}|${hops.map((h) => h.id).join(",")}`;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const W = 300, H = 210;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(W, H);
    wrap.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 500);
    scene.add(new THREE.HemisphereLight(0xcfd8ff, 0x101420, 1.2));
    // z-up mesh frame -> y-up: (x, y, z) -> (x, z, -y)
    const root = new THREE.Group();
    root.rotation.x = -Math.PI / 2;
    scene.add(root);
    const disposables: { dispose(): void }[] = [];
    let alive = true;
    const center = new THREE.Vector3();
    let radius = 20;

    fetch(`/api/${url}`)
      .then((r) => (r.ok ? r.text() : null))
      .then((txt) => {
        if (!alive || !txt) return;
        const obj = new OBJLoader().parse(txt);
        obj.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          const surf = new THREE.Mesh(m.geometry, new THREE.MeshLambertMaterial({ color: 0x1e1e21, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
          const edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 28), new THREE.LineBasicMaterial({ color: 0xe9e4da, transparent: true, opacity: 0.5 }));
          root.add(surf, edges);
          disposables.push(m.geometry, surf.material as THREE.Material, edges.geometry, edges.material as THREE.Material);
        });
        const box = new THREE.Box3().setFromObject(root);
        box.getCenter(center);
        radius = box.getSize(new THREE.Vector3()).length() / 2;
      })
      .catch(() => {});

    // Scan spots (in the mesh frame, standing at z=0).
    const dotGeo = new THREE.SphereGeometry(0.45, 10, 8);
    const dotMat = new THREE.MeshBasicMaterial({ color: 0x9a968f });
    const youMat = new THREE.MeshBasicMaterial({ color: 0xf2a33a });
    const dots = hops.map((h) => {
      const d = new THREE.Mesh(dotGeo, dotMat);
      d.position.set(h.x, h.y, 0.6);
      root.add(d);
      return d;
    });
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.7, 2.2, 10), youMat);
    root.add(arrow);
    disposables.push(dotGeo, dotMat, youMat, arrow.geometry);

    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const { at: i, heading: hd } = live.current;
      dots.forEach((d, j) => {
        d.material = j === i ? youMat : dotMat;
        d.scale.setScalar(j === i ? 1.6 : 1);
      });
      const h = hops[Math.min(i, hops.length - 1)];
      if (h) {
        // Heading is clockwise from the plan's +y; the cone points along +y by default after a -90 deg x-rotation.
        arrow.position.set(h.x, h.y, 1.6);
        arrow.rotation.set(Math.PI / 2, 0, 0);
        arrow.rotateOnWorldAxis(new THREE.Vector3(0, 0, 1), (-hd * Math.PI) / 180);
      }
      const a = now / 9000;
      camera.position.set(center.x + Math.sin(a) * radius * 1.3, center.y + radius * 0.9, center.z + Math.cos(a) * radius * 1.3);
      camera.lookAt(center);
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      disposables.forEach((d) => d.dispose());
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className={`${styles.root} ${styles.plan}`}>
      <div className={styles.planHead}>
        <b>Floor plan</b> · real 3D scan · W/S to walk, drag to look
      </div>
      <div ref={wrapRef} />
    </div>
  );
}
