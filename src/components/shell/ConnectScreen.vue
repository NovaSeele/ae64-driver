<script setup lang="ts">
import { IconAlertTriangle, IconPlayerPlay, IconShieldCheck, IconUsb } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import { useDeviceStore } from '../../stores/device';
import { t } from '../../i18n/vi';

const device = useDeviceStore();
</script>

<template>
  <div class="cs">
    <div class="cs__card">
      <div class="cs__art" aria-hidden="true">
        <svg viewBox="0 0 240 92" width="240" height="92">
          <rect x="1" y="1" width="238" height="90" rx="14" fill="var(--bg-1)" stroke="var(--line-2)" />
          <g v-for="r in 4" :key="r">
            <rect
              v-for="c in 12"
              :key="c"
              :x="12 + (c - 1) * 18.2 + (r % 2) * 4"
              :y="10 + (r - 1) * 18"
              width="15"
              height="15"
              rx="3.5"
              :fill="(r === 2 && c >= 2 && c <= 4) || (r === 3 && c === 3) ? 'var(--acc-soft)' : 'var(--bg-3)'"
              :stroke="(r === 2 && c >= 2 && c <= 4) || (r === 3 && c === 3) ? 'var(--acc)' : 'var(--line-1)'"
            />
          </g>
        </svg>
      </div>
      <h1 class="cs__title">{{ t('connect.title') }}</h1>
      <p class="cs__sub">{{ t('connect.subtitle') }}</p>

      <div class="cs__actions">
        <Button
          variant="primary"
          size="lg"
          :icon="IconUsb"
          :loading="device.status === 'connecting'"
          :disabled="!device.hidAvailable"
          @click="device.connect()"
        >
          {{ device.status === 'connecting' ? t('device.connecting') : t('connect.button') }}
        </Button>
        <Button size="lg" :icon="IconPlayerPlay" :disabled="device.status === 'connecting'" :title="t('connect.demoHint')" @click="device.connectDemo()">
          {{ t('connect.demo') }}
        </Button>
      </div>

      <p v-if="!device.hidAvailable" class="cs__note cs__note--warn">
        <IconAlertTriangle :size="16" stroke-width="1.5" aria-hidden="true" />{{ t('connect.noHid') }}
      </p>
      <p v-if="device.status === 'error' && device.error" class="cs__note cs__note--error" role="alert">
        <IconAlertTriangle :size="16" stroke-width="1.5" aria-hidden="true" />{{ t('connect.failed') }}: {{ device.error }}
      </p>
      <p class="cs__note">
        <IconShieldCheck :size="16" stroke-width="1.5" aria-hidden="true" />{{ t('connect.safety') }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.cs {
  flex: 1;
  display: grid;
  place-items: center;
  padding: var(--s-8);
  background: radial-gradient(ellipse 60% 50% at 50% 35%, rgba(63, 224, 197, 0.06), transparent 70%);
}
.cs__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: var(--s-4);
  max-width: 520px;
  animation: rise var(--t-slow) var(--ease) both;
}
@keyframes rise { from { opacity: 0; transform: translateY(8px); } }
.cs__art { margin-bottom: var(--s-3); filter: drop-shadow(0 20px 40px rgba(0, 0, 0, 0.4)); }
.cs__title { font-size: var(--fs-hero); }
.cs__sub { color: var(--fg-2); max-width: 440px; }
.cs__actions { display: flex; gap: var(--s-3); margin: var(--s-3) 0; flex-wrap: wrap; justify-content: center; }
.cs__note {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  color: var(--fg-3);
  font-size: var(--fs-label);
  text-align: left;
}
.cs__note svg { flex: none; margin-top: 1px; }
.cs__note--warn { color: var(--warn); }
.cs__note--error { color: var(--danger); }
</style>
