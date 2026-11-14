<script setup lang="ts">
import { computed } from 'vue';
import { IconArrowsExchange, IconPlugConnectedX } from '@tabler/icons-vue';
import IconButton from '../ui/IconButton.vue';
import Segmented from '../ui/Segmented.vue';
import { useCalibrationStore } from '../../stores/calibration';
import { useDeviceStore } from '../../stores/device';
import { useFirmwareStore } from '../../stores/firmware';
import { t } from '../../i18n/vi';
import type { DemoSeed } from '../../protocol/mock';

const props = defineProps<{ compact?: boolean }>();

const device = useDeviceStore();
const calibration = useCalibrationStore();
const calibrating = computed(() => calibration.phase !== 'idle' || device.calibrationLocked());
const firmware = useFirmwareStore();
// Calibrating, or a firmware session / rescue mode (DESIGN FW §3.4): no change of keyboard, model or connection.
const locked = computed(() => calibrating.value || firmware.active);
const calibratingTitle = computed(() => (firmware.active ? t('fw.pill') : calibrating.value ? t('device.calibrating') : undefined));
// Short labels so the three fit the 222 px card; the full name is in the title.
const demoModels = computed(() => [
  { value: 'max' as const, label: t('device.demoMax'), title: 'AE64 Max' },
  { value: 'pro' as const, label: t('device.demoPro'), title: 'AE64 Pro' },
  { value: 'pro-xinput' as const, label: t('device.demoXinput'), title: t('device.demoXinputTitle') },
]);
const demoModel = computed<DemoSeed | null>({
  get: () => device.demoSeed ?? device.model,
  set: (m) => { if (m) void device.switchDemoModel(m); },
});
const name = computed(() => device.modelName ?? device.transport?.productName ?? 'AE64');
const statusText = computed(() => {
  if (device.status === 'connected') return device.demo ? t('device.demo') : t('device.connected');
  if (device.status === 'connecting') return t('device.connecting');
  return t('device.disconnected');
});
const cardTitle = computed(() => (props.compact ? `${name.value} · ${statusText.value}` : undefined));
</script>

<template>
  <div class="dc" :class="{ 'dc--compact': compact }" :title="cardTitle">
    <div class="dc__top">
      <span class="dc__dot" :class="`dc__dot--${device.status}`" aria-hidden="true" />
      <div class="dc__id">
        <div class="dc__name">{{ name }}</div>
        <div class="dc__status">
          {{ statusText }}
          <template v-if="device.connected">
            · <span class="num">{{ device.latencyMs.toFixed(1) }} ms</span>
          </template>
        </div>
      </div>
      <IconButton v-if="device.connected && !compact" :icon="IconArrowsExchange" :label="t('device.changeKeyboard')" size="sm" :disabled="locked" :title="calibratingTitle ?? t('device.changeKeyboard')" @click="device.changeKeyboard()" />
      <IconButton v-if="device.connected && !compact" :icon="IconPlugConnectedX" :label="t('device.disconnect')" size="sm" :disabled="locked" :title="calibratingTitle ?? t('device.disconnect')" @click="device.disconnect({ user: true })" />
    </div>
    <Segmented v-if="device.connected && device.demo && !compact" v-model="demoModel" :options="demoModels" :label="t('device.demoModel')" size="sm" :disabled="locked" :title="calibratingTitle" />
    <dl v-if="device.info && !compact" class="dc__meta">
      <div><dt class="micro">{{ t('device.firmware') }}</dt><dd class="num">{{ device.info.firmware }}</dd></div>
      <div><dt class="micro">{{ t('device.board') }}</dt><dd class="num">{{ device.info.boardIdHex.toUpperCase() }}</dd></div>
    </dl>
  </div>
</template>

<style scoped>
.dc {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-3);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  background: var(--bg-2);
}
.dc--compact {
  padding: 0;
  border: 0;
  background: none;
  height: 32px;
  display: grid;
  place-items: center;
}
.dc__top { display: flex; align-items: center; gap: 10px; }
.dc--compact .dc__top { justify-content: center; }
.dc__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-4);
}
.dc__dot--connected { background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
.dc__dot--connecting { background: var(--warn); animation: pulse 1s ease-in-out infinite; }
.dc__dot--error { background: var(--danger); }
@keyframes pulse { 50% { opacity: 0.35; } }
.dc__id { flex: 1; min-width: 0; }
.dc--compact .dc__id {
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
.dc__name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dc__status { font-size: var(--fs-label); color: var(--fg-3); }
.dc__meta { display: flex; gap: var(--s-5); margin: 0; padding-top: var(--s-2); border-top: 1px solid var(--line-1); }
.dc__meta dd { margin: 2px 0 0; font-size: var(--fs-label); color: var(--fg-2); }
</style>
