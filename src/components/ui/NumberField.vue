<script setup lang="ts">
// Numeric input with unit suffix. `null` shows the mixed-values placeholder. Commits on Enter/blur,
// ArrowUp/Down step (Shift = fine), and the − / + buttons. Accepts "," as decimal separator.
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
}>(), { step: 0.01, decimals: 2, unit: 'mm' });
const emit = defineEmits<{ 'update:modelValue': [number] }>();

const focused = ref(false);
const text = ref('');
const display = computed(() => (props.modelValue === null ? '' : props.modelValue.toFixed(props.decimals)));
watch(display, (d) => { if (!focused.value) text.value = d; }, { immediate: true });

function clamp(v: number) {
  return Number(Math.min(props.max, Math.max(props.min, v)).toFixed(props.decimals));
}
function commit() {
  const v = parseFloat(text.value.replace(',', '.'));
  if (Number.isFinite(v)) {
    const c = clamp(v);
    if (c !== props.modelValue) emit('update:modelValue', c);
    text.value = c.toFixed(props.decimals);
  } else text.value = display.value;
}
function nudge(dir: 1 | -1, fine = false) {
  const base = props.modelValue ?? (props.min + props.max) / 2;
  const c = clamp(base + dir * (fine ? props.step / 10 : props.step));
  emit('update:modelValue', c);
  text.value = c.toFixed(props.decimals);
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).select(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey); }
  else if (e.key === 'Escape') { text.value = display.value; (e.target as HTMLInputElement).blur(); }
}
</script>

<template>
  <div class="nf" :class="{ 'nf--disabled': disabled, 'nf--focus': focused }">
    <button type="button" class="nf__btn" :aria-label="`${t('ui.decrease')} ${label}`" tabindex="-1" :disabled="disabled" @click="nudge(-1)">
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
    <button type="button" class="nf__btn" :aria-label="`${t('ui.increase')} ${label}`" tabindex="-1" :disabled="disabled" @click="nudge(1)">
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
</style>
