// Keyboard + mouse for on-foot play. Pointer lock is optional: without it (or in headless tests),
// dragging with the mouse or the arrow keys turn the camera, so the game is always playable.

export type Input = {
  /** Keys currently held, by KeyboardEvent.code ("KeyW", "ShiftLeft", "Space", ...). */
  down: Set<string>;
  /** Keys pressed since the last frame (edge-triggered). Cleared by endFrame(). */
  pressed: Set<string>;
  /** Mouse movement since the last frame, in pixels. Cleared by endFrame(). */
  mouseDx: number;
  mouseDy: number;
  locked: boolean;
  /** Ask for pointer lock (must be called from a user gesture, e.g. a click). */
  lock(): void;
  unlock(): void;
  endFrame(): void;
  dispose(): void;
};

const GAME_KEYS = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space", "ShiftLeft", "ShiftRight", "KeyE", "KeyH", "KeyR", "KeyN", "KeyM", "Digit1", "Digit2", "Digit3", "Enter", "Escape"]);

export function createInput(el: HTMLElement): Input {
  const down = new Set<string>();
  const pressed = new Set<string>();
  let dragging = false;
  const inp: Input = {
    down,
    pressed,
    mouseDx: 0,
    mouseDy: 0,
    locked: false,
    lock() {
      try {
        const p = el.requestPointerLock?.() as unknown;
        if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {});
      } catch {
        /* headless or denied: drag-to-look still works */
      }
    },
    unlock() {
      if (document.pointerLockElement) document.exitPointerLock();
    },
    endFrame() {
      pressed.clear();
      inp.mouseDx = 0;
      inp.mouseDy = 0;
    },
    dispose() {
      window.removeEventListener("keydown", kd);
      window.removeEventListener("keyup", ku);
      window.removeEventListener("blur", blur);
      document.removeEventListener("pointerlockchange", plc);
      document.removeEventListener("mousemove", mm);
      el.removeEventListener("mousedown", md);
      window.removeEventListener("mouseup", mu);
    },
  };
  const typing = (e: Event) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  };
  const kd = (e: KeyboardEvent) => {
    if (typing(e)) return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (!down.has(e.code)) pressed.add(e.code);
    down.add(e.code);
  };
  const ku = (e: KeyboardEvent) => down.delete(e.code);
  const blur = () => down.clear();
  const plc = () => (inp.locked = document.pointerLockElement === el);
  const mm = (e: MouseEvent) => {
    if (inp.locked || dragging) {
      inp.mouseDx += e.movementX;
      inp.mouseDy += e.movementY;
    }
  };
  const md = (e: MouseEvent) => {
    if (e.button === 0) dragging = true;
  };
  const mu = () => (dragging = false);
  window.addEventListener("keydown", kd);
  window.addEventListener("keyup", ku);
  window.addEventListener("blur", blur);
  document.addEventListener("pointerlockchange", plc);
  document.addEventListener("mousemove", mm);
  el.addEventListener("mousedown", md);
  window.addEventListener("mouseup", mu);
  return inp;
}
