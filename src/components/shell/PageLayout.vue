<script setup lang="ts">
// Page frame: optional keyboard block (keyboard + aside chips + selection bar) above the editor panels.
// Pages pass their own <KeyboardView> in the `keyboard` slot; without it a plain selectable keyboard
// with live legends is shown.
import { watchEffect } from 'vue';
import KeyboardView from '../keyboard/KeyboardView.vue';
import SelectionBar from '../keyboard/SelectionBar.vue';
import { useDeviceStore } from '../../stores/device';
import { t } from '../../i18n/vi';

const props = defineProps<{ title: string; keyboard?: boolean }>();
const device = useDeviceStore();

watchEffect(() => {
  document.title = `${props.title} · ${t('app.name')}`;
});
</script>

<template>
  <div class="page">
    <h1 class="sr-only">{{ title }}</h1>
    <div v-if="$slots.toolbar" class="page__toolbar"><slot name="toolbar" /></div>
    <section v-if="keyboard" class="page__kb">
      <div class="page__kbrow">
        <div class="page__board">
          <slot name="keyboard">
            <KeyboardView :keys="device.keys" :legend="device.legend" selectable />
          </slot>
        </div>
        <aside v-if="$slots['keyboard-aside']" class="page__aside"><slot name="keyboard-aside" /></aside>
      </div>
      <SelectionBar />
    </section>
    <div class="page__panels"><slot /></div>
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
  padding: var(--s-6) var(--s-7) var(--s-8);
  max-width: 1280px;
  margin: 0 auto;
  width: 100%;
}
.page__toolbar { display: flex; align-items: center; justify-content: flex-end; gap: var(--s-2); flex-wrap: wrap; }
.page__kb { display: flex; flex-direction: column; gap: var(--s-3); }
.page__kbrow { display: flex; gap: var(--s-5); align-items: flex-start; }
.page__board { flex: 1; min-width: 0; max-width: 940px; margin: 0 auto; }
.page__aside { flex: none; width: 168px; display: flex; flex-direction: column; gap: var(--s-2); }
.page__panels { min-width: 0; }

@media (min-width: 1600px) {
  .page { max-width: 1560px; }
  .page__board { max-width: 1100px; }
  .page__aside { width: 196px; }
}

@media (max-width: 1360px) {
  .page { padding: var(--s-5) var(--s-6) var(--s-7); }
  .page__kbrow { flex-direction: column-reverse; align-items: stretch; }
  .page__aside { width: auto; flex-direction: row; flex-wrap: wrap; justify-content: flex-end; }
  .page__board { width: 100%; }
}
</style>
