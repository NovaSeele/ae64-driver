// useToast(): tiny global toast queue rendered by <ToastHost> (Toast.vue) in App.vue.
import { ref, shallowRef, watch } from 'vue';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';
/** A button on the toast (e.g. Hoàn tác); the toast closes when it is pressed. */
export interface ToastAction { label: string; run: () => void; /** Spoken name of the button when the label alone is not enough (screen readers). */ ariaLabel?: string }
export interface ToastItem { id: number; text: string; kind: ToastKind; action?: ToastAction; /** Full text for a toast whose text is clipped to its width. */ title?: string }

const items = shallowRef<ToastItem[]>([]);
let nextId = 1;

/**
 * Each toast's timer. It is held (cleared, with the time left kept) while the pointer is on the toast or focus is inside
 * it, so a toast with "Hoàn tác" cannot go away under the hand that reaches for it; it runs on with the time that was
 * left once both hold reasons are gone.
 */
interface Timer { left: number; until: number; handle: ReturnType<typeof setTimeout> | null; holds: Set<'hover' | 'focus'> }
const timers = new Map<number, Timer>();

function dismiss(id: number): void {
  const tm = timers.get(id);
  if (tm?.handle) clearTimeout(tm.handle);
  timers.delete(id);
  items.value = items.value.filter((x) => x.id !== id);
}

function run(id: number, tm: Timer): void {
  tm.until = Date.now() + tm.left;
  tm.handle = setTimeout(() => dismiss(id), tm.left);
}

function show(text: string, kind: ToastKind = 'info', ms = kind === 'error' ? 6000 : 3200, action?: ToastAction, title?: string): number {
  const id = nextId++;
  const next = [...items.value.filter((x) => x.text !== text), { id, text, kind, action, title }].slice(-4);
  // the toasts that went (same text replaced, or over four): their timers go too
  for (const old of items.value) if (!next.includes(old)) dismiss(old.id);
  items.value = next;
  const tm: Timer = { left: ms, until: 0, handle: null, holds: new Set() };
  timers.set(id, tm);
  run(id, tm);
  return id;
}

/** The pointer is on the toast, or focus is inside it: its timer stops, keeping the time left. */
function hold(id: number, why: 'hover' | 'focus'): void {
  const tm = timers.get(id);
  if (!tm) return;
  tm.holds.add(why);
  if (!tm.handle) return;
  clearTimeout(tm.handle);
  tm.handle = null;
  tm.left = Math.max(0, tm.until - Date.now());
}

/** One hold reason gone; with none left the timer runs on with the time that was left. */
function release(id: number, why: 'hover' | 'focus'): void {
  const tm = timers.get(id);
  if (!tm) return;
  tm.holds.delete(why);
  if (tm.holds.size || tm.handle) return;
  run(id, tm);
}

/** Bottom padding the page scroller needs while toasts are open (stack height + its 20 px bottom offset + 16 px; 0 when none). Published by Toast.vue. */
export const toastSafeTarget = ref(0);
/** Bumped on every publication of toastSafeTarget, even an unchanged value (revealAboveToast waits for the next one). */
export const toastSafeVersion = ref(0);

/**
 * Pad of the page scroller under the toasts. Never removes padding the user can see: when the target shrinks the pad
 * stays while it is on screen and shrinks as scrolling moves it out of view. `apply` receives each pad in px.
 */
export function createSafePad(scroller: () => HTMLElement | null, apply: (px: number) => void) {
  let pad = 0;
  let target = 0;
  let listening: HTMLElement | null = null; // the element the scroll listener is on (the scroller can be re-created)
  const set = (px: number): void => { pad = px; apply(px); };
  const onScroll = (): void => follow();
  const unlisten = (): void => {
    listening?.removeEventListener('scroll', onScroll);
    listening = null;
  };
  // Keep only the on-screen part of the pad (but never below the target); listen while it is above the target.
  function follow(): void {
    const el = scroller();
    if (el) {
      // The pad the current scrollTop still needs (removing more would clamp it, i.e. the page jumps); at the top it needs none.
      const inView = el.scrollTop > 0 ? Math.max(0, el.scrollTop + el.clientHeight - (el.scrollHeight - pad)) : 0;
      set(Math.max(target, Math.min(pad, inView)));
    } else set(target);
    if (pad <= target || listening !== el) unlisten();
    if (pad > target && el && !listening) {
      el.addEventListener('scroll', onScroll, { passive: true });
      listening = el;
    }
  }
  return {
    // Grow or shrink alike: a pad still on screen above the new target stays (a new toast never pulls the page either).
    setTarget(next: number): void {
      target = next;
      follow();
    },
    /** Route change: target at once. */
    reset(): void { unlisten(); set(target); },
    stop: unlisten,
  };
}

/**
 * Scroll `el` into view (nearest) once the toast's pad is in place: waits for the toast host's next publication of toastSafeTarget
 * (toastSafeVersion, after a ResizeObserver; capped at 500 ms), then one frame. Smooth unless the user prefers reduced motion; nothing scrolls if `el` is already clear.
 */
type Target = HTMLElement | null | undefined;
/** `target` may be a function, looked up after the wait, when the element can still render meanwhile. */
export async function revealAboveToast(target: Target | (() => Target)): Promise<void> {
  // Callers show the toast first, so a publication (new stack height) is always coming, even if a toast was already open.
  await new Promise<void>((resolve) => {
    const stop = watch(toastSafeVersion, done, { flush: 'sync' });
    const timer = setTimeout(done, 500);
    function done() { stop(); clearTimeout(timer); resolve(); }
  });
  if (typeof requestAnimationFrame === 'function') await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const el = typeof target === 'function' ? target() : target;
  if (!el || typeof el.scrollIntoView !== 'function') return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}

export function useToast() {
  return { items, show, dismiss, hold, release };
}
