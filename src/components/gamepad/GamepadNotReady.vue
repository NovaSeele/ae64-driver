<script setup lang="ts">
// The card shown instead of the editor (DESIGN K §4.2): AE64 Max, a Pro on its factory firmware, an INFO that failed,
// or a newer protocol. Nothing here sends anything to the keyboard except "Thử lại" (INFO again, on the Pro).
import { computed } from 'vue';
import { IconAlertTriangle, IconDeviceGamepad2, IconInfoCircle, IconPlayerPlay, IconRefresh } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import { useDeviceStore } from '../../stores/device';
import { useGamepadStore } from '../../stores/gamepad';
import { t } from '../../i18n/vi';
import type { MessageKey } from '../../i18n/vi';

const props = defineProps<{ kind: 'max' | 'stock' | 'error' | 'newer' }>();

const device = useDeviceStore();
const gp = useGamepadStore();

const title = computed(() => t(({ max: 'gp.maxTitle', stock: 'gp.stockTitle', error: 'gp.errorTitle', newer: 'gp.newerTitle' } as const)[props.kind]));
const body = computed(() => {
  if (props.kind === 'max') return t('gp.maxBody');
  if (props.kind === 'stock') return t('gp.stockBody', { version: device.info?.firmware ?? '—' });
  if (props.kind === 'error') return t('gp.errorBody');
  return t('gp.newerBody', { proto: gp.newerProto ?? `AGP1 v${gp.protocolVersion ?? '?'}` });
});
const facts = computed<MessageKey[]>(() => (props.kind === 'max' ? ['gp.factKeymap'] : props.kind === 'stock' ? ['gp.factThirdParty', 'gp.factUntested', 'gp.factKeymap'] : []));
const tone = computed(() => (props.kind === 'error' ? 'var(--danger)' : props.kind === 'stock' ? 'var(--warn)' : 'var(--fg-3)'));
const meta = computed(() => t('gp.meta', { model: device.modelName ?? '—', fw: device.info?.firmware ?? '—', board: device.info?.boardIdHex.toUpperCase() ?? '—' }));
const reload = () => window.location.reload();
const canDemo = computed(() => device.demo && (props.kind === 'max' || props.kind === 'stock'));
</script>

<template>
  <section class="gpn" aria-labelledby="gp-gpn-title">
    <div class="gpn__tile" :style="{ '--f': tone }">
      <IconAlertTriangle v-if="kind === 'error'" :size="28" stroke-width="1.6" aria-hidden="true" />
      <IconDeviceGamepad2 v-else :size="28" stroke-width="1.6" aria-hidden="true" />
    </div>
    <div class="gpn__main">
      <h2 id="gp-gpn-title" class="gpn__title">{{ title }}</h2>
      <p class="gpn__body">{{ body }}</p>
      <ul v-if="facts.length" class="gpn__facts">
        <li v-for="f in facts" :key="f"><IconInfoCircle :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t(f) }}</span></li>
      </ul>
      <div v-if="kind === 'error' || kind === 'newer' || canDemo" class="gpn__actions">
        <Button v-if="kind === 'error'" variant="primary" :icon="IconRefresh" @click="gp.load(true)">{{ t('gp.retry') }}</Button>
        <Button v-if="kind === 'newer'" variant="primary" :icon="IconRefresh" @click="reload">{{ t('gp.reload') }}</Button>
        <Button v-if="canDemo" :icon="IconPlayerPlay" @click="device.switchDemoModel('pro-xinput')">{{ t('gp.tryDemo') }}</Button>
      </div>
      <p class="gpn__meta">{{ meta }}<template v-if="kind === 'error' && gp.loadError"> · {{ gp.loadError }}</template></p>
    </div>
  </section>
</template>
