<script setup lang="ts">
// Settings page: system mode, polling rate, RGB sleep, shake optimization, profile names, hardware info.
import { computed, onMounted, ref } from 'vue';
import PageLayout from '../components/shell/PageLayout.vue';
import Card from '../components/ui/Card.vue';
import Segmented from '../components/ui/Segmented.vue';
import Switch from '../components/ui/Switch.vue';
import NumberField from '../components/ui/NumberField.vue';
import Button from '../components/ui/Button.vue';
import { POLLING_RATE_HZ } from '../protocol';
import { useDeviceStore } from '../stores/device';
import { useSettingsStore } from '../stores/settings';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const settings = useSettingsStore();

const editingNames = ref<string[]>([]);

onMounted(async () => {
  await settings.load();
  editingNames.value = device.profileNames.slice();
});

const systemModeOptions = computed(() => [
  { value: 0, label: t('settings.systemModeWin') },
  { value: 1, label: t('settings.systemModeMac') },
]);

const pollingRateOptions = computed(() =>
  settings.supportedRates.map((r) => ({
    value: r,
    label: `${POLLING_RATE_HZ[r] ?? r} Hz`,
  })),
);

const sleepPresets = [0, 5, 10, 15, 30];

const shakeModel = computed({
  get: () => settings.shakeOptimization,
  set: (v: boolean) => settings.setShakeOptimization(v),
});

function saveProfileName(index: number) {
  const name = editingNames.value[index];
  if (name && name.trim()) {
    void device.renameProfile(index, name.trim());
  }
}
</script>

<template>
  <PageLayout :title="t('page.settings')">
    <div class="settings-grid">
      <!-- System mode -->
      <Card :title="t('settings.systemMode')" :subtitle="t('settings.systemModeDesc')">
        <div>
          <Segmented
            :model-value="settings.systemMode"
            :options="systemModeOptions"
            :label="t('settings.systemMode')"
            @update:model-value="(v) => v !== null && settings.setSystemMode(v)"
          />
        </div>
      </Card>

      <!-- Polling rate -->
      <Card :title="t('settings.pollingRate')" :subtitle="t('settings.pollingRateDesc')">
        <div>
          <Segmented
            :model-value="settings.pollingRate"
            :options="pollingRateOptions"
            :label="t('settings.pollingRate')"
            @update:model-value="(v) => v !== null && settings.setPollingRate(v)"
          />
          <p v-if="settings.pollingState === 'applying'" class="settings-note">{{ t('settings.pollingApplying') }}</p>
          <p v-else-if="settings.pollingState === 'reconnecting'" class="settings-note">{{ t('settings.pollingReconnecting') }}</p>
          <p v-else-if="settings.pollingState === 'error' && settings.pollingError" class="settings-note settings-note--error">{{ settings.pollingError }}</p>
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
              unit="min"
              :label="t('settings.rgbSleep')"
              @update:model-value="(v) => settings.setRgbSleep(v)"
            />
          </div>
        </div>
      </Card>

      <!-- Shake optimization -->
      <Card :title="t('settings.shakeOptimization')" :subtitle="t('settings.shakeOptimizationDesc')">
        <div class="settings-shake">
          <Switch
            v-model="shakeModel"
            :label="settings.shakeOptimization ? t('settings.shakeOptimizationOn') : t('settings.shakeOptimizationOff')"
          />
        </div>
      </Card>

      <!-- Profile names -->
      <Card :title="t('settings.profileNames')" :subtitle="t('settings.profileNamesDesc')">
        <div class="settings-profiles">
          <div
            v-for="(name, i) in device.profileNames"
            :key="i"
            class="settings-profile-row"
          >
            <span class="settings-profile-row__label micro">Profile {{ i + 1 }}</span>
            <input
              v-model="editingNames[i]"
              type="text"
              maxlength="32"
              class="settings-profile-row__input"
              :placeholder="`Profile ${i + 1}`"
              @keydown.enter="saveProfileName(i)"
            >
            <Button
              size="sm"
              variant="ghost"
              :disabled="editingNames[i] === name || !editingNames[i]?.trim()"
              @click="saveProfileName(i)"
            >
              {{ t('settings.profileRename') }}
            </Button>
          </div>
        </div>
      </Card>

      <!-- Device Hardware Information (Read-only) -->
      <Card :title="t('settings.deviceInfo')" :subtitle="t('settings.deviceInfoDesc')">
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
              {{ t('settings.macroCapacityVal', { count: settings.macroSpace.count, capacity: settings.macroSpace.capacity }) }}
            </dd>
          </div>
          <div class="settings-info-item">
            <dt class="micro">{{ t('settings.lightingAreas') }}</dt>
            <dd class="num">
              {{ t('settings.lightingAreasVal', { count: settings.lightingAreas?.count ?? 2, details: `${t('settings.lightingAreaKeys')}, ${t('settings.lightingAreaStrip')}` }) }}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  </PageLayout>
</template>

<style scoped>
.settings-note {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-2);
}
.settings-note--error {
  color: var(--danger, #ff6b6b);
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
}
.settings-profiles {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}
.settings-profile-row {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.settings-profile-row__label {
  width: 70px;
  flex: none;
  color: var(--fg-3);
}
.settings-profile-row__input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  background: var(--bg-1);
  color: var(--fg-1);
  font-size: var(--fs-body);
}
.settings-profile-row__input:focus {
  border-color: var(--acc-line);
  box-shadow: var(--focus-ring);
  outline: none;
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
