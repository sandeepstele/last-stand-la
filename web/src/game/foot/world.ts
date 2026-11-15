// OWNER: builder C (world). The real city at night: the aerial mosaic on the ground, every kit building and backdrop
// block extruded from its real outline at its real height, facades in world metres, record conflicts, retrofit
// orders, doors, the beacon, the route, streetlamps, the sky and the dawn.
// Bus in: world:beacon, world:route, world:lean, world:barricade, fx:crack. Reads ctx.dawn every frame.

import * as THREE from "three";
import { MATERIAL_COLOR } from "../District3D";
import type { Building, Material } from "../types";
import { buildingHeight, outlineOf, type FootCtx, type Pt, type System } from "./engine";
import { closestOnPoly, pointInPoly } from "./collide";
import { addBand, addCap, addOutline, addPlainWalls, addWalls, areaOf, centroid, cleanRing, facadeMaterial, gridAngle, newBuf, offsetRing, rectRing, toGeometry } from "./worldMesh";
import { buildGrid, createRoute, walkableAt } from "./worldRoute";
import { dustTexture, facadeTextures, glowTexture, labelSprite, questionSprite, rng, streetTexture, TILE } from "./worldTex";

const AMBER = 0xf5a524;
/**
 * Name labels (door + beacon) live on their own layer, which only the main camera enables: the picture-in-picture
 * feed cameras (layer 0, and builder B's DRONE_LAYER = 2) never draw them.
 */
export const LABEL_LAYER = 3;
/** Largest on-screen height of a name label, CSS px (the sprite includes its rounded frame). */
const LABEL_MAX_PX = 40;
/** Backdrop blocks: neutral concrete and stone, darker than the kit's material colours. */
const BLOCK_TONES = [0x8d8a84, 0x7d8188, 0x9a948a, 0x6f747b, 0x8a8278, 0xa19d96, 0x767069];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const C = (hex: number) => new THREE.Color(hex);

type Kit = { b: Building; ring: Pt[]; c: Pt; h: number };
type Split = { lower: THREE.MeshLambertMaterial; upper: THREE.MeshLambertMaterial; seam: THREE.MeshBasicMaterial; costar: THREE.Color; city: THREE.Color; from: [THREE.Color, THREE.Color]; to: [THREE.Color, THREE.Color]; t0: number; leaned: boolean };

