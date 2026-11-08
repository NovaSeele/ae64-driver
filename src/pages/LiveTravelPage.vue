<script setup lang="ts">
// Đo hành trình thật (DESIGN §7): press a real key and watch the switch move against the trigger points
// from the key's settings. Polling lives in stores/live.ts; this page renders from one rAF loop.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IconAdjustmentsHorizontal, IconAlertTriangle, IconPlayerPause, IconPlayerPlay, IconRefresh, IconTrash } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import SwitchSim from '../components/live/SwitchSim.vue';
import TravelGraph from '../components/live/TravelGraph.vue';
import { attachDemoPress } from '../components/live/demoPress';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import IconButton from '../components/ui/IconButton.vue';
import Segmented from '../components/ui/Segmented.vue';
import Switch from '../components/ui/Switch.vue';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { DEFAULT_RANGE_MM, rangeMm, usePerformanceStore } from '../stores/performance';
import { settingsFrom, useLiveStore } from '../stores/live';
import type { MockTransport, PhysicalKey } from '../protocol';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const perf = usePerformanceStore();
const live = useLiveStore();
const route = useRoute();
const router = useRouter();

// ----- focus: selection on the keyboard = pinned key, empty selection = auto-follow
function syncFocusFromSelection() {
  const ids = sel.ids;
  if (!ids.length) {
    live.setFollow(true);
    return;
  }
  live.pin(sel.focused !== null && sel.selected.has(sel.focused) ? sel.focused : ids[0]);
}
watch(() => [sel.ids, sel.focused], syncFocusFromSelection);

function setFollow(v: 'auto' | 'pin' | null) {
  if (v === null) return;
  if (v === 'auto') sel.clear();
  else if (live.focusId !== null) sel.select(live.focusId);
}

const focusKey = computed<PhysicalKey | null>(() => (live.focusId === null ? null : device.keys[live.focusId]));
const focusPerf = computed(() => (live.focusId === null ? undefined : perf.values[live.focusId]));
const settings = computed(() => (focusPerf.value ? settingsFrom(focusPerf.value) : null));
const range = computed(() => (focusPerf.value ? rangeMm(focusPerf.value) : DEFAULT_RANGE_MM));
const keyName = computed(() => (focusKey.value ? device.legend(focusKey.value) : '—'));
const modeLabel = computed(() => (settings.value ? (settings.value.mode === 1 ? t('perf.modeRt') : t('perf.modeStandard')) : ''));

function editKey() {
  if (live.focusId === null) return;
  sel.select(live.focusId);
  void router.push('/performance');
}

// ----- per-frame view (one reactive update per animation frame at most)
interface View {
  current: number; peak: number; count: number; lastActuation: number | null; lastRelease: number | null; rate: number;
  firmware: boolean; mismatch: boolean; resetAt: number | null; reactuateAt: number | null; touched: boolean;
}
const view = shallowRef<View>({
  current: 0, peak: 0, count: 0, lastActuation: null, lastRelease: null, rate: 0,
  firmware: false, mismatch: false, resetAt: null, reactuateAt: null, touched: false,
});
const heat = shallowRef<{ ratio: number[]; status: number[]; travel: number[] }>({ ratio: [], status: [], travel: [] });
const graphPaused = ref(false);

let raf = 0;
let seen = -1;
let lastHeat = 0;
let lastRate = -1;
const HEAT_MS = 33;

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  const d = live.data;
  if (d.version === seen && d.rateHz === lastRate) return;
  seen = d.version;
  lastRate = d.rateHz;
  view.value = {
    current: d.current, peak: d.peak, count: d.count, lastActuation: d.lastActuation, lastRelease: d.lastRelease,
    rate: d.rateHz, firmware: d.firmwarePressed, mismatch: d.mismatch,
    resetAt: d.model?.resetAt ?? null, reactuateAt: d.model?.reactuateAt ?? null, touched: d.touched,
  };
  if (now - lastHeat >= HEAT_MS) {
    lastHeat = now;
    heat.value = { ratio: Array.from(d.ratio), status: Array.from(d.status), travel: Array.from(d.travel) };
  }
}

// ----- keyboard heat view
const heatFill = (k: PhysicalKey) => heat.value.ratio[k.id] || 0;
const heatState = (k: PhysicalKey) => (heat.value.status[k.id] > 0 ? 'pressed' as const : undefined);
function heatSub(k: PhysicalKey) {
  const mm = heat.value.travel[k.id] || 0;
  return mm > 0.05 ? mm.toFixed(2) : undefined;
}
/** In auto-follow there is no selection ring, so the followed key gets an accent bar. */
const heatColor = (k: PhysicalKey) => (live.follow && k.id === live.focusId ? 'var(--acc)' : undefined);

// ----- demo: PC keyboard drives the emulator
const demoKeys = ref(true);
let detachDemo: (() => void) | null = null;
watch(() => device.demo && demoKeys.value && device.transport?.kind === 'mock', (on) => {
  detachDemo?.();
  detachDemo = on ? attachDemoPress(device.transport as MockTransport) : null;
}, { immediate: true });

