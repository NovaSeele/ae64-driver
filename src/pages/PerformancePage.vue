<script lang="ts">
import type { Performance as PerformanceRec } from '../protocol';

/** RT press/release start linked only when every Rapid Trigger key in the selection already has them equal. */
export function deriveRtLinked(recs: PerformanceRec[], isRt: (mode: number) => boolean): boolean {
  return recs.filter((p) => isRt(p.mode)).every((p) => Math.abs(p.rtPress - p.rtRelease) < 0.0005);
}
</script>

<script setup lang="ts">
// Hành trình — reference implementation of the per-key page pattern (docs/ARCHITECTURE.md).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { IconAdjustmentsHorizontal, IconAlertTriangle, IconFlask, IconLink, IconLinkOff, IconLock, IconRefresh } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import EmptyState from '../components/shell/EmptyState.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import TravelEditor from '../components/performance/TravelEditor.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import Segmented from '../components/ui/Segmented.vue';
import Slider from '../components/ui/Slider.vue';
import Switch from '../components/ui/Switch.vue';
import NumberField, { decimalsFor, formatMm } from '../components/ui/NumberField.vue';
import AnimatedNumber from '../components/ui/AnimatedNumber.vue';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { LIMITS, PRESETS, actuationOf, isKnownMode, rangeMm, usePerformanceStore } from '../stores/performance';
import type { PerfEdit } from '../stores/performance';
import { isRtMode, supportsIntervalRt } from '../protocol';
import type { Performance, PerfMode, PhysicalKey } from '../protocol';
import { useToast } from '../components/ui/toast';
import { t } from '../i18n/vi';
import type { MessageKey } from '../i18n/vi';
import type { SubLine } from '../components/keyboard/Keycap.vue';

type Metric = 'actuation' | 'rt' | 'deadzone';

const device = useDeviceStore();
const sel = useSelectionStore();
const perf = usePerformanceStore();
const router = useRouter();
const toast = useToast();

const metric = ref<Metric>('actuation');
const METRIC_TONE: Record<Metric, string> = {
  actuation: 'var(--m-actuation)',
  rt: 'var(--m-press)',
  deadzone: 'var(--m-deadzone)',
};
const METRICS: { id: Metric; label: MessageKey }[] = [
  { id: 'actuation', label: 'perf.metricActuation' },
  { id: 'rt', label: 'perf.metricRt' },
  { id: 'deadzone', label: 'perf.metricDeadzone' },
];

// Display preference only (never sent to the keyboard).
const SHADING_KEY = 'ae64.perf.depthShading';
function loadShading(): boolean {
  try {
    return localStorage.getItem(SHADING_KEY) === '1';
  } catch {
    return false;
  }
}
const depthShading = ref(loadShading());
watch(depthShading, (on) => {
  try {
    localStorage.setItem(SHADING_KEY, on ? '1' : '0');
  } catch {
    // ignore storage error
  }
});
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
/** Editor value text: 2 decimals unless the value needs the third. */
const fmtEdit = (v: number) => formatMm(v, decimals.value);
function fmt(v: number): string {
  const s = v.toFixed(decimals.value).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
}

// ----- keyboard
function sublabel(k: PhysicalKey): string | SubLine[] | undefined {
  const p = perf.values[k.id];
  if (!p) return undefined;
  switch (metric.value) {
    case 'actuation': return fmt(actuationOf(p));
    case 'rt':
      return isRtMode(p.mode)
        ? [{ text: `↓${fmt(p.rtPress)}`, tone: 'var(--m-press)' }, { text: `↑${fmt(p.rtRelease)}`, tone: 'var(--m-release)' }]
        : '—';
    case 'deadzone': return [{ text: `↑${fmt(p.pressDeadStroke)}`, tone: 'var(--m-deadzone)' }, { text: `↓${fmt(p.releaseDeadStroke)}`, tone: 'var(--m-deadzone)' }];
  }
}
/** Rapid Trigger keys carry an "RT" tag in the actuation view; the full numbers are in its title. */
function badge(k: PhysicalKey): string | undefined {
  const p = perf.values[k.id];
  return p && isRtMode(p.mode) && metric.value === 'actuation' ? 'RT' : undefined;
}
function badgeIcon(k: PhysicalKey) {
  const p = perf.values[k.id];
  return p && !isKnownMode(p.mode) ? IconLock : undefined;
}
function badgeTitle(k: PhysicalKey): string | undefined {
  const p = perf.values[k.id];
  if (!p) return undefined;
  if (!isKnownMode(p.mode)) return t('perf.unsupportedMode');
  return badge(k) ? t('perf.rtTagTitle', { press: fmt(p.rtPress), release: fmt(p.rtRelease) }) : undefined;
}
function fill(k: PhysicalKey): number | undefined {
  const p = perf.values[k.id];
  return p && depthShading.value && metric.value === 'actuation' ? actuationOf(p) / rangeMm(p) : undefined;
}

