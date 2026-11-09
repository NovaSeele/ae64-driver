<script lang="ts">
/** Decimals a value needs: 2, or `max` (≥3) only when the third digit is not zero (1.000 → 1.00, 0.125 stays). */
export function decimalsFor(v: number, max: number): number {
  if (max <= 2) return max;
  return Math.abs(v * 100 - Math.round(v * 100)) < 0.0005 ? 2 : max;
}
export function formatMm(v: number, max: number): string {
  return v.toFixed(decimalsFor(v, max));
}
</script>

<script setup lang="ts">
// Numeric input with unit suffix. `null` shows the mixed-values placeholder. Commits on Enter/blur,
// ArrowUp/Down step and the − / + buttons (Shift = fine, a tenth of the step). Accepts "," as decimal separator.
// On a mixed value (null) − / + / arrows are off, since there is no base to step from, unless `relative`
// is set: then they emit `step` with the signed delta and the parent moves each item from its own value.
import { computed, ref, watch } from 'vue';
import { IconMinus, IconPlus } from '@tabler/icons-vue';
import { t } from '../../i18n/vi';

const props = withDefaults(defineProps<{
  modelValue: number | null;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  unit?: string;
  label: string;
  disabled?: boolean;
  placeholder?: string;
  relative?: boolean;
}>(), { step: 0.01, decimals: 2, unit: 'mm' });
const emit = defineEmits<{ 'update:modelValue': [number]; step: [number] }>();

const focused = ref(false);
const text = ref('');
const display = computed(() => (props.modelValue === null ? '' : formatMm(props.modelValue, props.decimals)));
watch(display, (d) => { if (!focused.value) text.value = d; }, { immediate: true });

function clamp(v: number) {
  return Number(Math.min(props.max, Math.max(props.min, v)).toFixed(props.decimals));
}
function commit() {
  const v = parseFloat(text.value.replace(',', '.'));
  if (Number.isFinite(v)) {
    const c = clamp(v);
    if (c !== props.modelValue) emit('update:modelValue', c);
    text.value = formatMm(c, props.decimals);
  } else text.value = display.value;
}
const stepOff = computed(() => props.disabled || (props.modelValue === null && !props.relative));
function nudge(dir: 1 | -1, fine = false) {
  if (stepOff.value) return;
  const delta = dir * (fine ? props.step / 10 : props.step);
  if (props.modelValue === null) { emit('step', Number(delta.toFixed(props.decimals + 1))); return; }
  const c = clamp(props.modelValue + delta);
  emit('update:modelValue', c);
  text.value = formatMm(c, props.decimals);
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).select(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); }
  else if (e.key === 'Escape') { text.value = display.value; (e.target as HTMLInputElement).blur(); }
}
</script>

<template>
  <div class="nf" :class="{ 'nf--disabled': disabled, 'nf--focus': focused }">
    <button type="button" class="nf__btn" :aria-label="`${t('ui.decrease')} ${label}`" tabindex="-1" :disabled="stepOff" @click="nudge(-1, $event.shiftKey)">
      <IconMinus :size="14" stroke-width="1.5" />
    </button>
    <input
      v-model="text"
      class="nf__input num"
      inputmode="decimal"
      :aria-label="label"
      :placeholder="placeholder ?? t('perf.mixed')"
      :disabled="disabled"
      @focus="focused = true; ($event.target as HTMLInputElement).select()"
      @blur="focused = false; commit()"
      @keydown="onKey"
    >
    <span v-if="unit" class="nf__unit">{{ unit }}</span>
    <button type="button" class="nf__btn" :aria-label="`${t('ui.increase')} ${label}`" tabindex="-1" :disabled="stepOff" @click="nudge(1, $event.shiftKey)">
      <IconPlus :size="14" stroke-width="1.5" />
    </button>
  </div>
</template>

<style scoped>
.nf {
  display: inline-flex;
  align-items: center;
  height: 34px;
  min-width: 0;
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  background: var(--bg-1);
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.nf:hover { border-color: var(--line-3); }
.nf--focus { border-color: var(--acc-line); box-shadow: var(--focus-ring); }
.nf--disabled { opacity: 0.45; }
.nf__input {
  width: 100%;
  min-width: 48px;
  border: 0;
  background: transparent;
  text-align: right;
  font-size: var(--fs-body);
  font-weight: 500;
  padding: 0 2px;
}
.nf__input::placeholder { color: var(--fg-3); font-weight: 400; font-size: var(--fs-label); }
.nf__input:focus-visible { box-shadow: none; }
.nf__unit { color: var(--fg-3); font-size: var(--fs-label); padding: 0 4px 0 3px; }
.nf__btn {
  display: grid;
  place-items: center;
  width: 26px;
  height: 100%;
  border: 0;
  background: transparent;
  color: var(--fg-3);
  transition: color var(--t-fast) var(--ease);
}
.nf__btn:hover:not(:disabled) { color: var(--fg-1); }
.nf__btn:disabled { opacity: 0.35; cursor: not-allowed; }
</style>
