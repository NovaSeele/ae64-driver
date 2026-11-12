<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconLoader2 } from '@tabler/icons-vue';
import Sidebar from './components/shell/Sidebar.vue';
import TopBar from './components/shell/TopBar.vue';
import ConnectScreen from './components/shell/ConnectScreen.vue';
import ToastHost from './components/ui/Toast.vue';
import { useDeviceStore } from './stores/device';
import { useHistoryStore } from './stores/history';
import { useSettingsStore } from './stores/settings';
import { t } from './i18n/vi';

const SIDEBAR_KEY = 'ae64.sidebarCollapsed';
const device = useDeviceStore();
const history = useHistoryStore();
const settings = useSettingsStore();
// The keyboard restarts its USB interface after a polling-rate change: keep the page and say so.
const usbRestarting = computed(() => settings.pollingState === 'applying' || settings.pollingState === 'reconnecting');
const collapsed = ref(localStorage.getItem(SIDEBAR_KEY) === '1');
watch(collapsed, (v) => localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0'));

// Below this width the sidebar folds into the rail so the page keeps its room.
const NARROW_QUERY = '(max-width: 1249px)';
let narrowMql: MediaQueryList | null = null;
const onNarrow = (e: MediaQueryListEvent) => { if (e.matches) collapsed.value = true; };

let removeShortcuts: (() => void) | null = null;
onMounted(() => {
  removeShortcuts = history.installShortcuts();
  if (typeof window.matchMedia === 'function') {
    narrowMql = window.matchMedia(NARROW_QUERY);
    if (narrowMql.matches) collapsed.value = true;
    narrowMql.addEventListener('change', onNarrow);
  }
  void device.tryAutoReconnect();
});
onBeforeUnmount(() => {
  removeShortcuts?.();
  narrowMql?.removeEventListener('change', onNarrow);
});
</script>

<template>
  <div class="shell" :class="{ 'shell--collapsed': collapsed }">
    <Sidebar v-model:compact="collapsed" />
    <main class="main">
      <template v-if="device.connected || usbRestarting">
        <TopBar />
        <div class="main__scroll">
          <RouterView v-slot="{ Component, route }">
            <Transition name="page" mode="out-in">
              <component :is="Component" :key="route.path" />
            </Transition>
          </RouterView>
        </div>
      </template>
      <ConnectScreen v-else />
      <div v-if="usbRestarting" class="main__wait" role="status" aria-live="polite">
        <IconLoader2 class="main__spin" :size="22" stroke-width="1.5" aria-hidden="true" />
        <span>{{ t('settings.pollingOverlay') }}</span>
      </div>
    </main>
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  min-width: 1044px;
}
.shell--collapsed { min-width: 900px; }
.main {
  position: relative;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background-color: var(--bg-0);
  background-image: var(--bg-art);
}
.main__scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding-bottom: var(--toast-safe, 0px);
}
.main__wait {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--s-3);
  background: var(--glass);
  backdrop-filter: blur(2px);
  color: var(--fg-1);
  font-size: var(--fs-card);
}
.main__spin { color: var(--acc); animation: main-spin 0.9s linear infinite; }
@keyframes main-spin { to { transform: rotate(360deg); } }
</style>
