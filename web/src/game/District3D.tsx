"use client";

// The district in plain three.js: flat-coloured buildings by material, hazard rings for unfinished retrofit
// orders, split colours for a record conflict, the horde, and a fixed ~45 degree map camera (pan + zoom only).

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import * as THREE from "three";
import { MapControls } from "three/examples/jsm/controls/MapControls.js";
import { Horde } from "./Horde";
import type { Building, District, Material, Wave } from "./types";
import styles from "./district.module.css";

export type DistrictHandle = {
  focus(pid: string): void;
  shake(mmi: number): void;
  flash(pid: string, color: string | number): void;
  setTarget(pid: string | null): void;
  spawnWave(wave: Wave, pid: string): void;
  clearHorde(): void;
};

type Props = {
  district: District | null;
  selected: string | null;
  fortress: string | null;
  /** pid -> the material a weigh_case leans to; null keeps the split. Only conflict buildings appear. */
  conflictMaterials: Record<string, Material | null>;
  onSelect(pid: string): void;
};

export const MATERIAL_COLOR: Record<Material, number> = {
  concrete: 0x9aa3ad, steel: 0x6f8fb0, masonry: 0xa5523f, wood: 0xc8a26b, unknown: 0x5b6573,
};
const AMBER = 0xf5a524;
const RED = 0xe5484d;
const HERO_EMISSIVE = new THREE.Color(0x2a1c06);
const SELECT_EMISSIVE = new THREE.Color(0x6a4508);
const NO_EMISSIVE = new THREE.Color(0x000000);
const BG = 0x0b1020;

type Rec = {
  b: Building;
  cx: number;
  cz: number;
  top: number;
  radius: number;
  meshes: THREE.Mesh[];
  mats: THREE.MeshStandardMaterial[];
  edges: THREE.LineSegments[];
  edgeMat: THREE.LineBasicMaterial;
  baseEmissive: THREE.Color;
  label?: HTMLDivElement;
  split?: {
    from: [THREE.Color, THREE.Color];
    to: [THREE.Color, THREE.Color];
    t0: number;
    sprite: THREE.Sprite;
    spriteMat: THREE.SpriteMaterial;
    resolved: boolean;
  };
};

type Ctx = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: MapControls;
  horde: Horde;
  group: THREE.Group;
  recs: Map<string, Rec>;
  pickables: THREE.Mesh[];
  ringMats: { amber: THREE.MeshBasicMaterial; red: THREE.MeshBasicMaterial };
  ringGeo: THREE.RingGeometry;
  beacon: THREE.Mesh;
  beaconRing: THREE.Mesh;
  qTexture: THREE.CanvasTexture;
  clock: THREE.Clock;
  focus: { from: THREE.Vector3; to: THREE.Vector3; off0: THREE.Vector3; off1: THREE.Vector3; t0: number; active: boolean };
  shake: { amp: number; t0: number; active: boolean; offset: THREE.Vector3 };
  flash: { rec: Rec | null; color: THREE.Color; t0: number };
  hover: { dirty: boolean; ndc: THREE.Vector2; x: number; y: number; pid: string | null; inside: boolean };
  limit: number;
  radius: number;
  seed: number;
};

function buildingHeight(b: Building): number {
  const s = Math.max(1, b.stories || 1);
  let h = Number(b.height_m) || 0;
  if (h < 2.5 * s) h = s * 3.5;
  return h > 0 ? h : 10;
}

function validFootprint(fp: Building["footprint"]): fp is [number, number][] {
  return Array.isArray(fp) && fp.length >= 3 && fp.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** Geometry for [y0, y1] of a building, positioned in world space (meshes sit at the origin). */
function partGeometry(b: Building, y0: number, y1: number): { geo: THREE.BufferGeometry; cx: number; cz: number; radius: number } {
  const fp = b.footprint;
  if (validFootprint(fp)) {
    let mx = 0;
    let mz = 0;
    for (const [x, z] of fp) {
      mx += x;
      mz += z;
    }
    mx /= fp.length;
    mz /= fp.length;
    // Footprints are an open ring relative to the building's own (x, z).
    const ox = b.x;
    const oz = b.z;
    const shape = new THREE.Shape();
    fp.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x + ox, -(z + oz)) : shape.lineTo(x + ox, -(z + oz))));
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // shape (x, -z) -> world (x, z), extruded up +y
    geo.translate(0, y0, 0);
    let radius = 0;
    for (const [x, z] of fp) radius = Math.max(radius, Math.hypot(x - mx, z - mz));
    return { geo, cx: mx + ox, cz: mz + oz, radius };
  }
  const w = b.w > 0 ? b.w : 20;
  const d = b.d > 0 ? b.d : 20;
  const geo = new THREE.BoxGeometry(w, y1 - y0, d);
  geo.translate(b.x, (y0 + y1) / 2, b.z);
  return { geo, cx: b.x, cz: b.z, radius: Math.hypot(w, d) / 2 };
}

function makeQTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(11,16,32,0.85)";
  g.beginPath();
  g.arc(64, 64, 56, 0, Math.PI * 2);
  g.fill();
  g.lineWidth = 8;
  g.strokeStyle = "#f5a524";
  g.stroke();
  g.fillStyle = "#f5a524";
  g.font = "bold 84px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("?", 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function listStatus(b: Building): string {
  if (b.past_due) return "Retrofit ordered · past a deadline";
  if (b.unfinished) return "Retrofit ordered, unfinished";
  if (b.list) return "On a city retrofit list";
  return "Not on a retrofit list";
}

function tooltipHtml(b: Building): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);
  const facts = [b.year_built ? `built ${b.year_built}` : null, `${b.stories} stories`, `${b.material} on record`].filter(Boolean).join(" · ");
  const people = b.people != null ? `<div>${b.people} people on record</div>` : "";
  const conflict = b.conflict ? `<div class="${styles.warn}">Records disagree: ${esc(b.conflict.costar)} vs the city's ${esc(b.conflict.city)}</div>` : "";
  const status = `<div class="${b.unfinished ? styles.warn : ""}">${esc(listStatus(b))}</div>`;
  return `<strong>${esc(b.label)}</strong><div>${esc(facts)}</div>${people}${status}${conflict}`;
}

