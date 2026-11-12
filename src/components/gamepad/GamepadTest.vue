<script setup lang="ts">
// "Thử trực tiếp" card (DESIGN K §3.6, §5.5, §5.6). Left: the controller the computer sees (browser Gamepad API, polled
// in requestAnimationFrame only while the tab is visible and the card on screen; the demo's simulated controller in the
// demo) and the Xbox controller switch. Right: the controller computed from key travel (the page reads travel only while
// its switch is on).
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { IconAlertTriangle, IconDeviceGamepad2, IconInfoCircle, IconRefresh, IconTarget } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import Segmented from '../ui/Segmented.vue';
import Switch from '../ui/Switch.vue';
import { useToast } from '../ui/toast';
import type { MockTransport } from '../../protocol';
import { useDeviceStore } from '../../stores/device';
import { useGamepadStore } from '../../stores/gamepad';
import { t } from '../../i18n/vi';
import GamepadViz from './GamepadViz.vue';
import type { VizState } from './GamepadViz.vue';

const props = defineProps<{ appState: VizState | null; modeOff: boolean }>();
const reading = defineModel<boolean>('reading', { required: true });

const gp = useGamepadStore();
const device = useDeviceStore();
const toast = useToast();

const ZERO: VizState = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: [] };
const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);
const osTitle = computed(() => t(isWindows ? 'gp.osPane' : 'gp.osPaneAny'));
const hasApi = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';

/** Pads the browser (or the demo) reports, polled each frame while visible. */
interface Pad { index: number; id: string; state: VizState }
const pads = shallowRef<Pad[]>([]);
const picked = ref<number | null>(null);
const pad = computed(() => pads.value.find((p) => p.index === picked.value) ?? pads.value[0] ?? null);
const padOptions = computed(() => pads.value.map((p) => ({ value: p.index, label: `${p.index + 1}`, title: p.id })));

const STD = ['A', 'B', 'X', 'Y', 'LB', 'RB', null, null, 'Back', 'Start', 'L3', 'R3', 'D↑', 'D↓', 'D←', 'D→'] as const;
const round = (v: number) => Math.round(v * 100) / 100 + 0;
function toState(g: { axes: readonly number[]; buttons: readonly { pressed: boolean; value: number }[] }): VizState {
  const ax = (i: number) => round(g.axes[i] ?? 0);
  return {
    lx: ax(0), ly: -ax(1) + 0, rx: ax(2), ry: -ax(3) + 0,
    lt: round(g.buttons[6]?.value ?? 0), rt: round(g.buttons[7]?.value ?? 0),
    buttons: STD.filter((b, i): b is NonNullable<typeof b> => b !== null && !!g.buttons[i]?.pressed),
  };
}
const same = (a: Pad[], b: Pad[]) => a.length === b.length && a.every((p, i) => p.id === b[i].id && JSON.stringify(p.state) === JSON.stringify(b[i].state));

function poll(): void {
  let next: Pad[] = [];
  if (device.demo && device.transport?.kind === 'mock') {
    const v = (device.transport as MockTransport).virtualGamepad();
    if (v) next = [{ index: v.index, id: v.id, state: toState(v) }];
  } else if (hasApi) {
    next = Array.from(navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected)
      .map((g) => ({ index: g.index, id: g.id, state: toState(g) }));
  }
  if (!same(next, pads.value)) pads.value = next;
}

const root = ref<{ $el: HTMLElement } | null>(null);
let raf = 0;
let onScreen = false;
let io: IntersectionObserver | null = null;
function loop(): void {
  raf = 0;
  if (!onScreen || document.hidden) return;
  poll();
  raf = requestAnimationFrame(loop);
}
function wake(): void {
  if (!raf && onScreen && !document.hidden) raf = requestAnimationFrame(loop);
}
onMounted(() => {
  const el = root.value?.$el;
  if (el && typeof IntersectionObserver !== 'undefined') {
    io = new IntersectionObserver((entries) => {
      onScreen = entries.some((e) => e.isIntersecting);
      wake();
    });
    io.observe(el);
  } else {
    onScreen = true;
    wake();
  }
  document.addEventListener('visibilitychange', wake);
});
onBeforeUnmount(() => {
  io?.disconnect();
  if (raf) cancelAnimationFrame(raf);
  document.removeEventListener('visibilitychange', wake);
});

const osSource = computed(() => (device.demo ? t('gp.osDemo') : pad.value?.id ?? '—'));

// ------------------------------------------------------------------ Xbox controller switch

const xbox = computed({
  get: () => gp.usb?.enabled ?? true,
  set: (v: boolean) => { void setXbox(v); },
});
async function setXbox(v: boolean): Promise<void> {
  if (await gp.setXboxDevice(v)) {
    toast.show(t(v ? 'gp.xboxShown' : 'gp.xboxHidden'), 'success');
    return;
  }
  const msg = gp.usbError ?? '';
  if (msg === t('gp.usbOtherKeyboard')) toast.show(t('gp.xboxLost', { msg }), 'error', 10 * 60_000);
  else if (!device.connected) {
    toast.show(t('gp.xboxLost', { msg }), 'error', 10 * 60_000, { label: t('gp.xboxReconnect'), run: () => { void device.connect(); } });
  }
}
const showFailure = computed(() => !!gp.usbError && device.connected && !gp.usbBusy);

