<script setup lang="ts">
const model = defineModel<string>({ required: true });
const props = defineProps<{ items: { id: string; label: string }[]; label: string }>();

function onKey(e: KeyboardEvent) {
  const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  const n = props.items.length;
  const i = props.items.findIndex((x) => x.id === model.value);
  const next = props.items[i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n]; // none selected (search active)
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
      :tabindex="it.id === model || (idx === 0 && !items.some((x) => x.id === model)) ? 0 : -1"
      @click="model = it.id"
    >
      {{ it.label }}
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
.tabs__tab:hover { color: var(--fg-1); }
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
.tabs__tab[aria-selected='true'] { color: var(--fg-1); }
.tabs__tab[aria-selected='true']::after { transform: scaleX(1); }
</style>