// ----- selection summary
/** Selected keys that are loaded; keys in a firmware mode we do not know are shown but never edited (store.apply skips them). */
const loadedIds = computed(() => sel.ids.filter((id) => perf.values[id]));
const hasSel = computed(() => loadedIds.value.length > 0);
const ids = computed(() => loadedIds.value.filter((id) => isKnownMode(perf.values[id].mode)));
const unknownCount = computed(() => loadedIds.value.length - ids.value.length);
const recs = computed<Performance[]>(() => ids.value.map((id) => perf.values[id]));

// RT link: derived from the selection, re-derived whenever the selection changes; a click overrides it until then.
const rtLinkOverride = ref<boolean | null>(null);
const rtLinked = computed(() => rtLinkOverride.value ?? deriveRtLinked(recs.value, isRtMode));
watch(() => ids.value.join(','), () => { rtLinkOverride.value = null; });

function summary(get: (p: Performance) => number): { value: number | null; range: [number, number] } {
  const vs = recs.value.map(get);
  if (!vs.length) return { value: null, range: [0, 0] };
  const lo = Math.min(...vs);
  const hi = Math.max(...vs);
  return { value: hi - lo < 0.0005 ? lo : null, range: [lo, hi] };
}
/** Standard (0) or Rapid Trigger (1, either flavour) for the Segmented control. */
const mode = computed<PerfMode | null>(() => {
  const m = new Set(recs.value.map((p): PerfMode => (isRtMode(p.mode) ? 1 : 0)));
  return m.size === 1 ? [...m][0] : null;
});
const anyRt = computed(() => recs.value.some((p) => isRtMode(p.mode)));
const allRt = computed(() => recs.value.length > 0 && recs.value.every((p) => isRtMode(p.mode)));
/** Continuous RT can be turned off on protocol ≥ 1.3.0.0 (factory driver rule), or where a key already is in mode 2. */
const intervalRt = computed(() => supportsIntervalRt(device.version) || recs.value.some((p) => p.mode === 2));
/** Continuous RT across the selected RT keys: true (all mode 1), false (all mode 2), null (mixed / none). */
const continuous = computed<boolean | null>(() => {
  const m = new Set(recs.value.filter((p) => isRtMode(p.mode)).map((p) => p.mode));
  return m.size === 1 ? m.has(1) : null;
});
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
  // Turning RT on keeps a key's Continuous setting if it is already RT; new RT keys start continuous (mode 1).
  perf.apply(ids.value, (p) => ({ mode: m === 0 ? 0 : isRtMode(p.mode) ? p.mode : 1 }), t('perf.mode'));
}
function setContinuous(on: boolean) {
  perf.apply(ids.value.filter((id) => isRtMode(perf.values[id].mode)), () => ({ mode: on ? 1 : 2 }), t('perf.continuous'));
}
/** Relative step from a mixed field: each key moves one step from its own value (the store clamps). */
const add = (v: number, d: number) => Number((v + d).toFixed(3));
function stepActuation(d: number) {
  perf.apply(ids.value, (p) => (isRtMode(p.mode) ? { rtFirstTouch: add(p.rtFirstTouch, d) } : { normalPress: add(p.normalPress, d) }), t('perf.actuation'));
}
function stepRt(which: 'rtPress' | 'rtRelease', d: number) {
  perf.apply(
    ids.value.filter((id) => isRtMode(perf.values[id].mode)),
    (p) => {
      const v = add(p[which], d);
      return rtLinked.value ? { rtPress: v, rtRelease: v } : { [which]: v };
    },
    t('perf.rt'),
  );
}
function stepDead(which: 'pressDeadStroke' | 'releaseDeadStroke', d: number) {
  perf.apply(ids.value, (p) => ({ [which]: add(p[which], d) }), t('perf.deadzones'));
}
function setActuation(v: number, gesture = true) {
  perf.apply(ids.value, (p) => (isRtMode(p.mode) ? { rtFirstTouch: v } : { normalPress: v }), t('perf.actuation'), gesture ? 'act' : undefined);
}
function setRt(which: 'rtPress' | 'rtRelease', v: number, gesture = true) {
  const patch: Partial<PerfEdit> = rtLinked.value ? { rtPress: v, rtRelease: v } : { [which]: v };
  perf.apply(ids.value.filter((id) => isRtMode(perf.values[id].mode)), () => patch, t('perf.rt'), gesture ? `rt-${which}` : undefined);
}
function setDead(which: 'pressDeadStroke' | 'releaseDeadStroke', v: number, gesture = true) {
  perf.apply(ids.value, () => ({ [which]: v }), t('perf.deadzones'), gesture ? `dz-${which}` : undefined);
}
function applyPreset(id: (typeof PRESETS)[number]['id']) {
  const preset = PRESETS.find((p) => p.id === id)!;
  const name = t(PRESET_TEXT[id][0]);
  // An RT preset keeps a key's Continuous RT setting (mode 2 stays 2).
  perf.apply(ids.value, (p) => ({ ...preset.values, mode: preset.values.mode !== 0 && p.mode === 2 ? 2 : preset.values.mode }), name);
  toast.show(t('perf.presetApplied', { name, n: ids.value.length }), 'success');
}
function tryNow() {
  const key = sel.focused !== null && sel.selected.has(sel.focused) ? sel.focused : loadedIds.value[0];
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
        :badge="badge"
        :badge-title="badgeTitle"
        :badge-icon="badgeIcon"
        :fill="fill"
        :loading="perf.loading"
        :style="{ '--metric': METRIC_TONE[metric] }"
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
          :style="{ '--chip': METRIC_TONE[m.id] }"
          :aria-checked="metric === m.id"
          @click="metric = m.id"
        >
          <span class="chip__dot" :class="{ 'chip__dot--rt': m.id === 'rt' }" aria-hidden="true" />{{ t(m.label) }}
        </button>
      </div>
      <div class="aside-sub">
        <template v-if="metric === 'actuation'">
          <p class="aside-hint">{{ t('perf.rtBadgeHint') }}</p>
          <div class="shading">
            <Switch v-model="depthShading" :label="t('perf.depthShading')" :title="t('perf.depthShadingHint')" describedby="perf-shading-hint" />
            <p id="perf-shading-hint" class="shading__hint">{{ t('perf.depthShadingHint') }}</p>
          </div>
        </template>
        <p v-else-if="metric === 'rt'" class="aside-hint">{{ t('perf.rtViewHint') }}</p>
        <p v-else-if="metric === 'deadzone'" class="aside-hint">{{ t('perf.deadzoneViewHint') }}</p>
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
      <div v-if="unknownCount" class="unknown" role="note">
        <IconAlertTriangle :size="16" stroke-width="1.5" aria-hidden="true" />
        <span>{{ t('perf.unknownModes', { n: unknownCount }) }}</span>
      </div>
      <template v-if="recs.length">
      <Card :title="t('perf.actuation')" :subtitle="allRt ? t('perf.actuationHintRt') : t('perf.actuationHintStandard')">
        <div class="act">
          <TravelEditor
            :value="act.value"
            :range="act.range"
            :min="LIMITS.actuationMin"
            :max="maxTravel"
            :step="0.01"
            :dead-top="deadTop.value"
            :dead-bottom="deadBottom.value"
            :label="t('perf.actuation')"
            @update="setActuation"
            @commit="setActuation"
          />
          <div class="act__readout">
            <span class="micro">{{ t('perf.travel') }}</span>
            <div class="big">
              <AnimatedNumber v-if="act.value !== null" :value="act.value" :decimals="decimalsFor(act.value, decimals)" />
              <span v-else class="mixed">{{ fmtEdit(act.range[0]) }}–{{ fmtEdit(act.range[1]) }}</span>
              <span class="unit">mm</span>
            </div>
            <NumberField
              :model-value="act.value"
              :min="LIMITS.actuationMin"
              :max="maxTravel"
              :step="0.01"
              :decimals="decimals"
              :label="t('perf.actuation')"
              relative
              @update:model-value="setActuation($event, false)"
              @step="stepActuation"
            />
            <span class="hint num">{{ t('perf.range', { max: fmt(maxTravel) }) }}</span>
            <span v-if="decimals === 3" class="hint">{{ t('perf.fineHint') }}</span>
          </div>
        </div>
      </Card>

      <Card :title="t('perf.mode')">
        <Segmented :model-value="mode" :options="modeOptions" :label="t('perf.mode')" @update:model-value="setMode" />
        <p class="hint">
          {{ mode === null ? t('perf.modeMixed') : mode === 1 ? t('perf.modeHintRt') : t('perf.modeHintStandard') }}
        </p>
        <div v-if="anyRt && intervalRt" class="continuous">
          <Switch
            :model-value="continuous ?? false"
            :label="continuous === null ? `${t('perf.continuous')} (${t('perf.mixed')})` : t('perf.continuous')"
            @update:model-value="setContinuous"
          />
          <p class="hint">{{ continuous === false ? t('perf.continuousOffHint') : t('perf.continuousOnHint') }}</p>
        </div>
      </Card>

      <Card :title="t('perf.rt')">
        <template #actions>
          <button
            type="button"
            class="link"
            :class="{ 'link--on': rtLinked }"
            :aria-pressed="rtLinked"
            :title="t('perf.rtLinkHint')"
            :disabled="!anyRt"
            @click="rtLinkOverride = !rtLinked"
          >
            <component :is="rtLinked ? IconLink : IconLinkOff" :size="16" stroke-width="1.5" aria-hidden="true" />
            {{ t('perf.rtLinkLabel') }}
          </button>
        </template>
        <p v-if="!anyRt" class="hint">{{ t('perf.rtDisabled') }}</p>
        <div class="field" :class="{ 'field--off': !anyRt }">
          <div class="field__row">
            <span class="field__label">{{ t('perf.rtPress') }}</span>
            <NumberField
              :model-value="rtPress.value"
              :min="LIMITS.rtMin"
              :max="LIMITS.rtMax"
              :step="0.01"
              :decimals="decimals"
              :label="t('perf.rtPress')"
              :disabled="!anyRt"
              relative
              @update:model-value="setRt('rtPress', $event, false)"
              @step="stepRt('rtPress', $event)"
            />
          </div>
          <Slider
            :model-value="rtPress.value ?? rtPress.range[0]"
            :range="rtPress.value === null && anyRt ? rtPress.range : null"
            :min="LIMITS.rtMin"
            :max="LIMITS.rtMax"
            :step="0.01"
            :fine-step="0.001"
            :label="t('perf.rtPress')"
            :disabled="!anyRt"
            style="--sl-tone: var(--m-press)"
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
              :step="0.01"
              :decimals="decimals"
              :label="t('perf.rtRelease')"
              :disabled="!anyRt"
              relative
              @update:model-value="setRt('rtRelease', $event, false)"
              @step="stepRt('rtRelease', $event)"
            />
          </div>
          <Slider
            :model-value="rtRelease.value ?? rtRelease.range[0]"
            :range="rtRelease.value === null && anyRt ? rtRelease.range : null"
            :min="LIMITS.rtMin"
            :max="LIMITS.rtMax"
            :step="0.01"
            :fine-step="0.001"
            :label="t('perf.rtRelease')"
            :disabled="!anyRt"
            style="--sl-tone: var(--m-release)"
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
              :step="0.01"
              :decimals="decimals"
              :label="dz.label"
              relative
              @update:model-value="setDead(dz.field, $event, false)"
              @step="stepDead(dz.field, $event)"
            />
          </div>
          <Slider
            :model-value="dz.s.value ?? dz.s.range[0]"
            :range="dz.s.value === null ? dz.s.range : null"
            :min="0"
            :max="LIMITS.deadMax"
            :step="0.01"
            :fine-step="0.001"
            :label="dz.label"
            :style="{ '--sl-tone': 'var(--m-deadzone)' }"
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
      </template>
    </div>
  </PageLayout>
</template>

<style scoped>
.aside-sub { display: contents; }
.aside-hint {
  margin: 2px 0 0;
  max-width: 160px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--fg-3);
}
.aside-label { padding: 0 2px; }
.chips { display: flex; flex-direction: column; gap: 4px; }
.chip {
  display: flex;
  align-items: center;
  gap: 8px;
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
.chip__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--chip); flex: none; }
.chip__dot--rt { background: linear-gradient(90deg, var(--m-press) 50%, var(--m-release) 50%); }
.shading { display: flex; flex-direction: column; gap: 4px; max-width: 160px; margin-top: var(--s-2); }
.shading__hint { margin: 0; font-size: var(--fs-caption); line-height: 1.4; color: var(--fg-3); }
/* The RT tag on a keycap (actuation view). */
.kb :deep(.cap__badge) { font-size: 10px; font-weight: 600; opacity: 1; }
.chip[aria-checked='true'] { background: var(--sel-bg); border-color: var(--acc-line); color: var(--fg-1); }
.try { margin-top: var(--s-2); }

@media (max-width: 1360px) {
  .chips { flex-direction: row; }
  .aside-label, .chips, .try { align-self: center; }
  .try { margin-top: 0; }
  /* Hint and switch share one fixed-height line below the chips, so the board never moves between views. */
  .aside-sub { order: 1; flex: 0 0 100%; display: flex; justify-content: flex-end; align-items: center; gap: var(--s-4); min-height: 28px; }
  .aside-hint { max-width: none; margin: 0; text-align: right; }
  .shading { flex-direction: row; align-items: center; margin: 0; max-width: none; }
  .shading__hint { display: none; }
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

.link {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  background: transparent;
  color: var(--fg-2);
  font-size: var(--fs-label);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.link:hover:not(:disabled) { background: var(--bg-3); color: var(--fg-1); }
.link:disabled { opacity: 0.35; cursor: not-allowed; }
.link--on { color: var(--acc); background: var(--acc-soft); border-color: var(--acc-line); }
.unknown {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: var(--fs-label);
}
.hint { color: var(--fg-3); font-size: var(--fs-label); }
.continuous { display: grid; gap: var(--s-2); margin-top: var(--s-4); padding-top: var(--s-4); border-top: 1px solid var(--line-1); }
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