export function createWorld(ctx: FootCtx): System {
  const { scene, district, bounds, renderer } = ctx;
  const objs: THREE.Object3D[] = [];
  const trash: { dispose(): void }[] = [];
  const add = <T extends THREE.Object3D>(o: T): T => {
    scene.add(o);
    objs.push(o);
    return o;
  };
  const keep = <T extends { dispose(): void }>(d: T): T => {
    trash.push(d);
    return d;
  };
  const R = rng((district.seed || 1) * 7919 + 13);
  ctx.camera.layers.enable(LABEL_LAYER);
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const offs: (() => void)[] = [];

  // ================================================================== sky, fog, lights
  const NIGHT = { top: C(0x03060f), mid: C(0x16203a), low: C(0x0c1222), fog: C(0x111a2e), hemiSky: C(0x6878b0), hemiGround: C(0x1c1a1a), moon: C(0xa8bcff) };
  const DAWN = { top: C(0x5b7cc4), mid: C(0xf3a27e), low: C(0xe9b892), fog: C(0xd8b0a0), hemiSky: C(0xd4dcef), hemiGround: C(0x7a6c62), moon: C(0xffd0a6) };
  // Full daylight (the desk shift, 9 am to 5 pm). ctx.day blends on top of the night/dawn mix: 1 = noon, 0 = no sun.
  const DAY = { top: C(0x3d7fd6), mid: C(0x9cc6ef), low: C(0xd6e6f4), fog: C(0xc9dbea), hemiSky: C(0xeaf2ff), hemiGround: C(0x8a8478), moon: C(0xfff4e0) };
  const skyU = { uTop: { value: NIGHT.top.clone() }, uMid: { value: NIGHT.mid.clone() }, uLow: { value: NIGHT.low.clone() }, uMoon: { value: new THREE.Vector3(-0.45, 0.55, -0.7).normalize() }, uStars: { value: 1 } };
  const sky = add(
    new THREE.Mesh(
      keep(new THREE.SphereGeometry(1500, 32, 16)),
      keep(
        new THREE.ShaderMaterial({
          uniforms: skyU,
          side: THREE.BackSide,
          depthWrite: false,
          fog: false,
          vertexShader: /* glsl */ `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uLow; uniform vec3 uMoon; uniform float uStars;
            varying vec3 vDir;
            float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
            void main(){
              vec3 d = normalize(vDir);
              vec3 c = mix(uMid, uTop, smoothstep(0.0, 0.55, d.y));
              c = mix(uLow, c, smoothstep(-0.04, 0.06, d.y));
              float st = step(0.9972, hash(floor(d * 260.0))) * smoothstep(0.08, 0.45, d.y) * uStars;
              c += vec3(0.75, 0.8, 0.9) * st;
              float m = dot(d, uMoon);
              c += vec3(0.95, 0.96, 1.0) * smoothstep(0.99955, 0.9997, m) * uStars;
              c += vec3(0.20, 0.26, 0.42) * pow(max(m, 0.0), 260.0) * uStars;
              gl_FragColor = vec4(c, 1.0);
              #include <colorspace_fragment>
            }`,
        }),
      ),
    ),
  );
  sky.renderOrder = -10;
  sky.frustumCulled = false;
  const prevBg = scene.background, prevFog = scene.fog;
  scene.background = NIGHT.low.clone();
  const fog = new THREE.Fog(NIGHT.fog.clone(), 40, 220);
  scene.fog = fog;
  const hemi = add(new THREE.HemisphereLight(NIGHT.hemiSky.clone(), NIGHT.hemiGround.clone(), 1.6));
  const moon = add(new THREE.DirectionalLight(NIGHT.moon.clone(), 1.5));
  moon.position.set(-160, 260, -220);
  const moonTarget = add(new THREE.Object3D());
  moon.target = moonTarget;

  // ================================================================== buildings
  const kits: Kit[] = [];
  for (const b of district.buildings) {
    const ring = cleanRing(outlineOf(b));
    if (!ring.length) continue;
    const c = centroid(ring);
    kits.push({ b, ring, c, h: buildingHeight(b) });
  }
  const kitOf = new Map(kits.map((k) => [k.b.pid, k]));
  const blocks = (district.blocks ?? []).map((k) => ({ ring: cleanRing(k.ring ?? []), h: Math.max(3, Number(k.height_m) || 12) })).filter((k) => k.ring.length);
  function allOutlines(): Pt[][] {
    return [...kits.map((k) => k.ring), ...blocks.map((k) => k.ring)];
  }

  // ================================================================== ground
  // The whole city's extent (all outlines + the play rectangle): a street texture (asphalt + sidewalks around every
  // outline) covers it, so the city beyond the aerial still reads as streets. The aerial covers exactly `bounds`.
  const g = district.ground;
  const ext = { x0: Math.min(bounds.x0, g?.x0 ?? Infinity), z0: Math.min(bounds.z0, g?.z0 ?? Infinity), x1: Math.max(bounds.x1, g?.x1 ?? -Infinity), z1: Math.max(bounds.z1, g?.z1 ?? -Infinity) };
  for (const o of allOutlines())
    for (const [x, z] of o) {
      ext.x0 = Math.min(ext.x0, x);
      ext.z0 = Math.min(ext.z0, z);
      ext.x1 = Math.max(ext.x1, x);
      ext.z1 = Math.max(ext.z1, z);
    }
  ext.x0 = Math.max(-1600, ext.x0 - 60);
  ext.z0 = Math.max(-1600, ext.z0 - 60);
  ext.x1 = Math.min(1600, ext.x1 + 60);
  ext.z1 = Math.min(1600, ext.z1 + 60);
  const streets = keep(streetTexture(ext, allOutlines()));
  streets.anisotropy = aniso;
  const worldUv = (geo: THREE.BufferGeometry) => {
    const p = geo.getAttribute("position");
    const uv = new Float32Array(p.count * 2);
    for (let i = 0; i < p.count; i++) {
      uv[i * 2] = (p.getX(i) - ext.x0) / (ext.x1 - ext.x0);
      uv[i * 2 + 1] = 1 - (p.getZ(i) - ext.z0) / (ext.z1 - ext.z0);
    }
    geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  };
  const groundTint = { night: C(0x5a6070), dawn: C(0xffffff) };
  const groundMats = [0, 1].map(() => keep(new THREE.MeshLambertMaterial({ map: streets, emissiveMap: streets, color: 0x8a92a4, emissive: groundTint.night.clone() })));
  const [groundMat, outerMat] = groundMats;
  // the aerial's own rectangle (the walkable bounds may be larger than it)
  const rect = g ? { x0: g.x0, z0: g.z0, x1: g.x1, z1: g.z1 } : bounds;
  const groundGeo = keep(new THREE.PlaneGeometry(rect.x1 - rect.x0, rect.z1 - rect.z0));
  groundGeo.rotateX(-Math.PI / 2); // local +y (image top, v = 1) -> world -z (north) = z0; left (u = 0) = x0
  groundGeo.translate((rect.x0 + rect.x1) / 2, 0, (rect.z0 + rect.z1) / 2);
  add(new THREE.Mesh(groundGeo, groundMat));
  let alive = true;
  if (g?.image) {
    new THREE.TextureLoader().load(
      ctx.imageUrl(g.image),
      (t) => {
        if (!alive) return void t.dispose();
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = aniso;
        keep(t);
        groundMat.map = t;
        groundMat.emissiveMap = t;
        // soften the aerial's edge into the street ground over the last ~14 m
        const size = { value: new THREE.Vector2(rect.x1 - rect.x0, rect.z1 - rect.z0) };
        const edgeCol = { value: new THREE.Color(0x4b4d52) };
        groundMat.onBeforeCompile = (sh) => {
          sh.uniforms.uSize = size;
          sh.uniforms.uEdge = edgeCol;
          sh.fragmentShader = sh.fragmentShader
            .replace("#include <common>", "#include <common>\nuniform vec2 uSize;\nuniform vec3 uEdge;")
            .replace(
              "#include <map_fragment>",
              `#include <map_fragment>
  float eM = min(min(vMapUv.x, 1.0 - vMapUv.x) * uSize.x, min(vMapUv.y, 1.0 - vMapUv.y) * uSize.y);
  float eK = smoothstep(0.0, 14.0, eM);
  diffuseColor.rgb = mix(uEdge, diffuseColor.rgb, eK);`,
            )
            .replace(
              "#include <emissivemap_fragment>",
              `#include <emissivemap_fragment>
  totalEmissiveRadiance = mix(emissive * uEdge, totalEmissiveRadiance, eK);`,
            );
        };
        groundMat.customProgramCacheKey = () => "foot-aerial-edge";
        groundMat.needsUpdate = true;
      },
      undefined,
      () => worldUv(groundGeo),
    );
  } else {
    worldUv(groundGeo);
  }
  // beyond the aerial, out to ~1.6 km, with a hole so it never z-fights the aerial
  {
    const S = 1600;
    const sh = new THREE.Shape([new THREE.Vector2(-S, -S), new THREE.Vector2(S, -S), new THREE.Vector2(S, S), new THREE.Vector2(-S, S)]);
    // Shape is in (x, -z) so that rotateX(-90deg) lands it on the ground
    sh.holes.push(new THREE.Path([new THREE.Vector2(rect.x0, -rect.z0), new THREE.Vector2(rect.x0, -rect.z1), new THREE.Vector2(rect.x1, -rect.z1), new THREE.Vector2(rect.x1, -rect.z0)]));
    const geo = keep(new THREE.ShapeGeometry(sh));
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, -0.02, 0);
    worldUv(geo);
    add(new THREE.Mesh(geo, outerMat));
  }

  const tex = facadeTextures(renderer);
  keep(tex.map);
  keep(tex.light);
  const night = { value: 1 };
  const wallMat = keep(facadeMaterial(tex.map, tex.light, night));
  const walls = newBuf();
  const roofs = newBuf();
  const lines: number[] = [];
  const PARAPET = 0.9;
  const ROOF_TONES = [0x3b3e44, 0x45474c, 0x34373c, 0x4b4945, 0x3f4247, 0x53555a];
  const parapetCol = C(0x6a6c70);
  const boxCol = C(0x5d6066), boxTop = C(0x4a4d52);

  const addRoof = (ring: Pt[], h: number) => {
    addCap(roofs, ring, h, C(ROOF_TONES[Math.floor(R() * ROOF_TONES.length)]).multiplyScalar(0.85 + R() * 0.3));
    addPlainWalls(roofs, ring, h, h + PARAPET, parapetCol);
    addOutline(lines, ring, h + PARAPET);
    // rooftop structures (stair/elevator penthouse, HVAC), aligned with the building's own grid
    const area = areaOf(ring);
    if (area < 220) return;
    const ang = gridAngle(ring);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of ring) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      z0 = Math.min(z0, z);
      z1 = Math.max(z1, z);
    }
    const want = area > 1500 ? 4 : area > 600 ? 3 : 1;
    for (let t = 0, placed = 0; t < 16 && placed < want; t++) {
      const big = placed === 0 && h > 18;
      const w = big ? 5 + R() * 5 : 1.8 + R() * 2.6, d = big ? 4 + R() * 4 : 1.4 + R() * 2;
      const bh = big ? 3 + R() * 1.6 : 1.1 + R() * 0.9;
      const x = x0 + R() * (x1 - x0), z = z0 + R() * (z1 - z0);
      if (!pointInPoly(x, z, ring) || closestOnPoly(x, z, ring).d < Math.hypot(w, d) / 2 + 1) continue;
      const rr = rectRing(x, z, w, d, ang);
      if (!rr.length) continue;
      addPlainWalls(roofs, rr, h, h + bh, boxCol);
      addCap(roofs, rr, h + bh, boxTop);
      placed++;
    }
  };

  for (const k of blocks) {
    const tone = C(BLOCK_TONES[Math.floor(R() * BLOCK_TONES.length)]).multiplyScalar(0.85 + R() * 0.3);
    const lit = [0.15, 0.3, 0.6, 0.6, 1, 1, 1.3][Math.floor(R() * 7)];
    const style = k.h > 45 ? (R() < 0.7 ? 1 : 0) : k.h > 28 && R() < 0.2 ? 1 : 0;
    addWalls(walls, k.ring, 0, k.h, tone, lit, Math.floor(R() * TILE), style);
    addRoof(k.ring, k.h);
  }

  const splits = new Map<string, Split>();
  for (const k of kits) {
    const { b, ring, h } = k;
    const lit = (b.people ?? 0) > 0 ? 2 : b.hero || b.door ? 1.6 : 1.1;
    const uOff = Math.floor(R() * TILE);
    const mat0 = b.conflict?.costar ?? b.material;
    const style = mat0 === "steel" || (mat0 === "concrete" && h > 45 && R() < 0.5) ? 1 : 0;
    if (b.conflict) {
      const costar = C(MATERIAL_COLOR[b.conflict.costar] ?? MATERIAL_COLOR.unknown);
      const city = C(MATERIAL_COLOR[b.conflict.city] ?? MATERIAL_COLOR.unknown);
      const lower = keep(facadeMaterial(tex.map, tex.light, night));
      const upper = keep(facadeMaterial(tex.map, tex.light, night));
      lower.color.copy(costar);
      upper.color.copy(city);
      const lb = newBuf(), ub = newBuf(), sb = newBuf();
      const mid = Math.round(h / 2 / 3.8) * 3.8 || h / 2;
      addWalls(lb, ring, 0, mid, C(0xffffff), lit, uOff, style);
      addWalls(ub, ring, mid, h, C(0xffffff), lit, uOff, style);
      addPlainWalls(sb, offsetRing(ring, 0.12), mid - 0.22, mid + 0.22, C(0xffffff));
      const seam = keep(new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }));
      for (const [buf, mat] of [[lb, lower], [ub, upper], [sb, seam]] as const) {
        add(new THREE.Mesh(keep(toGeometry(buf, { lit: mat !== seam })), mat));
      }
      splits.set(b.pid, { lower, upper, seam, costar, city, from: [costar.clone(), city.clone()], to: [costar.clone(), city.clone()], t0: -1, leaned: false });
    } else {
      addWalls(walls, ring, 0, h, C(MATERIAL_COLOR[b.material] ?? MATERIAL_COLOR.unknown), lit, uOff, style);
    }
    addRoof(ring, h);
  }
  add(new THREE.Mesh(keep(toGeometry(walls, { lit: true })), wallMat));
  add(new THREE.Mesh(keep(toGeometry(roofs, { lit: false, uv: false })), keep(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }))));
  {
    const lg = keep(new THREE.BufferGeometry());
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    add(new THREE.LineSegments(lg, keep(new THREE.LineBasicMaterial({ color: 0x9aa0aa, transparent: true, opacity: 0.45 }))));
  }

  // ================================================================== the hero's "?" (records disagree)
  const heroK = kits.find((k) => k.b.conflict && k.b.door) ?? kits.find((k) => k.b.conflict && k.b.hero) ?? null;
  const question = heroK ? add(questionSprite(9)) : null;
  if (question && heroK) {
    question.layers.set(LABEL_LAYER); // a marker for the player, not something the feed cameras see
    question.position.set(heroK.c[0], heroK.h + 6.5, heroK.c[1]);
    keep(question.material);
    keep(question.material.map!);
  }

  // ================================================================== retrofit orders (a fact from the city's list)
  // Hazard-striped bands (not a path): amber = an unfinished order on the city's list, red = past due.
  const ringPulse = { value: 1 };
  {
    const amber = newBuf(), red = newBuf();
    for (const k of kits) if (k.b.unfinished) addBand(k.b.past_due ? red : amber, k.ring, 1.8, 2.9, 0.07);
    for (const [buf, rgb] of [[amber, [1.0, 0.62, 0.12]], [red, [1.0, 0.16, 0.14]]] as const) {
      if (!buf.pos.length) continue;
      const m = keep(
        new THREE.ShaderMaterial({
          uniforms: { uColor: { value: new THREE.Color().setRGB(rgb[0], rgb[1], rgb[2]) }, uPulse: ringPulse },
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
          side: THREE.DoubleSide,
          vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
          fragmentShader: /* glsl */ `
            uniform vec3 uColor; uniform float uPulse; varying vec2 vUv;
            void main(){
              float s = smoothstep(0.45, 0.55, fract((vUv.x + vUv.y * 1.1) / 1.6));
              float edge = smoothstep(0.0, 0.12, vUv.y) * (1.0 - smoothstep(0.88, 1.0, vUv.y));
              float rim = 1.0 - smoothstep(0.0, 0.2, min(vUv.y, 1.0 - vUv.y));
              float a = (mix(0.12, 0.85, s) * edge + rim * 0.5) * uPulse;
              gl_FragColor = vec4(uColor * a, a);
            }`,
        }),
      );
      add(new THREE.Mesh(keep(toGeometry(buf, { lit: false })), m)).renderOrder = 1;
    }
  }

  // ================================================================== doors
  const doorMat = keep(new THREE.MeshBasicMaterial({ color: 0xffc27a }));
  const frameMat = keep(new THREE.MeshLambertMaterial({ color: 0x3a3631, emissive: 0x6a4618 }));
  const doorGeo = keep(new THREE.PlaneGeometry(2.2, 2.9));
  const jambGeo = keep(new THREE.BoxGeometry(0.28, 3.3, 0.35));
  const lintelGeo = keep(new THREE.BoxGeometry(3.0, 0.32, 0.4));
  const canopyGeo = keep(new THREE.BoxGeometry(3.6, 0.14, 1.4));
  const doorLights: THREE.PointLight[] = [];
  const doorLabels: THREE.Sprite[] = [];
  /** A group at (x, z) whose local +z is the outward normal for a bearing `facing` (deg clockwise from north). */
  const facingGroup = (x: number, z: number, facing: number) => {
    const grp = new THREE.Group();
    grp.position.set(x, 0, z);
    grp.rotation.y = Math.PI - (facing * Math.PI) / 180;
    return grp;
  };
  for (const k of kits) {
    const d = k.b.door;
    if (!d) continue;
    const grp = add(facingGroup(d.x, d.z, d.facing));
    const wallZ = -0.95; // the door point is ~1 m outside the wall
    const glow = new THREE.Mesh(doorGeo, doorMat);
    glow.position.set(0, 1.45, wallZ + 0.03);
    const jl = new THREE.Mesh(jambGeo, frameMat);
    jl.position.set(-1.25, 1.65, wallZ + 0.1);
    const jr = jl.clone();
    jr.position.x = 1.25;
    const li = new THREE.Mesh(lintelGeo, frameMat);
    li.position.set(0, 3.3, wallZ + 0.12);
    const ca = new THREE.Mesh(canopyGeo, frameMat);
    ca.position.set(0, 3.7, wallZ + 0.6);
    const pl = new THREE.PointLight(0xffb066, 40, 16, 2);
    pl.position.set(0, 2.9, 0.9);
    doorLights.push(pl);
    const label = labelSprite(k.b.label, 1.4, { depthTest: false });
    label.renderOrder = 15;
    label.layers.set(LABEL_LAYER);
    label.position.set(0, 4.5, 0.6); // just above the canopy
    label.userData.aspect = label.scale.x / label.scale.y;
    doorLabels.push(label);
    keep(label.material);
    keep(label.material.map!);
    grp.add(glow, jl, jr, li, ca, pl, label);
  }

  // ================================================================== barricade
  const plankGeo = keep(new THREE.BoxGeometry(3.3, 0.28, 0.09));
  const plankMat = keep(new THREE.MeshLambertMaterial({ color: 0x8a6440, emissive: 0x1a1006 }));
  let barricade: THREE.Group | null = null;
  const setBarricade = (pid: string | null) => {
    if (barricade) {
      scene.remove(barricade);
      barricade = null;
    }
    if (!pid) return;
    const k = kitOf.get(pid);
    if (!k) return;
    let grp: THREE.Group;
    let wallZ: number;
    if (k.b.door) {
      grp = facingGroup(k.b.door.x, k.b.door.z, k.b.door.facing);
      wallZ = -0.95;
    } else {
      // the edge the player walked up to (else the edge nearest the centre)
      const from: Pt = Number.isFinite(ctx.player.x) ? [ctx.player.x, ctx.player.z] : k.c;
      const { p } = closestOnPoly(from[0], from[1], k.ring);
      let nx = from[0] - p[0], nz = from[1] - p[1];
      const l = Math.hypot(nx, nz);
      if (l < 0.01) {
        nx = p[0] - k.c[0];
        nz = p[1] - k.c[1];
      }
      const facing = (Math.atan2(nx, -nz) * 180) / Math.PI;
      grp = facingGroup(p[0], p[1], facing);
      wallZ = 0;
    }
    const tilts = [0.22, -0.18, 0.12, -0.25, 0.05];
    tilts.forEach((t, i) => {
      const m = new THREE.Mesh(plankGeo, plankMat);
      m.position.set((i % 2 ? 0.15 : -0.12), 0.55 + i * 0.62, wallZ + 0.22 + (i % 2) * 0.08);
      m.rotation.z = t;
      grp.add(m);
    });
    barricade = grp;
    scene.add(grp);
  };

  // ================================================================== beacon
  const beamU = { uColor: { value: new THREE.Color().setRGB(1.0, 0.7, 0.32) }, uAlpha: { value: 0 }, uTime: { value: 0 } };
  const beamMat = keep(
    new THREE.ShaderMaterial({
      uniforms: beamU,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying float vRim;
        void main(){
          vUv = uv;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vec3 n = normalize(normalMatrix * normal);
          vRim = abs(dot(n, normalize(-mv.xyz)));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uAlpha; uniform float uTime;
        varying vec2 vUv; varying float vRim;
        void main(){
          float fall = pow(1.0 - vUv.y, 1.3);
          float ripple = 0.8 + 0.2 * sin(uTime * 2.4 - vUv.y * 60.0);
          float a = vRim * vRim * fall * ripple * uAlpha;
          gl_FragColor = vec4(uColor * a, a);
        }`,
    }),
  );
  const BEAM_H = 420;
  const beamInner = keep(new THREE.CylinderGeometry(2.4, 3.2, BEAM_H, 24, 1, true));
  const beamOuter = keep(new THREE.CylinderGeometry(7, 9, BEAM_H, 24, 1, true));
  const beacon = new THREE.Group();
  beacon.add(new THREE.Mesh(beamInner, beamMat), new THREE.Mesh(beamOuter, beamMat));
  beacon.children.forEach((m) => (m.renderOrder = 3));
  add(beacon).visible = false;
  let beaconLabel: THREE.Sprite | null = null;
  let beaconPid: string | null = null;
  const setBeacon = (pid: string | null) => {
    beaconPid = pid;
    if (beaconLabel) {
      beacon.remove(beaconLabel);
      beaconLabel.material.map?.dispose();
      beaconLabel.material.dispose();
      beaconLabel = null;
    }
    const k = pid ? kitOf.get(pid) : null;
    if (!k) return;
    beacon.position.set(k.c[0], 0, k.c[1]);
    beacon.children.slice(0, 2).forEach((m) => (m.position.y = k.h + BEAM_H / 2));
    beaconLabel = labelSprite(k.b.label, 4, { depthTest: false });
    beaconLabel.renderOrder = 20;
    beaconLabel.layers.set(LABEL_LAYER);
    beaconLabel.position.y = k.h + 12;
    beaconLabel.visible = false; // sized and faded in update()
    beacon.add(beaconLabel);
    beacon.visible = true;
  };

  // ================================================================== route
  const grid = buildGrid(ctx.colliders, bounds, 2, 1);
  const route = createRoute(ctx, grid);

  // ================================================================== streetlamps (along the sidewalks of the walkable area, nearest the hero first)
  const glow = keep(glowTexture(128));
  const focus: Pt[] = kits.filter((k) => k.b.door || k.b.hero).map((k) => k.c);
  const heroFocus: Pt = heroK ? (heroK.b.door ? [heroK.b.door.x, heroK.b.door.z] : heroK.c) : focus[0] ?? [0, 0];
  const lamps: Pt[] = [];
  {
    const MAX_LAMPS = 260;
    const inB = (x: number, z: number) => x > bounds.x0 + 2 && x < bounds.x1 - 2 && z > bounds.z0 + 2 && z < bounds.z1 - 2;
    const fd = (p: Pt) => Math.hypot(p[0] - heroFocus[0], p[1] - heroFocus[1]);
    const rings = [...kits.map((k) => ({ ring: k.ring, c: k.c })), ...blocks.map((k) => ({ ring: k.ring, c: centroid(k.ring) }))]
      .filter((r) => inB(r.c[0], r.c[1]) || fd(r.c) < 200)
      .sort((a, b) => fd(a.c) - fd(b.c));
    for (const { ring } of rings) {
      if (lamps.length >= MAX_LAMPS) break;
      const o = offsetRing(ring, 3.4);
      for (let i = 0; i < o.length && lamps.length < MAX_LAMPS; i++) {
        const a = o[i], b = o[(i + 1) % o.length];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let s = 9; s < L - 4; s += 26) {
          const p: Pt = [a[0] + ((b[0] - a[0]) * s) / L, a[1] + ((b[1] - a[1]) * s) / L];
          if (!inB(p[0], p[1]) || !walkableAt(grid, p[0], p[1])) continue;
          if (lamps.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 18)) continue;
          lamps.push(p);
        }
      }
    }
  }
  const POLE_H = 6.6;
  const poleGeo = keep(new THREE.CylinderGeometry(0.08, 0.12, POLE_H, 6));
  poleGeo.translate(0, POLE_H / 2, 0);
  const headGeo = keep(new THREE.BoxGeometry(0.42, 0.2, 0.42));
  headGeo.translate(0, POLE_H + 0.05, 0);
  const poolGeo = keep(new THREE.PlaneGeometry(15, 15));
  poolGeo.rotateX(-Math.PI / 2);
  poolGeo.translate(0, 0.05, 0);
  const headMat = keep(new THREE.MeshBasicMaterial({ color: 0xffd7a0 }));
  const poolMat = keep(new THREE.MeshBasicMaterial({ map: glow, color: 0xff9a4a, transparent: true, opacity: 0.32, blending: THREE.AdditiveBlending, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
  const haloMat = keep(new THREE.PointsMaterial({ map: glow, color: 0xffc078, size: 3.2, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true }));
  if (lamps.length) {
    const poles = add(new THREE.InstancedMesh(poleGeo, keep(new THREE.MeshLambertMaterial({ color: 0x30343b })), lamps.length));
    const heads = add(new THREE.InstancedMesh(headGeo, headMat, lamps.length));
    const pools = add(new THREE.InstancedMesh(poolGeo, poolMat, lamps.length));
    const m = new THREE.Matrix4();
    lamps.forEach(([x, z], i) => {
      m.makeTranslation(x, 0, z);
      poles.setMatrixAt(i, m);
      heads.setMatrixAt(i, m);
      pools.setMatrixAt(i, m);
    });
    for (const im of [poles, heads, pools]) {
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
    }
    const hg = keep(new THREE.BufferGeometry());
    hg.setAttribute("position", new THREE.Float32BufferAttribute(lamps.flatMap(([x, z]) => [x, POLE_H + 0.1, z]), 3));
    add(new THREE.Points(hg, haloMat));
  }
  const lampLights: THREE.PointLight[] = [];
  [...lamps]
    .sort((a, b) => Math.hypot(a[0] - heroFocus[0], a[1] - heroFocus[1]) - Math.hypot(b[0] - heroFocus[0], b[1] - heroFocus[1]))
    .slice(0, 6)
    .forEach(([x, z]) => {
      const l = add(new THREE.PointLight(0xffa860, 60, 26, 2));
      l.position.set(x, POLE_H - 0.3, z);
      lampLights.push(l);
    });

  // ================================================================== fx:crack (flash + dust, PG)
  const dust = keep(dustTexture());
  type Crack = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; pts: THREE.Points; pmat: THREE.PointsMaterial; vel: Float32Array; t: number };
  const cracks: Crack[] = [];
  const crack = (pid: string) => {
    const k = kitOf.get(pid);
    if (!k) return;
    const buf = newBuf();
    const ring = offsetRing(k.ring, 0.15);
    addPlainWalls(buf, ring, 0, k.h + 0.3, C(0xffffff));
    addCap(buf, ring, k.h + PARAPET + 0.05, C(0xffffff));
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd0c0, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(toGeometry(buf, { lit: false }), mat);
    const N = 220;
    const pos = new Float32Array(N * 3), vel = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const e = Math.floor(R() * k.ring.length);
      const a = k.ring[e], b = k.ring[(e + 1) % k.ring.length];
      const t = R();
      const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
      const ox = x - k.c[0], oz = z - k.c[1], ol = Math.hypot(ox, oz) || 1;
      pos.set([x, R() * Math.min(k.h, 30) * (R() < 0.7 ? 0.25 : 1), z], i * 3);
      const sp = 2 + R() * 6;
      vel.set([(ox / ol) * sp + (R() - 0.5) * 2, 0.5 + R() * 2.5, (oz / ol) * sp + (R() - 0.5) * 2], i * 3);
    }
    const pg = new THREE.BufferGeometry();
    pg.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const pmat = new THREE.PointsMaterial({ map: dust, color: 0xb9ab98, size: 7, transparent: true, opacity: 0.8, depthWrite: false, sizeAttenuation: true });
    const pts = new THREE.Points(pg, pmat);
    pts.frustumCulled = false;
    scene.add(mesh, pts);
    cracks.push({ mesh, mat, pts, pmat, vel, t: 0 });
  };

  // ================================================================== bus
  offs.push(ctx.bus.on("world:beacon", (e) => setBeacon(e.pid)));
  offs.push(ctx.bus.on("world:route", (e) => route.set(e.pts)));
  offs.push(ctx.bus.on("world:barricade", (e) => setBarricade(e.pid)));
  offs.push(ctx.bus.on("fx:crack", (e) => crack(e.pid)));
  offs.push(
    ctx.bus.on("world:lean", (e) => {
      const s = splits.get(e.pid);
      if (!s) return;
      const target = e.material ? C(MATERIAL_COLOR[e.material as Material] ?? MATERIAL_COLOR.unknown) : null;
      const to: [THREE.Color, THREE.Color] = target ? [target, target.clone()] : [s.costar.clone(), s.city.clone()];
      if (to[0].equals(s.to[0]) && to[1].equals(s.to[1])) return;
      s.from = [s.lower.color.clone(), s.upper.color.clone()];
      s.to = to;
      s.t0 = ctx.time;
      s.leaned = !!target;
    }),
  );

  // ================================================================== frame
  const tmpC = new THREE.Color();
  const tmpV = new THREE.Vector3();
  return {
    update(dt) {
      const t = ctx.time;
      const dawn = Math.max(0, Math.min(1, ctx.dawn));
      const day = Math.max(0, Math.min(1, ctx.day ?? 0));
      const lit = Math.max(dawn, day); // how much the night is gone (lamps, stars, fog distance)
      const cam = ctx.camera.position;
      sky.position.copy(cam);

      // sky + fog + light
      skyU.uTop.value.copy(NIGHT.top).lerp(DAWN.top, dawn).lerp(DAY.top, day);
      skyU.uMid.value.copy(NIGHT.mid).lerp(DAWN.mid, dawn).lerp(DAY.mid, day);
      skyU.uLow.value.copy(NIGHT.low).lerp(DAWN.low, dawn).lerp(DAY.low, day);
      skyU.uStars.value = 1 - lit;
      fog.color.copy(NIGHT.fog).lerp(DAWN.fog, dawn).lerp(DAY.fog, day);
      (scene.background as THREE.Color).copy(fog.color);
      const lift = Math.max(0, cam.y - 20);
      fog.near = lerp(40, 160, lit) + lift * 1.3;
      fog.far = lerp(220, 900, lit) + lift * 3.6 + day * 300;
      hemi.color.copy(NIGHT.hemiSky).lerp(DAWN.hemiSky, dawn).lerp(DAY.hemiSky, day);
      hemi.groundColor.copy(NIGHT.hemiGround).lerp(DAWN.hemiGround, dawn).lerp(DAY.hemiGround, day);
      hemi.intensity = lerp(lerp(2.0, 2.4, dawn), 2.6, day);
      moon.color.copy(NIGHT.moon).lerp(DAWN.moon, dawn).lerp(DAY.moon, day);
      moon.intensity = lerp(lerp(1.8, 2.6, dawn), 3.0, day);
      moon.position.set(lerp(lerp(-160, 320, dawn), 120, day) + cam.x, lerp(lerp(260, 140, dawn), 420, day), lerp(lerp(-220, -60, dawn), -140, day) + cam.z);
      moonTarget.position.set(cam.x, 0, cam.z);
      for (const m of groundMats) m.emissive.copy(groundTint.night).lerp(groundTint.dawn, lit * 0.85);
      night.value = 1 - lit * 0.9;

      // lamps + doors fade at dawn
      const lampOn = 1 - lit;
      poolMat.opacity = 0.32 * lampOn;
      haloMat.opacity = 0.85 * lampOn;
      headMat.color.setHex(0xffd7a0).lerp(tmpC.setHex(0x5a5d63), lit);
      for (const l of lampLights) l.intensity = 60 * lampOn;
      for (const l of doorLights) l.intensity = 40 * (1 - lit * 0.7);
      // name labels: never bigger than LABEL_MAX_PX on screen; hidden during the director's flyover
      const viewH = renderer.domElement.clientHeight || 900;
      const perPx = (2 * Math.tan((ctx.camera.fov * Math.PI) / 360)) / viewH; // world metres per px at 1 m
      const flyover = ctx.cameraOwner === "director";
      for (const lb of doorLabels) {
        const d = lb.getWorldPosition(tmpV).distanceTo(cam);
        // at the door itself the HUD's "go inside" prompt names the building; the label steps aside
        const fade = THREE.MathUtils.smoothstep(d, 10, 15);
        lb.material.opacity = fade;
        lb.visible = !flyover && d < 80 && fade > 0.01;
        // close up it sits in front of its own wall, so draw it on top; farther out, buildings hide it
        lb.material.depthTest = d > 30;
        const h = Math.min(1.4, LABEL_MAX_PX * perPx * d);
        lb.scale.set((h * lb.userData.aspect) || h * 4, h, 1);
      }

      // record conflicts: seam pulse + lean tween
      for (const s of splits.values()) {
        if (s.t0 >= 0) {
          const k = Math.min(1, (t - s.t0) / 1.5);
          const e = k * k * (3 - 2 * k);
          s.lower.color.copy(s.from[0]).lerp(s.to[0], e);
          s.upper.color.copy(s.from[1]).lerp(s.to[1], e);
          if (k >= 1) s.t0 = -1;
        }
        const target = s.leaned ? 0 : 0.35 + 0.25 * Math.sin(t * 2.2);
        s.seam.opacity += (target - s.seam.opacity) * Math.min(1, dt * 3);
      }
      if (question && heroK) {
        const s = splits.get(heroK.b.pid);
        question.visible = !s?.leaned;
        question.position.y = heroK.h + 6.5 + Math.sin(t * 1.6) * 0.6;
      }

      // retrofit rings pulse
      ringPulse.value = (0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.6))) * (1 - dawn * 0.5);

      // beacon
      beamU.uTime.value = t;
      const bTarget = beaconPid ? 1 - dawn * 0.6 : 0;
      beamU.uAlpha.value += (bTarget - beamU.uAlpha.value) * Math.min(1, dt * 3);
      if (!beaconPid && beamU.uAlpha.value < 0.01) beacon.visible = false;
      if (beaconLabel && beaconPid) {
        // constant ~LABEL_MAX_PX on screen at any distance; fades out within ~25 m of the building (the door label
        // serves up close)
        const lp = beaconLabel.getWorldPosition(tmpV);
        const d = lp.distanceTo(cam);
        const hgt = LABEL_MAX_PX * perPx * d;
        const img = beaconLabel.material.map?.image as { width: number; height: number } | undefined;
        beaconLabel.scale.set((hgt * (img?.width ?? 4)) / (img?.height ?? 1), hgt, 1);
        const kb = kitOf.get(beaconPid);
        const near = kb ? (pointInPoly(cam.x, cam.z, kb.ring) ? 0 : closestOnPoly(cam.x, cam.z, kb.ring).d) : Infinity;
        const fade = THREE.MathUtils.smoothstep(near, 25, 42);
        beaconLabel.material.opacity = fade;
        beaconLabel.visible = !flyover && fade > 0.01;
      }

      route.update(dt);

      // cracks
      for (let i = cracks.length - 1; i >= 0; i--) {
        const c = cracks[i];
        c.t += dt;
        const flick = c.t < 0.6 ? (Math.sin(c.t * 60) > 0 ? 1 : 0.45) : 1;
        c.mat.opacity = Math.max(0, 1 - c.t / 1.4) * flick;
        c.mat.color.setHex(0xffffff).lerp(tmpC.setHex(0xff3a2a), Math.min(1, c.t / 0.7));
        c.mesh.visible = c.mat.opacity > 0.01;
        const p = c.pts.geometry.getAttribute("position") as THREE.BufferAttribute;
        const a = p.array as Float32Array;
        for (let j = 0; j < a.length; j += 3) {
          a[j] += c.vel[j] * dt;
          a[j + 1] = Math.max(0.3, a[j + 1] + c.vel[j + 1] * dt);
          a[j + 2] += c.vel[j + 2] * dt;
          c.vel[j] *= 1 - dt * 0.6;
          c.vel[j + 2] *= 1 - dt * 0.6;
        }
        p.needsUpdate = true;
        c.pmat.size = 7 + c.t * 4;
        c.pmat.opacity = 0.8 * Math.max(0, 1 - c.t / 4);
        if (c.t > 4) {
          scene.remove(c.mesh, c.pts);
          c.mesh.geometry.dispose();
          c.mat.dispose();
          c.pts.geometry.dispose();
          c.pmat.dispose();
          cracks.splice(i, 1);
        }
      }
    },
    dispose() {
      alive = false;
      ctx.camera.layers.disable(LABEL_LAYER);
      offs.forEach((f) => f());
      setBarricade(null);
      setBeacon(null);
      route.dispose();
      for (const c of cracks) {
        scene.remove(c.mesh, c.pts);
        c.mesh.geometry.dispose();
        c.mat.dispose();
        c.pts.geometry.dispose();
        c.pmat.dispose();
      }
      for (const o of objs) scene.remove(o);
      for (const d of trash) d.dispose();
      scene.fog = prevFog;
      scene.background = prevBg;
    },
  };
}

