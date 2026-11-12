<script lang="ts">
import type { Performance as PerformanceRec } from '../protocol';

/** RT press/release start linked only when every Rapid Trigger key in the selection already has them equal. */
export function deriveRtLinked(recs: PerformanceRec[], isRt: (mode: number) => boolean): boolean {
  return recs.filter((p) => isRt(p.mode)).every((p) => Math.abs(p.rtPress - p.rtRelease) < 0.0005);
}
</script>

<script setup lang="ts">
// Hành trình — reference implementation of the per-key page pattern (docs/ARCHITECTURE.md), laid out as a workbench:
// toolbar → keyboard → scope bar → one editor dock. With nothing selected the editors work on every key.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { IconAlertTriangle, IconFlask, IconLink, IconLinkOff, IconLock, IconRefresh, IconX } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import SelectionBar from '../components/keyboard/SelectionBar.vue';
import TravelEditor from '../components/performance/TravelEditor.vue';
import StdCycleCard from '../components/performance/StdCycleCard.vue';
import InfoTip from '../components/performance/InfoTip.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import Dialog from '../components/ui/Dialog.vue';
import Segmented from '../components/ui/Segmented.vue';
import Slider from '../components/ui/Slider.vue';
import Switch from '../components/ui/Switch.vue';
import NumberField from '../components/ui/NumberField.vue';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { useHistoryStore } from '../stores/history';
import { useCalibrationStore } from '../stores/calibration';
import { LIMITS, PRESETS, actuationOf, isKnownMode, rangeMm, usePerformanceStore } from '../stores/performance';
import type { PerfEdit } from '../stores/performance';
import { USER_PRESET_MAX, USER_PRESET_NAME_MAX, useUserPresetsStore } from '../stores/userPresets';
import type { UserPreset } from '../stores/userPresets';
import { releasePoint, settingsFrom } from '../stores/live';
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
const history = useHistoryStore();
const userPresets = useUserPresetsStore();
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
const metricTip = computed(() =>
  metric.value === 'actuation' ? t('perf.rtBadgeHint') : metric.value === 'rt' ? t('perf.rtViewHint') : t('perf.deadzoneViewHint'),
);

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

// The editor columns never get shorter while the user stays on the page at the same width (the RT column coming and
// going must not make the dock jump); they only grow. Reset when their own width changes (window resize or folding the
// sidebar: the layout differs) and on a profile change.
const gridEl = ref<HTMLElement | null>(null);
const gridMinH = ref(0);
let gridWidth: number | null = null; // the width the held height was measured at
let gridObserver: ResizeObserver | null = null;
if (typeof ResizeObserver !== 'undefined') {
  gridObserver = new ResizeObserver((entries) => {
    for (const e of entries) {
      const w = Math.round(e.borderBoxSize?.[0]?.inlineSize ?? e.contentRect.width);
      if (gridWidth !== null && w !== gridWidth) {
        gridWidth = null;
        // This height was laid out under the old min-height: measure again, from the next frame rather than inside
        // this callback (re-observing here makes the browser report a "ResizeObserver loop" error).
        requestAnimationFrame(resetGridMinH);
        return;
      }
      gridWidth = w;
      const h = e.borderBoxSize?.[0]?.blockSize ?? e.contentRect.height;
      gridMinH.value = Math.max(gridMinH.value, h); // exact: rounding up would grow the grid and notify again
    }
  });
}
/** Forget the held height and measure again (re-observing delivers a fresh initial measurement). */
function resetGridMinH() {
  gridMinH.value = 0;
  gridWidth = null;
  if (gridObserver && gridEl.value) {
    gridObserver.unobserve(gridEl.value);
    gridObserver.observe(gridEl.value);
  }
}
watch(gridEl, (el, old) => {
  if (old) gridObserver?.unobserve(old);
  if (el) {
    gridMinH.value = 0; // a freshly mounted grid (after load / reload) measures itself
    gridWidth = null;
    gridObserver?.observe(el);
  }
});
let lastWidth = window.innerWidth;
function onWindowResize() {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  resetGridMinH();
}

/**
 * Esc returns to "all keys" (KeyboardView clears the selection and already skips dialogs and text/number fields).
 * While a calibration runs the key is marked handled before KeyboardView sees it, so the scope stays as it is.
 */
