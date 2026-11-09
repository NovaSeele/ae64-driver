<script setup lang="ts">
const model = defineModel<string>({ required: true });
const props = defineProps<{ items: { id: string; label: string; count?: number; disabled?: boolean }[]; label: string }>();

function onKey(e: KeyboardEvent) {
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const n = props.items.length;
  const i = props.items.findIndex((x) => x.id === model.value);
  let next: (typeof props.items)[number] | undefined;
  for (let step = 1, j = i < 0 ? (d > 0 ? -1 : n) : i; step <= n; step++) { // none selected (search active): start before the first / after the last
    j = (j + d + n) % n;
    if (!props.items[j].disabled) { next = props.items[j]; break; }
  }
  if (!next) return;
  model.value = next.id;
  ((e.currentTarget as HTMLElement).querySelector(`[data-id="${next.id}"]`) as HTMLElement | null)?.focus();
}
</script>

<template>
  <div class="tabs" role="tablist" :aria-label="label" @keydown="onKey">
    <button
      v-for="(it, idx) in items"
      :key="it.id"
      type="button"
      role="tab"
      class="tabs__tab"
      :data-id="it.id"
      :aria-selected="it.id === model"
      :disabled="it.disabled"
      :tabindex="it.id === model || (idx === 0 && !items.some((x) => x.id === model)) ? 0 : -1"
      @click="model = it.id"
    >
      {{ it.label }}<span v-if="it.count != null" class="tabs__n">{{ it.count }}</span>
    </button>
  </div>
</template>

<style scoped>
.tabs { display: flex; flex-wrap: wrap; gap: 0 var(--s-1); border-bottom: 1px solid var(--line-1); }
.tabs__tab {
  position: relative;
  border: 0;
  background: transparent;
  color: var(--fg-3);
  padding: 8px 10px 10px;
  font-size: var(--fs-label);
  font-weight: 500;
  white-space: nowrap;
  transition: color var(--t-fast) var(--ease);
}
.tabs__tab:hover:not(:disabled) { color: var(--fg-1); }
.tabs__tab:disabled { opacity: 0.45; cursor: not-allowed; }
.tabs__tab::after {
  content: '';
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 0;
  height: 2px;
  border-radius: 2px;
  background: var(--acc);
  transform: scaleX(0);
  transition: transform var(--t-med) var(--ease);
}
.tabs__n { margin-left: 6px; color: var(--fg-3); font-weight: 500; font-variant-numeric: tabular-nums; }
.tabs__tab[aria-selected='true'] { color: var(--fg-1); }
.tabs__tab[aria-selected='true']::after { transform: scaleX(1); }
</style>
