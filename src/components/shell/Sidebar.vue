<script setup lang="ts">
import { RouterLink } from 'vue-router';
import DeviceCard from './DeviceCard.vue';
import ProfileSelect from './ProfileSelect.vue';
import SidebarFooter from './SidebarFooter.vue';
import { NAV } from '../../router';
import { useDeviceStore } from '../../stores/device';
import { t } from '../../i18n/vi';

const compact = defineModel<boolean>('compact', { default: false });
const device = useDeviceStore();
</script>

<template>
  <aside class="side" :class="{ 'side--compact': compact }">
    <DeviceCard :compact="compact" />
    <ProfileSelect v-if="device.connected && device.profileNames.length" :compact="compact" />
    <nav class="side__nav" data-shellnav :aria-label="t('nav.configure')">
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
          :title="compact ? t(it.title) : undefined"
          :style="{ '--f': it.tone }"
        >
          <span class="tile"><component :is="it.icon" :size="18" stroke-width="1.5" aria-hidden="true" /></span>
          <span>{{ t(it.title) }}</span>
        </RouterLink>
      </div>
    </nav>
    <SidebarFooter v-model:compact="compact" />
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
.side--compact {
  width: var(--rail-w);
  padding: var(--s-3) 8px;
  gap: var(--s-3);
  overflow-x: hidden;
}
.side__nav { display: flex; flex-direction: column; gap: var(--s-4); }
.side--compact .side__nav { gap: var(--s-2); }
.side__group { display: flex; flex-direction: column; gap: 2px; }
.side__label { padding: 0 8px 6px; }
.side--compact .side__label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.side--compact .side__group + .side__group {
  border-top: 1px solid var(--line-1);
  padding-top: var(--s-2);
}
.side__link {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 8px;
  border-radius: var(--r-control);
  color: var(--fg-2);
  font-weight: 500;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.side--compact .side__link {
  justify-content: center;
  padding: 0;
  height: 36px;
}
.side--compact .side__link > span:not(.tile) {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.tile {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--f) 16%, transparent);
  color: var(--f);
}
.side__link:hover { background: var(--bg-2); color: var(--fg-1); }
.side__link--on { background: var(--sel-bg); color: var(--fg-1); font-weight: 600; }
.side__link--on .tile { background: color-mix(in srgb, var(--acc) 16%, transparent); color: var(--acc); }
.side__link[aria-disabled='true'] { opacity: 0.4; pointer-events: none; }
</style>