function onEscCapture(e: KeyboardEvent) {
  if (e.key === 'Escape' && (useCalibrationStore().phase !== 'idle' || device.calibrationLocked())) e.preventDefault();
}

let offProfile: (() => void) | null = null;
onMounted(() => {
  void perf.load();
  offProfile = device.onProfileChanged(() => {
    resetGridMinH();
    void perf.load(true);
  });
  window.addEventListener('resize', onWindowResize);
  window.addEventListener('keydown', onEscCapture, true);
});
onBeforeUnmount(() => {
  offProfile?.();
  window.removeEventListener('resize', onWindowResize);
  window.removeEventListener('keydown', onEscCapture, true);
  gridObserver?.disconnect();
});

const decimals = computed(() => (device.rtPrecision < 0.01 ? 3 : 2));
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

// ----- scope: the selection, or every key of the connected keyboard when nothing is selected
const scoped = computed(() => sel.count > 0);
/** Keys in scope that are loaded; keys in a firmware mode we do not know are shown but never edited (store.apply skips them). */
const loadedIds = computed(() => (scoped.value ? sel.ids : device.keys.map((k) => k.id)).filter((id) => perf.values[id]));
const hasKeys = computed(() => loadedIds.value.length > 0);
const ids = computed(() => loadedIds.value.filter((id) => isKnownMode(perf.values[id].mode)));
const unknownCount = computed(() => loadedIds.value.length - ids.value.length);
const recs = computed<Performance[]>(() => ids.value.map((id) => perf.values[id]));
const SCOPE_NAMES = 8;
const scopeNames = computed(() => {
  const names = loadedIds.value.map((id) => device.legend(device.keys[id]));
  return names.length > SCOPE_NAMES ? `${names.slice(0, SCOPE_NAMES).join(' ')} …` : names.join(' ');
});

// RT link: derived from the scope, re-derived whenever it changes; a click overrides it until then.
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
/** Continuous RT can be turned off on protocol ≥ 1.3.0.0 (factory driver rule), or where a key already is in mode 2. */
const intervalRt = computed(() => supportsIntervalRt(device.version) || recs.value.some((p) => p.mode === 2));
/** Continuous RT across the RT keys in scope: true (all mode 1), false (all mode 2), null (mixed / none). */
const continuous = computed<boolean | null>(() => {
  const m = new Set(recs.value.filter((p) => isRtMode(p.mode)).map((p) => p.mode));
  return m.size === 1 ? m.has(1) : null;
});
/** The middle column: Rapid Trigger when any key in scope uses it, else the read-only Standard diagram. */
const slot = computed<'rt' | 'std'>(() => (anyRt.value ? 'rt' : 'std'));
const maxTravel = computed(() => (recs.value.length ? Math.min(...recs.value.map(rangeMm)) : 3.31));
const act = computed(() => summary(actuationOf));
const stdRelease = computed(() => summary((p) => releasePoint(settingsFrom(p))));
const rtPress = computed(() => summary((p) => p.rtPress));
const rtRelease = computed(() => summary((p) => p.rtRelease));
const deadTop = computed(() => summary((p) => p.pressDeadStroke));
const deadBottom = computed(() => summary((p) => p.releaseDeadStroke));
const deadFields = computed(() => [
  { field: 'pressDeadStroke' as const, label: t('perf.deadTop'), s: deadTop.value },
  { field: 'releaseDeadStroke' as const, label: t('perf.deadBottom'), s: deadBottom.value },
]);
const modeTip = computed(() =>
  mode.value === null ? t('perf.modeMixed') : mode.value === 1 ? t('perf.modeHintRt') : t('perf.modeHintStandard'),
);

