<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Rail from './components/shell/Rail.vue';
import Sidebar from './components/shell/Sidebar.vue';
import TopBar from './components/shell/TopBar.vue';
import ConnectScreen from './components/shell/ConnectScreen.vue';
import ToastHost from './components/ui/Toast.vue';
import { useDeviceStore } from './stores/device';
import { useHistoryStore } from './stores/history';

const SIDEBAR_KEY = 'ae64.sidebarCollapsed';
const device = useDeviceStore();
const history = useHistoryStore();
const collapsed = ref(localStorage.getItem(SIDEBAR_KEY) === '1');
watch(collapsed, (v) => localStorage.setItem(SIDEBAR_KEY, v ? '1' : '0'));

let removeShortcuts: (() => void) | null = null;
onMounted(() => {
  removeShortcuts = history.installShortcuts();
  void device.tryAutoReconnect();
});
onBeforeUnmount(() => removeShortcuts?.());
</script>

<template>
  <div class="shell" :class="{ 'shell--collapsed': collapsed }">
    <Rail v-model:collapsed="collapsed" />
    <Transition name="side">
      <Sidebar v-show="!collapsed" />
    </Transition>
    <main class="main">
      <template v-if="device.connected">
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
    </main>
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  height: 100%;
  min-width: 1100px;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-0);
}
.main__scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
}
.side-enter-active, .side-leave-active { transition: opacity var(--t-med) var(--ease), transform var(--t-med) var(--ease); }
.side-enter-from, .side-leave-to { opacity: 0; transform: translateX(-8px); }
</style>
