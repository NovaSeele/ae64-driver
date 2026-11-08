<script setup lang="ts">
// Scalable keyboard on a case panel. Selection is wired to the selection store:
// click = replace, Ctrl/⌘-click = toggle, Shift-click = range, drag = box select (Ctrl/Shift adds),
// click on the case clears, Esc clears. Arrow keys move focus between keys, Space/Enter selects.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Keycap from './Keycap.vue';
import { layoutBounds } from '../../protocol';
import type { PhysicalKey } from '../../protocol';
import { useSelectionStore } from '../../stores/selection';
import type { SelectMode } from '../../stores/selection';
import { t } from '../../i18n/vi';

const props = defineProps<{
  keys: PhysicalKey[];
  legend?: (key: PhysicalKey) => string;
  sublabel?: (key: PhysicalKey) => string | undefined;
  fill?: (key: PhysicalKey) => number | undefined;
  color?: (key: PhysicalKey) => string | undefined;
  state?: (key: PhysicalKey) => 'pressed' | undefined;
  selectable?: boolean;
  /** Shows skeleton value lines while page data loads. */
  loading?: boolean;
}>();

const MAX_UNIT = 58;
const PAD = 16;
const DRAG_THRESHOLD = 5;

const sel = useSelectionStore();
const root = ref<HTMLElement | null>(null);
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

function local(e: PointerEvent) {
  const r = root.value!.getBoundingClientRect();
  return { x: e.clientX - r.left - PAD, y: e.clientY - r.top - PAD };
}

function onPointerDown(e: PointerEvent) {
  if (!props.selectable || e.button !== 0) return;
  const keyEl = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
  const p = local(e);
  start = { ...p, id: keyEl ? Number(keyEl.dataset.key) : null, mods: modeOf(e) };
  root.value!.setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent) {
  if (!start) return;
  const p = local(e);
  if (!box.value && Math.hypot(p.x - start.x, p.y - start.y) < DRAG_THRESHOLD) return;
  box.value = { x0: start.x, y0: start.y, x1: p.x, y1: p.y };
}

function onPointerUp(e: PointerEvent) {
  if (!start) return;
  const s = start;
  start = null;
  if (box.value) {
    const b = box.value;
    box.value = null;
    const [x0, x1] = [Math.min(b.x0, b.x1), Math.max(b.x0, b.x1)];
    const [y0, y1] = [Math.min(b.y0, b.y1), Math.max(b.y0, b.y1)];
    const u = unit.value;
    const hit = props.keys.filter((k) => k.x * u < x1 && (k.x + k.w) * u > x0 && k.y * u < y1 && (k.y + 1) * u > y0).map((k) => k.id);
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
});
onBeforeUnmount(() => {
  ro?.disconnect();
  window.removeEventListener('keydown', onWindowKey);
});

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
    @pointercancel="box = null; start = null"
  >
    <div class="kb__plate" :style="{ width: `${bounds.width * unit}px`, height: `${bounds.height * unit}px` }">
      <button
        v-for="k in keys"
        :key="k.id"
        type="button"
        class="kb__key"
        :data-key="k.id"
        :tabindex="k.id === tabStop ? 0 : -1"
        :aria-pressed="selectable ? sel.selected.has(k.id) : undefined"
        :aria-label="`${legend ? legend(k) : k.name}${sublabel?.(k) ? ` · ${sublabel(k)}` : ''}`"
        :style="{ left: `${k.x * unit}px`, top: `${k.y * unit}px`, width: `${k.w * unit}px`, height: `${unit}px` }"
        @keydown="onKeyDown($event, k)"
        @focus="focusId = k.id"
      >
        <Keycap
          :legend="legend ? legend(k) : k.name"
          :sublabel="sublabel?.(k)"
          :fill="fill?.(k)"
          :color="color?.(k)"
          :state="state?.(k)"
          :selected="selectable && sel.selected.has(k.id)"
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
  box-shadow: var(--shadow-case), inset 0 1px 0 rgba(255, 255, 255, 0.03);
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
  border: 1px solid var(--acc);
  background: rgba(63, 224, 197, 0.08);
  border-radius: 4px;
  pointer-events: none;
}
</style>
