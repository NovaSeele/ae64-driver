<script setup lang="ts">
// Hành trình — reference implementation of the per-key page pattern (docs/ARCHITECTURE.md).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IconAdjustmentsHorizontal, IconFlask, IconLink, IconLinkOff, IconRefresh } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import EmptyState from '../components/shell/EmptyState.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import TravelEditor from '../components/performance/TravelEditor.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import IconButton from '../components/ui/IconButton.vue';
import Segmented from '../components/ui/Segmented.vue';
import Slider from '../components/ui/Slider.vue';
import NumberField from '../components/ui/NumberField.vue';
import AnimatedNumber from '../components/ui/AnimatedNumber.vue';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { LIMITS, PRESETS, actuationOf, rangeMm, usePerformanceStore } from '../stores/performance';
import type { PerfEdit } from '../stores/performance';
import type { Performance, PerfMode, PhysicalKey } from '../protocol';
import { useToast } from '../components/ui/toast';
import { t } from '../i18n/vi';
import type { MessageKey } from '../i18n/vi';

type Metric = 'actuation' | 'rtPress' | 'rtRelease' | 'deadzone';

const device = useDeviceStore();
const sel = useSelectionStore();
const perf = usePerformanceStore();
const router = useRouter();
const toast = useToast();

const metric = ref<Metric>('actuation');
const rtLinked = ref(true);
const METRICS: { id: Metric; label: MessageKey }[] = [
  { id: 'actuation', label: 'perf.metricActuation' },
  { id: 'rtPress', label: 'perf.metricRtPress' },
  { id: 'rtRelease', label: 'perf.metricRtRelease' },
  { id: 'deadzone', label: 'perf.metricDeadzone' },
];
const PRESET_TEXT: Record<(typeof PRESETS)[number]['id'], [MessageKey, MessageKey]> = {
  typing: ['perf.presetTyping', 'perf.presetTypingDesc'],
  gaming: ['perf.presetGaming', 'perf.presetGamingDesc'],
  sensitive: ['perf.presetSensitive', 'perf.presetSensitiveDesc'],
};

let offProfile: (() => void) | null = null;
onMounted(() => {
  void perf.load();
  offProfile = device.onProfileChanged(() => void perf.load(true));
});
onBeforeUnmount(() => offProfile?.());

const decimals = computed(() => (device.rtPrecision < 0.01 ? 3 : 2));
function fmt(v: number): string {
  const s = v.toFixed(decimals.value).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
}

// ----- keyboard
function sublabel(k: PhysicalKey): string | undefined {
  const p = perf.values[k.id];
  if (!p) return undefined;
  switch (metric.value) {
    case 'actuation': return fmt(actuationOf(p));
    case 'rtPress': return p.mode === 1 ? fmt(p.rtPress) : '—';
    case 'rtRelease': return p.mode === 1 ? fmt(p.rtRelease) : '—';
    case 'deadzone': return `${fmt(p.pressDeadStroke)}·${fmt(p.releaseDeadStroke)}`;
  }
}
function fill(k: PhysicalKey): number | undefined {
  const p = perf.values[k.id];
  return p && metric.value === 'actuation' ? actuationOf(p) / rangeMm(p) : undefined;
}

// ----- selection summary
const ids = computed(() => sel.ids.filter((id) => perf.values[id]));
const recs = computed<Performance[]>(() => ids.value.map((id) => perf.values[id]));
const hasSel = computed(() => recs.value.length > 0);

