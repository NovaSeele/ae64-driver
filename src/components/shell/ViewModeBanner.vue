<script setup lang="ts">
// View-mode banner (DESIGN MKB §9.1): static strip under TopBar while a generic keyboard is connected.
// Announces once per connection via a persistent role="status" region; never re-announced on page change or locale switch.
import { computed, ref, watch } from 'vue';
import { IconEye } from '@tabler/icons-vue';
import Dialog from '../ui/Dialog.vue';
import { useDeviceStore } from '../../stores/device';
import { t } from '../../i18n/vi';

const device = useDeviceStore();
const isGeneric = computed(() => device.connected && device.support === 'generic');
const helpOpen = ref(false);

const announcement = ref('');
let announcedConnection = -1;

// Watch only connection identity/state — intentionally NOT locale or route — so page and language changes never re-announce (M17).
watch(
  () => [device.connection, device.connected, device.support] as const,
  ([conn, connected, support]) => {
    if (connected && support === 'generic') {
      if (conn !== announcedConnection) {
        announcedConnection = conn;
        announcement.value = t('mkb.banner.announce', { name: device.displayName });
      }
    } else {
      announcement.value = '';
    }
  },
  { immediate: true },
);
</script>

<template>
  <div v-if="isGeneric" class="vmb" data-testid="view-mode-banner">
    <IconEye class="vmb__icon" :size="16" stroke-width="1.75" aria-hidden="true" />
    <p class="vmb__text">
      <strong class="vmb__title">{{ t('mkb.banner.title') }}</strong>
      {{ ' — ' }}{{ t('mkb.banner.body', { name: device.displayName }) }}
      <button type="button" class="vmb__why" data-testid="view-mode-why" @click="helpOpen = true">{{ t('mkb.banner.why') }}</button>
    </p>
  </div>
  <span class="sr-only" role="status" data-testid="view-mode-announce">{{ announcement }}</span>
  <Dialog v-model:open="helpOpen" :title="t('help.title')" :width="480">
    <p class="vmb__help">{{ t('help.body') }}</p>
  </Dialog>
</template>

<style scoped>
/* Height reserved before first paint after connect so the page below never jumps (DESIGN MKB §9.1). */
.vmb {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-height: 40px;
  padding: 8px var(--s-6) 8px calc(var(--s-7) - 3px);
  background: var(--bg-2);
  border-left: 3px solid var(--acc);
  border-bottom: 1px solid var(--line-1);
  color: var(--fg-1);
  font-size: var(--fs-label);
  line-height: 18px;
}
.vmb__icon {
  flex: none;
  color: var(--fg-2);
}
.vmb__text {
  margin: 0;
  min-width: 0;
}
.vmb__title {
  font-weight: 600;
}
/* Underlined at all times (WCAG 1.4.1, R15): colour alone does not mark a link. */
.vmb__why {
  margin-left: 6px;
  padding: 0;
  border: 0;
  background: none;
  color: var(--fg-2);
  font: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.vmb__why:hover {
  color: var(--fg-1);
}
.vmb__why:focus-visible {
  outline: none;
  box-shadow: var(--focus-ring);
  border-radius: 3px;
}
.vmb__help {
  margin: 0;
  line-height: 1.55;
  color: var(--fg-2);
}
@media (max-width: 768px) {
  .shell--generic .vmb {
    padding: 8px var(--s-4) 8px calc(var(--s-4) - 3px);
  }
}
</style>