// ----- lifecycle
let offProfile: (() => void) | null = null;
onMounted(() => {
  const q = Number(route.query.key);
  if (route.query.key !== undefined && Number.isInteger(q) && device.keys[q]) sel.select(q);
  syncFocusFromSelection();
  if (live.focusId === null) live.setFocus(device.keys.find((k) => k.name === 'W')?.id ?? 0);
  live.clear();
  live.start();
  offProfile = device.onProfileChanged(async () => {
    live.stop();
    live.reset();
    await perf.load(true);
    live.start();
  });
  raf = requestAnimationFrame(frame);
});
onBeforeUnmount(() => {
  live.stop();
  offProfile?.();
  detachDemo?.();
  cancelAnimationFrame(raf);
});

const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(2));
const unit = (v: number | null) => (v === null ? '' : 'mm');
const followOptions = computed(() => [
  { value: 'auto' as const, label: t('live.followAuto'), title: t('live.followAutoHint') },
  { value: 'pin' as const, label: t('live.followPinned'), title: t('live.followPinnedHint') },
]);
const simLabel = computed(() => t('live.simLabel', { key: keyName.value, mm: view.value.current.toFixed(2) }));
</script>

<template>
  <PageLayout :title="t('page.live')">
    <section class="kbrow">
      <div class="board">
        <KeyboardView
          :keys="device.keys"
          :legend="device.legend"
          :sublabel="heatSub"
          :fill="heatFill"
          :state="heatState"
          :color="heatColor"
          selectable
        />
      </div>
      <aside class="aside">
        <span class="micro">{{ t('live.follow') }}</span>
        <Segmented
          :model-value="live.follow ? 'auto' : 'pin'"
          :options="followOptions"
          :label="t('live.follow')"
          size="sm"
          @update:model-value="setFollow"
        />
        <p class="hint">{{ live.follow ? t('live.followAutoHint') : t('live.followPinnedHint') }}</p>
        <Switch v-if="!live.follow" v-model="live.allKeys" class="toggle" :label="t('live.allKeys')" :title="t('live.allKeysHint')" />
        <Switch v-if="device.demo" v-model="demoKeys" class="toggle" :label="t('live.demoKeys')" :title="t('live.demoKeysHint')" />
      </aside>
    </section>

    <p v-if="!view.touched" class="start" aria-live="polite">
      <span class="start__dot" />
      {{ device.demo && demoKeys ? t('live.startHintDemo') : t('live.startHint') }}
    </p>
    <p v-if="live.paused" class="status num">{{ t('live.paused') }}</p>
    <p v-else-if="!live.running" class="status">
      {{ t('live.stopped') }}
      <Button size="sm" variant="ghost" :icon="IconRefresh" @click="live.start()">{{ t('live.restart') }}</Button>
    </p>

    <div class="grid">
      <Card class="simcard" :title="t('live.sim')" :subtitle="focusKey ? `${keyName} · ${modeLabel}` : undefined">
        <template #actions>
          <Button size="sm" variant="ghost" :icon="IconAdjustmentsHorizontal" :disabled="live.focusId === null" @click="editKey">
            {{ t('live.editKey') }}
          </Button>
        </template>
        <SwitchSim
          :travel="view.current"
          :peak="view.peak"
          :range="range"
          :settings="settings"
          :reset-at="view.resetAt"
          :reactuate-at="view.reactuateAt"
          :actuated="view.firmware"
          :label="simLabel"
        />
        <p v-if="!settings" class="hint">{{ t('live.loadingSettings') }}</p>
      </Card>

      <Card class="readcard">
        <div class="lamp" :class="{ 'lamp--on': view.firmware }" role="status">
          <span class="lamp__light" />
          <div>
            <div class="lamp__text">{{ view.firmware ? t('live.actuated') : t('live.idle') }}</div>
            <div class="lamp__src">{{ t('live.lampSource') }}</div>
          </div>
        </div>
        <p v-if="view.mismatch" class="mismatch" role="alert">
          <IconAlertTriangle :size="14" />
          {{ t('live.mismatch') }}
        </p>

        <div class="hero">
          <span class="micro">{{ t('live.current') }}</span>
          <div class="big num">{{ view.current.toFixed(2) }}<span class="unit">mm</span></div>
          <div class="bar"><span :style="{ transform: `scaleX(${Math.min(1, view.current / range)})` }" /></div>
        </div>

        <dl class="stats">
          <div><dt>{{ t('live.peak') }}</dt><dd class="num">{{ fmt(view.peak) }}<small>mm</small></dd></div>
          <div><dt>{{ t('live.count') }}</dt><dd class="num">{{ view.count }}</dd></div>
          <div><dt>{{ t('live.lastActuation') }}</dt><dd class="num acc">{{ fmt(view.lastActuation) }}<small>{{ unit(view.lastActuation) }}</small></dd></div>
          <div><dt>{{ t('live.lastRelease') }}</dt><dd class="num">{{ fmt(view.lastRelease) }}<small>{{ unit(view.lastRelease) }}</small></dd></div>
          <div><dt>{{ t('live.rate') }}</dt><dd class="num">{{ Math.round(view.rate) }}<small>Hz</small></dd></div>
        </dl>
      </Card>

      <Card class="graphcard" :title="t('live.graph')">
        <template #actions>
          <span class="legend"><i class="dot dot--press" />{{ t('live.legendPress') }}</span>
          <span class="legend"><i class="dot dot--release" />{{ t('live.legendRelease') }}</span>
          <IconButton
            :icon="graphPaused ? IconPlayerPlay : IconPlayerPause"
            :label="graphPaused ? t('live.resume') : t('live.pause')"
            :active="graphPaused"
            size="sm"
            @click="graphPaused = !graphPaused"
          />
          <IconButton :icon="IconTrash" :label="t('live.clear')" size="sm" @click="live.clear()" />
        </template>
        <TravelGraph
          :data="live.data"
          :settings="settings"
          :range="range"
          :paused="graphPaused"
          :label="t('live.graphLabel', { key: keyName })"
        />
      </Card>
    </div>
  </PageLayout>
