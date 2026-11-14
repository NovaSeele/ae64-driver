<script setup lang="ts">
// Settings page: system mode, polling rate, RGB sleep, shake optimization, profile names (a link to the Profiles page), hardware info.
import { computed, onMounted, ref } from 'vue';
import { IconArrowRight, IconRefresh } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import Card from '../components/ui/Card.vue';
import Segmented from '../components/ui/Segmented.vue';
import Switch from '../components/ui/Switch.vue';
import NumberField from '../components/ui/NumberField.vue';
import Button from '../components/ui/Button.vue';
import Dialog from '../components/ui/Dialog.vue';
import ThemePicker from '../components/settings/ThemePicker.vue';
import AccentPicker from '../components/settings/AccentPicker.vue';
import WallpaperCard from '../components/settings/WallpaperCard.vue';
import CopyInfo from '../components/settings/CopyInfo.vue';
import DataLocation from '../components/settings/DataLocation.vue';
import { POLLING_RATE_HZ } from '../protocol';
import { useDeviceStore } from '../stores/device';
import { useSettingsStore } from '../stores/settings';
import { zoomModifier, currentPlatform } from '../components/ui/zoomHint';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const settings = useSettingsStore();

// Controls stay disabled until the values were read from the keyboard (not the built-in defaults),
// on read-only boards, and while the USB restart after a polling-rate change is in progress.
const ready = computed(() => settings.loaded && !settings.loadError);
const busy = computed(() => settings.pollingState === 'applying' || settings.pollingState === 'reconnecting');
const locked = computed(() => !ready.value || !device.boardAllowed || busy.value);

onMounted(() => {
  if (!settings.loaded) void settings.load();
});

const systemModeOptions = computed(() => [
  { value: 0, label: t('settings.systemModeWin') },
  { value: 1, label: t('settings.systemModeMac') },
]);

const rateLabel = (r: number) => `${POLLING_RATE_HZ[r] ?? r} Hz`;

const pollingRateOptions = computed(() =>
  settings.supportedRates.map((r) => ({
    value: r,
    label: String(POLLING_RATE_HZ[r] ?? r),
    ariaLabel: rateLabel(r),
  })),
);

const sleepPresets = [0, 5, 10, 15, 30];

// Polling rate restarts the keyboard's USB connection: arrows only move focus, a pick needs confirmation.
const pendingRate = ref<number | null>(null);
const confirmOpen = ref(false);
const shownRate = computed(() => settings.pollingTarget ?? settings.pollingRate);

function askPollingRate(v: number | null) {
  if (v === null || v === settings.pollingRate || locked.value) return;
  pendingRate.value = v;
  confirmOpen.value = true;
}

function confirmPollingRate() {
  const rate = pendingRate.value;
  confirmOpen.value = false;
  if (rate !== null) void settings.setPollingRate(rate);
}

const lightingDetails = computed(() => {
  const strip = settings.lightingAreas?.areas.find((a) => a.leds !== undefined)?.leds ?? 38;
  return `${t('settings.lightingAreaKeys')}, ${t('settings.lightingAreaStrip', { leds: strip })}`;
});

const shakeModel = computed({
  get: () => settings.shakeOptimization,
  set: (v: boolean) => settings.setShakeOptimization(v),
});
</script>

