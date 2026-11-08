<script setup lang="ts" generic="T extends string | number">
const model = defineModel<T | null>({ required: true });
const props = withDefaults(defineProps<{
  options: { value: T; label: string; title?: string }[];
  label: string;
  size?: 'sm' | 'md';
}>(), { size: 'md' });

function onKey(e: KeyboardEvent) {
  const opts = props.options;
  const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const i = opts.findIndex((o) => o.value === model.value);
  const next = opts[(Math.max(i, 0) + d + opts.length) % opts.length];
  model.value = next.value;
  ((e.currentTarget as HTMLElement).querySelector(`[data-v="${String(next.value)}"]`) as HTMLElement | null)?.focus();
}
</script>

<template>
  <div class="seg" :class="`seg--${size}`" role="radiogroup" :aria-label="label" @keydown="onKey">
    <button
      v-for="(o, i) in options"
      :key="String(o.value)"
      type="button"
      role="radio"
      class="seg__opt"
      :data-v="String(o.value)"
      :title="o.title"
      :aria-checked="o.value === model"
      :tabindex="o.value === model || (model === null && i === 0) ? 0 : -1"
      @click="model = o.value"
    >
      {{ o.label }}
    </button>
  </div>
</template>

<style scoped>
.seg {
  display: inline-flex;
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
.seg__opt:hover { color: var(--fg-1); }
.seg__opt[aria-checked='true'] {
  background: var(--bg-4);
  color: var(--fg-1);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 1px 2px rgba(0, 0, 0, 0.3);
}
</style>
