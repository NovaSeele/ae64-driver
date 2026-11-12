// useToast(): tiny global toast queue rendered by <ToastHost> (Toast.vue) in App.vue.
import { ref, shallowRef } from 'vue';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';
/** A button on the toast (e.g. Hoàn tác); the toast closes when it is pressed. */
export interface ToastAction { label: string; run: () => void; /** Spoken name of the button when the label alone is not enough (screen readers). */ ariaLabel?: string }
export interface ToastItem { id: number; text: string; kind: ToastKind; action?: ToastAction; /** Full text for a toast whose text is clipped to its width. */ title?: string }

const items = shallowRef<ToastItem[]>([]);
let nextId = 1;

function dismiss(id: number): void {
  items.value = items.value.filter((x) => x.id !== id);
}

function show(text: string, kind: ToastKind = 'info', ms = kind === 'error' ? 6000 : 3200, action?: ToastAction, title?: string): number {
  const id = nextId++;
  items.value = [...items.value.filter((x) => x.text !== text), { id, text, kind, action, title }].slice(-4);
  setTimeout(() => dismiss(id), ms);
  return id;
}

/** Bottom padding the page scroller needs while toasts are open (stack height + 16 px; 0 when none). Published by Toast.vue. */
export const toastSafeTarget = ref(0);

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

export function useToast() {
  return { items, show, dismiss };
}
