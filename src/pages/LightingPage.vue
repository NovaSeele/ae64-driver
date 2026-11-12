<script setup lang="ts">
// Đèn — a workbench like Hành trình: toolbar → keyboard (the edge strip is a ring of LEDs on its frame) → selection bar →
// one editor dock. Every control calls the same lighting-store action as before; the colour field, the quick colours and
// the strip's Esc only change what the page shows, never the keyboard.
import { IconBorderOuter, IconChevronDown, IconKeyboard } from '@tabler/icons-vue';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import SelectionBar from '../components/keyboard/SelectionBar.vue';
import Button from '../components/ui/Button.vue';
import Dialog from '../components/ui/Dialog.vue';
import InfoTip from '../components/ui/InfoTip.vue';
import Popover from '../components/ui/Popover.vue';
import Segmented from '../components/ui/Segmented.vue';
import Slider from '../components/ui/Slider.vue';
import ColorPicker from '../components/ui/ColorPicker.vue';
import Switch from '../components/ui/Switch.vue';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { useSyncStore } from '../stores/sync';
import { hexToRgb, rgbToHex, useLightingStore } from '../stores/lighting';
import { inkFor } from '../colorInk';
import { LED_MATRIX_COLS, LED_STRIP_COUNT, STRIP_ORDER, STRIP_SIDES } from '../protocol';
import type { PhysicalKey } from '../protocol';
import { stripRing } from '../protocol/ledLayout';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const sync = useSyncStore();
const lighting = useLightingStore();

type TabId = 'keys' | 'strip';
const activeTab = ref<TabId>('keys');
/** Firmware lighting area of the active tab: 0 = keys, 1 = edge strip. */
const area = computed<0 | 1>(() => (activeTab.value === 'keys' ? 0 : 1));

const tabItems = computed(() => [
  { id: 'keys' as const, title: t('lighting.tabKeys'), sub: t('lighting.tabKeysSub'), icon: IconKeyboard },
  { id: 'strip' as const, title: t('lighting.tabStrip'), sub: t('lighting.tabStripSub'), icon: IconBorderOuter },
]);

/** ←/→ move and activate, Home/End jump (the tab pair is a plain tablist). */
function onTabKey(e: KeyboardEvent) {
  const items = tabItems.value;
  let next: (typeof items)[number] | undefined;
  if (e.key === 'Home') next = items[0];
  else if (e.key === 'End') next = items[items.length - 1];
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const i = items.findIndex((x) => x.id === activeTab.value);
    next = items[(i + (e.key === 'ArrowRight' ? 1 : -1) + items.length) % items.length];
  } else return;
  e.preventDefault();
  activeTab.value = next.id;
  (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
}

// What the page may show and edit: nothing is real until this profile's lighting has been read.
const ready = computed(() => !lighting.loading && lighting.loadedProfile === device.activeProfile);
const readOnly = computed(() => !device.boardAllowed);
const locked = computed(() => !ready.value || readOnly.value);

const base = computed(() => (area.value === 0 ? lighting.area0Base : lighting.area1Base));
const palette = computed(() => (area.value === 0 ? lighting.area0Palette : lighting.area1Palette));
const modeCount = computed(() => (area.value === 0 ? lighting.area0ModeCount : lighting.area1ModeCount));
const powered = computed(() => base.value.open);
/** Effect, tuning and palette do nothing while the area is off. */
const tuneLocked = computed(() => locked.value || !powered.value);

const areaName = () => t(area.value === 0 ? 'lighting.tabKeys' : 'lighting.tabStrip');
const baseLabel = () => t('lighting.syncBase', { area: areaName() });
const paletteLabel = () => t('lighting.syncPalette', { area: areaName() });
const matrixLabel = () => t('lighting.syncMatrix', { area: areaName() });

const stripSelection = ref<Set<number>>(new Set());

let offProfile: (() => void) | null = null;

onMounted(() => {
  void lighting.load();
  lighting.startLivePolling();
  offProfile = device.onProfileChanged(() => {
    void lighting.load(true);
  });
  window.addEventListener('keydown', onWindowKey);
});

// A write was dropped: the shown values are no longer what the keyboard has, read them again once the
// queue has settled (a newer job for the same area may still be waiting to be written).
let reloading = false;
let reloadAgain = false;
async function reloadAfterSettle(): Promise<void> {
  if (reloading) { reloadAgain = true; return; }
  reloading = true;
  try {
    do {
      reloadAgain = false;
      try { await sync.flush(); } catch { /* the toast/pill report it */ }
      if (device.connected) await lighting.load(true);
    } while (reloadAgain);
  } finally {
    reloading = false;
  }
}
watch(() => lighting.staleSeq, () => { void reloadAfterSettle(); });

onBeforeUnmount(() => {
  offProfile?.();
  lighting.stopLivePolling();
  window.removeEventListener('keydown', onWindowKey);
});

// ------------------------------------------------------------------ Preview colours
/** Static stand-in for the firmware's rainbow: hue by position (0..1). */
function rainbowAt(pos: number): string {
  return `hsl(${Math.round(pos * 360)} 80% 60%)`;
}

