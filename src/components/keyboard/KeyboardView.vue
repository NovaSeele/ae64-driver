<script setup lang="ts">
// Scalable keyboard on a case panel. Selection is wired to the selection store:
// click = replace, Ctrl/⌘-click = toggle, Shift-click = range, drag = box select (Ctrl/Shift adds),
// click on the case clears, Esc clears. Arrow keys move focus between keys, Space/Enter selects.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Component } from 'vue';
import Keycap from './Keycap.vue';
import type { SubLine } from './Keycap.vue';
import { layoutBounds } from '../../protocol';
import type { PhysicalKey } from '../../protocol';
import { useFlashStore } from '../../stores/flash';
import { useSelectionStore } from '../../stores/selection';
import type { SelectMode } from '../../stores/selection';
import { t } from '../../i18n/vi';

const props = defineProps<{
  keys: PhysicalKey[];
  legend?: (key: PhysicalKey) => string;
  sublabel?: (key: PhysicalKey) => string | SubLine[] | undefined;
  /** Small accent value on the keycap's bottom-left. */
  badge?: (key: PhysicalKey) => string | undefined;
  /** Accessible name / tooltip for a key's badge (replaces the badge text in the key's aria-label). */
  badgeTitle?: (key: PhysicalKey) => string | undefined;
  /** Tabler icon shown as the badge instead of its text. */
  badgeIcon?: (key: PhysicalKey) => Component | undefined;
  fill?: (key: PhysicalKey) => number | undefined;
  color?: (key: PhysicalKey) => string | undefined;
  /** CSS colour (e.g. 'var(--k-dks)') for a key's values; sets --metric on the keycap. */
  tone?: (key: PhysicalKey) => string | undefined;
  state?: (key: PhysicalKey) => 'pressed' | undefined;
  selectable?: boolean;
  /** Shows skeleton value lines while page data loads. */
  loading?: boolean;
}>();

const MAX_UNIT = 58;
const DRAG_THRESHOLD = 5;

const sel = useSelectionStore();
const flashStore = useFlashStore();
const root = ref<HTMLElement | null>(null);
const plate = ref<HTMLElement | null>(null);
const width = ref(0);
const bounds = computed(() => layoutBounds(props.keys));
const unit = computed(() => Math.max(24, Math.min(MAX_UNIT, width.value / bounds.value.width)));
const box = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
const focusId = ref<number | null>(null);

let ro: ResizeObserver | null = null;
let start: { x: number; y: number; id: number | null; mods: SelectMode } | null = null;

function modeOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): SelectMode {
  return e.ctrlKey || e.metaKey ? 'toggle' : e.shiftKey ? 'range' : 'replace';
}

/** Pointer position in plate coordinates (the plate is centred in the case, so measure it, not the case). */
function local(e: PointerEvent) {
  const r = plate.value!.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/** Lost capture / cancel / window blur: end the box-select instead of leaving the box following the mouse. */
function cancelDrag() {
  box.value = null;
  start = null;
}

function onPointerDown(e: PointerEvent) {
  if (!props.selectable || e.button !== 0) return;
  const keyEl = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
  const p = local(e);
  start = { ...p, id: keyEl ? Number(keyEl.dataset.key) : null, mods: modeOf(e) };
  root.value!.setPointerCapture(e.pointerId);
}

/** Keys whose cap intersects the drag box (plate coordinates). */
function keysInBox(b: { x0: number; y0: number; x1: number; y1: number }): number[] {
  const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
  const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
  const u = unit.value;
  return props.keys.filter((k) => k.x * u < x1 && (k.x + k.w) * u > x0 && k.y * u < y1 && (k.y + 1) * u > y0).map((k) => k.id);
}

/** Live preview while box-selecting: the keys the box covers light up as it grows (added to the selection with Ctrl/Shift). */
const boxHits = computed<Set<number> | null>(() => (box.value ? new Set(keysInBox(box.value)) : null));
const boxAdds = ref(false);
function isSelected(id: number): boolean {
  const hits = boxHits.value;
  if (!hits) return sel.selected.has(id);
  return hits.has(id) || (boxAdds.value && sel.selected.has(id));
}

function onPointerMove(e: PointerEvent) {
  if (!start) return;
  const p = local(e);
  if (!box.value && Math.hypot(p.x - start.x, p.y - start.y) < DRAG_THRESHOLD) return;
  boxAdds.value = start.mods !== 'replace';
  box.value = { x0: start.x, y0: start.y, x1: p.x, y1: p.y };
}

function onPointerUp(e: PointerEvent) {
  if (!start) return;
  const s = start;
  start = null;
  if (box.value) {
    const hit = keysInBox(box.value);
    box.value = null;
    sel.selectMany(hit, s.mods === 'replace' ? 'replace' : 'range');
    return;
  }
  if (s.id === null) {
    if (!e.ctrlKey && !e.shiftKey && !e.metaKey) sel.clear();
    return;
  }
  sel.select(s.id, s.mods);
  focusId.value = s.id;
}

function focusKey(id: number) {
  focusId.value = id;
  root.value?.querySelector<HTMLElement>(`[data-key="${id}"]`)?.focus();
}

function neighbour(from: PhysicalKey, key: string): PhysicalKey | undefined {
  const keys = props.keys;
  if (key === 'ArrowLeft' || key === 'ArrowRight') {
    const row = keys.filter((k) => k.uiRow === from.uiRow).sort((a, b) => a.x - b.x);
    const i = row.indexOf(from);
    return row[i + (key === 'ArrowRight' ? 1 : -1)];
  }
  const target = from.uiRow + (key === 'ArrowDown' ? 1 : -1);
  const cx = from.x + from.w / 2;
  return keys
    .filter((k) => k.uiRow === target)
    .sort((a, b) => Math.abs(a.x + a.w / 2 - cx) - Math.abs(b.x + b.w / 2 - cx))[0];
}

function onKeyDown(e: KeyboardEvent, key: PhysicalKey) {
  if (e.key.startsWith('Arrow')) {
    e.preventDefault();
    const n = neighbour(key, e.key);
    if (n) {
      focusKey(n.id);
      if (e.shiftKey && props.selectable) sel.select(n.id, 'range');
    }
  } else if ((e.key === ' ' || e.key === 'Enter') && props.selectable) {
    e.preventDefault();
    sel.select(key.id, modeOf(e));
  }
}

function onWindowKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !props.selectable || e.defaultPrevented) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest('[role="dialog"]') || el?.tagName === 'INPUT') return;
  sel.clear();
}

