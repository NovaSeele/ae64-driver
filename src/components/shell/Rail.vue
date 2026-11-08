<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IconActivity, IconAdjustments, IconHelpCircle, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-vue';
import Dialog from '../ui/Dialog.vue';
import { t } from '../../i18n/vi';

const collapsed = defineModel<boolean>('collapsed', { required: true });
const route = useRoute();
const router = useRouter();
const help = ref(false);
const lastConfig = ref('/performance');

const onLive = computed(() => route.path === '/live');
const removeHook = router.afterEach((to) => { if (to.path !== '/live') lastConfig.value = to.fullPath; });
onBeforeUnmount(removeHook);
</script>

<template>
  <nav class="rail" :aria-label="t('app.name')">
    <div class="rail__mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="28" height="28">
        <rect x="3" y="5" width="26" height="22" rx="6" fill="var(--bg-3)" stroke="var(--acc)" stroke-width="1.6" />
        <path d="M11 21 L16 11 L21 21" fill="none" stroke="var(--acc)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M13.3 17.5h5.4" stroke="var(--acc)" stroke-width="2" stroke-linecap="round" />
      </svg>
    </div>
    <button type="button" class="rail__btn" :class="{ 'rail__btn--on': !onLive }" :aria-current="!onLive ? 'page' : undefined" @click="router.push(lastConfig)">
      <IconAdjustments :size="20" stroke-width="1.5" aria-hidden="true" />
      <span>{{ t('nav.configure') }}</span>
    </button>
    <button type="button" class="rail__btn" :class="{ 'rail__btn--on': onLive }" :aria-current="onLive ? 'page' : undefined" @click="router.push('/live')">
      <IconActivity :size="20" stroke-width="1.5" aria-hidden="true" />
      <span>{{ t('nav.live') }}</span>
    </button>
    <div class="rail__spacer" />
    <button type="button" class="rail__icon" :aria-label="collapsed ? t('nav.expand') : t('nav.collapse')" :title="collapsed ? t('nav.expand') : t('nav.collapse')" @click="collapsed = !collapsed">
      <component :is="collapsed ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse" :size="19" stroke-width="1.5" />
    </button>
    <button type="button" class="rail__icon" :aria-label="t('nav.help')" :title="t('nav.help')" @click="help = true">
      <IconHelpCircle :size="19" stroke-width="1.5" />
    </button>

    <Dialog v-model:open="help" :title="t('help.title')" :width="480">
      <div class="help">
        <p>{{ t('help.body') }}</p>
        <h3 class="micro">{{ t('help.shortcuts') }}</h3>
        <dl>
          <dt><kbd>Ctrl</kbd>+<kbd>Z</kbd> · <kbd>Ctrl</kbd>+<kbd>Y</kbd></dt><dd>{{ t('help.shortcutUndo') }}</dd>
          <dt><kbd>Esc</kbd></dt><dd>{{ t('help.shortcutSelect') }}</dd>
        </dl>
        <p class="help__safe">{{ t('help.safety') }}</p>
      </div>
    </Dialog>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-2);
  width: var(--rail-w);
  padding: var(--s-3) 0;
  background: var(--bg-1);
  border-right: 1px solid var(--line-1);
}
.rail__mark { display: grid; place-items: center; height: 40px; margin-bottom: var(--s-3); }
.rail__btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 48px;
  padding: 7px 0 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-3);
  font-size: 9.5px;
  font-weight: 500;
  line-height: 1.1;
  text-align: center;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.rail__btn:hover { color: var(--fg-1); background: var(--bg-3); }
.rail__btn--on { color: var(--acc); background: var(--acc-soft); }
.rail__spacer { flex: 1; }
.rail__icon {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-3);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.rail__icon:hover { color: var(--fg-1); background: var(--bg-3); }
.help { display: flex; flex-direction: column; gap: var(--s-3); }
.help dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
.help dt { color: var(--fg-1); }
.help dd { margin: 0; }
.help kbd {
  font: inherit;
  font-size: var(--fs-caption);
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  background: var(--bg-3);
}
.help__safe { color: var(--fg-3); font-size: var(--fs-label); }
</style>