function keyColor(key: PhysicalKey): string | undefined {
  if (!ready.value) return undefined;
  if (lighting.livePreview && lighting.liveColors[key.id]) {
    return lighting.liveColors[key.id];
  }
  const custom = lighting.keyCustomColors[key.id];
  if (custom?.custom) {
    return custom.colorHex;
  }
  const b = lighting.area0Base;
  if (!b.open || b.openMode === 0) return undefined;
  if (b.paletteIndex === 0) return rainbowAt(key.col / LED_MATRIX_COLS);
  const pal = lighting.area0Palette[b.paletteIndex];
  return pal ? rgbToHex(pal) : undefined;
}

/** Marks keys that carry their own colour (the LED line alone is easy to miss). */
function keyBadge(key: PhysicalKey): string | undefined {
  return ready.value && lighting.keyCustomColors[key.id]?.custom ? '●' : undefined;
}

function stripColor(index: number): string {
  if (!ready.value) return 'var(--bg-3)';
  if (lighting.livePreview && lighting.liveStripColors[index]) {
    return lighting.liveStripColors[index];
  }
  const custom = lighting.stripCustomColors[index];
  if (custom?.custom) return custom.colorHex;
  const b = lighting.area1Base;
  if (!b.open || b.openMode === 0) return 'var(--bg-1)';
  if (b.paletteIndex === 0) return rainbowAt(STRIP_ORDER.indexOf(index) / LED_STRIP_COUNT);
  const pal = lighting.area1Palette[b.paletteIndex];
  return pal ? rgbToHex(pal) : 'var(--bg-3)';
}

// ------------------------------------------------------------------ Edge strip as a ring on the keyboard frame
const SIDE_KEY = {
  top: 'lighting.sideTop',
  right: 'lighting.sideRight',
  bottom: 'lighting.sideBottom',
  left: 'lighting.sideLeft',
} as const;

const ringLeds = computed(() => stripRing().map(({ index, side, t: pos }) => {
  const label = t('lighting.ledLabel', { n: index, side: t(SIDE_KEY[side]) });
  return {
    index,
    side,
    pos,
    label,
    color: stripColor(index),
    isSel: stripSelection.value.has(index),
    custom: ready.value && lighting.stripCustomColors[index]?.custom,
  };
}));

const ringEl = ref<HTMLElement | null>(null);
/** The ring is one Tab stop: this LED holds it (roving tabindex), moved with the arrow keys. */
const ringStop = ref<number>(STRIP_ORDER[0]);

function onToggleStripLed(index: number) {
  const next = new Set(stripSelection.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  stripSelection.value = next;
}

function focusLed(index: number) {
  ringStop.value = index;
  ringEl.value?.querySelector<HTMLElement>(`[data-led="${index}"]`)?.focus();
}

function onRingKey(e: KeyboardEvent, index: number) {
  const n = STRIP_ORDER.length;
  const at = STRIP_ORDER.indexOf(index);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') focusLed(STRIP_ORDER[(at + 1) % n]);
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') focusLed(STRIP_ORDER[(at - 1 + n) % n]);
  else if (e.key === 'Home') focusLed(STRIP_ORDER[0]);
  else if (e.key === 'End') focusLed(STRIP_ORDER[n - 1]);
  else if (e.key === ' ' || e.key === 'Enter') onToggleStripLed(index);
  else return;
  e.preventDefault();
}

/** Esc clears the strip selection (the keys tab's KeyboardView does the same for keys). Selection only: nothing is written. */
function onWindowKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || activeTab.value !== 'strip' || e.defaultPrevented) return;
  const el = e.target as HTMLElement | null;
  if (el?.closest('[role="dialog"]') || el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.isContentEditable) return;
  if (stripSelection.value.size) stripSelection.value = new Set();
}

function onStripPreset(preset: 'all' | 'none' | 'top' | 'bottom' | 'left' | 'right') {
  if (preset === 'all') stripSelection.value = new Set(STRIP_ORDER);
  else if (preset === 'none') stripSelection.value = new Set();
  else stripSelection.value = new Set(STRIP_SIDES[preset]);
}

const stripPresets = computed(() => [
  { id: 'all' as const, label: t('sel.all') },
  { id: 'top' as const, label: t('lighting.selectTop') },
  { id: 'right' as const, label: t('lighting.selectRight') },
  { id: 'bottom' as const, label: t('lighting.selectBottom') },
  { id: 'left' as const, label: t('lighting.selectLeft') },
]);

// ------------------------------------------------------------------ Power / direction / effect
const openOptions = computed(() => (area.value === 0
  ? [
      { value: 0, label: t('lighting.modeOff') },
      { value: 1, label: t('lighting.modeBottom') },
      { value: 2, label: t('lighting.modeTop') },
      { value: 3, label: t('lighting.modeBoth') },
    ]
  : [
      { value: 0, label: t('lighting.modeOff') },
      { value: 1, label: t('lighting.modeOn') },
    ]));

const openModel = computed<number>({
  get: () => (base.value.open ? base.value.openMode || 1 : 0),
  set: (val: number | null) => {
    const openMode = val ?? 0;
    lighting.applyBase(area.value, { openMode, open: openMode !== 0 }, baseLabel());
  },
});

