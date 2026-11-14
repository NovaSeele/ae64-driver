<script setup lang="ts">
// Modal dialog: teleported, Esc / backdrop closes, focus moves in and returns to the opener.
import { nextTick, onDeactivated, ref, useId, watch } from 'vue';
import { IconX } from '@tabler/icons-vue';
import IconButton from './IconButton.vue';
import { t } from '../../i18n/vi';

const open = defineModel<boolean>('open', { required: true });
// A page or tab kept alive and hidden (KeepAlive) closes what it had open: no overlay of a hidden tab (DESIGN E §3.6).
onDeactivated(() => { open.value = false; });
/** `describe`: the body is the dialog's description (aria-describedby), so a screen reader reads it after the title; off
 *  by default (a body with a form would be read whole on every open). DESIGN L §3.1. */
withDefaults(defineProps<{ title: string; width?: number; describe?: boolean }>(), { width: 460, describe: false });

const panel = ref<HTMLElement | null>(null);
const titleId = useId();
const bodyId = useId();
let opener: HTMLElement | null = null;

watch(open, async (v) => {
  if (v) {
    opener = document.activeElement as HTMLElement | null;
    await nextTick();
    (panel.value?.querySelector<HTMLElement>('[autofocus], input, button:not(.dlg__close), [tabindex="0"]') ?? panel.value)?.focus();
  } else opener?.focus?.();
});

function trap(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.stopPropagation(); open.value = false; return; }
  if (e.key !== 'Tab' || !panel.value) return;
  const f = [...panel.value.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')].filter((el) => !el.hasAttribute('disabled'));
  if (!f.length) return;
  const first = f[0];
  const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="dlg">
      <div v-if="open" class="dlg" @pointerdown.self="open = false">
        <div
          ref="panel"
          class="dlg__panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :aria-describedby="describe ? bodyId : undefined"
          tabindex="-1"
          :style="{ width: `${width}px` }"
          @keydown="trap"
        >
          <header class="dlg__head">
            <h2 :id="titleId" class="dlg__title">{{ title }}</h2>
            <IconButton class="dlg__close" :icon="IconX" :label="t('ui.close')" size="sm" @click="open = false" />
          </header>
          <div :id="describe ? bodyId : undefined" class="dlg__body"><slot /></div>
          <footer v-if="$slots.footer" class="dlg__foot"><slot name="footer" /></footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.dlg {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: grid;
  place-items: center;
  background: var(--scrim);
  backdrop-filter: blur(3px);
}
.dlg__panel {
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--r-panel);
  box-shadow: var(--shadow-case);
}
.dlg__head { display: flex; align-items: center; justify-content: space-between; padding: 18px 20px 0; }
.dlg__title { font-size: var(--fs-section); }
.dlg__body { padding: 16px 20px 20px; color: var(--fg-2); }
.dlg__foot { display: flex; justify-content: flex-end; gap: var(--s-2); padding: 0 20px 20px; }
.dlg-enter-active, .dlg-leave-active { transition: opacity var(--t-med) var(--ease); }
.dlg-enter-active .dlg__panel, .dlg-leave-active .dlg__panel { transition: transform var(--t-med) var(--ease); }
.dlg-enter-from, .dlg-leave-to { opacity: 0; }
.dlg-enter-from .dlg__panel { transform: translateY(8px) scale(0.98); }
</style>
