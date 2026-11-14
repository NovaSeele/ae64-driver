<script setup lang="ts">
import type { Component } from 'vue';
import { t } from '../../i18n/vi';

withDefaults(defineProps<{ icon: Component; title?: string; body?: string }>(), {});
</script>

<template>
  <div class="empty">
    <div class="empty__icon">
      <component :is="icon" :size="28" stroke-width="1.5" aria-hidden="true" />
    </div>
    <h2 class="empty__title">{{ title ?? t('page.wip') }}</h2>
    <p class="empty__body">{{ body ?? t('page.wipBody') }}</p>
    <slot />
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--s-3);
  padding: 72px var(--s-6);
  border: 1px dashed var(--line-2);
  border-radius: var(--r-panel);
  background: radial-gradient(ellipse at top, color-mix(in srgb, var(--acc) 5%, transparent), transparent 60%);
}
.empty__icon {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid var(--line-2);
  color: var(--acc);
  margin-bottom: var(--s-2);
}
.empty__title { font-size: var(--fs-section); }
.empty__body { max-width: 420px; color: var(--fg-2); }
</style>