// ------------------------------------------------------------------ "an assigned key may not be calibrated"

// The firmware leaves the whole report neutral while any assigned key is invalid for it, which includes a key it does not
// see as calibrated (board_port.c). The app cannot read that flag yet, so it only hints: on a real keyboard, Windows shows
// an idle controller for a while although the travel the app reads gives output. Not in the demo (no real Gamepad API).
const router = useRouter();
const neutral = (s: VizState) => !s.lx && !s.ly && !s.rx && !s.ry && !s.lt && !s.rt && !s.buttons.length;
const mismatch = computed(() => !device.demo && reading.value && !props.modeOff && !!props.appState && !neutral(props.appState)
  && (!pad.value || neutral(pad.value.state)) && !(gp.usb && !gp.usb.enabled) && !gp.usbBusy);
const CAL_HINT_MS = 1500;
const calHint = ref(false);
let calTimer: ReturnType<typeof setTimeout> | null = null;
watch(mismatch, (on) => {
  if (calTimer) clearTimeout(calTimer);
  calTimer = null;
  if (!on) return;
  calTimer = setTimeout(() => { calTimer = null; calHint.value = true; }, CAL_HINT_MS);
});
// Shown once it held for CAL_HINT_MS; it stays until reading stops (it would blink with every release otherwise).
watch(() => reading.value && !device.demo, (on) => { if (!on) calHint.value = false; });
onBeforeUnmount(() => { if (calTimer) clearTimeout(calTimer); });
</script>

<template>
  <Card ref="root" class="gpt" :title="t('gp.test')" :subtitle="t('gp.testSub')">
    <div class="gpt__panes">
      <div class="gpt__pane">
        <div class="gpt__ph">
          <h4>{{ osTitle }}</h4>
          <p class="gps__desc">{{ t('gp.osSource', { name: osSource }) }}</p>
        </div>
        <div v-if="pads.length > 1" class="gpt__pick">
          <Segmented v-model="picked" :options="padOptions" :label="t('gp.osPick')" size="sm" />
          <p class="gps__desc">{{ t('gp.osMany', { n: pads.length }) }}</p>
        </div>
        <div v-if="!hasApi && !device.demo" class="gpt__empty"><p>{{ t('gp.osUnsupported') }}</p></div>
        <div v-else-if="!pad" class="gpt__empty">
          <IconDeviceGamepad2 :size="24" stroke-width="1.5" aria-hidden="true" />
          <p>{{ t('gp.osNone') }}</p>
        </div>
        <GamepadViz v-else :pane="osTitle" :state="modeOff ? ZERO : pad.state" />

        <div v-if="gp.info?.usbSwitch" class="gpt__xbox">
          <Switch v-model="xbox" :label="t('gp.xbox')" :disabled="gp.usbBusy" describedby="gp-xbox-d" />
          <p v-if="gp.usbBusy" class="gps__desc gps__desc--busy" role="status"><span class="gp-spin" aria-hidden="true" />{{ t('gp.xboxSwitching') }}</p>
          <div v-else-if="showFailure" class="gps__fail" role="alert">
            <p><IconAlertTriangle :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ gp.usbError }}</span></p>
            <div class="gps__failact"><Button size="sm" :icon="IconRefresh" @click="gp.readUsb().catch(() => undefined)">{{ t('gp.xboxRecheck') }}</Button></div>
          </div>
          <p v-else id="gp-xbox-d" class="gps__desc">{{ t('gp.xboxDesc') }} {{ t(gp.info.usbPersistent ? 'gp.xboxKept' : 'gp.xboxReset') }}</p>
        </div>
      </div>

      <div class="gpt__pane">
        <div class="gpt__ph">
          <h4>{{ t('gp.appPane') }}</h4>
          <p class="gps__desc">{{ t('gp.appSource') }}</p>
        </div>
        <GamepadViz v-if="reading && props.appState" :pane="t('gp.appPane')" :state="props.appState" />
        <div v-else class="gpt__empty"><p>{{ t('gp.appOff') }}</p></div>
        <div class="gpt__xbox">
          <Switch v-model="reading" :label="t('gp.appRead')" describedby="gp-read-d" />
          <p id="gp-read-d" class="gps__desc">{{ t('gp.appReadDesc') }}</p>
        </div>
      </div>
    </div>
    <div v-if="calHint" class="gps__fail gpt__cal" role="status">
      <p><IconAlertTriangle :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('gp.calHint') }}</span></p>
      <div class="gps__failact"><Button size="sm" :icon="IconTarget" @click="router.push('/calibration')">{{ t('gp.openCal') }}</Button></div>
    </div>
    <p class="gps__desc gpt__note"><IconInfoCircle :size="14" stroke-width="1.75" aria-hidden="true" />{{ t(modeOff ? 'gp.modeOffTest' : 'gp.rearm') }}</p>
  </Card>
</template>
