"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import type { Ack, FrontendAction } from "@/lib/contracts";
import styles from "./world.module.css";

const SQM_PER_SQFT = 0.092903;

export interface WorldHandle {
  perform(action: FrontendAction): Promise<Ack>;
}

interface Ctx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  group: THREE.Group;
  side: number;
  height: number;
}

/** Deterministic three.js scene driven only by frontend_action events (the agent never touches geometry). */
export const WorldPane = forwardRef<WorldHandle>(function WorldPane(_props, ref) {
  const mount = useRef<HTMLDivElement>(null);
  const ctx = useRef<Ctx | null>(null);

  useEffect(() => {
    const el = mount.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(el.clientWidth, el.clientHeight);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#0b0f14");
    const camera = new THREE.PerspectiveCamera(45, el.clientWidth / el.clientHeight, 0.1, 2000);
    camera.position.set(60, 45, 60);
    camera.lookAt(0, 5, 0);
    scene.add(new THREE.HemisphereLight("#cfe3ff", "#20242a", 1.2));
    const sun = new THREE.DirectionalLight("#ffffff", 1.5);
    sun.position.set(40, 80, 20);
    scene.add(sun);
    scene.add(new THREE.GridHelper(200, 40, "#2b3542", "#1a222c"));
    const group = new THREE.Group();
    scene.add(group);
    ctx.current = { renderer, scene, camera, group, side: 30, height: 8 };

    let frame = 0;
    const loop = () => {
      frame = requestAnimationFrame(loop);
      group.rotation.y += 0.0015;
      renderer.render(scene, camera);
    };
    loop();
    const onResize = () => {
      camera.aspect = el.clientWidth / el.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(el.clientWidth, el.clientHeight);
    };
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      el.removeChild(renderer.domElement);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    async perform(action) {
      const c = ctx.current;
      if (!c) return { id: action.id, ok: false, error: "scene not ready" };
      apply(c, action);
      c.renderer.render(c.scene, c.camera);
      return { id: action.id, ok: true, screenshot_jpeg_b64: snapshot(c.renderer.domElement) };
    },
  }));

  return <div ref={mount} className={styles.world} />;
});

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function box(w: number, h: number, d: number, color: string, opacity = 1): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
  return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
}

function apply(c: Ctx, action: FrontendAction): void {
  const a = action.args;
  switch (action.verb) {
    case "show_building": {
      // TODO(B): use args.polygon_m when the toolkit provides a footprint outline; a square is the fallback.
      c.group.clear();
      c.side = Math.sqrt(num(a.footprint_sqft, 10000) * SQM_PER_SQFT);
      c.height = num(a.height_m, num(a.stories, 2) * 3.5);
      const mass = box(c.side, c.height, c.side, "#8fa3b8");
      mass.position.y = c.height / 2;
      mass.name = "measured";
      c.group.add(mass);
      return;
    }
    case "ghost_compare": {
      const stories = Math.max(1, num(a.stories, 1));
      const floorHeight = c.height / stories;
      const listedFloors = num(a.listed_sqft, 0) / Math.max(1, num(a.footprint_sqft, 1)) / 0.9; // mid efficiency band
      const ghostHeight = listedFloors * floorHeight;
      const ghost = box(c.side * 1.01, ghostHeight, c.side * 1.01, "#f5a524", 0.25);
      ghost.position.y = ghostHeight / 2;
      ghost.name = "as-listed";
      c.group.add(ghost);
      return;
    }
    case "reveal_levels": {
      const levels = Array.isArray(a.levels) ? (a.levels as { offset_m?: number }[]) : [];
      const ftf = num(a.floor_to_floor_m, 3.5);
      levels.forEach((lv) => {
        const slab = box(c.side, ftf * 0.9, c.side, "#4cc38a", 0.6);
        slab.position.y = num(lv.offset_m, -ftf) + (ftf * 0.9) / 2;
        c.group.add(slab);
      });
      return;
    }
    case "place_solar": {
      // Layout is illustrative: a grid of panels inside the usable roof area.
      const panels = Math.min(800, Math.max(0, Math.floor(num(a.panels, 0))));
      const usableSide = Math.sqrt(num(a.usable_roof_sqft, 0) * SQM_PER_SQFT);
      const cols = Math.max(1, Math.floor(usableSide / 1.2));
      for (let i = 0; i < panels; i++) {
        const p = box(1.0, 0.05, 1.7, "#1e3a8a");
        p.position.set(-usableSide / 2 + (i % cols) * 1.2 + 0.6, c.height + 0.1, -usableSide / 2 + Math.floor(i / cols) * 2.0 + 1.0);
        c.group.add(p);
      }
      return;
    }
  }
}

function snapshot(canvas: HTMLCanvasElement): string {
  const scale = Math.min(1, 640 / canvas.width);
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.5).split(",")[1] ?? "";
}
