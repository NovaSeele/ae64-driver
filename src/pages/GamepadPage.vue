<script setup lang="ts">
// Gamepad page (DESIGN K-gamepad): the experimental AE64 Pro XInput firmware. Status card, keyboard with the outputs on
// the keycaps, outputs / details / sticks / live test. AE64 Max, the factory Pro firmware, a failed INFO and a newer
// protocol get a card instead (nothing is sent to an AE64 Max). Every edit goes through stores/gamepad (history + sync).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import PageLayout from '../components/shell/PageLayout.vue';
import type { LegendItem } from '../components/keyboard/SelectionBar.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import GamepadStatus from '../components/gamepad/GamepadStatus.vue';
import GamepadNotReady from '../components/gamepad/GamepadNotReady.vue';
import GamepadOutputs from '../components/gamepad/GamepadOutputs.vue';
import GamepadDetail from '../components/gamepad/GamepadDetail.vue';
import GamepadSticks from '../components/gamepad/GamepadSticks.vue';
import GamepadTest from '../components/gamepad/GamepadTest.vue';
import type { VizState } from '../components/gamepad/GamepadViz.vue';
import { useGamepadActions } from '../components/gamepad/actions';
import { SHORT, indexOfKey, longNameOf, physKey, toneOfIndex } from '../components/gamepad/outputs';
import '../components/gamepad/gamepad.css';
import { attachDemoPress } from '../components/live/demoPress';
import { GP_CONTROLS, GP_KEY_COUNT, GP_LEVEL_MAX, gamepadOutputs, toStandardGamepad } from '../protocol/gamepad';
import type { MockTransport, PhysicalKey } from '../protocol';
import { useDeviceStore } from '../stores/device';
import { useGamepadStore } from '../stores/gamepad';
import { useLiveStore } from '../stores/live';
import { usePerformanceStore } from '../stores/performance';
import { useSelectionStore } from '../stores/selection';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const gp = useGamepadStore();
const sel = useSelectionStore();
const live = useLiveStore();
const perf = usePerformanceStore();
const actions = useGamepadActions();

// ------------------------------------------------------------------ loading

watch(() => [device.connected, gp.support] as const, ([connected, support]) => {
  if (connected && support === 'unknown') void gp.load();
}, { immediate: true });
// Mode, output type and assignments are per onboard profile: the store reads them again after a profile change.

const notReady = computed(() => (gp.support === 'max' || gp.support === 'stock' || gp.support === 'error' || gp.support === 'newer' ? gp.support : null));
const loading = computed(() => gp.support === 'unknown' || gp.support === 'loading' || (gp.support === 'ready' && !gp.travelKnown && perf.loading));
const ready = computed(() => gp.support === 'ready' && !!gp.config && !loading.value);
const modeOff = computed(() => gp.config?.mode === 'off');

// ------------------------------------------------------------------ selection ↔ outputs

const keyById = (id: number): PhysicalKey | undefined => device.keys.find((k) => k.id === id);
/** Selected keys as record key indices. */
const selectedKeys = computed(() => sel.ids.map((id) => keyById(id)).map((k) => (k ? indexOfKey(k) : null)).filter((i): i is number => i !== null));
/** Outputs (record indices) of the selected keys. */
const current = computed(() => {
  const keys = new Set(selectedKeys.value);
  return gp.config ? gp.config.bindings.flatMap((b, i) => (b.key !== null && keys.has(b.key) ? [i] : [])) : [];
});
/** Output index of each record key. */
const outputOfKey = computed(() => {
  const m = new Map<number, number>();
  gp.config?.bindings.forEach((b, i) => { if (b.key !== null) m.set(b.key, i); });
  return m;
});
const outputOf = (k: PhysicalKey): number | undefined => {
  const i = indexOfKey(k);
  return i === null ? undefined : outputOfKey.value.get(i);
};

// A saved block the keyboard would refuse: open the first output in trouble (§4.1 "Switch nông hơn").
watch(() => gp.travelIssues[0]?.key, (key) => {
  if (key === undefined) return;
  const pk = physKey(device.keys, key);
  if (pk && !sel.selected.has(pk.id)) sel.select(pk.id);
}, { immediate: true });

