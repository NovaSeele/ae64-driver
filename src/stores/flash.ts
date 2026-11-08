// Keys flashed on the keyboard view for a moment (e.g. a sync job for them was dropped without being saved).
import { defineStore } from 'pinia';
import { reactive } from 'vue';

export const useFlashStore = defineStore('flash', () => {
  const active = reactive(new Set<number>());
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

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
