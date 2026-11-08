<script setup lang="ts">
// Horizontal or vertical slider. Vertical sliders put `min` at the top (key-travel semantics:
// deeper = further down), and ArrowDown increases. Shift = fine step for keys and drags.
// Emits `update:modelValue` continuously and `commit` when a gesture/keystroke finishes.
import { computed, ref } from 'vue';

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
}>(), { step: 0.01, orientation: 'horizontal', range: null });

const emit = defineEmits<{ 'update:modelValue': [number]; commit: [number] }>();
const track = ref<HTMLElement | null>(null);
const dragging = ref(false);

const vertical = computed(() => props.orientation === 'vertical');
const fine = computed(() => props.fineStep ?? props.step / 10);
const ratio = (v: number) => (props.max === props.min ? 0 : (Math.min(props.max, Math.max(props.min, v)) - props.min) / (props.max - props.min));
const pct = computed(() => ratio(props.modelValue) * 100);
const band = computed(() => (props.range ? { from: ratio(props.range[0]) * 100, to: ratio(props.range[1]) * 100 } : null));

function snap(v: number, step: number): number {
  const s = Math.round((v - props.min) / step) * step + props.min;
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(Math.min(props.max, Math.max(props.min, s)).toFixed(decimals));
}

function fromPointer(e: PointerEvent): number {
  const r = track.value!.getBoundingClientRect();
  const t = vertical.value ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
  return snap(props.min + Math.min(1, Math.max(0, t)) * (props.max - props.min), e.shiftKey ? fine.value : props.step);
}

function set(v: number) {
  if (v !== props.modelValue) emit('update:modelValue', v);
}

function onDown(e: PointerEvent) {
  if (props.disabled || e.button !== 0) return;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  dragging.value = true;
  set(fromPointer(e));
  (track.value?.querySelector('.sl__thumb') as HTMLElement | null)?.focus({ preventScroll: true });
}
function onMove(e: PointerEvent) {
  if (dragging.value) set(fromPointer(e));
}
function onUp(e: PointerEvent) {
  if (!dragging.value) return;
  dragging.value = false;
  set(fromPointer(e));
  emit('commit', fromPointer(e));
}

function onKey(e: KeyboardEvent) {
  if (props.disabled) return;
  const step = e.shiftKey ? fine.value : props.step;
  const inc = vertical.value ? ['ArrowDown', 'ArrowRight'] : ['ArrowUp', 'ArrowRight'];
  const dec = vertical.value ? ['ArrowUp', 'ArrowLeft'] : ['ArrowDown', 'ArrowLeft'];
  let v: number | null = null;
  if (inc.includes(e.key)) v = props.modelValue + step;
  else if (dec.includes(e.key)) v = props.modelValue - step;
  else if (e.key === 'PageUp') v = props.modelValue + step * 10;
  else if (e.key === 'PageDown') v = props.modelValue - step * 10;
  else if (e.key === 'Home') v = props.min;
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
    @pointercancel="onUp"
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
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="modelValue"
      :aria-valuetext="format ? format(modelValue) : undefined"
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
  background: var(--acc);
  border-radius: 2px;
}
.sl--v .sl__fill, .sl--v .sl__band { right: 0; bottom: auto; }
.sl__band { background: var(--acc-line); }
.sl:not(.sl--drag) .sl__fill { transition: width var(--t-fast) var(--ease), height var(--t-fast) var(--ease); }
.sl__thumb {
  position: absolute;
  top: 50%;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border-radius: 50%;
  background: var(--fg-1);
  border: 3px solid var(--acc);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
  transition: transform var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.sl--v .sl__thumb { left: 50%; margin: -8px 0 0 -8px; }
.sl:not(.sl--drag) .sl__thumb { transition: transform var(--t-fast) var(--ease), top var(--t-fast) var(--ease), left var(--t-fast) var(--ease); }
.sl:hover .sl__thumb, .sl--drag .sl__thumb { transform: scale(1.12); }
.sl__thumb:focus-visible { box-shadow: 0 0 0 4px var(--acc-line); }
</style>
