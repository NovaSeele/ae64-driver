<script setup lang="ts">
import type { Component } from 'vue';

withDefaults(defineProps<{
  icon: Component;
  /** Required accessible name (also the native tooltip). */
  label: string;
  size?: 'sm' | 'md';
  active?: boolean;
  disabled?: boolean;
}>(), { size: 'md', active: undefined });
</script>

<template>
  <button
    type="button"
    class="ibtn"
    :class="[`ibtn--${size}`, { 'ibtn--active': active }]"
    :aria-label="label"
    :title="label"
    :aria-pressed="active"
    :disabled="disabled"
  >
    <component :is="icon" :size="size === 'sm' ? 16 : 18" stroke-width="1.5" aria-hidden="true" />
  </button>
</template>

<style scoped>
.ibtn {
  display: inline-grid;
  place-items: center;
  flex: none;
  border: 1px solid transparent;
  border-radius: var(--r-control);
  background: transparent;
  color: var(--fg-2);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.ibtn--sm { width: 28px; height: 28px; }
.ibtn--md { width: 34px; height: 34px; }
.ibtn:hover:not(:disabled) { background: var(--bg-3); color: var(--fg-1); }
.ibtn:active:not(:disabled) { transform: translateY(1px); background: var(--bg-4); }
.ibtn:disabled { opacity: 0.35; cursor: not-allowed; }
.ibtn--active { color: var(--acc); background: var(--acc-soft); }
</style>
