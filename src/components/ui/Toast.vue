<script setup lang="ts">
// Toast host — mount once (App.vue). Show toasts with useToast().show(text, kind).
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX } from '@tabler/icons-vue';
import { useToast } from './toast';
import { t } from '../../i18n/vi';

const { items, dismiss } = useToast();
const ICONS = { info: IconInfoCircle, success: IconCircleCheck, warn: IconAlertTriangle, error: IconAlertTriangle };
</script>

<template>
  <div class="toasts">
    <TransitionGroup name="toast">
      <div v-for="it in items" :key="it.id" class="toast" :class="`toast--${it.kind}`" :role="it.kind === 'error' ? 'alert' : 'status'">
        <component :is="ICONS[it.kind]" class="toast__icon" :size="18" stroke-width="1.5" aria-hidden="true" />
        <span class="toast__text" :class="{ 'toast__text--clip': it.title }" :title="it.title">{{ it.text }}</span>
        <button v-if="it.action" type="button" class="toast__act" :aria-label="it.action.ariaLabel" @click="it.action.run(); dismiss(it.id)">{{ it.action.label }}</button>
        <button type="button" class="toast__x" :aria-label="t('ui.close')" @click="dismiss(it.id)">
          <IconX :size="14" stroke-width="1.5" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 200;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--s-2);
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  max-width: 420px;
  padding: 10px 10px 10px 14px;
  border-radius: var(--r-card);
  background: var(--bg-3);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow-pop);
}
.toast__icon { flex: none; color: var(--info); }
.toast--success .toast__icon { color: var(--ok); }
.toast--warn .toast__icon { color: var(--warn); }
.toast--error .toast__icon { color: var(--danger); }
.toast__text { font-size: var(--fs-body); color: var(--fg-1); }
.toast__text--clip { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast__act {
  flex: none;
  height: 24px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--r-control);
  background: transparent;
  color: var(--acc);
  font-size: var(--fs-body);
  font-weight: 600;
}
.toast__act:hover { background: var(--acc-soft); }
.toast__x {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 0;
  border-radius: var(--r-control);
  background: transparent;
  color: var(--fg-3);
}
.toast__x:hover { color: var(--fg-1); background: var(--bg-4); }
.toast-enter-active, .toast-leave-active { transition: opacity var(--t-slow) var(--ease), transform var(--t-slow) var(--ease); }
.toast-enter-from { opacity: 0; transform: translateY(8px); }
.toast-leave-to { opacity: 0; transform: translateX(12px); }
</style>
