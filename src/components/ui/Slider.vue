<script setup lang="ts">
// Horizontal or vertical slider. Vertical sliders put `min` at the top (key-travel semantics:
// deeper = further down), and ArrowDown increases. Shift = fine step for keys and drags.
// Emits `update:modelValue` continuously and `commit` when a gesture/keystroke finishes.
// U-12: on a mixed selection (`range`) with `relative`, the arrow keys and PageUp / PageDown emit `step` with the signed delta
// and the parent moves each item from its own value (as the number field beside it does); Home / End still set every item.
import { computed, onBeforeUnmount, ref } from 'vue';
import { t } from '../../i18n/vi';

const props = withDefaults(defineProps<{
  modelValue: number;
  min: number;
  max: number;
  step?: number;
  fineStep?: number;
  orientation?: 'horizontal' | 'vertical';
  label: string;
  disabled?: boolean;
  /** Mixed selection: draws a band between the lowest and highest selected values. */
  range?: [number, number] | null;
  /** Formats aria-valuetext. */
  format?: (v: number) => string;
  /**
   * The lowest value the slider gives (DESIGN J §3.4): drags, track clicks and every decreasing key (←, ↓, PageDown, Home)
   * stop here, and it is aria-valuemin. The track is still drawn from `min`. Absent: `min`.
   */
  floor?: number;
  /** id of a line that explains the value (aria-describedby on the thumb). */
  describedby?: string;
  /** On a mixed selection the step keys emit `step` (each item moves from its own value) instead of one value for all. */
  relative?: boolean;
}>(), { step: 0.01, orientation: 'horizontal', range: null });

/** `cancel`: the slider went away mid-drag (no commit): a parent's draft of the drag is dropped, nothing is written. */
const emit = defineEmits<{ 'update:modelValue': [number]; commit: [number]; step: [number]; cancel: [] }>();
/** "Mixed: 0.05–0.60" while the values differ; else the formatted value. */
const valueText = computed(() => {
  const f = props.format ?? ((v: number) => String(v));
  return props.range ? `${t('perf.mixed')}: ${f(props.range[0])}–${f(props.range[1])}` : props.format ? f(props.modelValue) : undefined;
});
const track = ref<HTMLElement | null>(null);
const dragging = ref(false);

const vertical = computed(() => props.orientation === 'vertical');
const lowest = computed(() => (props.floor === undefined ? props.min : Math.min(props.max, Math.max(props.min, props.floor))));
const fine = computed(() => props.fineStep ?? props.step / 10);
const ratio = (v: number) => (props.max === props.min ? 0 : (Math.min(props.max, Math.max(props.min, v)) - props.min) / (props.max - props.min));
const pct = computed(() => ratio(props.modelValue) * 100);
const band = computed(() => (props.range ? { from: ratio(props.range[0]) * 100, to: ratio(props.range[1]) * 100 } : null));

function snap(v: number, step: number): number {
  // Absolute grid (0.30, 0.35…), not one anchored at `min` (0.01 → 0.06, 0.11…); clamped below.
  const s = Math.round(v / step) * step;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(Math.min(props.max, Math.max(lowest.value, s)).toFixed(decimals));
}

function fromPointer(e: PointerEvent): number {
  const r = track.value!.getBoundingClientRect();
  const t = vertical.value ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
  return snap(props.min + Math.min(1, Math.max(0, t)) * (props.max - props.min), e.shiftKey ? fine.value : props.step);
}

function set(v: number) {
  if (v !== props.modelValue) emit('update:modelValue', v);
}

/** Last value emitted by the current drag; the gesture always ends on it. */
let last: number | null = null;

function onDown(e: PointerEvent) {
  if (props.disabled || e.button !== 0) return;
  // No text selection / native drag: those make the browser cancel the pointer stream mid-drag.
  e.preventDefault();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = true;
  last = fromPointer(e);
  set(last);
  (track.value?.querySelector('.sl__thumb') as HTMLElement | null)?.focus({ preventScroll: true });
}
function onMove(e: PointerEvent) {
  if (!dragging.value) return;
  last = fromPointer(e);
  set(last);
}
function onUp(e: PointerEvent) {
  if (!dragging.value) return;
  last = fromPointer(e);
  finish();
}
/**
 * pointercancel / lostpointercapture carry no usable position (often clientX = 0, which would map to
 * `min`): keep the value the drag last reached instead of reading the event.
 */