// ------------------------------------------------------------------ arming: output first, then a key (§5.1)

const armed = ref<number | null>(null);
watch(() => sel.selected, (now) => {
  const index = armed.value;
  if (index === null) return;
  armed.value = null;
  if (!now.size) return; // Esc on the keyboard, a click on the case: cancelled
  const id = sel.focused !== null && now.has(sel.focused) ? sel.focused : [...now].at(-1)!;
  const k = keyById(id);
  const key = k ? indexOfKey(k) : null;
  if (key === null) return;
  actions.assign(index, key);
  if (now.size !== 1) sel.select(id);
});
// Leaving: an arm never outlives the page state it was made in.
watch(() => [gp.support, device.connection], () => { armed.value = null; });

function focusTile(index: number): void {
  void nextTick(() => document.querySelector<HTMLElement>(`[data-gp-tile="${index}"]`)?.focus());
}
function onEsc(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || armed.value === null) return;
  const index = armed.value;
  e.preventDefault(); // the keyboard keeps its selection: Esc only cancels the arm
  e.stopPropagation();
  armed.value = null;
  focusTile(index);
}
/** Armed from the keyboard: go to the keyboard's tab stop. */
function toKeyboard(): void {
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>('.page__kb [data-key][tabindex="0"]');
    el?.scrollIntoView({ block: 'nearest' });
    el?.focus();
  });
}
onMounted(() => window.addEventListener('keydown', onEsc, true));

const armedHint = computed(() => (armed.value !== null ? t('gp.armed', { out: longNameOf(armed.value) }) : ''));
/** Selection bar "Keycap: …" (DESIGN B §3.4), only once the config is shown on the keys. */
const shows = computed<LegendItem[] | undefined>(() => (ready.value ? [{ text: t('gp.shows') }, { text: t('gp.showsGroups') }] : undefined));

// ------------------------------------------------------------------ live key travel (the "computed" pane, §5.6)

const reading = ref(false);
const depthUm = shallowRef<Float64Array>(new Float64Array(GP_KEY_COUNT));
const pressed = shallowRef<boolean[]>(Array(GP_KEY_COUNT).fill(false));
let liveAllKeys: boolean | null = null;
let detachDemo: (() => void) | null = null;
let raf = 0;
let seen = -1;

function sample(): void {
  raf = requestAnimationFrame(sample);
  const d = live.data;
  if (d.version === seen) return;
  seen = d.version;
  const depth = new Float64Array(GP_KEY_COUNT);
  const down = Array<boolean>(GP_KEY_COUNT).fill(false);
  for (const k of device.keys) {
    const i = indexOfKey(k);
    if (i === null) continue;
    depth[i] = Math.round((d.travel[k.id] ?? 0) * 1000);
    const st = d.status[k.id];
    down[i] = st === 1 || st === 2; // 11 is the release edge
  }
  depthUm.value = depth;
  pressed.value = down;
}

function startReading(): void {
  if (liveAllKeys === null) liveAllKeys = live.allKeys;
  live.allKeys = true;
  live.start();
  if (device.demo && device.transport?.kind === 'mock' && !detachDemo) detachDemo = attachDemoPress(device.transport as MockTransport);
  if (!raf) raf = requestAnimationFrame(sample);
}
function stopReading(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  seen = -1;
  detachDemo?.();
  detachDemo = null;
  if (liveAllKeys !== null) {
    live.stop();
    live.allKeys = liveAllKeys;
    liveAllKeys = null;
  }
  depthUm.value = new Float64Array(GP_KEY_COUNT);
  pressed.value = Array(GP_KEY_COUNT).fill(false);
}
watch(() => reading.value && ready.value && device.connected, (on) => (on ? startReading() : stopReading()));
onBeforeUnmount(() => {
  stopReading();
  window.removeEventListener('keydown', onEsc, true);
});

