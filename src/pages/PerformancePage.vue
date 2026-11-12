<script lang="ts">
import type { Performance as PerformanceRec } from '../protocol';

/** RT press/release start linked only when every Rapid Trigger key in the selection already has them equal. */
export function deriveRtLinked(recs: PerformanceRec[], isRt: (mode: number) => boolean): boolean {
  return recs.filter((p) => isRt(p.mode)).every((p) => Math.abs(p.rtPress - p.rtRelease) < 0.0005);
}
</script>

<script setup lang="ts">
// Hành trình — reference implementation of the per-key page pattern (docs/ARCHITECTURE.md), laid out as a workbench:
// toolbar → keyboard → scope bar → the editor cards. With nothing selected the editors work on every key.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { IconAlertTriangle, IconFlask, IconLink, IconLinkOff, IconLock, IconRefresh, IconX } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import SelectionBar from '../components/keyboard/SelectionBar.vue';
import TravelEditor from '../components/performance/TravelEditor.vue';
import StdCycleCard from '../components/performance/StdCycleCard.vue';
import InfoTip from '../components/ui/InfoTip.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import Dialog from '../components/ui/Dialog.vue';
import Segmented from '../components/ui/Segmented.vue';
import Slider from '../components/ui/Slider.vue';
import Switch from '../components/ui/Switch.vue';
import NumberField, { decimalsFor, formatMm } from '../components/ui/NumberField.vue';
import AnimatedNumber from '../components/ui/AnimatedNumber.vue';
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
import { toastSafeTarget, useToast } from '../components/ui/toast';
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
// ----- columns: real wrappers (so every column can stretch to the same bottom), chosen by width.
// 3 columns from 1361px, 2 from 761px, else 1. Without matchMedia (tests) the layout is the widest one.
const colCount = ref<1 | 2 | 3>(3);
const mqlWide = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 1361px)') : null;
const mqlMid = typeof window.matchMedia === 'function' ? window.matchMedia('(min-width: 761px)') : null;
function updateColCount() {
  if (mqlWide && mqlMid) colCount.value = mqlWide.matches ? 3 : mqlMid.matches ? 2 : 1;
}
updateColCount();
mqlWide?.addEventListener('change', updateColCount);
mqlMid?.addEventListener('change', updateColCount);
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
  mqlWide?.removeEventListener('change', updateColCount);
  mqlMid?.removeEventListener('change', updateColCount);
  gridObserver?.disconnect();
  dismissUndoToast();
});

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
const uncalFlag = (k: PhysicalKey) => (perf.uncalibrated.includes(k.id) ? { label: t('kb.uncalibrated') } : undefined);
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
/** The Standard card takes the RT card's slot, only when every key in scope is Standard (neither card when mixed). */
const stdShown = computed(() => recs.value.length > 0 && mode.value === 0);
type CardId = 'act' | 'mode' | 'rt' | 'std' | 'dead' | 'presets';
const slotId = computed<'rt' | 'std' | null>(() => (anyRt.value ? 'rt' : stdShown.value ? 'std' : null));
/** Mode always heads the second column, so it never moves when the RT / Standard card swaps. */
const cols = computed<CardId[][]>(() => {
  // Only unknown-mode keys in scope: no editors (they would edit 0 keys); the .unknown note stands alone.
  if (!recs.value.length) return [];
  const slot = slotId.value ? [slotId.value] : [];
  const mid: CardId[] = ['mode', ...slot];
  const all = (c: CardId[][]) => c.filter((x) => x.length);
  if (colCount.value === 3) return all([['act'], mid, ['dead', 'presets']]);
  if (colCount.value === 2) return all([['act', 'dead'], [...mid, 'presets']]);
  return [['act', 'mode', ...slot, 'dead', 'presets']];
});
/** One named grower per column (two in the RT column: Mode and RT split the spare height); none in a single column. */
const growers = computed<Set<CardId>>(() => {
  if (colCount.value === 1) return new Set();
  const slot = slotId.value;
  const mid: CardId[] = slot === 'rt' ? ['mode', 'rt'] : slot === 'std' ? ['std'] : colCount.value === 3 ? ['mode'] : ['presets'];
  return new Set<CardId>(colCount.value === 3 ? ['act', 'presets', ...mid] : ['dead', ...mid]);
});
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