// ----- all-keys toast: "Đã áp dụng cho N phím · Hoàn tác". Hoàn tác is the history store's own undo (the same as Ctrl+Z).
let lastLabel: string | null = null; // the history entry the toast offers to undo
let gestureKeys = 0; // keys changed by the slider drag in progress (all-keys scope), announced when it ends
function undoLast() {
  // Another entry on top since (a newer edit): leave it to Ctrl+Z rather than undoing something the toast does not name.
  if (history.undoLabel === lastLabel) history.undo();
}
function announce(text: string, kind: 'success' | 'info' = 'success') {
  lastLabel = history.undoLabel;
  if (toast.items.value.some((x) => x.text === text)) return; // repeated steps keep one toast on screen
  toast.show(text, kind, undefined, { label: t('history.undo'), run: undoLast });
}
/** Every edit of the page: perf.apply, then the all-keys toast. Slider gestures announce when they end. */
function edit(targets: number[], patch: (p: Performance) => Partial<PerfEdit>, what: string, gesture?: string) {
  const n = perf.apply(targets, patch, what, gesture);
  if (!n || scoped.value) return;
  if (gesture) gestureKeys = n;
  else announce(t('perf.appliedAll', { n }));
}
function endGesture() {
  if (!gestureKeys) return;
  const n = gestureKeys;
  gestureKeys = 0;
  announce(t('perf.appliedAll', { n }));
}

// ----- edits (every edit goes through perf.apply → history + sync)
function setMode(m: PerfMode | null) {
  if (m === null) return;
  // Turning RT on keeps a key's Continuous setting if it is already RT; new RT keys start continuous (mode 1).
  // A key whose mode family changes carries the actuation it showed into both fields (one actuation point for Standard and RT).
  edit(
    ids.value,
    (p) => {
      const mode = m === 0 ? 0 : isRtMode(p.mode) ? p.mode : 1;
      if (isRtMode(mode) === isRtMode(p.mode)) return { mode };
      const a = actuationOf(p);
      return { mode, normalPress: a, rtFirstTouch: a };
    },
    t('perf.mode'),
  );
}
function setContinuous(on: boolean) {
  edit(ids.value.filter((id) => isRtMode(perf.values[id].mode)), () => ({ mode: on ? 1 : 2 }), t('perf.continuous'));
}
/** Relative step from a mixed field: each key moves one step from its own value (the store clamps). */
const add = (v: number, d: number) => Number((v + d).toFixed(3));
function stepActuation(d: number) {
  edit(
    ids.value,
    (p) => {
      const v = add(actuationOf(p), d);
      return { normalPress: v, rtFirstTouch: v };
    },
    t('perf.actuation'),
  );
}
function stepRt(which: 'rtPress' | 'rtRelease', d: number) {
  edit(
    ids.value.filter((id) => isRtMode(perf.values[id].mode)),
    (p) => {
      const v = add(p[which], d);
      return rtLinked.value ? { rtPress: v, rtRelease: v } : { [which]: v };
    },
    t('perf.rt'),
  );
}
function stepDead(which: 'pressDeadStroke' | 'releaseDeadStroke', d: number) {
  edit(ids.value, (p) => ({ [which]: add(p[which], d) }), t('perf.deadzones'));
}
function setActuation(v: number, gesture = true) {
  edit(ids.value, () => ({ normalPress: v, rtFirstTouch: v }), t('perf.actuation'), gesture ? 'act' : undefined);
}
function setRt(which: 'rtPress' | 'rtRelease', v: number, gesture = true) {
  const patch: Partial<PerfEdit> = rtLinked.value ? { rtPress: v, rtRelease: v } : { [which]: v };
  edit(ids.value.filter((id) => isRtMode(perf.values[id].mode)), () => patch, t('perf.rt'), gesture ? `rt-${which}` : undefined);
}
function setDead(which: 'pressDeadStroke' | 'releaseDeadStroke', v: number, gesture = true) {
  edit(ids.value, () => ({ [which]: v }), t('perf.deadzones'), gesture ? `dz-${which}` : undefined);
}