const output = computed(() => {
  if (!reading.value || !gp.config) return null;
  const max = Array.from({ length: GP_KEY_COUNT }, (_, k) => gp.travelUm(k));
  return gamepadOutputs(gp.config, depthUm.value, max, pressed.value);
});
const appState = computed<VizState | null>(() => {
  const out = output.value;
  if (!out) return null;
  const std = toStandardGamepad(out);
  const held = [...out.buttons, ...out.dpad].map((id) => SHORT[id]);
  return {
    lx: out.lx / GP_LEVEL_MAX, ly: out.ly / GP_LEVEL_MAX, rx: out.rx / GP_LEVEL_MAX, ry: out.ry / GP_LEVEL_MAX,
    lt: std.buttons[6].value, rt: std.buttons[7].value, buttons: held,
  };
});
const stickPositions = computed<[[number, number], [number, number]]>(() => {
  const s = appState.value;
  return s ? [[s.lx, s.ly], [s.rx, s.ry]] : [[0, 0], [0, 0]];
});
const liveDepth = (key: number): number | null => (reading.value ? depthUm.value[key] ?? 0 : null);

// ------------------------------------------------------------------ keycaps (§3.2)

const sublabel = (k: PhysicalKey) => {
  const o = outputOf(k);
  return o === undefined ? undefined : SHORT[GP_CONTROLS[o].id];
};
const fill = (k: PhysicalKey) => (outputOf(k) === undefined ? undefined : 1);
const tone = (k: PhysicalKey) => {
  const o = outputOf(k);
  return o === undefined ? undefined : toneOfIndex(o);
};
const status = (k: PhysicalKey) => {
  const o = outputOf(k);
  return o === undefined ? undefined : longNameOf(o);
};
const keyState = (k: PhysicalKey): 'pressed' | undefined => {
  if (!reading.value) return undefined;
  const i = indexOfKey(k);
  return i !== null && pressed.value[i] ? 'pressed' : undefined;
};
</script>

<template>
  <PageLayout
    :title="t('page.gamepad')"
    :keyboard="!notReady"
    :shows="shows"
    :hint="t('gp.hint')"
    class="gp-page"
    :class="{ 'gp-locked': gp.locked, 'gp-busy': gp.usbBusy }"
    :aria-busy="gp.usbBusy || undefined"
  >
    <template v-if="!notReady" #toolbar>
      <GamepadStatus :loading="loading || !gp.config" :inert="gp.usbBusy || undefined" />
    </template>
    <template v-if="!notReady" #keyboard>
      <!-- one persistent live region, so arming an output is announced even though the bar's detail is new -->
      <span class="sr-only" role="status">{{ armedHint }}</span>
      <div :class="{ 'gp-kb--off': modeOff }" :inert="gp.usbBusy || undefined">
        <KeyboardView
          :keys="device.keys" :legend="device.legend" :sublabel="ready ? sublabel : undefined" :fill="ready ? fill : undefined"
          :tone="ready ? tone : undefined" :status="ready ? status : undefined" :state="keyState" :loading="loading" selectable
        />
      </div>
    </template>
    <!-- an output is armed: the bar says which one waits for a key, in place of the keycap legend -->
    <template v-if="!notReady && armed !== null" #detail>
      <span class="gp-armed">{{ armedHint }}</span>
    </template>

    <GamepadNotReady v-if="notReady" :kind="notReady" />
    <div v-else-if="ready" class="gpg">
      <GamepadOutputs v-model:armed="armed" :current="current" :selected-keys="selectedKeys" :inert="gp.usbBusy || gp.locked || undefined" @armed-by-keyboard="toKeyboard" />
      <GamepadDetail :current="current" :selected-keys="selectedKeys" :depth-um="liveDepth" :inert="gp.usbBusy || undefined" />
      <GamepadSticks :positions="stickPositions" :inert="gp.usbBusy || gp.locked || undefined" />
      <GamepadTest v-model:reading="reading" :app-state="appState" :mode-off="modeOff" />
    </div>
  </PageLayout>
</template>
