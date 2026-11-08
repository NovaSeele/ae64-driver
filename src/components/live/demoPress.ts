// Demo mode only: PC-keyboard presses drive MockTransport.simulatePress with smooth travel curves, so the
// live travel and calibration pages are usable without hardware.
import { PHYSICAL_KEYS } from '../../protocol';
import type { MockTransport } from '../../protocol';

/** KeyboardEvent.code for each physical key, in PHYSICAL_KEYS order (null = no PC equivalent, e.g. Fn). */
const CODES: (string | null)[] = [
  'Escape', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'Backspace',
  'Tab', 'KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight', 'Backslash',
  'CapsLock', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote', 'Enter',
  'ShiftLeft', 'KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash', 'ShiftRight', 'ArrowUp', 'Delete',
  'ControlLeft', 'MetaLeft', 'AltLeft', 'Space', 'AltRight', null, 'ArrowLeft', 'ArrowDown', 'ArrowRight',
];

const BY_CODE = new Map<string, number>();
CODES.forEach((code, id) => { if (code) BY_CODE.set(code, PHYSICAL_KEYS[id].id); });

/** PhysicalKey.id for a KeyboardEvent.code, if the AE64 has that key. */
export function keyIdForCode(code: string): number | undefined {
  return BY_CODE.get(code);
}

const PRESS_MS = 90;
const RELEASE_MS = 120;
const BOTTOM_MM = 3.31;

interface Anim { from: number; to: number; start: number; ms: number; mm: number }

/**
 * Listens to window key events while attached. Each held key eases to the bottom (~90 ms) and back up
 * on release (~120 ms); a key pressed again mid-release turns around from where it is.
 */
export function attachDemoPress(mock: MockTransport): () => void {
  const anims = new Map<number, Anim>();
  let raf = 0;

  const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

  function frame(now: number) {
    raf = 0;
    let moving = false;
    for (const [id, a] of anims) {
      const k = Math.min(1, (now - a.start) / a.ms);
      a.mm = k >= 1 ? a.to : a.from + (a.to - a.from) * ease(k);
      mock.simulatePress(id, a.mm);
      if (k < 1) moving = true;
      else if (a.to === 0) anims.delete(id);
    }
    if (moving) raf = requestAnimationFrame(frame);
  }

  function go(id: number, to: number) {
    const cur = anims.get(id)?.mm ?? 0;
    const ms = (to > cur ? PRESS_MS : RELEASE_MS) * (Math.abs(to - cur) / BOTTOM_MM);
    anims.set(id, { from: cur, to, start: performance.now(), ms: Math.max(ms, 1), mm: cur });
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function typing(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest('[role="dialog"]'));
  }

  function onDown(e: KeyboardEvent) {
    const id = keyIdForCode(e.code);
    if (id === undefined || typing(e)) return;
    // Leave shortcuts (Ctrl+Z…) alone: modifiers only count when pressed on their own.
    if ((e.ctrlKey && e.code !== 'ControlLeft') || (e.metaKey && e.code !== 'MetaLeft')) return;
    e.preventDefault();
    e.stopPropagation();
    if (!e.repeat) go(id, BOTTOM_MM);
  }

  function onUp(e: KeyboardEvent) {
    const id = keyIdForCode(e.code);
    if (id === undefined || !anims.has(id)) return;
    e.preventDefault();
    e.stopPropagation();
    go(id, 0);
  }

  function releaseAll() {
    for (const id of anims.keys()) go(id, 0);
  }

  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', releaseAll);
  return () => {
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', releaseAll);
    cancelAnimationFrame(raf);
    for (const id of anims.keys()) mock.simulatePress(id, 0);
    anims.clear();
  };
}
