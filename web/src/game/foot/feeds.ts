// OWNER: builder B (horde + feeds). Live picture-in-picture: DRONE (top-down tactical) and CCTV (a corner camera).
//
// Each feed renders the scene into its own small render target (alternating frames, so each costs half a render),
// then every frame both targets are blitted into FEED_RECTS (engine.ts) with a tiny shader quad: the drone gets a
// night-vision lift, the CCTV a grey-green security look with scanlines and grain. Builder D draws the frames,
// labels and captions in the DOM; we draw only the image.
// `setOverride(slot, true)` = the DOM shows a real photo in that slot; we skip its live render.

import * as THREE from "three";
import { blocked } from "./collide";
import { FEED_RECTS, type FootCtx, type System } from "./engine";
import { DRONE_LAYER } from "./hordeLayers";

export type FeedSlot = "drone" | "cctv";
export type Feeds = System & {
  /** true = the DOM shows a photo in this slot; skip the live render. */
  setOverride(slot: FeedSlot, on: boolean): void;
  /** Short caption for the live view in each slot, e.g. "CCTV 3 · Building A, NE corner". */
  caption(slot: FeedSlot): string;
};

const DRONE_ALT = 70;
const DRONE_BACK = 12; // metres south of the player: a slight tilt, north stays up
const CCTV_R = 120, CCTV_MIN = 5, CCTV_H = 7, CCTV_OUT = 1.5, CCTV_FOV = 55;
const CCTV_HOLD_S = 2.5; // never switch faster than this unless the current camera lost the player
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