// ----- presets: apply to the current scope (one perf.apply = one history entry)
function presetApplied(name: string, n: number) {
  toast.show(t('perf.presetApplied', { name, n: ids.value.length }), 'success', undefined, n ? { label: t('history.undo'), run: undoLast } : undefined);
  if (n) lastLabel = history.undoLabel;
}
function applyPreset(id: (typeof PRESETS)[number]['id']) {
  const preset = PRESETS.find((p) => p.id === id)!;
  const name = t(PRESET_TEXT[id][0]);
  // An RT preset keeps a key's Continuous RT setting (mode 2 stays 2).
  const n = perf.apply(ids.value, (p) => ({ ...preset.values, mode: preset.values.mode !== 0 && p.mode === 2 ? 2 : preset.values.mode }), name);
  presetApplied(name, n);
}
/** A saved preset: its values are already validated; perf.apply clamps them again to each key's own range and the model's precision. */
function applyUserPreset(p: UserPreset) {
  const n = perf.apply(
    ids.value,
    (cur) => {
      const edit: Partial<PerfEdit> = {
        mode: p.mode === 0 ? 0 : p.continuous ? 1 : supportsIntervalRt(device.version) || cur.mode === 2 ? 2 : 1,
        normalPress: p.actuation,
        rtFirstTouch: p.actuation,
        pressDeadStroke: p.deadTop,
        releaseDeadStroke: p.deadBottom,
      };
      if (p.mode === 1) {
        edit.rtPress = p.rtPress;
        edit.rtRelease = p.rtRelease;
      }
      return edit;
    },
    p.name,
  );
  presetApplied(p.name, n);
}
const modeLabel = (m: 0 | 1) => (m === 0 ? t('perf.modeStandard') : t('perf.modeRt'));
const userPresetTitle = (p: UserPreset) => t('perf.presetUserTitle', { mode: modeLabel(p.mode), act: fmt(p.actuation) });

