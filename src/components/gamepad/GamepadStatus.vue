<script setup lang="ts">
// Status card of the Gamepad page (DESIGN K §3.1): which firmware, revision, persistence, the profile it applies to,
// Mode and Output type, and at most one banner (switch shallower > conflict > unconfirmed > Xbox hidden).
import { computed, nextTick, ref } from 'vue';
import { IconAlertTriangle, IconDeviceGamepad2, IconFlask, IconInfoCircle, IconRefresh, IconWand } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import Segmented from '../ui/Segmented.vue';
import { useToast } from '../ui/toast';
import { GP_CONTROLS, GP_VERSION } from '../../protocol/gamepad';
import type { GpMode, GpTransport } from '../../protocol/gamepad';
import { useDeviceStore } from '../../stores/device';
import { useGamepadStore } from '../../stores/gamepad';
import { useSyncStore } from '../../stores/sync';
import { t } from '../../i18n/vi';
import { SHORT, keyLegend, mm } from './outputs';
import { useGamepadActions } from './actions';

const props = defineProps<{ loading?: boolean }>();

const gp = useGamepadStore();
const device = useDeviceStore();
const sync = useSyncStore();
const actions = useGamepadActions();
const root = ref<HTMLElement | null>(null);
const toast = useToast();

const keyName = (key: number): string => keyLegend(device, key);

const mode = computed<GpMode | null>({
  get: () => gp.config?.mode ?? null,
  set: (v) => { if (v) gp.setMode(v); },
});
const transport = computed<GpTransport | null>({
  get: () => gp.config?.transport ?? null,
  set: (v) => { if (v) gp.setTransport(v); },
});
const modeOptions = computed(() => [
  { value: 'off' as const, label: t('gp.modeOff') },
  { value: 'controller' as const, label: t('gp.modeController') },
  { value: 'mixed' as const, label: t('gp.modeMixed') },
]);
const transportOptions = computed(() => {
  const has = gp.info?.transports ?? { hid: false, xinput: false };
  return [
    { value: 'xinput' as const, label: t('gp.tXinput'), title: has.xinput ? t('gp.tXinputDesc') : t('gp.tMissing', { type: 'XInput' }), disabled: !has.xinput },
    { value: 'hid' as const, label: t('gp.tHid'), title: has.hid ? t('gp.tHidDesc') : t('gp.tMissing', { type: 'HID' }), disabled: !has.hid },
  ];
});
const modeDesc = computed(() => t(mode.value === 'off' ? 'gp.modeOffDesc' : mode.value === 'mixed' ? 'gp.modeMixedDesc' : 'gp.modeControllerDesc'));

type Banner =
  | { kind: 'over'; text: string }
  | { kind: 'conflict'; text: string }
  | { kind: 'unconfirmed' }
  | { kind: 'hidden' };
const banner = computed<Banner | null>(() => {
  if (gp.travelIssues.length) {
    const items = gp.travelIssues.map((i) => {
      const b = gp.config!.bindings[i.index];
      const key = keyName(i.key);
      return i.code === 'overTravel'
        ? t('gp.overTravelItem', { key, out: SHORT[GP_CONTROLS[i.index].id], end: mm(b.endUm), travel: mm(i.limitUm) })
        : t('gp.noTravel', { key });
    });
    return { kind: 'over', text: t('gp.overTravelBanner', { list: items.join(', ') }) };
  }
  if (gp.conflict) return { kind: 'conflict', text: t('gp.conflict', { from: gp.conflict.from, to: gp.conflict.to }) };
  if (gp.unconfirmed && sync.state === 'error') return { kind: 'unconfirmed' };
  if (gp.config?.transport === 'xinput' && gp.info?.usbSwitch && gp.usb && !gp.usb.enabled && !gp.usbBusy) return { kind: 'hidden' };
  return null;
});

function fit(): void {
  const n = gp.fitToTravel();
  if (!n) return;
  toast.show(t('gp.fitDone', { n }), 'success', undefined, actions.undoAction());
  // The banner (and the button that had focus) is gone: focus moves on to Mode, the next stop in Tab order.
  void nextTick(() => root.value?.querySelector<HTMLElement>('.gps__field [role="radio"][tabindex="0"]')?.focus());
}

