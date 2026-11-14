<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { IconLoader2 } from '@tabler/icons-vue';
import Sidebar from './components/shell/Sidebar.vue';
import TopBar from './components/shell/TopBar.vue';
import ConnectScreen from './components/shell/ConnectScreen.vue';
import Wallpaper from './components/shell/Wallpaper.vue';
import { startWallpaper } from './data/wallpaperState';
import ToastHost from './components/ui/Toast.vue';
import { useRoute } from 'vue-router';
import { createSafePad, toastSafeTarget, useToast } from './components/ui/toast';
import { takeAppcfgDone } from './data/appcfgDone';
import { useDeviceStore } from './stores/device';
import { useGamepadStore } from './stores/gamepad';
import { useHistoryStore } from './stores/history';
import { useSettingsStore } from './stores/settings';
import { t } from './i18n/vi';

const SIDEBAR_KEY = 'ae64.sidebarCollapsed';
const device = useDeviceStore();
const history = useHistoryStore();
const settings = useSettingsStore();
// The keyboard restarts its USB interface after a polling-rate change: keep the page and say so.
const usbRestarting = computed(() => settings.pollingState === 'applying' || settings.pollingState === 'reconnecting');
// Showing / hiding the Xbox controller re-enumerates the keyboard: the Gamepad page stays (busy) until it is back.
const gamepad = useGamepadStore();
const keepPage = computed(() => usbRestarting.value || gamepad.usbBusy);
const collapsed = ref(localStorage.getItem(SIDEBAR_KEY) === '1');
watch(collapsed, (v) => localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0'));

// Below this width the sidebar folds into the rail so the page keeps its room.
const NARROW_QUERY = '(max-width: 1249px)';
let narrowMql: MediaQueryList | null = null;
const onNarrow = (e: MediaQueryListEvent) => { if (e.matches) collapsed.value = true; };

// Toast spacer at the bottom of the page scroller: kept while on screen when a toast closes, so the page never jumps.
const scroller = ref<HTMLElement | null>(null);
const safePad = ref(0);
const pad = createSafePad(() => scroller.value, (px) => { safePad.value = px; });
watch(toastSafeTarget, (v) => pad.setTarget(v));
const route = useRoute();
watch(() => route.path, () => pad.reset());
/**
 * A new page (path) starts at the top: the scroller is reset once the old page has left and before the new one is
 * inserted, so the old page is not pulled up while it fades and a page that scrolls itself on mount (a deep link, the
 * live page's ?check=1) still does. A query change (a tab, ?key=) keeps the scroll: the page is the same component.
 */
function pageToTop(): void {
  if (scroller.value) scroller.value.scrollTop = 0;
}

let removeShortcuts: (() => void) | null = null;
onMounted(() => {
  // An app-settings import or reset just reloaded the page (DESIGN H §3.6): say it worked, once.
  const done = takeAppcfgDone();
  if (done) useToast().show(t(done === 'import' ? 'appcfg.doneImport' : 'appcfg.doneReset'), 'success');
  removeShortcuts = history.installShortcuts();
  if (typeof window.matchMedia === 'function') {
    narrowMql = window.matchMedia(NARROW_QUERY);
    if (narrowMql.matches) collapsed.value = true;
    narrowMql.addEventListener('change', onNarrow);
  }
  void device.tryAutoReconnect();
  // The wallpaper (DESIGN J §5.7): read from IndexedDB after the first page is painted, never before.
  void startWallpaper();
});
onBeforeUnmount(() => {
  removeShortcuts?.();
  pad.stop();
  narrowMql?.removeEventListener('change', onNarrow);
});
</script>

<template>
  <div class="shell" :class="{ 'shell--collapsed': collapsed }">
    <Sidebar v-model:compact="collapsed" />
    <main class="main">
      <Wallpaper />
      <template v-if="device.connected || keepPage">
        <TopBar />
        <div ref="scroller" class="main__scroll" :style="{ paddingBottom: `${safePad}px`, scrollPaddingBottom: `${toastSafeTarget}px` }">
          <RouterView v-slot="{ Component, route }">
            <Transition name="page" mode="out-in" @before-enter="pageToTop">
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
  /* its own stacking context: the wallpaper (z-index -1) sits above this background and below every other child (DESIGN J §3.5) */
  isolation: isolate;
}
.main__scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
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