// ----- "Lưu mẫu…": the scope's values, only when they agree
const saveValues = computed<Omit<UserPreset, 'id' | 'name'> | null>(() => {
  const m = mode.value;
  if (!recs.value.length || m === null) return null;
  const a = act.value.value;
  const top = deadTop.value.value;
  const bottom = deadBottom.value.value;
  if (a === null || top === null || bottom === null) return null;
  if (m === 1 && (rtPress.value.value === null || rtRelease.value.value === null || continuous.value === null)) return null;
  return {
    mode: m === 0 ? 0 : 1,
    continuous: continuous.value ?? true,
    actuation: a,
    rtPress: rtPress.value.value ?? rtPress.value.range[0],
    rtRelease: rtRelease.value.value ?? rtRelease.value.range[0],
    deadTop: top,
    deadBottom: bottom,
  };
});
const saveBlocked = computed<string | null>(() => {
  if (userPresets.presets.length >= USER_PRESET_MAX) return t('perf.presetFull', { n: USER_PRESET_MAX });
  if (!recs.value.length) return t('perf.presetNoKeys');
  return saveValues.value ? null : t('perf.presetMixed');
});
const saveOpen = ref(false);
const saveName = ref('');
function openSave() {
  if (saveBlocked.value) return;
  saveName.value = '';
  saveOpen.value = true;
}
function confirmSave() {
  const name = saveName.value.trim();
  if (!name || !saveValues.value) return;
  // Stored in this browser only: nothing goes to the keyboard.
  const saved = userPresets.add(name, saveValues.value);
  saveOpen.value = false;
  if (saved) toast.show(t('perf.presetSaved', { name: saved.name }), 'success');
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
  <PageLayout :title="t('page.performance')">
    <div class="wb">
      <!-- toolbar -->
      <div class="wb__bar">
        <div class="wb__group">
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
          <InfoTip :text="metricTip" />
        </div>
        <div class="wb__group">
          <Switch v-model="depthShading" :label="t('perf.depthShading')" :disabled="metric !== 'actuation'" />
          <InfoTip :text="t('perf.depthShadingHint')" />
        </div>
        <div class="wb__group wb__presets" role="group" :aria-label="t('perf.presetsLabel')">
          <span class="micro">{{ t('perf.presetsLabel') }}</span>
          <button v-for="p in PRESETS" :key="p.id" type="button" class="chip chip--plain" :disabled="!ids.length" :title="t(PRESET_TEXT[p.id][1])" @click="applyPreset(p.id)">
            {{ t(PRESET_TEXT[p.id][0]) }}
          </button>
          <span v-for="p in userPresets.presets" :key="p.id" class="uchip">
            <button type="button" class="chip chip--plain uchip__use" :disabled="!ids.length" :title="userPresetTitle(p)" @click="applyUserPreset(p)">{{ p.name }}</button>
            <button type="button" class="uchip__x" :aria-label="t('perf.presetDelete', { name: p.name })" :title="t('perf.presetDelete', { name: p.name })" @click="userPresets.remove(p.id)">
              <IconX :size="12" stroke-width="2" aria-hidden="true" />
            </button>
          </span>
          <button type="button" class="chip chip--plain chip--dash" :disabled="!!saveBlocked" :title="saveBlocked ?? undefined" :aria-describedby="saveBlocked ? 'perf-save-why' : undefined" @click="openSave">
            {{ t('perf.presetSave') }}
          </button>
          <span v-if="saveBlocked" id="perf-save-why" class="sr-only">{{ saveBlocked }}</span>
        </div>
        <Button class="wb__try" variant="secondary" size="sm" :icon="IconFlask" :disabled="!hasKeys" :title="t('perf.tryNowHint')" @click="tryNow">
          {{ t('perf.tryNow') }}
        </Button>
      </div>

      <!-- keyboard + scope bar -->
      <div class="wb__board">
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
      </div>
      <SelectionBar>
        <template #lead>
          <span class="scope" aria-live="polite">
            <strong class="num">{{ scoped ? t('perf.scopeSel', { n: loadedIds.length }) : t('perf.scopeAll', { n: device.keys.length }) }}</strong>
            <span v-if="scoped && scopeNames" class="scope__names"> ({{ scopeNames }})</span>
            <span class="scope__hint"> · {{ scoped ? t('perf.scopeSelHint') : t('perf.scopeAllHint') }}</span>
          </span>
        </template>
      </SelectionBar>

      <!-- load error -->
      <Card v-if="perf.loadError" :title="t('perf.loadFailed')" :subtitle="perf.loadError">
        <div><Button :icon="IconRefresh" @click="perf.load(true)">{{ t('perf.reload') }}</Button></div>
      </Card>

      <!-- loading skeleton -->
      <div v-else-if="perf.loading" class="dock dock--skel" aria-busy="true">
        <p class="loading num">{{ t('perf.loading', { n: perf.loadedCount }) }}</p>
        <div class="skeleton" style="height: 120px" />
      </div>

      <!-- editor dock -->
      <section v-else-if="hasKeys" class="dock" :aria-label="t('perf.dock')">
        <div v-if="unknownCount" class="unknown" role="note">
          <IconAlertTriangle :size="16" stroke-width="1.5" aria-hidden="true" />
          <span>{{ t('perf.unknownModes', { n: unknownCount }) }}</span>
        </div>
        <template v-if="recs.length">
          <header class="dock__head">
            <div class="dock__mode">
              <h3 class="dock__title">{{ t('perf.mode') }}</h3>
              <Segmented :model-value="mode" :options="modeOptions" :label="t('perf.mode')" size="sm" @update:model-value="setMode" />
              <InfoTip :text="modeTip" />
            </div>
            <div v-if="anyRt && intervalRt" class="dock__cont">
              <Switch
                :model-value="continuous ?? false"
                :label="continuous === null ? `${t('perf.continuous')} (${t('perf.mixed')})` : t('perf.continuous')"
                @update:model-value="setContinuous"
              />
              <InfoTip :text="continuous === false ? t('perf.continuousOffHint') : t('perf.continuousOnHint')" />
            </div>
          </header>

          <div ref="gridEl" class="grid dock__cols" :style="{ minHeight: gridMinH ? gridMinH + 'px' : undefined }">
            <!-- Actuation -->
            <div class="pcol pcol--act">
              <div class="pcol__head">
                <h3 class="pcol__title">{{ t('perf.actuation') }}</h3>
                <InfoTip :text="decimals === 3 ? `${t('perf.actuationHint')} ${t('perf.fineHint')}` : t('perf.actuationHint')" placement="top" />
              </div>
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
                  @commit="endGesture"
                />
                <div class="act__readout">
                  <span class="micro">{{ t('perf.travel') }}</span>
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
                </div>
              </div>
            </div>

            <!-- Rapid Trigger (or the Standard diagram) -->
            <div v-if="slot === 'rt'" class="pcol pcol--rt">
              <div class="pcol__head">
                <h3 class="pcol__title">{{ t('perf.rt') }}</h3>
                <button
                  type="button"
                  class="link"
                  :class="{ 'link--on': rtLinked }"
                  :aria-pressed="rtLinked"
                  :title="t('perf.rtLinkHint')"
                  @click="rtLinkOverride = !rtLinked"
                >
                  <component :is="rtLinked ? IconLink : IconLinkOff" :size="16" stroke-width="1.5" aria-hidden="true" />
                  {{ t('perf.rtLinkLabel') }}
                </button>
              </div>
              <div class="field">
                <div class="field__row">
                  <span class="field__label">{{ t('perf.rtPress') }}</span>
                  <NumberField
                    :model-value="rtPress.value"
                    :min="LIMITS.rtMin"
                    :max="LIMITS.rtMax"
                    :step="0.01"
                    :decimals="decimals"
                    :label="t('perf.rtPress')"
                    relative
                    @update:model-value="setRt('rtPress', $event, false)"
                    @step="stepRt('rtPress', $event)"
                  />
                </div>
                <Slider
                  :model-value="rtPress.value ?? rtPress.range[0]"
                  :range="rtPress.value === null ? rtPress.range : null"
                  :min="LIMITS.rtMin"
                  :max="LIMITS.rtMax"
                  :step="0.01"
                  :fine-step="0.001"
                  :label="t('perf.rtPress')"
                  style="--sl-tone: var(--m-press)"
                  @update:model-value="setRt('rtPress', $event)"
                  @commit="endGesture"
                />
              </div>
              <div class="field">
                <div class="field__row">
                  <span class="field__label">{{ t('perf.rtRelease') }}</span>
                  <NumberField
                    :model-value="rtRelease.value"
                    :min="LIMITS.rtMin"
                    :max="LIMITS.rtMax"
                    :step="0.01"
                    :decimals="decimals"
                    :label="t('perf.rtRelease')"
                    relative
                    @update:model-value="setRt('rtRelease', $event, false)"
                    @step="stepRt('rtRelease', $event)"
                  />
                </div>
                <Slider
                  :model-value="rtRelease.value ?? rtRelease.range[0]"
                  :range="rtRelease.value === null ? rtRelease.range : null"
                  :min="LIMITS.rtMin"
                  :max="LIMITS.rtMax"
                  :step="0.01"
                  :fine-step="0.001"
                  :label="t('perf.rtRelease')"
                  style="--sl-tone: var(--m-release)"
                  @update:model-value="setRt('rtRelease', $event)"
                  @commit="endGesture"
                />
              </div>
            </div>
            <div v-else class="pcol pcol--std">
              <StdCycleCard :actuation="act.range" :release="stdRelease.range" :max-travel="maxTravel" :fmt="fmt" />
            </div>

            <!-- Deadzone -->
            <div class="pcol pcol--dead">
              <div class="pcol__head">
                <h3 class="pcol__title">{{ t('perf.deadzones') }}</h3>
                <InfoTip :text="t('perf.deadHint')" placement="top" />
              </div>
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
                  @commit="endGesture"
                />
              </div>
            </div>
          </div>
        </template>
      </section>
    </div>

    <Dialog v-model:open="saveOpen" :title="t('perf.presetSaveTitle')" :width="400">
      <form class="save" @submit.prevent="confirmSave">
        <label class="save__label">
          {{ t('perf.presetName') }}
          <input v-model="saveName" class="save__input" :maxlength="USER_PRESET_NAME_MAX" autocomplete="off" spellcheck="false">
        </label>
        <p class="hint">{{ t('perf.presetNote') }}</p>
      </form>
      <template #footer>
        <Button variant="ghost" @click="saveOpen = false">{{ t('perf.presetCancel') }}</Button>
        <Button variant="primary" :disabled="!saveName.trim()" @click="confirmSave">{{ t('perf.presetSaveBtn') }}</Button>
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.wb { display: flex; flex-direction: column; gap: var(--s-2); }
.wb__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
@media (min-width: 1100px) { .wb__bar { flex-wrap: nowrap; } }
.wb__group { display: flex; align-items: center; gap: var(--s-1); min-width: 0; }
.wb__presets { flex-wrap: wrap; margin-left: auto; gap: 4px; }
.wb__try { flex: none; }
.chips { display: flex; gap: 4px; }
.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 9px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-2);
  color: var(--fg-2);
  font-size: var(--fs-label);
  font-weight: 500;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.chip:hover:not(:disabled) { color: var(--fg-1); border-color: var(--line-3); }