const directionModel = computed<number>({
  get: () => base.value.direction,
  set: (val: number | null) => {
    lighting.applyBase(area.value, { direction: val ?? 0 }, baseLabel());
  },
});

const directionOptions = computed(() => [
  { value: 0, label: `→ ${t('lighting.directionForward')}` },
  { value: 1, label: `← ${t('lighting.directionBackward')}` },
]);

function onEffect(index: number) {
  lighting.applyBase(area.value, { mode: index }, baseLabel());
}

// ------------------------------------------------------------------ Brightness / speed
// The slider shows a local draft while it is dragged; the store only changes on commit, so applyBase
// sees the real before/after (history entry + write).
type TuneField = 'brightness' | 'speed';
const drafts = reactive<Record<string, number>>({});
const tuneFields = computed<{ id: TuneField; label: string }[]>(() => [
  { id: 'brightness', label: t('lighting.brightness') },
  { id: 'speed', label: t('lighting.speed') },
]);
const draftKey = (field: TuneField) => `${area.value}.${field}`;
const tuneValue = (field: TuneField) => drafts[draftKey(field)] ?? base.value[field];
function onTuneDrag(field: TuneField, value: number) {
  drafts[draftKey(field)] = value;
}
function onTuneCommit(field: TuneField, value: number) {
  delete drafts[draftKey(field)];
  lighting.applyBase(area.value, { [field]: value }, baseLabel(), field);
}

// ------------------------------------------------------------------ Palette
// Slot being edited, per area (0 = follow the active slot).
const editingSlots = reactive<Record<number, number>>({ 0: 0, 1: 0 });
for (const a of [0, 1] as const) {
  watch(() => (a === 0 ? lighting.area0Base : lighting.area1Base).paletteIndex, (idx) => {
    if (idx > 0) editingSlots[a] = idx;
  });
}
const editingSlot = computed(() => editingSlots[area.value] || (base.value.paletteIndex > 0 ? base.value.paletteIndex : 1));

// The picker edits a draft; the palette is written once, when the gesture ends (@commit).
const paletteDrafts = reactive<Record<number, string | null>>({ 0: null, 1: null });
const editingHex = computed<string>({
  get: () => {
    const entry = palette.value[editingSlot.value];
    return paletteDrafts[area.value] ?? (entry ? rgbToHex(entry) : '#ffffff');
  },
  set: (hex: string) => {
    paletteDrafts[area.value] = hex;
  },
});

function onPaletteCommit(hex: string) {
  paletteDrafts[area.value] = null;
  lighting.applyPaletteColor(area.value, editingSlot.value, hexToRgb(hex), paletteLabel(), 'color');
}

function onSwatch(index: number) {
  paletteDrafts[area.value] = null;
  if (index > 0) editingSlots[area.value] = index;
  lighting.applyBase(area.value, { paletteIndex: index }, baseLabel());
}

function swatchHex(index: number): string | undefined {
  const draft = paletteDrafts[area.value];
  if (index === editingSlot.value && draft) return draft;
  const entry = palette.value[index];
  return entry ? rgbToHex(entry) : undefined;
}

/** Slot-number colour that stays readable on the swatch. */
function swatchInk(index: number): 'dark' | 'light' {
  const hex = swatchHex(index);
  if (!hex) return 'light';
  const { r, g, b } = hexToRgb(hex);
  return inkFor(r, g, b); // from the LED colour itself, never the theme
}

// The slot editor and the per-key colour field both open a popover; closed whenever what they edit goes away.
type AnchorRef = { $el: HTMLElement } | null;
const palEditBtn = ref<AnchorRef>(null);
const palOpen = ref(false);
const colorBtn = ref<HTMLElement | null>(null);
const colorOpen = ref(false);
const palIsRainbow = computed(() => base.value.paletteIndex === 0);
watch([area, palIsRainbow, tuneLocked], () => { palOpen.value = false; });
watch([area, locked], () => { colorOpen.value = false; });

// ------------------------------------------------------------------ Per-key / per-LED colours
const picked = reactive<Record<number, string>>({ 0: '#ffffff', 1: '#ffffff' });
const confirmClear = ref(false);

/** White, then this area's palette slots 1–7. No write: a click only sets the colour the next "Áp dụng" will use. */
const quickColors = computed(() => ['#ffffff', ...Array.from({ length: 7 }, (_, i) => {
  const entry = palette.value[i + 1];
  return entry ? rgbToHex(entry) : '#000000';
})]);

const selectedCount = computed(() => (area.value === 0 ? sel.count : stripSelection.value.size));
const overrideCount = computed(() => (area.value === 0
  ? Object.values(lighting.keyCustomColors).filter((v) => v.custom).length
  : lighting.stripCustomColors.filter((v) => v.custom).length));
const selectionHasOverride = computed(() => (area.value === 0
  ? sel.ids.some((id) => lighting.keyCustomColors[id]?.custom)
  : [...stripSelection.value].some((i) => lighting.stripCustomColors[i]?.custom)));

