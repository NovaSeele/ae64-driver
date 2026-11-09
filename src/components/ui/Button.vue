<script setup lang="ts">
import type { Component } from 'vue';

withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: Component;
  loading?: boolean;
  disabled?: boolean;
  block?: boolean;
  type?: 'button' | 'submit';
}>(), { variant: 'secondary', size: 'md', type: 'button' });
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[`btn--${variant}`, `btn--${size}`, { 'btn--block': block }]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="spinner" aria-hidden="true" />
    <component :is="icon" v-else-if="icon" class="btn__icon" :size="size === 'sm' ? 15 : 17" stroke-width="1.5" aria-hidden="true" />
    <span v-if="$slots.default" class="btn__label"><slot /></span>
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  border: 1px solid transparent;
  border-radius: var(--r-control);
  font-weight: 500;
  white-space: nowrap;
  user-select: none;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease),
    color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn--block { width: 100%; }

.btn--sm { height: 28px; padding: 0 10px; font-size: var(--fs-label); }
.btn--md { height: 34px; padding: 0 14px; font-size: var(--fs-body); }
.btn--lg { height: 44px; padding: 0 22px; font-size: 14px; border-radius: 8px; }

.btn--primary { background: var(--acc); color: var(--on-acc); }
.btn--primary:hover:not(:disabled) { background: var(--acc-hover); }
.btn--primary:active:not(:disabled) { background: var(--acc-hover); }

.btn--secondary { background: var(--bg-3); border-color: var(--line-2); color: var(--fg-1); }
.btn--secondary:hover:not(:disabled) { background: var(--bg-4); border-color: var(--line-3); }

.btn--ghost { background: transparent; color: var(--fg-2); }
.btn--ghost:hover:not(:disabled) { background: var(--bg-3); color: var(--fg-1); }

.btn--danger { background: var(--danger-soft); color: var(--danger); border-color: var(--danger-line); }
.btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 22%, transparent); }

.btn__icon { flex: none; }
.spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: spin 0.7s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