export const District3D = forwardRef<DistrictHandle, Props>(function District3D({ district, selected, fortress, conflictMaterials, onSelect }, ref) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const ctxRef = useRef<Ctx | null>(null);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // ---------------------------------------------------------------- renderer, scene, loop (once)
  useEffect(() => {
    const wrap = wrapRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setClearColor(BG);
    wrap.prepend(renderer.domElement);
    renderer.domElement.className = styles.canvas;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.fog = new THREE.Fog(BG, 500, 1900);
    scene.add(new THREE.HemisphereLight(0x8fa6d8, 0x1a140f, 1.1));
    const sun = new THREE.DirectionalLight(0xffa860, 1.9);
    sun.position.set(-400, 140, 120); // low, from the west: dusk
    scene.add(sun);

    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x0f1628, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    scene.add(ground);
    const grid = new THREE.GridHelper(4000, 200, 0x1d2a44, 0x16203a);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    grid.position.y = 0.02;
    scene.add(grid);

    const camera = new THREE.PerspectiveCamera(40, 1, 1, 6000);
    camera.position.set(0, 450, 450);
    const controls = new MapControls(camera, renderer.domElement);
    controls.enableRotate = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = false;
    controls.minDistance = 70;
    controls.maxDistance = 1300;
    controls.target.set(0, 0, 0);
    controls.update();

    const horde = new Horde(800);
    scene.add(horde.mesh);
    const group = new THREE.Group();
    scene.add(group);

    const ringGeo = new THREE.RingGeometry(0.86, 1, 64);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMats = {
      amber: new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
      red: new THREE.MeshBasicMaterial({ color: RED, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }),
    };
    const beacon = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 1.6, 160, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    beacon.visible = false;
    scene.add(beacon);
    const beaconRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    beaconRing.position.y = 0.15;
    beaconRing.visible = false;
    scene.add(beaconRing);

    const ctx: Ctx = {
      renderer, scene, camera, controls, horde, group, recs: new Map(), pickables: [], ringMats, ringGeo, beacon, beaconRing,
      qTexture: makeQTexture(), clock: new THREE.Clock(),
      focus: { from: new THREE.Vector3(), to: new THREE.Vector3(), off0: new THREE.Vector3(), off1: new THREE.Vector3(), t0: 0, active: false },
      shake: { amp: 0, t0: 0, active: false, offset: new THREE.Vector3() },
      flash: { rec: null, color: new THREE.Color(), t0: 0 },
      hover: { dirty: false, ndc: new THREE.Vector2(), x: 0, y: 0, pid: null, inside: false },
      limit: 900, radius: 400, seed: 1,
    };
    ctxRef.current = ctx;

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

    // ---- picking (click without drag) and hover (raycast once per frame, in the loop)
    const raycaster = new THREE.Raycaster();
    const pick = (ndc: THREE.Vector2): string | null => {
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(ctx.pickables, false)[0];
      return hit ? (hit.object.userData.pid as string) : null;
    };
    const toNdc = (e: PointerEvent, out: THREE.Vector2) => {
      const r = renderer.domElement.getBoundingClientRect();
      out.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ctx.hover.x = e.clientX - r.left;
      ctx.hover.y = e.clientY - r.top;
    };
    let down: { x: number; y: number } | null = null;
    const clickNdc = new THREE.Vector2();
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: PointerEvent) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) return;
      down = null;
      toNdc(e, clickNdc);
      const pid = pick(clickNdc);
      if (pid) onSelectRef.current(pid);
    };
    const onMove = (e: PointerEvent) => {
      toNdc(e, ctx.hover.ndc);
      ctx.hover.dirty = true;
      ctx.hover.inside = true;
    };
    const onLeave = () => {
      ctx.hover.inside = false;
      ctx.hover.dirty = true;
    };
    const el = renderer.domElement;
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerleave", onLeave);

    // ---- loop
    const tmp = new THREE.Vector3();
    const proj = new THREE.Vector3();
    const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, ctx.clock.getDelta());
      const t = ctx.clock.elapsedTime;

      // pulsing hazard rings and target beacon
      const pulse = 0.35 + 0.35 * (0.5 + 0.5 * Math.sin(t * 3));
      ctx.ringMats.amber.opacity = pulse;
      ctx.ringMats.red.opacity = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(t * 5));
      (ctx.beacon.material as THREE.MeshBasicMaterial).opacity = 0.2 + 0.2 * (0.5 + 0.5 * Math.sin(t * 2.4));

      ctx.horde.update(dt);

      // eased camera focus
      const f = ctx.focus;
      if (f.active) {
        const p = Math.min(1, (performance.now() - f.t0) / 1000);
        const k = easeInOut(p);
        controls.target.lerpVectors(f.from, f.to, k);
        tmp.lerpVectors(f.off0, f.off1, k);
        camera.position.copy(controls.target).add(tmp);
        if (p >= 1) f.active = false;
      }

      // keep the pan inside the district
      const tg = controls.target;
      const dist = Math.hypot(tg.x, tg.z);
      if (dist > ctx.limit) {
        const s = ctx.limit / dist;
        const dx = tg.x * s - tg.x;
        const dz = tg.z * s - tg.z;
        tg.x += dx;
        tg.z += dz;
        camera.position.x += dx;
        camera.position.z += dz;
      }
      controls.update();

      // flash
      const fl = ctx.flash;
      if (fl.rec) {
        const p = (performance.now() - fl.t0) / 1400;
        if (p >= 1) {
          for (const m of fl.rec.mats) m.emissive.copy(fl.rec.baseEmissive);
          fl.rec = null;
        } else {
          const k = (1 - p) * (0.55 + 0.45 * Math.cos(p * Math.PI * 6));
          for (const m of fl.rec.mats) m.emissive.copy(fl.rec.baseEmissive).lerp(fl.color, k);
        }
      }

      // conflict split -> leading material
      for (const rec of ctx.recs.values()) {
        const s = rec.split;
        if (!s) continue;
        const p = Math.min(1, (performance.now() - s.t0) / 1500);
        if (p < 1 || s.t0 > 0) {
          rec.mats[0].color.lerpColors(s.from[0], s.to[0], p);
          rec.mats[1].color.lerpColors(s.from[1], s.to[1], p);
          s.spriteMat.opacity = s.resolved ? 1 - p : Math.max(s.spriteMat.opacity, p);
          if (p >= 1) s.t0 = 0;
        }
        s.sprite.position.y = rec.top + 14 + Math.sin(t * 2) * 1.5;
      }

      // hover tooltip
      const tip = tipRef.current;
      if (ctx.hover.dirty && tip) {
        ctx.hover.dirty = false;
        const pid = ctx.hover.inside ? pick(ctx.hover.ndc) : null;
        if (pid !== ctx.hover.pid) {
          ctx.hover.pid = pid;
          const rec = pid ? ctx.recs.get(pid) : undefined;
          tip.innerHTML = rec ? tooltipHtml(rec.b) : "";
          tip.style.display = rec ? "block" : "none";
          el.style.cursor = rec ? "pointer" : "";
        }
        if (pid) tip.style.transform = `translate(${ctx.hover.x + 16}px, ${ctx.hover.y + 16}px)`;
      }

      // hero labels
      const w = el.clientWidth;
      const h = el.clientHeight;
      for (const rec of ctx.recs.values()) {
        if (!rec.label) continue;
        proj.set(rec.cx, rec.top + 6, rec.cz).project(camera);
        const visible = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
        rec.label.style.display = visible ? "block" : "none";
        if (visible) rec.label.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translate(-50%, -100%)`;
      }

      // aftershock shake: offset the camera for this frame only
      const sh = ctx.shake;
      if (sh.active) {
        const p = (performance.now() - sh.t0) / 1500;
        if (p >= 1) sh.active = false;
        else {
          const a = sh.amp * (1 - p) * (1 - p);
          sh.offset.set(Math.sin(t * 47) * a, Math.sin(t * 53 + 1) * a * 0.6, Math.sin(t * 41 + 2) * a);
          camera.position.add(sh.offset);
          renderer.render(scene, camera);
          camera.position.sub(sh.offset);
          return;
        }
      }
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerleave", onLeave);
      controls.dispose();
      horde.dispose();
      clearBuildings(ctx);
      ground.geometry.dispose();
      (ground.material as THREE.Material).dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      ringGeo.dispose();
      ringMats.amber.dispose();
      ringMats.red.dispose();
      beacon.geometry.dispose();
      (beacon.material as THREE.Material).dispose();
      (beaconRing.material as THREE.Material).dispose();
      ctx.qTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      ctxRef.current = null;
    };
  }, []);

  // ---------------------------------------------------------------- buildings (per district)
  useEffect(() => {
    const ctx = ctxRef.current;
    const labels = labelsRef.current;
    if (!ctx || !district || !labels) return;
    ctx.seed = district.seed;
    ctx.radius = district.radius_m || 400;
    ctx.limit = ctx.radius * 1.6;
    ctx.controls.maxDistance = Math.max(600, ctx.radius * 3.2);
    const fog = ctx.scene.fog as THREE.Fog;
    fog.near = ctx.radius * 1.2;
    fog.far = ctx.radius * 5;
    const d0 = ctx.radius * 1.15;
    ctx.controls.target.set(0, 0, 0);
    ctx.camera.position.set(0, d0, d0);

    for (const b of district.buildings) {
      const h = buildingHeight(b);
      const color = MATERIAL_COLOR[b.material] ?? MATERIAL_COLOR.unknown;
      const parts: [number, number, number][] = b.conflict
        ? [[0, h / 2, MATERIAL_COLOR[b.conflict.costar] ?? color], [h / 2, h, MATERIAL_COLOR[b.conflict.city] ?? color]]
        : [[0, h, color]];
      const edgeMat = new THREE.LineBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.35), transparent: true, opacity: 0.7 });
      const rec: Rec = {
        b, cx: b.x, cz: b.z, top: h, radius: 15, meshes: [], mats: [], edges: [], edgeMat,
        baseEmissive: (b.hero ? HERO_EMISSIVE : NO_EMISSIVE).clone(),
      };
      for (const [y0, y1, c] of parts) {
        const { geo, cx, cz, radius } = partGeometry(b, y0, y1);
        rec.cx = cx;
        rec.cz = cz;
        rec.radius = radius;
        const mat = new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0.05, emissive: rec.baseEmissive.clone() });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.userData.pid = b.pid;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMat);
        ctx.group.add(mesh, edges);
        ctx.pickables.push(mesh);
        rec.meshes.push(mesh);
        rec.mats.push(mat);
        rec.edges.push(edges);
      }
      if (b.unfinished) {
        const ring = new THREE.Mesh(ctx.ringGeo, b.past_due ? ctx.ringMats.red : ctx.ringMats.amber);
        const r = rec.radius + 7;
        ring.scale.set(r, 1, r);
        ring.position.set(rec.cx, 0.1, rec.cz);
        ctx.group.add(ring);
      }
      if (b.conflict) {
        const spriteMat = new THREE.SpriteMaterial({ map: ctx.qTexture, transparent: true, depthWrite: false, fog: false });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.scale.set(16, 16, 1);
        sprite.position.set(rec.cx, h + 14, rec.cz);
        ctx.group.add(sprite);
        rec.split = {
          from: [rec.mats[0].color.clone(), rec.mats[1].color.clone()],
          to: [rec.mats[0].color.clone(), rec.mats[1].color.clone()],
          t0: 0, sprite, spriteMat, resolved: false,
        };
      }
      if (b.hero) {
        const el = document.createElement("div");
        el.className = styles.label;
        el.textContent = b.label;
        labels.appendChild(el);
        rec.label = el;
      }
      ctx.recs.set(b.pid, rec);
    }
    return () => clearBuildings(ctx);
  }, [district]);

  // ---------------------------------------------------------------- selection highlight
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    for (const rec of ctx.recs.values()) {
      const on = rec.b.pid === selected || rec.b.pid === fortress;
      rec.baseEmissive.copy(on ? SELECT_EMISSIVE : rec.b.hero ? HERO_EMISSIVE : NO_EMISSIVE);
      if (ctx.flash.rec !== rec) for (const m of rec.mats) m.emissive.copy(rec.baseEmissive);
      rec.edgeMat.color.set(on ? AMBER : new THREE.Color(rec.mats[rec.mats.length - 1].color).lerp(new THREE.Color(0xffffff), 0.35));
      rec.edgeMat.opacity = on ? 1 : 0.7;
      rec.label?.classList.toggle(styles.labelOn, on);
    }
  }, [selected, fortress, district]);

  // ---------------------------------------------------------------- conflict split -> leading material
  useEffect(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    for (const rec of ctx.recs.values()) {
      const s = rec.split;
      const c = rec.b.conflict;
      if (!s || !c) continue;
      const lean = conflictMaterials[rec.b.pid] ?? null;
      const resolved = !!lean;
      if (resolved === s.resolved && (!lean || s.to[0].getHex() === MATERIAL_COLOR[lean])) continue;
      s.from[0].copy(rec.mats[0].color);
      s.from[1].copy(rec.mats[1].color);
      s.to[0].set(lean ? MATERIAL_COLOR[lean] : MATERIAL_COLOR[c.costar]);
      s.to[1].set(lean ? MATERIAL_COLOR[lean] : MATERIAL_COLOR[c.city]);
      s.resolved = resolved;
      s.t0 = performance.now();
    }
  }, [conflictMaterials, district]);

  useImperativeHandle(ref, () => ({
    focus(pid) {
      const ctx = ctxRef.current;
      const rec = ctx?.recs.get(pid);
      if (!ctx || !rec) return;
      const f = ctx.focus;
      f.from.copy(ctx.controls.target);
      f.to.set(rec.cx, 0, rec.cz);
      f.off0.copy(ctx.camera.position).sub(ctx.controls.target);
      const len = f.off0.length();
      f.off1.copy(f.off0).setLength(Math.min(Math.max(len, 200), 380));
      f.t0 = performance.now();
      f.active = true;
    },
    shake(mmi) {
      const ctx = ctxRef.current;
      if (!ctx) return;
      ctx.shake.amp = Math.min(10, Math.max(1, ((mmi || 6) - 3) * 1.6));
      ctx.shake.t0 = performance.now();
      ctx.shake.active = true;
    },
    flash(pid, color) {
      const ctx = ctxRef.current;
      const rec = ctx?.recs.get(pid);
      if (!ctx || !rec) return;
      if (ctx.flash.rec && ctx.flash.rec !== rec) for (const m of ctx.flash.rec.mats) m.emissive.copy(ctx.flash.rec.baseEmissive);
      ctx.flash.rec = rec;
      ctx.flash.color.set(color);
      ctx.flash.t0 = performance.now();
    },
    setTarget(pid) {
      const ctx = ctxRef.current;
      if (!ctx) return;
      const rec = pid ? ctx.recs.get(pid) : undefined;
      ctx.beacon.visible = !!rec;
      ctx.beaconRing.visible = !!rec;
      if (!rec) return;
      ctx.beacon.position.set(rec.cx, rec.top + 80, rec.cz);
      ctx.beaconRing.position.set(rec.cx, 0.15, rec.cz);
      const r = rec.radius + 14;
      ctx.beaconRing.scale.set(r, 1, r);
    },
    spawnWave(wave, pid) {
      const ctx = ctxRef.current;
      const rec = ctx?.recs.get(pid);
      if (!ctx || !rec) return;
      ctx.horde.spawnWave(wave, { x: rec.cx, z: rec.cz }, ctx.seed, { stopRadius: rec.radius + 10 });
    },
    clearHorde() {
      ctxRef.current?.horde.clear();
    },
  }), []);

  return (
    <div ref={wrapRef} className={styles.wrap}>
      <div ref={labelsRef} className={styles.labels} />
      <div ref={tipRef} className={styles.tip} />
    </div>
  );
});

function clearBuildings(ctx: Ctx) {
  for (const rec of ctx.recs.values()) {
    for (const m of rec.meshes) m.geometry.dispose();
    for (const m of rec.mats) m.dispose();
    for (const e of rec.edges) e.geometry.dispose();
    rec.edgeMat.dispose();
    rec.split?.spriteMat.dispose();
    rec.label?.remove();
  }
  ctx.group.clear();
  ctx.recs.clear();
  ctx.pickables.length = 0;
  if (ctx.flash.rec) ctx.flash.rec = null;
  ctx.hover.pid = null;
}