const stripCountText = computed(() => {
  const n = stripSelection.value.size;
  if (n === 0) return t('lighting.selectedLedNone');
  return n === 1 ? t('lighting.selectedLedOne') : t('lighting.selectedLeds', { count: n });
});
const applyText = computed(() => {
  const n = selectedCount.value;
  if (n === 0) return t('lighting.applyColor');
  return t(area.value === 0 ? 'lighting.applyKeysN' : 'lighting.applyLedsN', { count: n });
});

function onApplyColor() {
  const rgb = hexToRgb(picked[area.value]);
  if (area.value === 0) lighting.applyKeyColors(sel.ids, rgb, matrixLabel());
  else lighting.applyStripColors([...stripSelection.value], rgb, matrixLabel());
}

function onClearSelected() {
  if (area.value === 0) lighting.clearKeyColors(sel.ids, matrixLabel());
  else lighting.clearStripColors([...stripSelection.value], matrixLabel());
}

function onClearAll() {
  confirmClear.value = false;
  if (area.value === 0) lighting.clearAllKeyColors(matrixLabel());
  else lighting.clearAllStripColors(matrixLabel());
}

const liveState = computed<'error' | 'live' | 'paused'>(() => {
  if (!lighting.livePreview) return 'paused';
  return lighting.liveError ? 'error' : 'live';
});
</script>

