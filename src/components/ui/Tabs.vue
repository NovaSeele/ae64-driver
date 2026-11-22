<script setup lang="ts">
import type { Component } from 'vue';

export interface TabItem {
  id: string;
  label: string;
  count?: number;
  icon?: Component;
  /** Draws a 1 px divider before this tab to set it apart from the preceding group. */
  apart?: boolean;
}

const model = defineModel<string>({ required: true });
const props = defineProps<{ items: TabItem[]; label: string }>();

// ARIA tabs keyboard: ←/→ wrap, Home/End jump to the first/last tab (same as FeatureSwitch; Tabs has no disabled items).
function onKey(e: KeyboardEvent) {
  const n = props.items.length;
  if (!n) return;
  const i = props.items.findIndex((x) => x.id === model.value);
  let next: (typeof props.items)[number];
  if (e.key === 'Home') next = props.items[0];
  else if (e.key === 'End') next = props.items[n - 1];
  else {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    next = props.items[i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n]; // none selected (search active)
  }
  e.preventDefault();
  model.value = next.id;
  ((e.currentTarget as HTMLElement).querySelector(`[data-id="${next.id}"]`) as HTMLElement | null)?.focus();
}
</script>

<template>
  <div class="tabs" role="tablist" :aria-label="label" @keydown="onKey">
    <template v-for="(it, idx) in items" :key="it.id">
      <span v-if="it.apart" class="tabs__sep" aria-hidden="true" />
      <button
        type="button"
        role="tab"
        class="tabs__tab"
        :data-id="it.id"
        :aria-selected="it.id === model"
        :tabindex="it.id === model || (idx === 0 && !items.some((x) => x.id === model)) ? 0 : -1"
        @click="model = it.id"
      >
        <component :is="it.icon" v-if="it.icon" class="tabs__icon" :size="15" aria-hidden="true" />{{ it.label }}<span v-if="it.count != null" class="tabs__n">{{ it.count }}</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.tabs { display: flex; flex-wrap: wrap; gap: 0 var(--s-1); border-bottom: 1px solid var(--line-1); }
.tabs__sep { align-self: stretch; width: 1px; margin: 6px var(--s-2); background: var(--line-2); flex: none; }
.tabs__icon { width: 15px; height: 15px; margin-right: 5px; vertical-align: -2px; }
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
.tabs__n { margin-left: 6px; color: var(--fg-3); font-weight: 500; font-variant-numeric: tabular-nums; }
.tabs__tab[aria-selected='true'] { color: var(--fg-1); }
.tabs__tab[aria-selected='true']::after { transform: scaleX(1); }
</style>