</template>

<style scoped>
.kbrow { display: flex; gap: var(--s-5); align-items: flex-start; }
.board { flex: 1; min-width: 0; max-width: 940px; margin: 0 auto; }
.aside { flex: none; width: 188px; display: flex; flex-direction: column; gap: var(--s-2); }
.hint { color: var(--fg-3); font-size: var(--fs-label); }
.toggle { font-size: var(--fs-label); }

@media (max-width: 1360px) {
  .kbrow { flex-direction: column-reverse; align-items: stretch; }
  .aside { width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--s-3); }
  .aside .hint { flex-basis: 100%; order: 9; }
}

.start {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--s-2);
  color: var(--fg-2);
}
.start__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--acc);
  animation: breathe 1.6s var(--ease) infinite;
}
@keyframes breathe {
  0%, 100% { opacity: 0.35; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .start__dot { animation: none; }
}
.status { display: flex; align-items: center; justify-content: center; gap: var(--s-2); color: var(--warn); font-size: var(--fs-label); }

.grid {
  display: grid;
  grid-template-columns: minmax(360px, 1.15fr) minmax(280px, 1fr);
  gap: var(--s-4);
  align-items: start;
}
.graphcard { grid-column: 1 / -1; }
@media (max-width: 1100px) {
  .grid { grid-template-columns: 1fr; }
}
.simcard :deep(.sim) { margin: var(--s-2) auto 0; }

.lamp {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-card);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.lamp__light {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--fg-4);
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.4);
  transition: background var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.lamp__text { font-weight: 600; letter-spacing: 0.06em; color: var(--fg-3); font-size: var(--fs-body); }
.lamp__src { font-size: var(--fs-caption); color: var(--fg-4); }
.lamp--on { background: var(--acc-soft); border-color: var(--acc-line); }
.lamp--on .lamp__light { background: var(--acc); box-shadow: 0 0 12px var(--acc), 0 0 2px var(--acc); }
.lamp--on .lamp__text { color: var(--acc); }
.lamp--on .lamp__src { color: var(--fg-3); }

.mismatch {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: var(--s-2);
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-control);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-label);
}
.mismatch svg { flex: none; margin-top: 1px; }

.hero { display: flex; flex-direction: column; gap: 6px; margin: var(--s-5) 0 var(--s-4); }
.big { font-size: 56px; font-weight: 600; letter-spacing: -0.03em; line-height: 1; }
.big .unit { margin-left: 6px; font-size: var(--fs-card); font-weight: 500; color: var(--fg-3); letter-spacing: 0; }
.bar { height: 4px; border-radius: 2px; background: var(--bg-4); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--acc); transform-origin: left; }

.stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1px;
  margin: 0;
  border-radius: var(--r-card);
  overflow: hidden;
  background: var(--line-1);
  border: 1px solid var(--line-1);
}
.stats > div { background: var(--bg-2); padding: var(--s-3) var(--s-4); display: flex; flex-direction: column; gap: 4px; }
.stats > div:last-child:nth-child(odd) { grid-column: 1 / -1; }
.stats dt { font-size: var(--fs-caption); color: var(--fg-3); }
.stats dd { margin: 0; font-size: var(--fs-hero); font-weight: 600; letter-spacing: -0.01em; }
.stats dd small { margin-left: 4px; font-size: var(--fs-label); font-weight: 500; color: var(--fg-3); }
.stats dd.acc { color: var(--acc); }

.legend { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-label); color: var(--fg-3); margin-right: var(--s-2); }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.dot--press { background: var(--acc); }
.dot--release { border: 1.5px solid var(--fg-2); }
</style>