// ----- undo toast: "Đã áp dụng cho N phím · Hoàn tác". Hoàn tác is the history store's own undo (the same as Ctrl+Z).
// An undo toast lives only while its entry is on top of the undo stack, and there is at most one on the page.
let gestureKeys = 0; // keys changed by the slider drag in progress (all-keys scope), announced when it ends
let undoToast: { toastId: number; entry: number } | null = null;
function dismissUndoToast() {
  if (undoToast) toast.dismiss(undoToast.toastId);
  undoToast = null;
}
// A scoped edit, Ctrl+Z / redo, a profile reload or a history clear change the top entry: the toast no longer names it.
const stopUndoWatch = watch(() => history.undoId, (id) => {
  if (undoToast && undoToast.entry !== id) dismissUndoToast();
}, { flush: 'sync' });
onBeforeUnmount(stopUndoWatch);
/** Show a toast whose Hoàn tác undoes the entry on top now. A repeated step on the same (coalesced) entry keeps its toast. */
function showUndoToast(text: string, kind: 'success' | 'info' = 'success') {
  const entry = history.undoId;
  if (entry === null) return;
  if (undoToast?.entry === entry && toast.items.value.some((x) => x.id === undoToast!.toastId)) return;
  dismissUndoToast();
  const run = () => { if (history.undoId === entry) history.undo(); };
  undoToast = { toastId: toast.show(text, kind, undefined, { label: t('history.undo'), run }), entry };
}
/** Every edit of the page: perf.apply, then the all-keys toast. Slider gestures announce when they end. */
function edit(targets: number[], patch: (p: Performance) => Partial<PerfEdit>, what: string, coalesce?: string, gesture = false) {
  const n = perf.apply(targets, patch, what, coalesce);
  if (!n || scoped.value) return;
  if (gesture) gestureKeys = n;
  else showUndoToast(t('perf.appliedAll', { n }));
}
function endGesture() {
  if (!gestureKeys) return;
  const n = gestureKeys;
  gestureKeys = 0;
  showUndoToast(t('perf.appliedAll', { n }));
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
    'step-act',
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
    `step-rt-${which}`,
  );
}
function stepDead(which: 'pressDeadStroke' | 'releaseDeadStroke', d: number) {
  edit(ids.value, (p) => ({ [which]: add(p[which], d) }), t('perf.deadzones'), `step-dz-${which}`);
}
function setActuation(v: number, gesture = true) {
  edit(ids.value, () => ({ normalPress: v, rtFirstTouch: v }), t('perf.actuation'), gesture ? 'act' : 'nf-act', gesture);
}
function setRt(which: 'rtPress' | 'rtRelease', v: number, gesture = true) {
  const patch: Partial<PerfEdit> = rtLinked.value ? { rtPress: v, rtRelease: v } : { [which]: v };
  edit(ids.value.filter((id) => isRtMode(perf.values[id].mode)), () => patch, t('perf.rt'), gesture ? `rt-${which}` : `nf-rt-${which}`, gesture);
}
function setDead(which: 'pressDeadStroke' | 'releaseDeadStroke', v: number, gesture = true) {
  edit(ids.value, () => ({ [which]: v }), t('perf.deadzones'), gesture ? `dz-${which}` : `nf-dz-${which}`, gesture);
}