function summary(get: (p: Performance) => number): { value: number | null; range: [number, number] } {
  const vs = recs.value.map(get);
  if (!vs.length) return { value: null, range: [0, 0] };
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  return { value: hi - lo < 0.0005 ? lo : null, range: [lo, hi] };
}
const mode = computed<PerfMode | null>(() => {
  const m = new Set(recs.value.map((p) => p.mode));
  return m.size === 1 ? [...m][0] : null;
});
const anyRt = computed(() => recs.value.some((p) => p.mode === 1));
const allRt = computed(() => recs.value.length > 0 && recs.value.every((p) => p.mode === 1));
const maxTravel = computed(() => (recs.value.length ? Math.min(...recs.value.map(rangeMm)) : 3.31));
const act = computed(() => summary(actuationOf));
const rtPress = computed(() => summary((p) => p.rtPress));
const rtRelease = computed(() => summary((p) => p.rtRelease));
const deadTop = computed(() => summary((p) => p.pressDeadStroke));
const deadBottom = computed(() => summary((p) => p.releaseDeadStroke));
const deadFields = computed(() => [
  { field: 'pressDeadStroke' as const, label: t('perf.deadTop'), s: deadTop.value },
  { field: 'releaseDeadStroke' as const, label: t('perf.deadBottom'), s: deadBottom.value },
]);

// ----- edits (every edit goes through perf.apply → history + sync)
function setMode(m: PerfMode | null) {
  if (m === null) return;
  perf.apply(ids.value, () => ({ mode: m }), t('perf.mode'));
}
function setActuation(v: number, gesture = true) {
  perf.apply(ids.value, (p) => (p.mode === 1 ? { rtFirstTouch: v } : { normalPress: v }), t('perf.actuation'), gesture ? 'act' : undefined);
}
function setRt(which: 'rtPress' | 'rtRelease', v: number, gesture = true) {
  const patch: Partial<PerfEdit> = rtLinked.value ? { rtPress: v, rtRelease: v } : { [which]: v };
  perf.apply(ids.value.filter((id) => perf.values[id].mode === 1), () => patch, t('perf.rt'), gesture ? `rt-${which}` : undefined);
}
function setDead(which: 'pressDeadStroke' | 'releaseDeadStroke', v: number, gesture = true) {
  perf.apply(ids.value, () => ({ [which]: v }), t('perf.deadzones'), gesture ? `dz-${which}` : undefined);
}
function applyPreset(id: (typeof PRESETS)[number]['id']) {
  const preset = PRESETS.find((p) => p.id === id)!;
  const name = t(PRESET_TEXT[id][0]);
  perf.apply(ids.value, () => preset.values, name);
  toast.show(t('perf.presetApplied', { name, n: ids.value.length }), 'success');
}
function tryNow() {
  const key = sel.focused !== null && sel.selected.has(sel.focused) ? sel.focused : ids.value[0];
  void router.push({ path: '/live', query: { key: String(key) } });
}

const modeOptions = computed(() => [
  { value: 0 as PerfMode, label: t('perf.modeStandard') },
  { value: 1 as PerfMode, label: t('perf.modeRt') },
]);
</script>