onMounted(() => {
  ro = new ResizeObserver(([entry]) => { width.value = entry.contentRect.width; });
  ro.observe(root.value!);
  window.addEventListener('keydown', onWindowKey);
  window.addEventListener('blur', cancelDrag);
});
onBeforeUnmount(() => {
  ro?.disconnect();
  window.removeEventListener('keydown', onWindowKey);
  window.removeEventListener('blur', cancelDrag);
});

/** Plain text of a key's sublabel for its aria-label (lines joined by spaces). */
function subText(k: PhysicalKey): string {
  const s = props.sublabel?.(k);
  if (!s) return '';
  return typeof s === 'string' ? s.replace(/\n/g, ' ') : s.map((l) => l.text).join(' ');
}

const tabStop = computed(() => focusId.value ?? sel.focused ?? props.keys[0]?.id);
</script>

<template>
  <div
    ref="root"
    class="kb"
    :class="{ 'kb--selectable': selectable }"
    role="group"
    :aria-label="t('keyboard.label')"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="cancelDrag"
    @lostpointercapture="cancelDrag"
  >
    <div ref="plate" class="kb__plate" :style="{ width: `${bounds.width * unit}px`, height: `${bounds.height * unit}px` }">
      <button
        v-for="k in keys"
        :key="k.id"
        type="button"
        class="kb__key"
        :data-key="k.id"
        :tabindex="k.id === tabStop ? 0 : -1"
        :aria-pressed="selectable ? isSelected(k.id) : undefined"
        :aria-label="`${legend ? legend(k) : k.name}${subText(k) ? ` · ${subText(k)}` : ''}${badge?.(k) || badgeIcon?.(k) ? ` · ${badgeTitle?.(k) ?? badge?.(k)}` : ''}`"
        :style="{ left: `${k.x * unit}px`, top: `${k.y * unit}px`, width: `${k.w * unit}px`, height: `${unit}px` }"
        @keydown="onKeyDown($event, k)"
        @focus="focusId = k.id"
      >
        <Keycap
          :legend="legend ? legend(k) : k.name"
          :sublabel="sublabel?.(k)"
          :badge="badge?.(k)"
          :badge-title="badgeTitle?.(k)"
          :badge-icon="badgeIcon?.(k)"
          :fill="fill?.(k)"
          :color="color?.(k)"
          :tone="tone?.(k)"
          :state="state?.(k)"
          :selected="selectable && isSelected(k.id)"
          :flashing="flashStore.isFlashing(k.id)"
          :loading="loading"
        />
      </button>
      <div
        v-if="box"
        class="kb__box"
        :style="{
          left: `${Math.min(box.x0, box.x1)}px`,
          top: `${Math.min(box.y0, box.y1)}px`,
          width: `${Math.abs(box.x1 - box.x0)}px`,
          height: `${Math.abs(box.y1 - box.y0)}px`,
        }"
      />
    </div>
  </div>
</template>

<style scoped>
.kb {
  position: relative;
  width: 100%;
  padding: 16px;
  display: flex;
  justify-content: center;
  border-radius: var(--r-panel);
  background: var(--bg-1);
  border: 1px solid var(--line-1);
  box-shadow: var(--shadow-case), inset 0 1px 0 var(--line-1);
  user-select: none;
  touch-action: none;
}
.kb__plate { position: relative; flex: none; }
.kb__key {
  position: absolute;
  padding: 0;
  border: 0;
  background: transparent;
  border-radius: var(--r-key);
  cursor: default;
}
.kb--selectable .kb__key { cursor: pointer; }
.kb__key:focus-visible { box-shadow: none; }
.kb__key:focus-visible :deep(.cap__face) { box-shadow: 0 0 0 2px var(--acc-line); }
.kb__key:active :deep(.cap) { transform: translateY(1px); }
.kb__box {
  position: absolute;
  border: 1px solid var(--sel);
  background: color-mix(in srgb, var(--sel) 12%, transparent);
  border-radius: 4px;
  pointer-events: none;
}
</style>
