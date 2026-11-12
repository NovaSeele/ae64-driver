<script setup lang="ts">
import { useSelectionStore } from '../../stores/selection';
import Button from '../ui/Button.vue';
import { t } from '../../i18n/vi';

const sel = useSelectionStore();
</script>

<template>
  <div class="sb">
    <slot name="lead">
      <span class="sb__count" :class="{ 'sb__count--on': sel.count > 0 }" aria-live="polite">
        <span class="num">{{ sel.count ? t('sel.count', { n: sel.count }) : t('sel.none') }}</span>
      </span>
    </slot>
    <slot name="hint"><span class="sb__hint">{{ t('sel.hint') }}</span></slot>
    <div class="sb__actions">
      <Button size="sm" variant="ghost" @click="sel.wasd()">{{ t('sel.wasd') }}</Button>
      <Button size="sm" variant="ghost" @click="sel.all()">{{ t('sel.all') }}</Button>
      <Button size="sm" variant="ghost" :disabled="!sel.count" @click="sel.clear()">{{ t('sel.clear') }}</Button>
      <Button size="sm" variant="ghost" @click="sel.invert()">{{ t('sel.invert') }}</Button>
    </div>
  </div>
</template>

<style scoped>
.sb {
  display: flex;
  align-items: center;
  gap: var(--s-4);
  min-height: 36px;
}
.sb__count {
  flex: none;
  font-weight: 500;
  color: var(--fg-3);
  transition: color var(--t-fast) var(--ease);
}
.sb__count--on { color: var(--fg-1); }
.sb__hint {
  flex: 1;
  min-width: 0;
  color: var(--fg-4);
  font-size: var(--fs-label);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb__actions { display: flex; gap: 2px; flex: none; }
</style>