type Cam = { mx: number; mz: number; label: string; corner: string };

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float time;
uniform int mode; // 0 drone, 1 cctv, 2 no signal
uniform vec2 res;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 uv = vUv;
  vec2 q = uv - 0.5;
  vec3 c;
  if (mode == 2) {
    float n = hash(floor(uv * res / 2.0) + floor(time * 20.0));
    c = vec3(0.015 + n * 0.035);
  } else if (mode == 1) {
    // a little line jitter, like an old camera
    uv.x += (hash(vec2(floor(uv.y * res.y / 3.0), floor(time * 12.0))) - 0.5) * 0.0025;
    vec3 s = texture2D(map, uv).rgb;
    float l = dot(s, vec3(0.299, 0.587, 0.114));
    l = pow(max(l, 0.0), 0.75) * 1.9 + 0.012;
    c = vec3(l * 0.80, l, l * 0.84);
    c *= 0.86 + 0.14 * sin(uv.y * res.y * 3.14159);
    c += (hash(uv * res + fract(time) * 91.0) - 0.5) * 0.025;
    c *= 1.0 - dot(q, q) * 1.3;
  } else {
    vec3 s = texture2D(map, uv).rgb;
    c = pow(max(s, vec3(0.0)), vec3(0.85)) * 1.8 + vec3(0.004, 0.006, 0.008);
    c *= 1.0 - dot(q, q) * 0.7;
    // thin centre reticle
    vec2 px = abs(q * res);
    float ret = (px.x < 0.6 && px.y > 5.0 && px.y < 13.0) || (px.y < 0.6 && px.x > 5.0 && px.x < 13.0) ? 1.0 : 0.0;
    c = mix(c, vec3(0.95, 0.75, 0.3), ret * 0.7);
  }
  gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
  #include <colorspace_fragment>
}
`;

function compassOf(dx: number, dz: number): string {
  const deg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

export function createFeeds(ctx: FootCtx): Feeds {
  const { renderer, scene } = ctx;
  const P = ctx.player;
  const override: Record<FeedSlot, boolean> = { drone: false, cctv: false };

  // ------------------------------------------------------------------ cameras + targets
  const aspect = (r: { w: number; h: number }) => r.w / r.h;
  const droneCam = new THREE.PerspectiveCamera(50, aspect(FEED_RECTS.drone), 1, 900);
  droneCam.layers.enable(DRONE_LAYER);
  const cctvCam = new THREE.PerspectiveCamera(CCTV_FOV, aspect(FEED_RECTS.cctv), 0.5, 600);
  const pr = Math.min(2, renderer.getPixelRatio() || 1);
  const mkRT = (r: { w: number; h: number }) =>
    new THREE.WebGLRenderTarget(Math.round(r.w * pr), Math.round(r.h * pr), { type: THREE.HalfFloatType, depthBuffer: true });
  const rt = { drone: mkRT(FEED_RECTS.drone), cctv: mkRT(FEED_RECTS.cctv) };
  const ready = { drone: false, cctv: false };

  // the player's own marker on the drone layer: an amber arrow pointing where they face
  const arrowGeo = new THREE.BufferGeometry();
  arrowGeo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, -3.8, -2, 0, 2, 0, 0, 0.8, 0, 0, -3.8, 0, 0, 0.8, 2, 0, 2], 3));
  const ringGeo = new THREE.RingGeometry(2.6, 3.4, 24);
  ringGeo.rotateX(-Math.PI / 2);
  const youMat = new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const you = new THREE.Group();
  you.add(new THREE.Mesh(arrowGeo, youMat), new THREE.Mesh(ringGeo, youMat));
  you.traverse((o) => {
    o.layers.set(DRONE_LAYER);
    o.renderOrder = 60;
  });
  scene.add(you);

  // ------------------------------------------------------------------ blit quad
  const blitMat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: { map: { value: null }, time: { value: 0 }, mode: { value: 0 }, res: { value: new THREE.Vector2(256, 160) } },
    depthTest: false,
    depthWrite: false,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
  quad.frustumCulled = false;
  const blitScene = new THREE.Scene();
  blitScene.add(quad);
  const blitCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // ------------------------------------------------------------------ CCTV candidates: corners of kit buildings
  const cams: Cam[] = [];
  for (const c of ctx.colliders) {
    if (!c.pid) continue;
    const label = ctx.byPid.get(c.pid)?.label ?? "Building";
    const pts = c.pts;
    const n = pts.length;
    let ax = 0, az = 0;
    for (const [px, pz] of pts) {
      ax += px / n;
      az += pz / n;
    }
    for (let k = 0; k < n; k++) {
      const [px, pz] = pts[k];
      const [bx, bz] = pts[(k + n - 1) % n];
      const [nx, nz] = pts[(k + 1) % n];
      const e1x = px - bx, e1z = pz - bz, e2x = nx - px, e2z = nz - pz;
      const l1 = Math.hypot(e1x, e1z), l2 = Math.hypot(e2x, e2z);
      if (l1 < 2 || l2 < 2) continue; // jitter vertices on detailed outlines
      if (Math.abs(e1x * e2z - e1z * e2x) / (l1 * l2) < 0.42) continue; // nearly straight: not a corner (~25 deg)
      let ox = px - ax, oz = pz - az;
      const ol = Math.hypot(ox, oz) || 1;
      ox /= ol;
      oz /= ol;
      cams.push({ mx: px + ox * CCTV_OUT, mz: pz + oz * CCTV_OUT, label, corner: compassOf(ox, oz) });
    }
  }
  let cur: Cam | null = null;
  let curSince = -99;
  let pickT = 0;
  const look = new THREE.Vector3();
  const order: { c: Cam; d: number }[] = cams.map((c) => ({ c, d: 0 }));

  function pickCctv() {
    for (const o of order) o.d = Math.hypot(o.c.mx - P.x, o.c.mz - P.z);
    order.sort((a, b) => a.d - b.d);
    const sees = (c: Cam) => !blocked(c.mx, c.mz, P.x, P.z, ctx.colliders);
    let best: Cam | null = null;
    let bestD = Infinity;
    let tried = 0;
    for (const o of order) {
      if (o.d > CCTV_R || tried >= 18) break;
      if (o.d < CCTV_MIN) continue;
      tried++;
      if (sees(o.c)) {
        best = o.c;
        bestD = o.d;
        break;
      }
    }
    const curD = cur ? Math.hypot(cur.mx - P.x, cur.mz - P.z) : Infinity;
    const curOk = !!cur && curD <= CCTV_R + 10 && curD >= CCTV_MIN - 1 && sees(cur);
    let next = cur;
    if (!curOk) next = best;
    else if (best && best !== cur && ctx.time - curSince > CCTV_HOLD_S && bestD < curD * 0.6) next = best;
    if (next !== cur) {
      cur = next;
      curSince = ctx.time;
      if (cur) look.set(P.x, 1.2, P.z); // snap the pan on a cut
    }
  }

  // ------------------------------------------------------------------ per frame
  const droneAt = new THREE.Vector3(P.x, DRONE_ALT, P.z + DRONE_BACK);
  const size = new THREE.Vector2();
  let frame = 0;

  function update(dt: number) {
    const k = 1 - Math.exp(-dt * 3);
    droneAt.x += (P.x - droneAt.x) * k;
    droneAt.z += (P.z + DRONE_BACK - droneAt.z) * k;
    if (Math.abs(droneAt.x - P.x) > 80 || Math.abs(droneAt.z - P.z - DRONE_BACK) > 80) droneAt.set(P.x, DRONE_ALT, P.z + DRONE_BACK); // teleports
    droneCam.position.copy(droneAt);
    droneCam.lookAt(droneAt.x, 0, droneAt.z - DRONE_BACK);
    you.position.set(P.x, 0.8, P.z);
    you.rotation.y = -P.yaw;
    you.visible = true;

    pickT -= dt;
    if (pickT <= 0) {
      pickT = 0.25;
      pickCctv();
    }
    if (cur) {
      const kl = 1 - Math.exp(-dt * 5);
      look.x += (P.x - look.x) * kl;
      look.y = 1.2;
      look.z += (P.z - look.z) * kl;
      cctvCam.position.set(cur.mx, CCTV_H, cur.mz);
      cctvCam.lookAt(look);
    }
  }

  function renderInto(slot: FeedSlot, cam: THREE.Camera, clearFog: boolean) {
    const fog = scene.fog;
    let near = 0, far = 0, density = 0;
    if (clearFog && fog instanceof THREE.Fog) {
      near = fog.near;
      far = fog.far;
      fog.near = 250;
      fog.far = 900;
    } else if (clearFog && fog instanceof THREE.FogExp2) {
      density = fog.density;
      fog.density = density * 0.25;
    }
    renderer.setRenderTarget(rt[slot]);
    renderer.render(scene, cam);
    if (clearFog && fog instanceof THREE.Fog) {
      fog.near = near;
      fog.far = far;
    } else if (clearFog && fog instanceof THREE.FogExp2) fog.density = density;
    ready[slot] = true;
  }

  function blit(slot: FeedSlot, mode: number, W: number) {
    const r = FEED_RECTS[slot];
    const x = W - r.right - r.w;
    if (x < 0) return;
    renderer.setViewport(x, r.bottom, r.w, r.h);
    renderer.setScissor(x, r.bottom, r.w, r.h);
    blitMat.uniforms.map.value = rt[slot].texture;
    blitMat.uniforms.mode.value = mode;
    (blitMat.uniforms.res.value as THREE.Vector2).set(r.w, r.h);
    blitMat.uniforms.time.value = ctx.time;
    renderer.render(blitScene, blitCam);
  }

  function render() {
    // Not during the intro flyover (no HUD frames yet) or the dawn screen.
    if (ctx.cameraOwner !== "player" || ctx.dawn > 0.02) return;
    frame++;
    const drone = !override.drone, cctv = !override.cctv && !!cur;
    const prevTarget = renderer.getRenderTarget();
    if (drone && (frame % 2 === 0 || !ready.drone)) renderInto("drone", droneCam, true);
    if (cctv && (frame % 2 === 1 || !ready.cctv)) renderInto("cctv", cctvCam, false);
    renderer.setRenderTarget(prevTarget);
    renderer.getSize(size);
    renderer.setScissorTest(true);
    if (drone) blit("drone", 0, size.x);
    if (!override.cctv) blit("cctv", cur ? 1 : 2, size.x);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.setScissor(0, 0, size.x, size.y);
  }

  return {
    update,
    render,
    dispose() {
      scene.remove(you);
      arrowGeo.dispose();
      ringGeo.dispose();
      youMat.dispose();
      quad.geometry.dispose();
      blitMat.dispose();
      rt.drone.dispose();
      rt.cctv.dispose();
    },
    setOverride(slot, on) {
      override[slot] = on;
    },
    caption(slot) {
      if (slot === "drone") return `DRONE · ${DRONE_ALT} m above you · N up`;
      return cur ? `CCTV · ${cur.label} · ${cur.corner} corner` : "CCTV · no camera in range";
    },
  };
}