<template>
  <PageLayout :title="t('page.settings')">
    <p v-if="!device.boardAllowed" class="settings-warn" role="note">{{ t('settings.readOnly') }}</p>

    <!-- Appearance: app preference only, always available (no device access) -->
    <div class="settings-appearance">
      <Card :title="t('settings.appearance')" :subtitle="t('settings.appearanceDesc')">
        <ThemePicker />
        <p class="settings-note">{{ t('settings.zoomHint', { mod: zoomModifier(currentPlatform()) }) }}</p>
        <AccentPicker />
      </Card>
      <WallpaperCard />
    </div>

    <!-- load error -->
    <template v-if="settings.loadError">
      <Card :title="t('settings.loadFailed')" :subtitle="settings.loadError">
        <div><Button :icon="IconRefresh" :loading="settings.loading" @click="settings.load()">{{ t('settings.reload') }}</Button></div>
      </Card>
      <!-- resetting the app settings is what helps most when something is broken (DESIGN H §3.3) -->
      <div class="settings-grid settings-grid--after"><DataLocation /></div>
    </template>

    <!-- loading skeleton -->
    <div v-else-if="!settings.loaded" class="settings-grid" aria-busy="true">
      <p class="settings-loading">{{ t('settings.loading') }}</p>
      <div v-for="i in 4" :key="i" class="settings-skel">
        <div class="skeleton" style="width: 40%; height: 14px" />
        <div class="skeleton" style="height: 32px" />
      </div>
    </div>

    <div v-else class="settings-grid">
      <!-- System mode -->
      <Card :title="t('settings.systemMode')" :subtitle="t('settings.systemModeDesc')">
        <div>
          <Segmented
            :model-value="settings.systemMode"
            :options="systemModeOptions"
            :label="t('settings.systemMode')"
            :disabled="locked"
            @update:model-value="(v) => v !== null && settings.setSystemMode(v)"
          />
        </div>
      </Card>

      <!-- Polling rate -->
      <Card :title="t('settings.pollingRate')" :subtitle="t('settings.pollingRateDesc')">
        <div>
          <div class="settings-rate">
            <Segmented
              :model-value="shownRate"
              :options="pollingRateOptions"
              :label="t('settings.pollingRate')"
              size="sm"
              manual
              :disabled="locked"
              @update:model-value="askPollingRate"
            />
            <span class="settings-rate__unit">Hz</span>
          </div>
          <p class="settings-note">{{ t('settings.pollingNote') }}</p>
          <p v-if="settings.pollingState === 'applying'" class="settings-note">{{ t('settings.pollingApplying') }}</p>
          <p v-else-if="settings.pollingState === 'reconnecting'" class="settings-note">{{ t('settings.pollingReconnecting') }}</p>
          <p v-else-if="settings.pollingState === 'error' && settings.pollingError" class="settings-note settings-note--error" role="alert">{{ settings.pollingError }}</p>
        </div>
      </Card>

      <!-- RGB Sleep -->
      <Card :title="t('settings.rgbSleep')" :subtitle="t('settings.rgbSleepDesc')">
        <div class="settings-sleep">
          <div class="settings-sleep__presets">
            <Button
              v-for="mins in sleepPresets"
              :key="mins"
              size="sm"
              :variant="settings.rgbSleep === mins ? 'primary' : 'ghost'"
              :aria-pressed="settings.rgbSleep === mins"
              :disabled="locked"
              @click="settings.setRgbSleep(mins)"
            >
              {{ mins === 0 ? t('settings.rgbSleepNever') : t('settings.rgbSleepMinutes', { n: mins }) }}
            </Button>
          </div>
          <div class="settings-sleep__custom">
            <NumberField
              :model-value="settings.rgbSleep"
              :min="0"
              :max="120"
              :step="1"
              :decimals="0"
              :unit="t('settings.minutesUnit')"
              :label="t('settings.rgbSleep')"
              :disabled="locked"
              @update:model-value="(v) => settings.setRgbSleep(v)"
            />
          </div>
        </div>
      </Card>

      <!-- Shake optimization -->
      <Card :title="t('settings.shakeOptimization')" :subtitle="t('settings.shakeOptimizationDesc')">
        <div class="settings-shake">
          <Switch v-model="shakeModel" :label="t('settings.shakeOptimization')" :disabled="locked" />
          <span class="settings-shake__state">{{ settings.shakeOptimization ? t('settings.shakeOptimizationOn') : t('settings.shakeOptimizationOff') }}</span>
        </div>
      </Card>

      <!-- Profile names: switching, renaming and comparing moved to the Profiles page (DESIGN G §3.8) -->
      <Card :title="t('settings.profileNames')" :subtitle="t('settings.profilesMoved')">
        <template #actions>
          <Button to="/profiles" size="sm" variant="secondary" :icon="IconArrowRight">{{ t('settings.manageProfiles') }}</Button>
        </template>
        <!-- read only (DESIGN H §3.7): renaming stays on the Profiles page; a Pro name keeps its trailing space -->
        <ol class="pn" :aria-label="t('settings.profileNames')">
          <li v-for="(n, i) in device.profileNames" :key="i" class="pn__row" :class="{ 'pn__row--on': i === device.activeProfile }">
            <span class="pn__n num" aria-hidden="true">{{ i + 1 }}</span><span class="pn__name" :title="n">{{ n }}</span>
            <span v-if="i === device.activeProfile" class="pn__on">{{ t('pf.active') }}</span>
          </li>
        </ol>
      </Card>

      <!-- Device Hardware Information (Read-only) -->
      <Card :title="t('settings.deviceInfo')" :subtitle="t('settings.deviceInfoDesc')">
        <template #actions><CopyInfo /></template>
        <dl class="settings-info-grid">
          <div class="settings-info-item">
            <dt class="micro">{{ t('settings.firmwareVersion') }}</dt>
            <dd class="num">{{ device.info?.firmware ?? '—' }}</dd>
          </div>
          <div class="settings-info-item">
            <dt class="micro">{{ t('settings.boardId') }}</dt>
            <dd class="num">{{ device.info?.boardIdHex ? `0x${device.info.boardIdHex.toUpperCase()}` : '—' }}</dd>
          </div>
          <div class="settings-info-item">
            <dt class="micro">{{ t('settings.protocolVersion') }}</dt>
            <dd class="num">
              {{ device.version ? `${device.version.main}.${device.version.sub}.${device.version.hardware}.${device.version.software}` : '—' }}
            </dd>
          </div>
          <div class="settings-info-item">
            <dt class="micro">{{ t('settings.rtPrecision') }}</dt>
            <dd class="num">{{ device.rtPrecision }} mm</dd>
          </div>
          <div class="settings-info-item">
            <dt class="micro">{{ t('settings.macroCapacity') }}</dt>
            <dd class="num">
              {{ t('settings.macroCapacityVal', { count: settings.macroSpace.count, capacity: settings.macroSpace.capacity, max: settings.macroSpace.capacity - settings.macroSpace.count }) }}
            </dd>
          </div>
          <div class="settings-info-item">
            <dt class="micro">{{ t('settings.lightingAreas') }}</dt>
            <dd class="num">
              {{ t('settings.lightingAreasVal', { count: settings.lightingAreas?.count ?? 0, details: lightingDetails }) }}
            </dd>
          </div>
        </dl>
      </Card>

      <!-- Where your data lives + app settings export / import / reset (DESIGN H §3.3) -->
      <DataLocation />
    </div>

    <Dialog v-model:open="confirmOpen" :title="t('settings.pollingConfirmTitle', { rate: pendingRate === null ? '' : rateLabel(pendingRate) })" :width="440">
      <p>{{ t('settings.pollingConfirmBody') }}</p>
      <template #footer>
        <Button variant="ghost" @click="confirmOpen = false">{{ t('settings.pollingCancel') }}</Button>
        <Button variant="primary" @click="confirmPollingRate">{{ t('settings.pollingConfirm') }}</Button>
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.settings-grid--after { margin-top: var(--s-4); }
.pn { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.pn__row { display: flex; align-items: center; gap: var(--s-2); min-width: 0; font-size: var(--fs-body); line-height: 22px; color: var(--fg-1); }
.pn__n {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: var(--fs-label);
  font-weight: 650;
  line-height: 1;
  background: var(--bg-4);
  color: var(--fg-2);
}
.pn__row--on .pn__n { background: var(--acc); color: var(--on-acc); }
.pn__name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pn__on { flex: none; margin-left: auto; font-size: var(--fs-label); font-weight: 600; color: var(--acc); }
.settings-rate {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.settings-rate :deep(.seg) { flex-wrap: nowrap; min-width: 0; }
.settings-rate :deep(.seg__opt) { padding: 0 8px; }
.settings-rate__unit {
  color: var(--fg-3);
  font-size: var(--fs-label);
}
.settings-note {
  margin: 10px 0 0;
  font-size: var(--fs-label);
  color: var(--fg-2);
}
.settings-note--error {
  color: var(--danger);
}
.settings-warn {
  max-width: 1200px;
  margin: 0 auto var(--s-4);
  width: 100%;
  color: var(--warn);
  font-size: var(--fs-label);
}
/* --warn is not page text (DESIGN J §3.5): over a wallpaper the line sits on the panel, padded by a spread shadow */
:root[data-wall] .settings-warn {
  background: var(--panel);
  border-radius: var(--r-control);
  box-shadow: 0 0 0 6px var(--panel);
}
.settings-appearance {
  max-width: 1200px;
  margin: 0 auto var(--s-4);
  width: 100%;
}
.settings-loading {
  grid-column: 1 / -1;
  color: var(--fg-3);
}
.settings-skel {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-4);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  background: var(--panel);
}
.settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(420px, 1fr));
  gap: var(--s-4);
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}
.settings-sleep {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.settings-sleep__presets {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}
.settings-sleep__custom {
  max-width: 160px;
}
.settings-shake {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.settings-shake__state {
  color: var(--fg-2);
  font-size: var(--fs-label);
}
.settings-info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--s-4);
  margin: 0;
}
.settings-info-item dt {
  color: var(--fg-3);
  margin-bottom: 4px;
}
.settings-info-item dd {
  margin: 0;
  color: var(--fg-1);
  font-size: var(--fs-body);
  font-weight: 500;
}
</style>