<template>
  <PageLayout :title="t('page.lighting')">
    <div class="wb">
      <!-- toolbar -->
      <div class="wb__bar">
        <div class="tabs" role="tablist" :aria-label="t('lighting.tabsLabel')" @keydown="onTabKey">
          <button
            v-for="it in tabItems"
            :key="it.id"
            type="button"
            role="tab"
            class="tabs__opt"
            :data-id="it.id"
            :aria-selected="it.id === activeTab"
            :aria-describedby="`lighting-tab-sub-${it.id}`"
            :title="it.sub"
            :tabindex="it.id === activeTab ? 0 : -1"
            @click="activeTab = it.id"
          >
            <component :is="it.icon" :size="16" stroke-width="1.75" aria-hidden="true" />{{ it.title }}
          </button>
        </div>
        <span v-for="it in tabItems" :id="`lighting-tab-sub-${it.id}`" :key="it.id" class="sr-only">{{ it.sub }}</span>
        <div class="wb__group">
          <span class="wb__label">{{ t('lighting.powerTitle') }}</span>
          <Segmented v-model="openModel" :options="openOptions" :label="t('lighting.powerTitle')" :disabled="locked" />
          <InfoTip :text="t(area === 0 ? 'lighting.powerHintKeys' : 'lighting.powerHintStrip')" />
        </div>
        <div class="wb__group wb__live">
          <span class="lighting-live-badge" :class="`lighting-live-badge--${liveState}`">
            <span class="lighting-live-badge__dot" />
            {{ liveState === 'error' ? t('lighting.liveError') : liveState === 'live' ? t(device.demo ? 'lighting.simStatus' : 'lighting.liveStatus') : t('lighting.pausedStatus') }}
          </span>
          <InfoTip :text="device.demo ? t('lighting.demoSimNote') : t('lighting.livePreviewHint')" />
          <Switch v-model="lighting.livePreview" :label="t('lighting.livePreview')" />
        </div>
      </div>

      <p v-if="readOnly" class="lighting-notice" role="status">{{ t('lighting.readOnly') }}</p>

      <!-- keyboard (keys are only selectable on the keys tab) with the edge strip as a ring on its frame -->
      <div class="wb__board">
        <KeyboardView
          :keys="device.keys"
          :legend="device.legend"
          :color="keyColor"
          :badge="keyBadge"
          :selectable="activeTab === 'keys'"
          :loading="!ready"
        />
        <div
          ref="ringEl"
          class="ring"
          :class="{ 'ring--on': activeTab === 'strip' && ready }"
          role="group"
          :aria-label="t('lighting.ringLabel')"
          :aria-hidden="activeTab === 'strip' ? undefined : true"
        >
          <button
            v-for="led in ringLeds"
            :key="led.index"
            type="button"
            class="led"
            :class="[`led--${led.side}`, { 'led--selected': led.isSel, 'led--custom': led.custom }]"
            :style="{ '--p': led.pos, '--led-color': led.color }"
            :data-led="led.index"
            :title="led.label"
            :aria-label="led.label"
            :aria-pressed="activeTab === 'strip' ? led.isSel : undefined"
            :disabled="activeTab !== 'strip' || !ready"
            :tabindex="led.index === ringStop ? 0 : -1"
            @click="onToggleStripLed(led.index)"
            @focus="ringStop = led.index"
            @keydown="onRingKey($event, led.index)"
          >
            <span class="led__glow" />
            <span class="led__dot" />
          </button>
        </div>
      </div>

      <!-- selection bar -->
      <SelectionBar v-if="activeTab === 'keys'" />
      <div v-else class="sb">
        <span class="sb__count" :class="{ 'sb__count--on': stripSelection.size > 0 }" aria-live="polite">
          <span class="num">{{ stripCountText }}</span>
        </span>
        <span class="sb__hint">{{ t('lighting.stripHint') }}</span>
        <div class="sb__actions">
          <Button v-for="p in stripPresets" :key="p.id" size="sm" variant="ghost" :disabled="locked" @click="onStripPreset(p.id)">{{ p.label }}</Button>
          <Button size="sm" variant="ghost" :disabled="locked || !stripSelection.size" @click="onStripPreset('none')">{{ t('sel.clear') }}</Button>
        </div>
      </div>

      <!-- load error -->
      <div v-if="lighting.loadError" class="lighting-error">
        <p>{{ t('lighting.loadFailed') }}: {{ lighting.loadError }}</p>
        <Button variant="secondary" size="sm" @click="lighting.load(true)">
          {{ t('lighting.reload') }}
        </Button>
      </div>

      <!-- loading skeleton -->
      <div v-else-if="!ready" class="dock dock--skel" role="status" aria-busy="true">
        <span class="sr-only">{{ t('lighting.loading') }}</span>
        <div v-for="n in 4" :key="n" class="skeleton lighting-skeleton" />
      </div>

      <!-- editor dock -->
      <section v-else class="dock" :aria-label="t('lighting.effectsTitle')">
        <p v-if="!powered" class="dock__off" role="status">{{ t('lighting.powerOffHint') }}</p>
        <div class="dock__cols">
          <!-- a. Effects -->
          <div class="col col--fx">
            <div class="col__head">
              <h3 class="col__title">{{ t('lighting.effectsShort') }}</h3>
              <InfoTip :text="t('lighting.effectsDesc')" placement="top" />
            </div>
            <fieldset class="col__body" :disabled="tuneLocked">
              <div class="effect-grid">
                <button
                  v-for="index in modeCount"
                  :key="index - 1"
                  type="button"
                  class="effect-btn num"
                  :class="{ 'effect-btn--active': base.mode === index - 1 }"
                  :aria-label="t('lighting.effectN', { n: index })"
                  :title="t('lighting.effectN', { n: index })"
                  :aria-pressed="base.mode === index - 1"
                  @click="onEffect(index - 1)"
                >
                  {{ index }}
                </button>
              </div>
            </fieldset>
          </div>

          <!-- b. Tuning -->
          <div class="col col--tune">
            <div class="col__head">
              <h3 class="col__title">{{ t('lighting.tuningShort') }}</h3>
            </div>
            <fieldset class="col__body" :disabled="tuneLocked">
              <div v-for="field in tuneFields" :key="field.id" class="field-block">
                <div class="field-label-row">
                  <span class="field-label">{{ field.label }}</span>
                  <span class="field-val num">{{ tuneValue(field.id) }}%</span>
                </div>
                <Slider
                  :model-value="tuneValue(field.id)"
                  :min="0"
                  :max="100"
                  :step="1"
                  :fine-step="1"
                  :label="field.label"
                  :disabled="tuneLocked"
                  @update:model-value="onTuneDrag(field.id, $event)"
                  @commit="onTuneCommit(field.id, $event)"
                />
              </div>
              <div class="field-inline">
                <span class="field-label">{{ t('lighting.directionShort') }}</span>
                <Segmented v-model="directionModel" :options="directionOptions" :label="t('lighting.direction')" />
              </div>
            </fieldset>
          </div>

          <!-- c. Palette -->
          <div class="col col--pal">
            <div class="col__head">
              <h3 class="col__title">{{ t('lighting.paletteTitle') }}</h3>
              <InfoTip :text="`${t('lighting.paletteDesc')} ${t('lighting.rainbowHint')}`" placement="top" />
            </div>
            <fieldset class="col__body" :disabled="tuneLocked">
              <div class="palette-swatches">
                <button
                  type="button"
                  class="palette-swatch palette-swatch--rainbow"
                  :class="{ 'palette-swatch--active': base.paletteIndex === 0 }"
                  :title="t('lighting.rainbowSlot')"
                  :aria-label="t('lighting.rainbowSlot')"
                  :aria-pressed="base.paletteIndex === 0"
                  @click="onSwatch(0)"
                >
                  <span class="palette-swatch__label">RGB</span>
                </button>
                <button
                  v-for="index in 7"
                  :key="index"
                  type="button"
                  class="palette-swatch"
                  :class="{
                    'palette-swatch--active': base.paletteIndex === index,
                    'palette-swatch--dark-ink': swatchInk(index) === 'dark',
                  }"
                  :style="{ backgroundColor: swatchHex(index) ?? 'var(--bg-3)' }"
                  :title="t('lighting.paletteSlot', { n: index })"
                  :aria-label="t('lighting.paletteSlot', { n: index })"
                  :aria-pressed="base.paletteIndex === index"
                  @click="onSwatch(index)"
                >
                  <span class="palette-swatch__num num">{{ index }}</span>
                </button>
              </div>
              <div class="pal">
                <span
                  class="pal__chip"
                  :class="{ 'pal__chip--rgb': palIsRainbow }"
                  :style="palIsRainbow ? undefined : { backgroundColor: swatchHex(base.paletteIndex) ?? 'var(--bg-3)' }"
                />
                <span class="pal__name">{{ palIsRainbow ? t('lighting.rainbow') : t('lighting.paletteSlot', { n: base.paletteIndex }) }}</span>
                <Button
                  ref="palEditBtn"
                  class="pal__edit"
                  size="sm"
                  variant="secondary"
                  aria-haspopup="dialog"
                  :aria-expanded="palOpen"
                  :disabled="palIsRainbow"
                  :title="palIsRainbow ? t('lighting.rainbowNoEdit') : undefined"
                  @click="palOpen = !palOpen"
                >
                  {{ t('lighting.editColorBtn') }}
                </Button>
              </div>
            </fieldset>
            <Popover v-model:open="palOpen" :anchor="palEditBtn?.$el ?? null" :title="t('lighting.editColorTitle', { n: editingSlot, area: areaName() })">
              <ColorPicker v-model="editingHex" :disabled="tuneLocked" @commit="onPaletteCommit" />
            </Popover>
          </div>

          <!-- d. Per-key / per-LED colours -->
          <div class="col col--own">
            <div class="col__head">
              <h3 class="col__title">{{ activeTab === 'keys' ? t('lighting.perKeyTitle') : t('lighting.stripCustomTitle') }}</h3>
              <InfoTip :text="activeTab === 'keys' ? `${t('lighting.perKeyDesc')} ${t('lighting.spaceNote')}` : t('lighting.stripCustomDesc')" placement="top" />
              <span v-if="overrideCount > 0" class="col__meta">{{ t(activeTab === 'keys' ? 'lighting.customMetaKeys' : 'lighting.customMetaLeds', { count: overrideCount }) }}</span>
            </div>
            <fieldset class="col__body" :disabled="locked">
              <button
                ref="colorBtn"
                type="button"
                class="cfield"
                aria-haspopup="dialog"
                :aria-expanded="colorOpen"
                :aria-label="`${t('lighting.pickColor')} ${picked[area].toUpperCase()}`"
                :title="t('lighting.pickColor')"
                @click="colorOpen = !colorOpen"
              >
                <span class="cfield__sw" :style="{ backgroundColor: picked[area] }" />
                <span class="cfield__hex num">{{ picked[area].toUpperCase() }}</span>
                <IconChevronDown class="cfield__chev" :size="14" stroke-width="1.8" aria-hidden="true" />
              </button>
              <div class="quick">
                <button
                  v-for="(hex, i) in quickColors"
                  :key="i"
                  type="button"
                  class="quick__chip"
                  :class="{ 'quick__chip--on': hex === picked[area].toLowerCase() }"
                  :style="{ backgroundColor: hex }"
                  :aria-label="hex"
                  :title="hex"
                  :aria-pressed="hex === picked[area].toLowerCase()"
                  @click="picked[area] = hex"
                />
              </div>
              <div class="own-actions">
                <Button variant="primary" size="sm" :disabled="selectedCount === 0" @click="onApplyColor">{{ applyText }}</Button>
                <Button
                  variant="secondary"
                  size="sm"
                  :disabled="!selectionHasOverride"
                  :title="activeTab === 'keys' ? t('lighting.clearKeyColor') : t('lighting.clearStripColor')"
                  :aria-label="activeTab === 'keys' ? t('lighting.clearKeyColor') : t('lighting.clearStripColor')"
                  @click="onClearSelected"
                >
                  {{ t('lighting.clearShort') }}
                </Button>
                <Button class="own-actions__all" variant="danger" size="sm" :disabled="overrideCount === 0" @click="confirmClear = true">
                  {{ t('lighting.clearAllN', { count: overrideCount }) }}
                </Button>
              </div>
            </fieldset>
            <Popover v-model:open="colorOpen" :anchor="colorBtn" :title="t('lighting.pickColor')">
              <ColorPicker v-model="picked[area]" :disabled="locked" />
            </Popover>
          </div>
        </div>
      </section>
    </div>

    <Dialog
      v-model:open="confirmClear"
      :title="activeTab === 'keys' ? t('lighting.confirmClearKeysTitle') : t('lighting.confirmClearStripTitle')"
    >
      <p class="dlg-body">{{ activeTab === 'keys' ? t('lighting.confirmClearKeysBody') : t('lighting.confirmClearStripBody') }}</p>
      <template #footer>
        <Button variant="ghost" @click="confirmClear = false">{{ t('advanced.cancel') }}</Button>
        <Button variant="danger" @click="onClearAll">
          {{ activeTab === 'keys' ? t('lighting.clearAllKeyColors') : t('lighting.clearAllStripColors') }}
        </Button>
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.wb { display: flex; flex-direction: column; gap: var(--s-2); }
.wb__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4); }
.wb__group { display: flex; align-items: center; gap: var(--s-2); min-width: 0; }
.wb__label { font-size: var(--fs-label); color: var(--fg-2); white-space: nowrap; }
.wb__live { margin-left: auto; flex: none; white-space: nowrap; }

