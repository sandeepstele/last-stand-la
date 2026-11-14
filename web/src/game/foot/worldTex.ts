// OWNER: builder C (world). Procedural textures: facades (one shared window grid), labels, glows, the stub ground.
// Everything is drawn once at startup; nothing here reads licensed data.

import * as THREE from "three";
import type { Pt } from "./engine";

/** Facade tile: 16 bays x 16 floors. A bay is BAY_M wide, a floor FLOOR_M tall (UVs are in bays/floors). */
export const BAY_M = 3;
export const TILE = 16;

/** Small deterministic PRNG so the city looks the same every load. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Window rectangle inside one cell, in cell fractions measured from the cell's bottom-left. */
const WIN = { u0: 0.16, u1: 0.84, v0: 0.22, v1: 0.86 };

/**
 * The facade albedo (sRGB, light grey so vertex colours tint it) and the window-light map (linear data):
 *   R = warm windows lit in every building (sparse), G = extra warm windows lit only in busy buildings, B = cold windows.
 * The shader picks how much of R/G/B to show per building (attribute `lit`), so one texture serves the whole city.
 */
export function facadeTextures(renderer: THREE.WebGLRenderer): { map: THREE.CanvasTexture; light: THREE.DataTexture } {
  const r = rng(7);
  const N = 1024;
  const cell = N / TILE;
  const shop: ("glass" | "shutter")[] = [];
  const [c, g] = canvas(N, N);
  // wall
  g.fillStyle = "#c8c5bf";
  g.fillRect(0, 0, N, N);
  for (let i = 0; i < 2600; i++) {
    const v = 175 + Math.floor(r() * 50);
    g.fillStyle = `rgba(${v},${v - 3},${v - 8},0.35)`;
    g.fillRect(r() * N, r() * N, 2 + r() * 10, 2 + r() * 10);
  }
  for (let f = 0; f < TILE; f++) {
    const yTop = N - (f + 1) * cell; // canvas y of this floor's top edge (flipY: v up = canvas up)
    // floor slab band
    g.fillStyle = "#a9a59e";
    g.fillRect(0, yTop + cell - 5, N, 5);
    g.fillStyle = "rgba(0,0,0,0.10)";
    g.fillRect(0, yTop + cell - 7, N, 2);
    for (let i = 0; i < TILE; i++) {
      if (f === 0) {
        // street level: shopfront glass under a sign band, or a roll-down shutter
        shop[i] = r() < 0.38 ? "shutter" : "glass";
        const x0 = i * cell + 0.05 * cell, x1 = i * cell + 0.95 * cell;
        const y0 = yTop + 0.2 * cell, y1 = yTop + 0.95 * cell;
        g.fillStyle = "#4d4a45";
        g.fillRect(i * cell, yTop + 0.04 * cell, cell, 0.14 * cell);
        g.fillStyle = "#2f2d2a";
        g.fillRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4);
        if (shop[i] === "shutter") {
          g.fillStyle = "#7c7e81";
          g.fillRect(x0, y0, x1 - x0, y1 - y0);
          g.fillStyle = "rgba(0,0,0,0.25)";
          for (let y = y0; y < y1; y += 3) g.fillRect(x0, y, x1 - x0, 1);
        } else {
          const gr = g.createLinearGradient(0, y0, 0, y1);
          gr.addColorStop(0, "#2c3440");
          gr.addColorStop(1, "#11151b");
          g.fillStyle = gr;
          g.fillRect(x0, y0, x1 - x0, y1 - y0);
          g.fillStyle = "#3a3936";
          g.fillRect((x0 + x1) / 2 - 1.5, y0, 3, y1 - y0);
        }
        continue;
      }
      const x0 = i * cell + WIN.u0 * cell, x1 = i * cell + WIN.u1 * cell;
      const y0 = yTop + (1 - WIN.v1) * cell, y1 = yTop + (1 - WIN.v0) * cell;
      // frame
      g.fillStyle = "#8d8d8b";
      g.fillRect(x0 - 2, y0 - 2, x1 - x0 + 4, y1 - y0 + 4);
      // glass: dark, a faint sky reflection, sometimes blinds
      const gr = g.createLinearGradient(0, y0, 0, y1);
      const k = r();
      gr.addColorStop(0, k < 0.15 ? "#5b5e63" : "#3a4350");
      gr.addColorStop(1, k < 0.15 ? "#44474b" : "#161b22");
      g.fillStyle = gr;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      // mullion + transom
      g.fillStyle = "#6f7072";
      g.fillRect((x0 + x1) / 2 - 1.5, y0, 3, y1 - y0);
      g.fillRect(x0, y0 + (y1 - y0) * 0.28, x1 - x0, 2);
      // sill
      g.fillStyle = "#d9d6cf";
      g.fillRect(x0 - 4, y1 + 2, x1 - x0 + 8, 3);
    }
  }
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.anisotropy = renderer.capabilities.getMaxAnisotropy();

  // window light (linear data), half resolution
  const M = 512;
  const mc = M / TILE;
  const data = new Uint8Array(M * M * 4);
  for (let f = 0; f < TILE; f++) {
    for (let i = 0; i < TILE; i++) {
      const p = r();
      const store = f === 0;
      if (store && shop[i] === "shutter") continue;
      const set = store ? (p < 0.3 ? 0 : p < 0.55 ? 1 : p < 0.62 ? 2 : -1) : p < 0.2 ? 0 : p < 0.52 ? 1 : p < 0.57 ? 2 : -1; // R sparse, G busy-only, B cold, else dark
      if (set < 0) continue;
      const bright = 0.55 + r() * 0.45;
      const blinds = !store && r() < 0.3;
      const half = !store && r() < 0.2 ? (r() < 0.5 ? 1 : 2) : 0; // one pane only
      const w = store ? { u0: 0.05, u1: 0.95, v0: 0.05, v1: 0.8 } : WIN;
      const x0 = Math.round(i * mc + w.u0 * mc), x1 = Math.round(i * mc + w.u1 * mc);
      const y0 = Math.round(f * mc + w.v0 * mc), y1 = Math.round(f * mc + w.v1 * mc); // DataTexture rows run bottom-up
      const mid = (x0 + x1) / 2;
      for (let y = y0; y < y1; y++) {
        const t = (y - y0) / Math.max(1, y1 - y0);
        let v = bright * (0.75 + 0.25 * t); // ceiling light: brighter at the top
        if (blinds && Math.floor(y / 2) % 2 === 0) v *= 0.55;
        for (let x = x0; x < x1; x++) {
          if (Math.abs(x - mid) < 0.6) continue; // mullion
          if ((half === 1 && x > mid) || (half === 2 && x < mid)) continue;
          data[(y * M + x) * 4 + set] = Math.round(255 * v);
        }
      }
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const light = new THREE.DataTexture(data, M, M, THREE.RGBAFormat, THREE.UnsignedByteType);
  light.colorSpace = THREE.NoColorSpace;
  light.wrapS = light.wrapT = THREE.RepeatWrapping;
  light.magFilter = THREE.LinearFilter;
  light.minFilter = THREE.LinearMipmapLinearFilter;
  light.generateMipmaps = true;
  light.anisotropy = renderer.capabilities.getMaxAnisotropy();
  light.needsUpdate = true;
  return { map, light };
}

/** A soft radial glow (white centre to transparent), for light pools, dust and halos. */
export function glowTexture(size = 128, hard = 0): THREE.CanvasTexture {
  const [c, g] = canvas(size, size);
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, "rgba(255,255,255,1)");
  gr.addColorStop(Math.min(0.9, 0.25 + hard), "rgba(255,255,255,0.55)");
  gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A dusty puff: a lumpy soft blob. */
export function dustTexture(): THREE.CanvasTexture {
  const r = rng(11);
  const S = 128;
  const [c, g] = canvas(S, S);
  for (let i = 0; i < 9; i++) {
    const x = S / 2 + (r() - 0.5) * S * 0.35, y = S / 2 + (r() - 0.5) * S * 0.35, rad = S * (0.18 + r() * 0.2);
    const gr = g.createRadialGradient(x, y, 0, x, y, rad);
    gr.addColorStop(0, "rgba(255,255,255,0.45)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A text label as a sprite. heightM = world height of the sprite; it keeps the text's aspect. */
export function labelSprite(text: string, heightM: number, opts: { color?: string; border?: string; depthTest?: boolean } = {}): THREE.Sprite {
  const font = "600 64px ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif";
  const [, m] = canvas(8, 8);
  m.font = font;
  const tw = Math.ceil(m.measureText(text).width);
  const H = 112;
  const W = Math.max(H, tw + 72);
  const [c, g] = canvas(W, H);
  g.font = font;
  const rad = 22;
  g.beginPath();
  g.moveTo(rad, 6);
  g.arcTo(W - 6, 6, W - 6, H - 6, rad);
  g.arcTo(W - 6, H - 6, 6, H - 6, rad);
  g.arcTo(6, H - 6, 6, 6, rad);
  g.arcTo(6, 6, W - 6, 6, rad);
  g.closePath();
  g.fillStyle = "rgba(8,12,22,0.78)";
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = opts.border ?? "#f5a524";
  g.stroke();
  g.fillStyle = opts.color ?? "#ffe8bf";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, W / 2, H / 2 + 3);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: opts.depthTest ?? true, depthWrite: false, fog: false });
  const s = new THREE.Sprite(mat);
  s.scale.set((heightM * W) / H, heightM, 1);
  return s;
}

/** The "records disagree" marker: an amber "?" in a ring. */
export function questionSprite(sizeM: number): THREE.Sprite {
  const S = 256;
  const [c, g] = canvas(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S / 2);
  gr.addColorStop(0, "rgba(245,165,36,0.35)");
  gr.addColorStop(1, "rgba(245,165,36,0)");
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  g.beginPath();
  g.arc(S / 2, S / 2, S * 0.33, 0, Math.PI * 2);
  g.fillStyle = "rgba(10,12,20,0.85)";
  g.fill();
  g.lineWidth = 12;
  g.strokeStyle = "#f5a524";
  g.stroke();
  g.fillStyle = "#ffd28a";
  g.font = "800 150px ui-sans-serif, system-ui, Helvetica, Arial, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("?", S / 2, S / 2 + 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  s.scale.set(sizeM, sizeM, 1);
  return s;
}

/**
 * Stub ground (no aerial mosaic): asphalt with sidewalks drawn around every building outline, so streets read as
 * streets whatever the grid's angle. Covers `bounds`; returns a texture for a plane over exactly that rectangle.
 */
export function streetTexture(bounds: { x0: number; z0: number; x1: number; z1: number }, outlines: Pt[][]): THREE.CanvasTexture {
  const r = rng(3);
  const wM = bounds.x1 - bounds.x0, hM = bounds.z1 - bounds.z0;
  const scale = Math.min(4, 2048 / Math.max(wM, hM)); // px per metre
  const W = Math.max(64, Math.round(wM * scale)), H = Math.max(64, Math.round(hM * scale));
  const [c, g] = canvas(W, H);
  g.fillStyle = "#4b4d52";
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    const v = 60 + Math.floor(r() * 30);
    g.fillStyle = `rgba(${v},${v + 2},${v + 6},0.5)`;
    g.fillRect(r() * W, r() * H, 1 + r() * 3, 1 + r() * 3);
  }
  const px = ([x, z]: Pt): [number, number] => [(x - bounds.x0) * scale, (z - bounds.z0) * scale];
  const path = (pts: Pt[]) => {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(...px(p)) : g.moveTo(...px(p))));
    g.closePath();
  };
  g.lineJoin = "round";
  // sidewalk (curb edge first, then the slab)
  for (const o of outlines) {
    path(o);
    g.lineWidth = 11 * scale;
    g.strokeStyle = "#9a9b9d";
    g.stroke();
  }
  for (const o of outlines) {
    path(o);
    g.lineWidth = 9.6 * scale;
    g.strokeStyle = "#78797c";
    g.stroke();
    g.fillStyle = "#5a5b5e";
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
