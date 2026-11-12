// useToast(): tiny global toast queue rendered by <ToastHost> (Toast.vue) in App.vue.
import { shallowRef } from 'vue';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';
/** A button on the toast (e.g. Hoàn tác); the toast closes when it is pressed. */
export interface ToastAction { label: string; run: () => void }
export interface ToastItem { id: number; text: string; kind: ToastKind; action?: ToastAction }

const items = shallowRef<ToastItem[]>([]);
let nextId = 1;

function dismiss(id: number): void {
  items.value = items.value.filter((x) => x.id !== id);
}

function show(text: string, kind: ToastKind = 'info', ms = kind === 'error' ? 6000 : 3200, action?: ToastAction): number {
  const id = nextId++;
  items.value = [...items.value.filter((x) => x.text !== text), { id, text, kind, action }].slice(-4);
  setTimeout(() => dismiss(id), ms);
  return id;
}

export function useToast() {
  return { items, show, dismiss };
}
