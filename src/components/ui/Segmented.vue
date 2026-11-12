<script setup lang="ts" generic="T extends string | number">
const model = defineModel<T | null>({ required: true });
// `manual`: arrow keys only move focus; Enter / Space / click select (for choices with side effects).
const props = withDefaults(defineProps<{
  options: { value: T; label: string; title?: string; ariaLabel?: string }[];
  label: string;
  size?: 'sm' | 'md';
  manual?: boolean;
  disabled?: boolean;
}>(), { size: 'md' });

function select(v: T) {
  if (!props.disabled) model.value = v;
}

function onKey(e: KeyboardEvent) {
  if (props.disabled) return;
  const opts = props.options;
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const from = props.manual ? (e.target as HTMLElement).closest<HTMLElement>('[data-v]')?.dataset.v : undefined;
  const i = props.manual
    ? opts.findIndex((o) => String(o.value) === from)
    : opts.findIndex((o) => o.value === model.value);
  const next = opts[(Math.max(i, 0) + d + opts.length) % opts.length];
  if (!props.manual) model.value = next.value;
  ((e.currentTarget as HTMLElement).querySelector(`[data-v="${String(next.value)}"]`) as HTMLElement | null)?.focus();
}
</script>

<template>
  <div class="seg" :class="[`seg--${size}`, { 'seg--disabled': disabled }]" role="radiogroup" :aria-label="label" :aria-disabled="disabled || undefined" @keydown="onKey">
    <button
      v-for="(o, i) in options"
      :key="String(o.value)"
      type="button"
      role="radio"
      class="seg__opt"
      :data-v="String(o.value)"
      :title="o.title"
      :aria-label="o.ariaLabel"
      :aria-checked="o.value === model"
      :disabled="disabled"
      :tabindex="o.value === model || (model === null && i === 0) ? 0 : -1"
      @click="select(o.value)"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
  flex-wrap: wrap;
  max-width: 100%;
  padding: 3px;
  gap: 2px;
  background: var(--bg-1);
  border: 1px solid var(--line-1);
  border-radius: 8px;
}
.seg__opt {
  border: 0;
  background: transparent;
  color: var(--fg-2);
  border-radius: 5px;
  font-weight: 500;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.seg--md .seg__opt { height: 28px; padding: 0 12px; font-size: var(--fs-body); }
.seg--sm .seg__opt { height: 24px; padding: 0 10px; font-size: var(--fs-label); }
.seg--disabled { opacity: 0.45; }
.seg__opt:disabled { cursor: not-allowed; }
.seg__opt:hover:not(:disabled) { color: var(--fg-1); }
.seg__opt[aria-checked='true'] {
  background: var(--sel-bg);
  color: var(--fg-1);
  box-shadow: inset 0 0 0 1px var(--acc-line);
}
/* Declared after the checked shadow so the focus ring is not overridden. */
.seg__opt:focus-visible,
.seg__opt[aria-checked='true']:focus-visible {
  box-shadow: var(--focus-ring);
}
</style>