// ----- presets: apply to the current scope (one perf.apply = one history entry)
function presetApplied(name: string, n: number) {
  const text = t('perf.presetApplied', { name, n: ids.value.length });
  if (n) showUndoToast(text);
  else toast.show(text, 'success');
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
const userPresetMeta = (p: UserPreset) => t('perf.presetUserMeta', { mode: p.mode === 0 ? t('perf.modeStandard') : 'RT', act: formatMm(p.actuation, decimals.value) });
/** The preset-delete toast: at most one. Deletes made while it is open merge into it; its Hoàn tác restores all of them. */
interface PresetToast { toastId: number; deleted: { p: UserPreset; index: number }[] }
let presetToast: PresetToast | null = null;
let ownPresetChange = false; // the toast's own deletes and restore are not "another change" to the saved list
function dismissPresetToast() {
  if (presetToast) toast.dismiss(presetToast.toastId);
  presetToast = null;
}
// Any other change of the saved list (a new save) makes the pending restore stale: close the toast and drop it.
const stopPresetWatch = watch(() => userPresets.presets, () => {
  if (!ownPresetChange) dismissPresetToast();
}, { flush: 'sync' });
onBeforeUnmount(stopPresetWatch);
/** Deleting is immediate; the toast puts the presets back at their indexes. Presets are not in the history store, so this undo is local. */
function removeUserPreset(p: UserPreset) {
  const index = userPresets.presets.findIndex((x) => x.id === p.id);
  if (index < 0) return;
  ownPresetChange = true;
  userPresets.remove(p.id);
  ownPresetChange = false;
  const open = presetToast && toast.items.value.some((x) => x.id === presetToast!.toastId) ? presetToast : null;
  if (open) toast.dismiss(open.toastId); // merged: the new toast below replaces it and restarts the timer
  const state: PresetToast = { toastId: 0, deleted: [...(open?.deleted ?? []), { p, index }] };
  const n = state.deleted.length;
  const list = state.deleted.map((d) => d.p.name).join(', ');
  const text = n === 1 ? t('perf.presetDeleted', { name: p.name }) : t('perf.presetsDeleted', { n, names: list });
  const ariaLabel = n === 1 ? t('perf.presetUndoOne', { name: p.name }) : t('perf.presetUndoMany', { n });
  state.toastId = toast.show(text, 'info', undefined, { label: t('history.undo'), ariaLabel, run: () => restoreUserPresets(state) }, n === 1 ? undefined : list);
  presetToast = state;
}
/** Runs at most once (the state is consumed), and only while the list is still as the deletes left it. */
function restoreUserPresets(state: PresetToast) {
  if (presetToast !== state) return;
  presetToast = null;
  toast.dismiss(state.toastId);
  if (userPresets.presets.length + state.deleted.length > USER_PRESET_MAX) return;
  ownPresetChange = true;
  try {
    // Newest delete first, so each index is the one it had when its turn came. The store only appends (new ids): take the
    // presets after the index off and add them back behind the restored one.
    for (const { p, index } of [...state.deleted].reverse()) {
      const tail = userPresets.presets.slice(index);
      for (const x of tail) userPresets.remove(x.id);
      for (const { id: _id, name, ...values } of [p, ...tail]) userPresets.add(name, values);
    }
  } finally {
    ownPresetChange = false;
  }
}

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
  if (!saved) return;
  const full = userPresets.presets.length === USER_PRESET_MAX;
  toast.show(full ? t('perf.presetSavedFull', { name: saved.name, n: USER_PRESET_MAX }) : t('perf.presetSaved', { name: saved.name }), 'success');
  void showSaveResult(saved.id);
}
const saveFoot = ref<HTMLElement | null>(null);
/** After a save: focus (the Dialog restores it to the opener first; a disabled opener loses it) and scroll the card footer above the toast. */
async function showSaveResult(id: string) {
  await nextTick(); // the Dialog's own focus restore has run, and the save button reflects 6/6
  const footer = saveFoot.value;
  const btn = footer?.querySelector<HTMLButtonElement>('button');
  const target = btn && !btn.disabled ? btn : document.querySelector<HTMLElement>(`.preset[data-preset="${id}"]`);
  target?.focus({ preventScroll: true });
  if (toastSafeTarget.value <= 0) {
    // The toast host publishes its height after a ResizeObserver; do not wait for ever when there is none.
    await new Promise<void>((resolve) => {
      const stop = watch(toastSafeTarget, (v) => { if (v > 0) done(); });
      const timer = setTimeout(done, 500);
      function done() { stop(); clearTimeout(timer); resolve(); }
    });
  }
  if (typeof requestAnimationFrame === 'function') await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const el = footer?.querySelector<HTMLElement>('#perf-save-why') ?? btn;
  if (!el || typeof el.scrollIntoView !== 'function') return;
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
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
          :flag="uncalFlag"
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
      <div v-else-if="perf.loading" class="grid" :style="{ '--cols': colCount }" aria-busy="true">
        <p class="loading num">{{ t('perf.loading', { n: perf.loadedCount }) }}</p>
        <div v-for="i in 3" :key="i" class="skel-card">
          <div class="skeleton" style="width: 40%; height: 14px" />
          <div class="skeleton" style="height: 120px" />
          <div class="skeleton" style="width: 70%; height: 12px" />
        </div>
      </div>

      <!-- editors: row 1 is the column grid (its height is held); saved presets sit in their own row below -->
      <div v-else-if="hasKeys" class="editors">
      <div
        ref="gridEl"
        class="grid"
        :class="{ 'grid--note': unknownCount }"
        :style="{ '--cols': cols.length || 1, minHeight: gridMinH ? gridMinH + 'px' : undefined }"
      >
        <div v-if="unknownCount" class="unknown" role="note">
          <IconAlertTriangle :size="16" stroke-width="1.5" aria-hidden="true" />
          <span>{{ t('perf.unknownModes', { n: unknownCount }) }}</span>
        </div>
        <div v-for="(col, ci) in cols" :key="ci" class="pcol">
        <template v-for="id in col" :key="id">
        <Card v-if="id === 'act'" :class="{ grow: growers.has('act') }" :title="t('perf.actuation')" :subtitle="t('perf.actuationHint')">
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

        <Card v-else-if="id === 'mode'" class="c-mode" :class="{ grow: growers.has('mode') }" :title="t('perf.mode')">
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

        <Card v-else-if="id === 'rt'" class="c-rt" :class="{ grow: growers.has('rt') }" :title="t('perf.rt')">
          <template #actions>
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
          </template>
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
        </Card>

        <Card v-else-if="id === 'dead'" class="c-dead" :class="{ grow: growers.has('dead') }" :title="t('perf.deadzones')" :subtitle="t('perf.deadHint')">
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
        </Card>

        <StdCycleCard
          v-else-if="id === 'std'"
          :class="{ grow: growers.has('std') }"
          :actuation="act.range"
          :release="stdRelease.range"
          :max-travel="maxTravel"
          :fmt="fmt"
        />

        <Card v-else :class="{ grow: growers.has('presets') }" :title="t('perf.presets')">
          <div class="presets">
            <button v-for="p in PRESETS" :key="p.id" type="button" class="preset" @click="applyPreset(p.id)">
              <span class="preset__name">{{ t(PRESET_TEXT[p.id][0]) }}</span>
              <span class="preset__desc num">{{ t(PRESET_TEXT[p.id][1]) }}</span>
            </button>
          </div>
        </Card>
        </template>
        </div>
      </div>
      <div class="saved" :style="{ '--cols': cols.length || 1 }">
        <Card class="saved__card" :title="t('perf.presetsOwn')" :subtitle="t('perf.presetsOwnSub', { n: userPresets.presets.length, max: USER_PRESET_MAX })">
          <div class="presets">
            <p v-if="!userPresets.presets.length" class="hint">{{ t('perf.presetsEmpty') }}</p>
            <div v-for="u in userPresets.presets" :key="u.id" class="preset-row">
              <button type="button" class="preset" :data-preset="u.id" :title="userPresetTitle(u)" @click="applyUserPreset(u)">
                <span class="preset__name">{{ u.name }}</span>
                <span class="preset__desc num">{{ userPresetMeta(u) }}</span>
              </button>
              <button type="button" class="preset-x" :aria-label="t('perf.presetDelete', { name: u.name })" :title="t('perf.presetDelete', { name: u.name })" @click="removeUserPreset(u)">
                <IconX :size="14" stroke-width="2" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div ref="saveFoot" class="presets__save">
            <Button variant="secondary" size="sm" :disabled="!!saveBlocked" :aria-describedby="saveBlocked ? 'perf-save-why' : undefined" @click="openSave">
              {{ t('perf.presetSaveCurrent') }}
            </Button>
            <p v-if="saveBlocked" id="perf-save-why" class="hint">{{ saveBlocked }}</p>
          </div>
        </Card>
      </div>
      </div>
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
.wb__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); white-space: nowrap; }
/* If the bar ever wraps, a whole group moves to the next row; no label is squeezed under its neighbour. */
.wb__group { display: flex; flex: none; align-items: center; gap: var(--s-1); }
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
.chip__dot { width: 8px; height: 8px; border-radius: 50%; background: var(--chip); flex: none; }
.chip__dot--rt { background: linear-gradient(90deg, var(--m-press) 50%, var(--m-release) 50%); }
.chip[aria-checked='true'] { background: var(--sel-bg); border-color: var(--acc-line); color: var(--fg-1); }
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