<template>
  <PageLayout :title="t('page.performance')" keyboard>
    <template #keyboard>
      <KeyboardView
        :keys="device.keys"
        :legend="device.legend"
        :sublabel="sublabel"
        :fill="fill"
        :loading="perf.loading"
        selectable
      />
    </template>

    <template #keyboard-aside>
      <span class="micro aside-label">{{ t('perf.metric') }}</span>
      <div class="chips" role="radiogroup" :aria-label="t('perf.metric')">
        <button
          v-for="m in METRICS"
          :key="m.id"
          type="button"
          role="radio"
          class="chip"
          :aria-checked="metric === m.id"
          @click="metric = m.id"
        >
          {{ t(m.label) }}
        </button>
      </div>
      <Button class="try" variant="secondary" size="sm" :icon="IconFlask" :disabled="!hasSel" :title="t('perf.tryNowHint')" @click="tryNow">
        {{ t('perf.tryNow') }}
      </Button>
    </template>

    <!-- load error -->
    <Card v-if="perf.loadError" :title="t('perf.loadFailed')" :subtitle="perf.loadError">
      <div><Button :icon="IconRefresh" @click="perf.load(true)">{{ t('perf.reload') }}</Button></div>
    </Card>

    <!-- loading skeleton -->
    <div v-else-if="perf.loading" class="grid" aria-busy="true">
      <p class="loading num">{{ t('perf.loading', { n: perf.loadedCount }) }}</p>
      <div v-for="i in 3" :key="i" class="skel-card">
        <div class="skeleton" style="width: 40%; height: 14px" />
        <div class="skeleton" style="height: 120px" />
        <div class="skeleton" style="width: 70%; height: 12px" />
      </div>
    </div>

    <!-- nothing selected -->
    <EmptyState v-else-if="!hasSel" :icon="IconAdjustmentsHorizontal" :title="t('page.performance')" :body="t('perf.selectKeys')" />

    <!-- editors -->
    <div v-else class="grid">
      <Card :title="t('perf.actuation')" :subtitle="allRt ? t('perf.actuationHintRt') : t('perf.actuationHintStandard')">
        <div class="act">
          <TravelEditor
            :value="act.value"
            :range="act.range"
            :min="LIMITS.actuationMin"
            :max="maxTravel"
            :step="0.05"
            :dead-top="deadTop.value"
            :dead-bottom="deadBottom.value"
            :label="t('perf.actuation')"
            @update="setActuation"
            @commit="setActuation"
          />
          <div class="act__readout">
            <span class="micro">{{ t('perf.travel') }}</span>
            <div class="big">
              <AnimatedNumber v-if="act.value !== null" :value="act.value" :decimals="decimals" />
              <span v-else class="mixed">{{ fmt(act.range[0]) }}–{{ fmt(act.range[1]) }}</span>
              <span class="unit">mm</span>
            </div>
            <NumberField
              :model-value="act.value"
              :min="LIMITS.actuationMin"
              :max="maxTravel"
              :step="0.05"
              :decimals="decimals"
              :label="t('perf.actuation')"
              @update:model-value="setActuation($event, false)"
            />
            <span class="hint num">{{ t('perf.range', { max: fmt(maxTravel) }) }}</span>
          </div>
        </div>
      </Card>

      <Card :title="t('perf.mode')">
        <Segmented :model-value="mode" :options="modeOptions" :label="t('perf.mode')" @update:model-value="setMode" />
        <p class="hint">
          {{ mode === null ? t('perf.modeMixed') : mode === 1 ? t('perf.modeHintRt') : t('perf.modeHintStandard') }}
        </p>
      </Card>

      <Card :title="t('perf.rt')">
        <template #actions>
          <IconButton
            :icon="rtLinked ? IconLink : IconLinkOff"
            :label="t('perf.rtLink')"
            :active="rtLinked"
            size="sm"
            :disabled="!anyRt"
            @click="rtLinked = !rtLinked"
          />
        </template>
        <p v-if="!anyRt" class="hint">{{ t('perf.rtDisabled') }}</p>
        <div class="field" :class="{ 'field--off': !anyRt }">
          <div class="field__row">
            <span class="field__label">{{ t('perf.rtPress') }}</span>
            <NumberField
              :model-value="rtPress.value"
              :min="LIMITS.rtMin"
              :max="LIMITS.rtMax"
              :step="0.05"
              :decimals="decimals"
              :label="t('perf.rtPress')"
              :disabled="!anyRt"
              @update:model-value="setRt('rtPress', $event, false)"
            />
          </div>
          <Slider
            :model-value="rtPress.value ?? rtPress.range[0]"
            :range="rtPress.value === null && anyRt ? rtPress.range : null"
            :min="LIMITS.rtMin"
            :max="LIMITS.rtMax"
            :step="0.05"
            :fine-step="0.01"
            :label="t('perf.rtPress')"
            :disabled="!anyRt"
            @update:model-value="setRt('rtPress', $event)"
          />
        </div>
        <div class="field" :class="{ 'field--off': !anyRt }">
          <div class="field__row">
            <span class="field__label">{{ t('perf.rtRelease') }}</span>
            <NumberField
              :model-value="rtRelease.value"
              :min="LIMITS.rtMin"
              :max="LIMITS.rtMax"
              :step="0.05"
              :decimals="decimals"
              :label="t('perf.rtRelease')"
              :disabled="!anyRt"
              @update:model-value="setRt('rtRelease', $event, false)"
            />
          </div>
          <Slider
            :model-value="rtRelease.value ?? rtRelease.range[0]"
            :range="rtRelease.value === null && anyRt ? rtRelease.range : null"
            :min="LIMITS.rtMin"
            :max="LIMITS.rtMax"
            :step="0.05"
            :fine-step="0.01"
            :label="t('perf.rtRelease')"
            :disabled="!anyRt"
            @update:model-value="setRt('rtRelease', $event)"
          />
        </div>
      </Card>

      <Card :title="t('perf.deadzones')" :subtitle="t('perf.deadHint')">
        <div v-for="dz in deadFields" :key="dz.field" class="field">
          <div class="field__row">
            <span class="field__label">{{ dz.label }}</span>
            <NumberField
              :model-value="dz.s.value"
              :min="0"
              :max="LIMITS.deadMax"
              :step="0.05"
              :decimals="decimals"
              :label="dz.label"
              @update:model-value="setDead(dz.field, $event, false)"
            />
          </div>
          <Slider
            :model-value="dz.s.value ?? dz.s.range[0]"
            :range="dz.s.value === null ? dz.s.range : null"
            :min="0"
            :max="LIMITS.deadMax"
            :step="0.05"
            :fine-step="0.01"
            :label="dz.label"
            @update:model-value="setDead(dz.field, $event)"
          />
        </div>
      </Card>

      <Card :title="t('perf.presets')">
        <div class="presets">
          <button v-for="p in PRESETS" :key="p.id" type="button" class="preset" @click="applyPreset(p.id)">
            <span class="preset__name">{{ t(PRESET_TEXT[p.id][0]) }}</span>
            <span class="preset__desc num">{{ t(PRESET_TEXT[p.id][1]) }}</span>
          </button>
        </div>
      </Card>
    </div>
  </PageLayout>
