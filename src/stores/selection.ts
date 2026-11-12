// Key selection shared by every per-key page (ids are PhysicalKey.id, 0..63).
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { PHYSICAL_KEYS } from '../protocol';
import { keyGroups } from '../data/keyGroups';
import { useDeviceStore } from './device';

export type SelectMode = 'replace' | 'toggle' | 'range';
/** Quick-select buttons: replace the selection with the group, or add the group to it (Ctrl/⌘/Shift). */
export type GroupMode = 'replace' | 'add';

const ALL_IDS = PHYSICAL_KEYS.map((k) => k.id);

export const useSelectionStore = defineStore('selection', () => {
  const selected = shallowRef<Set<number>>(new Set());
  const focused = ref<number | null>(null);
  const device = useDeviceStore();
  // Another keyboard (or the demo) was connected: the selection was of the old one.
  watch(() => device.connection, () => { selected.value = new Set(); focused.value = null; });
  /** Letters / digits / modifiers / WASD by what each key does on the Main layer (DESIGN B §3.1); recomputed when it changes. */
  const groups = computed(() => keyGroups(device.keys, device.layer0));
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
  /** replace: exactly the group · add: the union with the selection. An empty group changes nothing (a replace with []
   *  would quietly turn Performance into "all 64 keys"). The first id anchors the next Shift-click. */
  function group(list: readonly number[], mode: GroupMode = 'replace'): void {
    if (!list.length) return;
    set(mode === 'add' ? [...selected.value, ...list] : list);
    focused.value = list[0];
  }
  function wasd(mode: GroupMode = 'replace'): void { group(groups.value.wasd, mode); }
  function letters(mode: GroupMode = 'replace'): void { group(groups.value.letters, mode); }
  function digits(mode: GroupMode = 'replace'): void { group(groups.value.digits, mode); }
  function modifiers(mode: GroupMode = 'replace'): void { group(groups.value.mods, mode); }

  return { selected, focused, ids, count, groups, select, selectMany, clear, all, invert, group, wasd, letters, digits, modifiers };
});
