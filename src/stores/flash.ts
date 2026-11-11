// Keys flashed on the keyboard view for a moment (e.g. a sync job for them was dropped without being saved).
import { defineStore } from 'pinia';
import { reactive, watch } from 'vue';
import { useDeviceStore } from './device';

export const useFlashStore = defineStore('flash', () => {
  const active = reactive(new Set<number>());
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  // Another keyboard (or the demo) was connected: no key of the old one stays highlighted.
  watch(() => useDeviceStore().connection, () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    active.clear();
  });

  function flash(ids: number[], ms = 1000): void {
    for (const id of ids) {
      clearTimeout(timers.get(id));
      active.add(id);
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        active.delete(id);
      }, ms));
    }
  }

  function isFlashing(id: number): boolean {
    return active.has(id);
  }

  return { flash, isFlashing };
});