.chip:disabled { opacity: 0.45; cursor: not-allowed; }
.chip__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--chip); flex: none; }
.chip__dot--rt { background: linear-gradient(90deg, var(--m-press) 50%, var(--m-release) 50%); }
.chip[aria-checked='true'] { background: var(--sel-bg); border-color: var(--acc-line); color: var(--fg-1); }
.chip--plain { height: 28px; padding: 0 8px; background: var(--bg-3); }
.chip--plain:hover:not(:disabled) { background: var(--bg-4); border-color: var(--acc-line); }
.chip--dash { border-style: dashed; background: transparent; }
/* A saved preset: the chip and its × share one outline. */
.uchip { display: inline-flex; align-items: center; }
.uchip__use { border-top-right-radius: 0; border-bottom-right-radius: 0; border-right: 0; }
.uchip__x {
  display: grid;
  place-items: center;
  align-self: stretch;
  width: 24px;
  padding: 0;
  border: 1px solid var(--line-1);
  border-radius: 0 var(--r-control) var(--r-control) 0;
  background: var(--bg-3);
  color: var(--fg-3);
}
.uchip__x:hover { color: var(--danger); background: var(--bg-4); }
/* The RT tag on a keycap (actuation view). */
.kb :deep(.cap__badge) { font-size: var(--fs-caption); font-weight: 600; opacity: 1; }