async function showXbox(): Promise<void> {
  if (await gp.setXboxDevice(true)) toast.show(t('gp.xboxShown'), 'success');
}
</script>

<template>
  <section v-if="loading" class="gps" aria-busy="true">
    <div class="gps__row">
      <span class="gps__tile"><IconDeviceGamepad2 :size="20" stroke-width="1.75" aria-hidden="true" /></span>
      <div class="gps__id">
        <div class="gps__title" role="status">{{ t('gp.loading') }}</div>
        <div class="gps__meta"><span class="skeleton gp-skel" style="width: 220px" /></div>
      </div>
    </div>
  </section>
  <section v-else ref="root" class="gps" :aria-label="t('gp.fwXinput')">
    <!-- First in the DOM (Tab order, DESIGN §7), drawn under the row (CSS order). -->
    <div v-if="banner?.kind === 'over'" class="gps__banner gps__banner--warn" role="alert">
      <IconAlertTriangle :size="18" stroke-width="1.75" aria-hidden="true" />
      <p>{{ banner.text }}</p>
      <Button variant="primary" size="sm" :icon="IconWand" @click="fit">{{ t('gp.fitAll') }}</Button>
    </div>
    <div v-else-if="banner?.kind === 'conflict'" class="gps__banner gps__banner--warn" role="alert">
      <IconAlertTriangle :size="18" stroke-width="1.75" aria-hidden="true" />
      <p>{{ banner.text }}</p>
      <div class="gps__bact">
        <Button size="sm" @click="gp.keepKeyboard()">{{ t('gp.useKeyboard') }}</Button>
        <Button size="sm" variant="ghost" @click="gp.writeMine()">{{ t('gp.writeMine') }}</Button>
      </div>
    </div>
    <div v-else-if="banner?.kind === 'unconfirmed'" class="gps__banner gps__banner--warn" role="alert">
      <IconAlertTriangle :size="18" stroke-width="1.75" aria-hidden="true" />
      <p>{{ t('gp.unconfirmedBanner') }}</p>
      <Button size="sm" :icon="IconRefresh" @click="gp.readBack()">{{ t('gp.readBack') }}</Button>
    </div>
    <div v-else-if="banner?.kind === 'hidden'" class="gps__banner gps__banner--info" role="status">
      <IconInfoCircle :size="18" stroke-width="1.75" aria-hidden="true" />
      <p>{{ t('gp.xboxHiddenWarn') }}</p>
      <Button size="sm" @click="showXbox">{{ t('gp.xbox') }}</Button>
    </div>
    <div class="gps__row">
      <span class="gps__tile"><IconDeviceGamepad2 :size="20" stroke-width="1.75" aria-hidden="true" /></span>
      <div class="gps__id">
        <div class="gps__title">
          {{ t('gp.fwXinput') }}
          <span class="gp-chip gp-chip--warn" :title="t('gp.experimentalHint')"><IconFlask :size="13" stroke-width="2" aria-hidden="true" />{{ t('gp.experimental') }}</span>
        </div>
        <div class="gps__meta">
          <span>{{ t('gp.protocol', { v: GP_VERSION }) }}</span>
          <span class="num">{{ t('gp.revision', { n: gp.revision ?? '—' }) }}</span>
          <span v-if="gp.info?.persistent" class="gp-ok">{{ t('gp.persistYes') }}</span>
          <span v-else class="gp-warn" :title="t('gp.persistNoHint')">{{ t('gp.persistNo') }}</span>
        </div>
        <p class="gps__desc">{{ t('gp.scope', { name: device.activeProfileName }) }}</p>
      </div>
      <div class="gps__field" :inert="gp.locked || undefined">
        <span class="gps__label" aria-hidden="true">{{ t('gp.mode') }}</span>
        <Segmented v-model="mode" :options="modeOptions" :label="t('gp.mode')" size="sm" />
        <p class="gps__desc">{{ modeDesc }}</p>
      </div>
      <div class="gps__field" :inert="gp.locked || undefined">
        <span class="gps__label" aria-hidden="true">{{ t('gp.transport') }}</span>
        <Segmented v-model="transport" :options="transportOptions" :label="t('gp.transport')" size="sm" />
        <p class="gps__desc">{{ t(transport === 'hid' ? 'gp.tHidDesc' : 'gp.tXinputDesc') }}</p>
      </div>
    </div>

  </section>
</template>
