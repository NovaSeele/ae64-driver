<script setup lang="ts">
import { RouterLink } from 'vue-router';
import DeviceCard from './DeviceCard.vue';
import ProfileSelect from './ProfileSelect.vue';
import { NAV } from '../../router';
import { useDeviceStore } from '../../stores/device';
import { t } from '../../i18n/vi';

const device = useDeviceStore();
</script>

<template>
  <aside class="side">
    <DeviceCard />
    <ProfileSelect v-if="device.connected && device.profileNames.length" />
    <nav class="side__nav" :aria-label="t('nav.configure')">
      <div v-for="g in NAV" :key="g.group" class="side__group">
        <div class="micro side__label">{{ t(g.group) }}</div>
        <RouterLink
          v-for="it in g.items"
          :key="it.path"
          :to="it.path"
          class="side__link"
          active-class="side__link--on"
          :tabindex="device.connected ? 0 : -1"
          :aria-disabled="!device.connected || undefined"
        >
          <component :is="it.icon" :size="18" stroke-width="1.5" aria-hidden="true" />
          <span>{{ t(it.title) }}</span>
        </RouterLink>
      </div>
    </nav>
  </aside>
</template>

<style scoped>
.side {
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
  width: var(--sidebar-w);
  padding: var(--s-3);
  background: var(--bg-1);
  border-right: 1px solid var(--line-1);
  overflow-y: auto;
}
.side__nav { display: flex; flex-direction: column; gap: var(--s-4); }
.side__group { display: flex; flex-direction: column; gap: 2px; }
.side__label { padding: 0 8px 6px; }
.side__link {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--r-control);
  color: var(--fg-2);
  font-weight: 500;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.side__link:hover { background: var(--bg-3); color: var(--fg-1); }
.side__link--on { background: var(--acc-soft); color: var(--acc); }
.side__link[aria-disabled='true'] { opacity: 0.4; pointer-events: none; }
</style>