/* The board takes the same widths as every page's keyboard (T3 sizes). */
.wb__board { width: 100%; max-width: 900px; margin: 0 auto; }
.scope { flex: 1; min-width: 0; font-size: var(--fs-label); color: var(--acc); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.scope strong { font-weight: 600; }
.scope__names { color: var(--fg-2); }
.scope__hint { color: var(--fg-3); }
@media (min-width: 1600px) {
  .wb__board { max-width: 1100px; }
}

/* ----- editor dock: one card, header row, three columns (2 + 1 under 1100px of content width) */
.dock {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-5);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  min-width: 0;
}
.dock__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--s-3) var(--s-5); }
.dock__mode, .dock__cont { display: flex; align-items: center; gap: var(--s-2); }
.dock__title, .pcol__title { font-size: var(--fs-card); font-weight: 600; }
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--s-4) 0;
}
.pcol {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  min-width: 0;
  padding: 0 var(--s-5);
  border-left: 1px solid var(--line-1);
}
.pcol:first-child { padding-left: 0; border-left: 0; }
.pcol:last-child { padding-right: 0; }
.pcol__head { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); min-height: 28px; }
.pcol__head .info { margin-right: auto; margin-left: var(--s-1); }
.pcol__head .link { margin-left: var(--s-2); }
@container (max-width: 859px) {
  .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pcol:nth-child(2) { padding-right: 0; }
  .pcol:nth-child(3) {
    grid-column: 1 / -1;
    padding: var(--s-4) 0 0;
    border-left: 0;
    border-top: 1px solid var(--line-1);
  }
}
/* The Standard diagram is a card of its own: inside the dock it drops its frame. */
.pcol--std :deep(.std) { padding: 0; border: 0; background: transparent; flex: 1 1 auto; }
.pcol--std :deep(.std__plot) { min-height: 56px; }

.dock--skel { gap: var(--s-3); }
.loading { margin: 0; color: var(--fg-3); }

.act { display: flex; flex: 1 1 auto; gap: var(--s-4); align-items: flex-start; }
.act__readout { display: flex; flex-direction: column; gap: var(--s-1); min-width: 0; }
.act__readout :deep(.nf) { width: 138px; }

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
  white-space: nowrap;
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
  background: var(--bg-1);
  color: var(--fg-2);
  font-size: var(--fs-label);
}
.hint { color: var(--fg-3); font-size: var(--fs-label); }
.field { display: flex; flex-direction: column; justify-content: center; gap: 6px; }
.field__row { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
.field__label { color: var(--fg-2); }
.field__row :deep(.nf) { width: 132px; }
/* A column under 280px: the label sits above its field instead of wrapping beside it. */
@container (max-width: 279px) {
  .field__row { flex-direction: column; align-items: stretch; gap: var(--s-1); }
  .field__row :deep(.nf) { width: 100%; }
}

.save { display: grid; gap: var(--s-3); }
.save__label { display: grid; gap: var(--s-2); color: var(--fg-2); }
.save__input { height: 34px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--bg-1); color: var(--fg-1); }
</style>
