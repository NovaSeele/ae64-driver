<script lang="ts">
/** Decimals a value needs: 2, or `max` (≥3) only when the third digit is not zero (1.000 → 1.00, 0.125 stays). */
export function decimalsFor(v: number, max: number): number {
  if (max <= 2) return max;
  return Math.abs(v * 100 - Math.round(v * 100)) < 0.0005 ? 2 : max;
}
export function formatMm(v: number, max: number): string {
  return v.toFixed(decimalsFor(v, max));
}
/**
 * The typed text as a number: null when empty, NaN when it is not one number. The decimal mark is "." or ","; more than one
 * separator or a space inside ("1.500,5", "1 500") is not read, and neither is a separator in a field without decimals
 * ("1.500" may be one thousand five hundred there). Nothing is guessed (WHOLE P3 NumberField).
 */
export function parseNumber(text: string, decimals: number): number | null {
  const s = text.trim();
  if (s === '') return null;
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(s)) return NaN;
  if (decimals === 0 && /[.,]/.test(s)) return NaN;
  return Number(s.replace(',', '.'));
}
</script>

<script setup lang="ts">
// Numeric input with unit suffix. `null` shows the mixed-values placeholder. Commits on Enter/blur once the text was changed
// (U-05: tabbing through writes nothing, and a value outside min / max that nobody typed stays as it is), ArrowUp/Down step
// (from the typed text when it reads as a number) and the − / + buttons (Shift = fine, `fineStep` (default a tenth of the step)). The decimal mark
// is "." or ","; text that is not one number shows the error state and writes nothing (parseNumber).
// On a mixed value (null) − / + / arrows are off, since there is no base to step from, unless `relative`
// is set: then they emit `step` with the signed delta and the parent moves each item from its own value.
import { computed, nextTick, ref, watch } from 'vue';
import { IconMinus, IconPlus } from '@tabler/icons-vue';
import { t } from '../../i18n/vi';

const props = withDefaults(defineProps<{
  modelValue: number | null;
  min: number;
  max: number;
  step?: number;
  fineStep?: number;
  decimals?: number;
  unit?: string;
  label: string;
  disabled?: boolean;
  placeholder?: string;
  relative?: boolean;
  /** id of a line that explains the value (aria-describedby on the input). */
  describedby?: string;
}>(), { step: 0.01, decimals: 2, unit: 'mm' });
const emit = defineEmits<{ 'update:modelValue': [number]; step: [number] }>();

const focused = ref(false);
const text = ref('');
const display = computed(() => (props.modelValue === null ? '' : formatMm(props.modelValue, props.decimals)));
const input = ref<HTMLInputElement | null>(null);
/** No pending draft: Esc and Ctrl/⌘+Z/Y go to the app (see `data-app-keys`). */
const clean = computed(() => text.value === display.value);
watch(display, (d, old) => {
  if (!focused.value) text.value = d;
  else if (text.value === old) {
    text.value = d;
    void nextTick(() => input.value?.select());
  }
}, { immediate: true });

function clamp(v: number) {
  return Number(Math.min(props.max, Math.max(props.min, v)).toFixed(props.decimals));
}
/** The typed text is not one number: the field says so and writes nothing. */
const badText = computed(() => Number.isNaN(parseNumber(text.value, props.decimals)));
/** The value shown is outside min / max (the keyboard holds it; nobody typed it): shown, never clamped on its own. */
const outOfRange = computed(() => props.modelValue !== null && clean.value && (props.modelValue < props.min - 1e-9 || props.modelValue > props.max + 1e-9));
const invalidText = computed(() => {
  if (badText.value) return t('ui.numberInvalid');
  if (outOfRange.value) return t('ui.numberRange', { min: formatMm(props.min, props.decimals), max: formatMm(props.max, props.decimals) });
  return undefined;
});
function commit() {
  if (clean.value) return; // only focused (U-05): nothing typed, nothing written
  const v = parseNumber(text.value, props.decimals);
  if (v === null) { text.value = display.value; return; } // emptied: back to the value
  if (Number.isNaN(v)) return; // not one number: the error state stays, nothing is written
  const c = clamp(v);
  if (c !== props.modelValue) emit('update:modelValue', c);
  text.value = formatMm(c, props.decimals);
}
const stepOff = computed(() => props.disabled || (props.modelValue === null && !props.relative));
function nudge(dir: 1 | -1, fine = false) {
  if (props.disabled) return;
  const delta = dir * (fine ? (props.fineStep ?? props.step / 10) : props.step);
  // typed and not yet committed: step from what was typed when it reads as a number, else from the value
  const typed = clean.value ? null : parseNumber(text.value, props.decimals);
  const base = typed !== null && Number.isFinite(typed) ? typed : props.modelValue;
  if (base === null) {
    if (stepOff.value) return;
    emit('step', Number(delta.toFixed(props.decimals + 1)));
    return;
  }
  // N-WX5-1: from a value outside min / max (the keyboard holds it), a step further out does nothing; a step toward the
  // range lands on the bound. Never "increase" to a lower value.
  if ((base > props.max && delta > 0) || (base < props.min && delta < 0)) return;
  const c = clamp(base + delta);
  if (c !== props.modelValue) emit('update:modelValue', c);
  text.value = formatMm(c, props.decimals);
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).select(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); }
  // Handled here (preventDefault): the revert makes the field clean before the window listeners run, and
  // KeyboardView would otherwise clear the selection on the same Esc.
  else if (e.key === 'Escape' && !clean.value) { e.preventDefault(); text.value = display.value; (e.target as HTMLInputElement).blur(); }
}
</script>

<template>
  <div class="nf" :class="{ 'nf--disabled': disabled, 'nf--focus': focused, 'nf--invalid': invalidText }" :title="invalidText">
    <button type="button" class="nf__btn" :aria-label="`${t('ui.decrease')} ${label}`" tabindex="-1" :disabled="stepOff" @click="nudge(-1, $event.shiftKey)">
      <IconMinus :size="14" stroke-width="1.5" />
    </button>
    <input
      ref="input"
      v-model="text"
      :data-app-keys="clean ? '' : undefined"
      class="nf__input num"
      inputmode="decimal"
      :aria-label="label"
      :aria-describedby="describedby"
      :placeholder="placeholder ?? t('perf.mixed')"
      :disabled="disabled"
      :aria-invalid="invalidText ? true : undefined"
      @focus="focused = true; ($event.target as HTMLInputElement).select()"
      @blur="focused = false; commit()"
      @keydown="onKey"
    >
    <span v-if="unit && !(modelValue === null && text === '')" class="nf__unit">{{ unit }}</span>
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
.nf--invalid { border-color: var(--warn); }
.nf--invalid.nf--focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 30%, transparent); }
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