</template>

<style scoped>
.aside-label { padding: 0 2px; }
.chips { display: flex; flex-direction: column; gap: 4px; }
.chip {
  height: 30px;
  padding: 0 12px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: var(--fs-label);
  font-weight: 500;
  text-align: left;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.chip:hover { color: var(--fg-1); border-color: var(--line-3); }
.chip[aria-checked='true'] { background: var(--acc-soft); border-color: var(--acc-line); color: var(--acc); }
.try { margin-top: var(--s-2); }

@media (max-width: 1360px) {
  .chips { flex-direction: row; }
  .aside-label { align-self: center; }
  .try { margin-top: 0; }
}

.grid {
  /* Balanced columns (masonry-like) so cards of different heights pack without gaps. */
  columns: 3 280px;
  column-gap: var(--s-4);
}
.grid > * { break-inside: avoid; margin-bottom: var(--s-4); }
@media (max-width: 1360px) {
  .grid { columns: 2 280px; }
}

.loading { column-span: all; margin-bottom: var(--s-3); color: var(--fg-3); }
.skel-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-5);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
}

.act { display: flex; gap: var(--s-6); align-items: center; flex-wrap: wrap; }
.act__readout { display: flex; flex-direction: column; gap: var(--s-2); min-width: 150px; }
.big { display: flex; align-items: baseline; gap: 6px; font-size: 40px; font-weight: 600; letter-spacing: -0.02em; line-height: 1.05; }
.big .unit { font-size: var(--fs-card); font-weight: 500; color: var(--fg-3); letter-spacing: 0; }
.big .mixed { font-size: var(--fs-hero); color: var(--fg-2); }
.act__readout :deep(.nf) { width: 150px; }

.hint { color: var(--fg-3); font-size: var(--fs-label); }
.field { display: flex; flex-direction: column; gap: var(--s-2); transition: opacity var(--t-fast) var(--ease); }
.field--off { opacity: 0.45; }
.field__row { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
.field__label { color: var(--fg-2); }
.field__row :deep(.nf) { width: 132px; }

.presets { display: flex; flex-direction: column; gap: var(--s-2); }
.preset {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  text-align: left;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.preset:hover { background: var(--bg-4); border-color: var(--acc-line); }
.preset:active { transform: translateY(1px); }
.preset__name { font-weight: 600; }
.preset__desc { font-size: var(--fs-label); color: var(--fg-3); }
</style>