function finish() {
  if (!dragging.value) return;
  dragging.value = false;
  const v = last ?? props.modelValue;
  last = null;
  set(v);
  emit('commit', v);
}

onBeforeUnmount(() => {
  if (!dragging.value) return;
  dragging.value = false;
  last = null;
  emit('cancel');
});

function onKey(e: KeyboardEvent) {
  if (props.disabled) return;
  const step = e.shiftKey ? fine.value : props.step;
  const inc = vertical.value ? ['ArrowDown', 'ArrowRight'] : ['ArrowUp', 'ArrowRight'];
  const dec = vertical.value ? ['ArrowUp', 'ArrowLeft'] : ['ArrowDown', 'ArrowLeft'];
  if (props.relative && props.range) {
    const d = inc.includes(e.key) ? step : dec.includes(e.key) ? -step : e.key === 'PageUp' ? step * 10 : e.key === 'PageDown' ? -step * 10 : 0;
    if (d) {
      e.preventDefault();
      const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
      emit('step', Number(d.toFixed(decimals)));
      emit('commit', props.modelValue);
      return;
    }
  }
  let v: number | null = null;
  if (inc.includes(e.key)) v = props.modelValue + step;
  else if (dec.includes(e.key)) v = props.modelValue - step;
  else if (e.key === 'PageUp') v = props.modelValue + step * 10;
  else if (e.key === 'PageDown') v = props.modelValue - step * 10;
  else if (e.key === 'Home') v = lowest.value;
  else if (e.key === 'End') v = props.max;
  if (v === null) return;
  e.preventDefault();
  const next = snap(v, step);
  set(next);
  emit('commit', next);
}
</script>

<template>
  <div
    ref="track"
    class="sl"
    :class="{ 'sl--v': vertical, 'sl--disabled': disabled, 'sl--drag': dragging }"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="finish"
    @lostpointercapture="finish"
  >
    <div class="sl__rail">
      <div v-if="band" class="sl__band" :style="vertical ? { top: `${band.from}%`, height: `${band.to - band.from}%` } : { left: `${band.from}%`, width: `${band.to - band.from}%` }" />
      <div v-else class="sl__fill" :style="vertical ? { height: `${pct}%` } : { width: `${pct}%` }" />
    </div>
    <div
      class="sl__thumb"
      role="slider"
      :tabindex="disabled ? -1 : 0"
      :aria-label="label"
      :aria-valuemin="lowest"
      :aria-describedby="describedby"
      :aria-valuemax="max"
      :aria-valuenow="modelValue"
      :aria-valuetext="valueText"
      :aria-orientation="orientation"
      :aria-disabled="disabled || undefined"
      :style="vertical ? { top: `${pct}%` } : { left: `${pct}%` }"
      @keydown="onKey"
    />
  </div>
</template>

<style scoped>
.sl {
  position: relative;
  touch-action: none;
  cursor: pointer;
  height: 20px;
  width: 100%;
}
.sl--v { width: 20px; height: 100%; }
.sl--disabled { opacity: 0.4; cursor: not-allowed; }
.sl__rail {
  position: absolute;
  inset: 8px 0;
  border-radius: 2px;
  background: var(--bg-4);
  overflow: hidden;
}
.sl--v .sl__rail { inset: 0 8px; }
.sl__fill, .sl__band {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--sl-tone, var(--acc));
  border-radius: 2px;
}
.sl--v .sl__fill, .sl--v .sl__band { right: 0; bottom: auto; }
.sl__band { background: color-mix(in srgb, var(--sl-tone, var(--acc)) 45%, transparent); }
.sl:not(.sl--drag) .sl__fill { transition: width var(--t-fast) var(--ease), height var(--t-fast) var(--ease); }
.sl__thumb {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border-radius: 50%;
  background: var(--fg-1);
  border: 3px solid var(--sl-tone, var(--acc));
  box-shadow: 0 1px 4px var(--cap-shade);
  transition: transform var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.sl--v .sl__thumb { left: 50%; margin: -8px 0 0 -8px; }
.sl:not(.sl--drag) .sl__thumb { transition: transform var(--t-fast) var(--ease), top var(--t-fast) var(--ease), left var(--t-fast) var(--ease); }
.sl:hover .sl__thumb, .sl--drag .sl__thumb { transform: scale(1.12); }
.sl__thumb:focus-visible { box-shadow: var(--focus-ring); }
</style>