/* Area tabs: the Segmented look, as a tablist. */
.tabs {
  display: inline-flex;
  padding: 3px;
  gap: 2px;
  background: var(--bg-1);
  border: 1px solid var(--line-1);
  border-radius: 8px;
}
.tabs__opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--fg-2);
  font-size: var(--fs-body);
  font-weight: 500;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.tabs__opt:hover:not([aria-selected='true']) { color: var(--fg-1); }
.tabs__opt[aria-selected='true'] { background: var(--sel-bg); color: var(--fg-1); box-shadow: inset 0 0 0 1px var(--acc-line); }
.tabs__opt:focus-visible,
.tabs__opt[aria-selected='true']:focus-visible { box-shadow: var(--focus-ring); }

.lighting-live-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--s-1);
  font-size: var(--fs-caption);
  padding: 3px 8px;
  border-radius: var(--r-control);
  background: var(--bg-3);
  color: var(--fg-3);
  border: 1px solid var(--line-1);
}

.lighting-live-badge--live {
  background: var(--ok-soft);
  color: var(--ok);
  border-color: var(--ok-soft);
}

.lighting-live-badge--error {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: var(--danger-soft);
}

.lighting-live-badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.lighting-notice {
  margin: 0;
  padding: var(--s-2) var(--s-3);
  border: 1px solid var(--warn-soft);
  border-radius: var(--r-control);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-label);
}