.grid {
  display: grid;
  grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr));
  gap: var(--s-4);
}
/* A note above the columns takes its own row; the columns' row takes all the spare height (the min-height hold). */
.grid--note { grid-template-rows: auto 1fr; }
/* Saved presets: a second row with the same columns, so nothing in it can stretch row 1. */
.editors { display: flex; flex-direction: column; gap: var(--s-4); }
.saved { display: grid; grid-template-columns: repeat(var(--cols, 3), minmax(0, 1fr)); gap: var(--s-4); }
.saved__card { grid-column: var(--cols, 3); }
.pcol { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
/* The grower of a column takes its spare height (Mode and RT split it); each puts it in a named region, never a blank tail. */
.pcol > .grow { flex: 1 1 auto; }

.loading { grid-column: 1 / -1; margin: 0; color: var(--fg-3); }
.skel-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-5);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
}

/* In the Actuation grower the editor and readout are centred in the spare height. */
.act { display: flex; flex: 1 1 auto; gap: var(--s-6); align-items: center; flex-wrap: wrap; }
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
  grid-column: 1 / -1;
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
/* Pinned to the bottom of the Mode card: the spare height opens above it, between the hint and the switch. */
.continuous { display: grid; gap: var(--s-2); margin-top: auto; padding-top: var(--s-4); border-top: 1px solid var(--line-1); }
/* In a grower the fields share the spare height, each centred in its share. */
.field { display: flex; flex: 1 1 auto; flex-direction: column; justify-content: center; gap: var(--s-2); }
.field__row { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
.field__label { color: var(--fg-2); }
.field__row :deep(.nf) { width: 132px; }

.presets { display: flex; flex: 1 1 auto; flex-direction: column; gap: var(--s-2); }
.preset {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  flex: 1 1 auto;
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
.preset:hover .preset__desc { color: var(--fg-2); }
/* Saved presets: the same rows as the built-ins, with a × beside each. */
.preset-row { position: relative; display: flex; flex: 1 1 auto; }
.preset-row .preset { flex: 1; min-width: 0; padding-right: 40px; }
.preset__name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.preset-x { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); display: grid; place-items: center; width: 24px; height: 24px; border: 0; background: transparent; border-radius: var(--r-control); color: var(--fg-3); }
.preset-x:hover { color: var(--danger); background: var(--bg-4); }
.presets__save { display: flex; flex-direction: column; align-items: flex-start; gap: var(--s-1); }
.presets__save .hint { margin: 0; font-size: var(--fs-caption); }

.save { display: grid; gap: var(--s-3); }
.save__label { display: grid; gap: var(--s-2); color: var(--fg-2); }
.save__input { height: 34px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--bg-1); color: var(--fg-1); }
</style>
