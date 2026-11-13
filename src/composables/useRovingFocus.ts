// Roving tabindex for a list of buttons (key check chips and table rows, DESIGN C §7): the list is one Tab stop; arrows,
// Home and End move between its items. The stop remembers the item used last (by id); when the list changes it stays on
// that item if it still exists, else on the item now at the same place (clamped to the end). Enter/Space are the
// buttons' own click.
import { computed, nextTick, ref } from 'vue';
import type { Ref } from 'vue';

export function useRovingFocus(opts: {
  /** Element holding the items; each item carries `data-rid="<id>"`. */
  container: Ref<HTMLElement | null>;
  /** The item ids in display order. */
  ids: () => number[];
  /** 'both': ←/→ and ↑/↓ move (a wrapping chip list); 'vertical': ↑/↓ only (table rows). */
  orientation: 'both' | 'vertical';
  /** Called before an arrow key focuses `id` (at `index`): a list that renders only part of its items brings it in. */
  reveal?: (id: number, index: number) => void;
}) {
  const current = ref<number | null>(null);
  /** Where the remembered item was, so a removed item hands the stop to its neighbour instead of the first item. */
  let lastIndex = 0;

  const stop = computed<number | null>(() => {
    const ids = opts.ids();
    if (!ids.length) return null;
    const at = current.value === null ? -1 : ids.indexOf(current.value);
    if (at >= 0) lastIndex = at; // where it is now, so its neighbour takes over if it goes (plain variable: no reactivity)
    return at >= 0 ? ids[at] : ids[Math.min(lastIndex, ids.length - 1)];
  });

  function tabindex(id: number): 0 | -1 {
    return id === stop.value ? 0 : -1;
  }

  function onFocus(id: number): void {
    current.value = id;
    lastIndex = Math.max(0, opts.ids().indexOf(id));
  }

  function onKeydown(e: KeyboardEvent, id: number): void {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const ids = opts.ids();
    const at = ids.indexOf(id);
    if (at < 0) return;
    const both = opts.orientation === 'both';
    let to: number;
    switch (e.key) {
      case 'ArrowDown': to = at + 1; break;
      case 'ArrowUp': to = at - 1; break;
      case 'ArrowRight': if (!both) return; to = at + 1; break;
      case 'ArrowLeft': if (!both) return; to = at - 1; break;
      case 'Home': to = 0; break;
      case 'End': to = ids.length - 1; break;
      default: return;
    }
    e.preventDefault();
    to = Math.max(0, Math.min(ids.length - 1, to));
    const next = ids[to];
    current.value = next;
    lastIndex = to;
    opts.reveal?.(next, to);
    void nextTick(() => opts.container.value?.querySelector<HTMLElement>(`[data-rid="${next}"]`)?.focus());
  }

  return { stop, tabindex, onFocus, onKeydown };
}