/* The board takes the same widths as every page's keyboard; the ring's dots hang 12px beyond the frame. */
.wb__board { position: relative; width: 100%; max-width: 900px; margin: 12px auto 14px; }
@media (min-width: 1600px) {
  .wb__board { max-width: 1100px; }
}

/* Edge strip: 38 LEDs on the frame, centred on its border line, clockwise from the top-left corner. */
.ring { position: absolute; inset: 0; pointer-events: none; --inset: 18px; }
.led {
  position: absolute;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  margin: -12px 0 0 -12px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  pointer-events: auto;
  cursor: default;
}
.led--top { top: 0; left: calc(var(--inset) + var(--p) * (100% - 2 * var(--inset))); }
.led--right { left: 100%; top: calc(var(--inset) + var(--p) * (100% - 2 * var(--inset))); }
.led--bottom { top: 100%; left: calc(var(--inset) + (1 - var(--p)) * (100% - 2 * var(--inset))); }
.led--left { left: 0; top: calc(var(--inset) + (1 - var(--p)) * (100% - 2 * var(--inset))); }
.ring--on .led { cursor: pointer; }
.led:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
.led__glow {
  position: absolute;
  inset: 3px;
  border-radius: 50%;
  background: var(--led-color);
  opacity: 0.35;
  filter: blur(4px);
  pointer-events: none;
  transition: background 100ms linear;
}
.led__dot {
  position: relative;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--led-color);
  box-shadow: 0 0 0 1.5px var(--bg-1);
  transition: background 100ms linear, box-shadow var(--t-fast) var(--ease);
}
.ring--on .led:hover .led__dot { box-shadow: 0 0 0 1.5px var(--bg-1), 0 0 0 3.5px var(--fg-2); }
.led--selected .led__dot,
.ring--on .led--selected:hover .led__dot { box-shadow: 0 0 0 2px var(--bg-1), 0 0 0 4px var(--acc); }
.led--custom .led__dot::after {
  content: '';
  position: absolute;
  inset: -5px;
  border-radius: 50%;
  border: 1.5px dashed var(--fg-3);
}

@media (prefers-reduced-motion: reduce) {
  .led__dot, .led__glow { transition: none; }
}

/* Strip selection bar: the same row as the keys' SelectionBar. */
.sb { display: flex; align-items: center; gap: var(--s-4); min-height: 36px; }
.sb__count { flex: none; font-weight: 500; color: var(--fg-3); transition: color var(--t-fast) var(--ease); }
.sb__count--on { color: var(--fg-1); }
.sb__hint { flex: 1; min-width: 0; color: var(--fg-4); font-size: var(--fs-label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sb__actions { display: flex; gap: 2px; flex: none; }

.lighting-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-6);
  background: var(--bg-2);
  border: 1px solid var(--danger);
  border-radius: var(--r-card);
  color: var(--danger);
}

