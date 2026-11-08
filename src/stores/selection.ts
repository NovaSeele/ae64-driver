// Key selection shared by every per-key page (ids are PhysicalKey.id, 0..63).
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { PHYSICAL_KEYS } from '../protocol';

export type SelectMode = 'replace' | 'toggle' | 'range';

const ALL_IDS = PHYSICAL_KEYS.map((k) => k.id);
const WASD_IDS = ['W', 'A', 'S', 'D'].map((n) => PHYSICAL_KEYS.find((k) => k.name === n)!.id);

export const useSelectionStore = defineStore('selection', () => {
  const selected = shallowRef<Set<number>>(new Set());
  const focused = ref<number | null>(null);
  const ids = computed(() => [...selected.value].sort((a, b) => a - b));
  const count = computed(() => selected.value.size);

  function set(next: Iterable<number>): void {
    selected.value = new Set(next);
  }

  /**
   * replace: only this key · toggle: add/remove this key (Ctrl-click) ·
   * range: add every key between the focused key and this one in layout order (Shift-click).
   */
  function select(id: number, mode: SelectMode = 'replace'): void {
    if (mode === 'replace') set([id]);
    else if (mode === 'toggle') {
      const next = new Set(selected.value);
      if (next.has(id)) next.delete(id); else next.add(id);
      set(next);
    } else {
      const anchor = focused.value ?? id;
      const [lo, hi] = anchor < id ? [anchor, id] : [id, anchor];
      set([...selected.value, ...ALL_IDS.filter((k) => k >= lo && k <= hi)]);
    }
    focused.value = id;
  }

  /** replace: exactly these · toggle: flip each · range: add all (union, used by drag-box with a modifier). */
  function selectMany(list: number[], mode: SelectMode = 'replace'): void {
    if (mode === 'replace') set(list);
    else if (mode === 'toggle') {
      const next = new Set(selected.value);
      for (const id of list) { if (next.has(id)) next.delete(id); else next.add(id); }
      set(next);
    } else set([...selected.value, ...list]);
    if (list.length) focused.value = list[list.length - 1];
  }

  function clear(): void { set([]); }
  function all(): void { set(ALL_IDS); }
  function invert(): void { set(ALL_IDS.filter((id) => !selected.value.has(id))); }
  function wasd(): void { set(WASD_IDS); focused.value = WASD_IDS[0]; }

  return { selected, focused, ids, count, select, selectMany, clear, all, invert, wasd };
});
