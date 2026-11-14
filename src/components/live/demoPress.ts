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

/** Keys a focused radio group (Auto/Pinned) moves its selection with. */
const NAV_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']);
/** Keys the focused travel graph uses to pan. */
const GRAPH_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape']);

const DOWN_MS = 300;
const BOTTOM_HOLD_MS = 60;
const UP_MS = 320;
const MAX_QUEUED = 2;
const BOTTOM_MM = 3.31;

/** One simulated stroke per tap: down, hold at the bottom while held (at least BOTTOM_HOLD_MS), up. */
interface Anim {
  phase: 'down' | 'bottom' | 'up'; start: number; mm: number;
  /** The PC key of the running stroke is still held. */
  held: boolean;
  /** Taps waiting for this key to be back at 0 mm; each flag is whether its PC key is still held. */
  queue: boolean[];
  /** The last keydown was dropped (queue full): its keyup must not release anything. */
  ignoreUp: boolean;
}

/**
 * Listens to window key events while attached. Every tap is one full stroke (300 ms down, 60 ms at the bottom or
 * until keyup, 320 ms up); taps arriving while the key still moves are queued (at most 2) and run one after another.
 */
export function attachDemoPress(mock: MockTransport): () => void {
  const anims = new Map<number, Anim>();
  let raf = 0;

  // Position (0…1) against time (0…1): velocity ramps linearly up over the first RAMP_K, stays constant, ramps down over the
  // last RAMP_K. The two ramps cover 12% of the distance each, so the middle reads evenly (actuation lands where it is set).
  const RAMP_K = 0.24 / 1.24;
  const V_MAX = 1.24;
  const ease = (k: number) => (k < RAMP_K ? V_MAX * k * k / (2 * RAMP_K)
    : k > 1 - RAMP_K ? 1 - V_MAX * (1 - k) * (1 - k) / (2 * RAMP_K)
      : 0.12 + V_MAX * (k - RAMP_K));

  let last = 0;

  /** Advances every stroke to `now`. Idempotent for the same `now`; an older `now` is ignored. */
  function advance(now: number) {
    if (now <= last) return;
    last = now;
    for (const [id, a] of anims) {
      if (a.phase === 'bottom' && !a.held && now - a.start >= BOTTOM_HOLD_MS) { a.phase = 'up'; a.start = now; }
      if (a.phase === 'down') {
        const k = Math.min(1, (now - a.start) / DOWN_MS);
        a.mm = k >= 1 ? BOTTOM_MM : BOTTOM_MM * ease(k);
        if (k >= 1) { a.phase = 'bottom'; a.start = now; }
      } else if (a.phase === 'up') {
        const k = Math.min(1, (now - a.start) / UP_MS);
        a.mm = k >= 1 ? 0 : BOTTOM_MM * (1 - ease(k));
      }
      mock.simulatePress(id, a.mm);
      if (a.phase === 'up' && a.mm === 0) {
        const next = a.queue.shift();
        if (next === undefined) anims.delete(id);
        else { a.phase = 'down'; a.start = now; a.held = next; }
      }
    }
  }

  function frame(now: number) {
    raf = 0;
    advance(now);
    if (anims.size) raf = requestAnimationFrame(frame);
  }

  function tap(id: number) {
    const a = anims.get(id);
    if (!a) {
      anims.set(id, { phase: 'down', start: performance.now(), mm: 0, held: true, queue: [], ignoreUp: false });
      if (!raf) raf = requestAnimationFrame(frame);
    } else if (a.queue.length < MAX_QUEUED) {
      a.queue.push(true);
      a.ignoreUp = false;
    } else {
      a.ignoreUp = true;
    }
  }

  function release(id: number) {
    const a = anims.get(id);
    if (!a) return;
    if (a.ignoreUp) a.ignoreUp = false;
    else if (a.queue.length) a.queue[a.queue.length - 1] = false;
    else a.held = false;
  }

  function typing(e: KeyboardEvent): boolean {
    const el = e.target as HTMLElement | null;
    // A focused tab keeps its arrow keys (the AE64 has arrows too, so they would otherwise drive the demo).
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable || !!el.closest('[role="dialog"], [role="tablist"]'));
  }

  function onDown(e: KeyboardEvent) {
    const id = keyIdForCode(e.code);
    if (id === undefined) return;
    const el = e.target as HTMLElement | null;
    const inTest = !!el?.closest?.('[data-keytest]');
    if (!inTest && typing(e)) return;
    // The focused travel graph pans with these keys (←/→/Esc are AE64 keys too); letters still simulate.
    if (GRAPH_KEYS.has(e.code) && el?.closest?.('canvas.graph')) return;
    // Tab on a focused control moves focus (the AE64 has a Tab key too); only Tab on the bare page simulates.
    if (!inTest && e.code === 'Tab' && el && el !== document.body && el !== document.documentElement) return;
    // Space/Enter on a focused control operates it (button, switch, radio…), as on real hardware; don't swallow it.
    if (!inTest && (e.code === 'Space' || e.code === 'Enter' || e.code === 'NumpadEnter') && el?.matches?.('button, [role="button"], [role="switch"], [role="radio"], [role="tab"], select')) return;
    // Enter on a focused link follows it, as on real hardware (DESIGN L §11.1); Space on a link is still simulated.
    if (!inTest && (e.code === 'Enter' || e.code === 'NumpadEnter') && el?.matches?.('a[href]')) return;
    // Arrows and Home/End move a radio group (Auto/Pinned); don't swallow them either.
    if (!inTest && NAV_KEYS.has(e.code) && el?.closest?.('[role="radiogroup"]')) return;
    // Leave shortcuts (Ctrl+Z…) alone: modifiers only count when pressed on their own.
    if ((e.ctrlKey && e.code !== 'ControlLeft') || (e.metaKey && e.code !== 'MetaLeft')) return;
    if (!inTest) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (!e.repeat) tap(id);
  }

  function onUp(e: KeyboardEvent) {
    const id = keyIdForCode(e.code);
    if (id === undefined || !anims.has(id)) return;
    const el = e.target as HTMLElement | null;
    const inTest = !!el?.closest?.('[data-keytest]');
    if (!inTest) {
      e.preventDefault();
      e.stopPropagation();
    }
    release(id);
  }

  function releaseAll() {
    for (const a of anims.values()) { a.held = false; a.queue.length = 0; a.ignoreUp = false; }
  }

  mock.setTravelTicker(advance);
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', releaseAll);
  return () => {
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', releaseAll);
    mock.setTravelTicker(null);
    cancelAnimationFrame(raf);
    for (const id of anims.keys()) mock.simulatePress(id, 0);
    anims.clear();
  };
}