/* ----- editor dock: one card, four columns (2 × 2 under 920px of dock width) */
.dock {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-5) var(--s-4);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  min-width: 0;
}
.dock--skel { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s-4); }
.lighting-skeleton { height: 160px; border-radius: var(--r-card); }
.dock__off { margin: 0; color: var(--fg-3); font-size: var(--fs-label); }
.dock__cols { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1.25fr) minmax(0, 0.85fr) minmax(0, 1.1fr); gap: var(--s-4) 0; }
.col {
  container-type: inline-size;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  min-width: 0;
  padding: 0 var(--s-4);
  border-left: 1px solid var(--line-1);
}
.col:first-child { padding-left: 0; border-left: 0; }
.col:last-child { padding-right: 0; }
.col__head { display: flex; align-items: center; gap: var(--s-1); min-height: 24px; }
.col__title { margin: 0; font-size: var(--fs-card); font-weight: 600; }
.col__meta { margin-left: auto; color: var(--fg-3); font-size: var(--fs-caption); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
@container (max-width: 919px) {
  .dock__cols { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .col:nth-child(2) { padding-right: 0; }
  .col:nth-child(3) { padding-left: 0; border-left: 0; }
  .col:nth-child(n + 3) { padding-top: var(--s-4); border-top: 1px solid var(--line-1); }
}

/* Fieldset so `disabled` reaches every native control inside. */
.col__body {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.col__body:disabled { opacity: 0.55; }
/* The fieldset already dims everything; Slider must not dim a second time. */
.col__body :deep(.sl--disabled) { opacity: 1; }

.dlg-body {
  margin: 0;
  color: var(--fg-2);
}

/* a. Effects: a numeric grid */
.effect-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.effect-btn {
  height: 32px;
  min-width: 0;
  padding: 0;
  background: var(--bg-3);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  color: var(--fg-2);
  cursor: pointer;
  font-size: var(--fs-body);
  font-weight: 500;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.effect-btn:hover:not(:disabled) { background: var(--bg-4); border-color: var(--line-3); color: var(--fg-1); }
.effect-btn:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
.effect-btn:disabled { cursor: not-allowed; }
.effect-btn--active {
  background: var(--acc-soft) !important;
  border-color: var(--acc) !important;
  color: var(--acc) !important;
  font-weight: 600;
}

/* b. Tuning */
.field-block { display: flex; flex-direction: column; gap: 4px; }
.field-block + .field-block { margin-top: 4px; }
.field-label-row { display: flex; justify-content: space-between; align-items: center; }
.field-label { font-size: var(--fs-label); font-weight: 500; color: var(--fg-2); }
.field-val { font-size: var(--fs-label); font-weight: 600; color: var(--fg-1); }
.field-inline { display: flex; align-items: center; justify-content: space-between; gap: var(--s-2); margin-top: 4px; }
.field-inline :deep(.seg) { flex-wrap: nowrap; }
/* A column with less than 260px of content: the label sits above the Segmented. */
@container (max-width: 259px) {
  .field-inline { flex-direction: column; align-items: stretch; gap: 4px; }
}

/* c. Palette */
.palette-swatches { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
.palette-swatch {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  min-width: 0;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  box-shadow: 0 0 0 1px var(--line-2), inset 0 0 0 1px var(--line-2);
  transition: transform var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.palette-swatch:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 0 0 1px var(--line-3), inset 0 0 0 1px var(--line-3);
}
.palette-swatch:focus-visible { outline: 2px solid var(--fg-1); outline-offset: 3px; }
.palette-swatch:disabled { cursor: not-allowed; }
.palette-swatch--active {
  box-shadow: 0 0 0 2px var(--acc), 0 0 12px var(--acc-soft) !important;
  transform: translateY(-1px);
}
.palette-swatch--rainbow {
  background: linear-gradient(135deg, #ff0055 0%, #ff5500 16%, #ffcc00 33%, #00cc66 50%, #0099ff 67%, #6600cc 83%, #cc0099 100%);
}
.palette-swatch__label {
  font-size: var(--fs-caption);
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.45);
  color: #ffffff;
}
.palette-swatch__num {
  font-size: var(--fs-caption);
  font-weight: 600;
  /* Ink follows the LED colour, not the theme. */
  color: #ffffff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
/* Swatches where the dark ink contrasts more (yellow, cyan, white, magenta...): dark number, no halo */
.palette-swatch--dark-ink .palette-swatch__num { color: #111318; text-shadow: none; }

.pal { display: flex; align-items: center; gap: 6px; min-width: 0; min-height: 28px; font-size: var(--fs-label); color: var(--fg-2); white-space: nowrap; }
.pal__chip { flex: none; width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--line-2); }
.pal__chip--rgb { background: conic-gradient(red, yellow, lime, cyan, blue, magenta, red); }
.pal__name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.pal__edit { margin-left: auto; flex: none; padding-inline: 8px; }

/* d. Per-key / per-LED colour */
.cfield {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 8px 0 4px;
  min-width: 0;
  background: var(--bg-1);
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  color: var(--fg-1);
  font: inherit;
  cursor: pointer;
}
.cfield:hover:not(:disabled) { border-color: var(--line-3); }
.cfield[aria-expanded='true'] { border-color: var(--acc-line); }
.cfield:disabled { cursor: not-allowed; }
.cfield__sw { flex: none; width: 22px; height: 22px; border-radius: 4px; border: 1px solid var(--line-2); }
.cfield__hex { font-size: var(--fs-label); }
.cfield__chev { margin-left: auto; flex: none; color: var(--fg-3); }
.quick { display: grid; grid-template-columns: repeat(8, minmax(0, 1fr)); gap: 4px; }
.quick__chip { height: 20px; min-width: 0; padding: 0; border-radius: 4px; border: 1px solid var(--line-2); cursor: pointer; }
.quick__chip:disabled { cursor: not-allowed; }
.quick__chip--on { box-shadow: 0 0 0 2px var(--bg-2), 0 0 0 4px var(--acc); }
.own-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.col .own-actions__all {
  flex-basis: 100%;
  justify-content: flex-start;
  height: auto;
  padding: 2px 0;
  border: 0;
  background: none;
  color: var(--danger);
  font-weight: 500;
}
.col .own-actions__all:disabled { color: var(--fg-3); }
</style>
