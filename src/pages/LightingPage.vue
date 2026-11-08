<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import SelectionBar from '../components/keyboard/SelectionBar.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import Dialog from '../components/ui/Dialog.vue';
import Segmented from '../components/ui/Segmented.vue';
import Slider from '../components/ui/Slider.vue';
import ColorPicker from '../components/ui/ColorPicker.vue';
import Tabs from '../components/ui/Tabs.vue';
import Switch from '../components/ui/Switch.vue';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { hexToRgb, rgbToHex, useLightingStore } from '../stores/lighting';
import { LED_MATRIX_COLS, LED_STRIP_COUNT } from '../protocol';
import type { PhysicalKey } from '../protocol';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const lighting = useLightingStore();

type TabId = 'keys' | 'strip';
const activeTab = ref<TabId>('keys');
/** Firmware lighting area of the active tab: 0 = keys, 1 = edge strip. */
const area = computed<0 | 1>(() => (activeTab.value === 'keys' ? 0 : 1));

const tabItems = computed(() => [
  { id: 'keys', label: t('lighting.tabKeys') },
  { id: 'strip', label: t('lighting.tabStrip') },
]);

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

// ------------------------------------------------------------------ Edge strip geometry
// LED indices run clockwise from the top edge's middle: 0..1 top right, 2..6 right, 7..20 bottom
// (right to left), 21..26 left, 27..37 top left. Drawn clockwise from the top-left corner so each
// edge is one contiguous group.
const STRIP_SIDES = {
  top: [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 0, 1],
  right: [2, 3, 4, 5, 6],
  bottom: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  left: [21, 22, 23, 24, 25, 26],
};
const STRIP_ORDER = [...STRIP_SIDES.top, ...STRIP_SIDES.right, ...STRIP_SIDES.bottom, ...STRIP_SIDES.left];

const stripSelection = ref<Set<number>>(new Set());

let offProfile: (() => void) | null = null;

onMounted(() => {
  void lighting.load();
  lighting.startLivePolling();
  offProfile = device.onProfileChanged(() => {
    void lighting.load(true);
  });
});

onBeforeUnmount(() => {
  offProfile?.();
  lighting.stopLivePolling();
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

const stripGroups = computed(() => {
  const sides = [
    { id: 'top', label: t('lighting.selectTop') },
    { id: 'right', label: t('lighting.selectRight') },
    { id: 'bottom', label: t('lighting.selectBottom') },
    { id: 'left', label: t('lighting.selectLeft') },
  ] as const;
  return sides.map((side) => ({
    ...side,
    leds: STRIP_SIDES[side.id].map((index) => ({
      index,
      color: stripColor(index),
      isSel: stripSelection.value.has(index),
      custom: ready.value && lighting.stripCustomColors[index]?.custom,
    })),
  }));
});

function onToggleStripLed(index: number) {
  const next = new Set(stripSelection.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  stripSelection.value = next;
}

function onStripPreset(preset: 'all' | 'none' | 'top' | 'bottom' | 'left' | 'right') {
  if (preset === 'all') stripSelection.value = new Set(STRIP_ORDER);
  else if (preset === 'none') stripSelection.value = new Set();
  else stripSelection.value = new Set(STRIP_SIDES[preset]);
}

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
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? 'dark' : 'light';
}

// ------------------------------------------------------------------ Per-key / per-LED colours
const picked = reactive<Record<number, string>>({ 0: '#ffffff', 1: '#ffffff' });
const confirmClear = ref(false);

const selectedCount = computed(() => (area.value === 0 ? sel.count : stripSelection.value.size));
const overrideCount = computed(() => (area.value === 0
  ? Object.values(lighting.keyCustomColors).filter((v) => v.custom).length
  : lighting.stripCustomColors.filter((v) => v.custom).length));
const selectionHasOverride = computed(() => (area.value === 0
  ? sel.ids.some((id) => lighting.keyCustomColors[id]?.custom)
  : [...stripSelection.value].some((i) => lighting.stripCustomColors[i]?.custom)));

const selectedText = computed(() => {
  const n = selectedCount.value;
  if (n === 0) return t(area.value === 0 ? 'lighting.noKeysSelected' : 'lighting.noLedsSelected');
  if (area.value === 0) return n === 1 ? t('lighting.selectedKeyOne') : t('lighting.selectedKeys', { count: n });
  return n === 1 ? t('lighting.selectedLedOne') : t('lighting.selectedLeds', { count: n });
});
const overrideText = computed(() => {
  const n = overrideCount.value;
  if (area.value === 0) return n === 1 ? t('lighting.customActiveOne') : t('lighting.customActive', { count: n });
  return n === 1 ? t('lighting.stripCustomActiveOne') : t('lighting.stripCustomActive', { count: n });
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
    <template #toolbar>
      <div class="lighting-toolbar">
        <span class="lighting-live-badge" :class="`lighting-live-badge--${liveState}`">
          <span class="lighting-live-badge__dot" />
          {{ liveState === 'error' ? t('lighting.liveError') : liveState === 'live' ? t('lighting.liveStatus') : t('lighting.pausedStatus') }}
        </span>
        <Switch
          v-model="lighting.livePreview"
          :label="t('lighting.livePreview')"
        />
      </div>
    </template>

    <div class="lighting">
      <p v-if="readOnly" class="lighting-notice" role="status">{{ t('lighting.readOnly') }}</p>

      <div class="lighting-tabs-row">
        <Tabs
          v-model="activeTab"
          :items="tabItems"
          :label="t('lighting.tabsLabel')"
        />
      </div>

      <!-- Keyboard + edge strip preview (keys are only selectable on the keys tab) -->
      <section class="lighting-stage">
        <KeyboardView
          :keys="device.keys"
          :legend="device.legend"
          :color="keyColor"
          :badge="keyBadge"
          :selectable="activeTab === 'keys'"
          :loading="!ready"
        />
        <SelectionBar v-if="activeTab === 'keys'" />

        <div class="strip-bar" :class="{ 'strip-bar--interactive': activeTab === 'strip' && ready }">
          <div class="strip-bar__header">
            <span class="strip-bar__title">{{ t('lighting.stripTitle') }}</span>
            <span v-if="activeTab === 'strip'" class="strip-bar__hint">{{ t('lighting.stripSubtitle') }}</span>
          </div>
          <div class="strip-bar__track">
            <div v-for="group in stripGroups" :key="group.id" class="strip-bar__group" :style="{ flexGrow: group.leds.length }">
              <span class="strip-bar__side">{{ group.label }}</span>
              <div class="strip-bar__leds" :style="{ gridTemplateColumns: `repeat(${group.leds.length}, minmax(0, 1fr))` }">
                <button
                  v-for="led in group.leds"
                  :key="led.index"
                  type="button"
                  class="strip-bar__led"
                  :class="{ 'strip-bar__led--selected': led.isSel, 'strip-bar__led--custom': led.custom }"
                  :style="{ '--led-color': led.color }"
                  :title="`LED ${led.index}`"
                  :aria-pressed="activeTab === 'strip' ? led.isSel : undefined"
                  :disabled="activeTab !== 'strip' || !ready"
                  @click="onToggleStripLed(led.index)"
                >
                  <span class="strip-bar__glow" />
                  <span class="strip-bar__dot" />
                  <span class="strip-bar__num num">{{ led.index }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <!-- Error State -->
      <div v-if="lighting.loadError" class="lighting-error">
        <p>{{ t('lighting.loadFailed') }}: {{ lighting.loadError }}</p>
        <Button variant="secondary" size="sm" @click="lighting.load(true)">
          {{ t('lighting.reload') }}
        </Button>
      </div>

      <!-- Loading State -->
      <div v-else-if="!ready" class="lighting-grid" role="status" aria-busy="true">
        <span class="sr-only">{{ t('lighting.loading') }}</span>
        <div class="lighting-grid__full skeleton lighting-skeleton lighting-skeleton--effects" />
        <div class="skeleton lighting-skeleton" />
        <div class="skeleton lighting-skeleton" />
      </div>

      <!-- Main Content Panels -->
      <div v-else class="lighting-grid">
        <!-- Effects (the main choice) -->
        <Card :title="t('lighting.effectsTitle')" class="lighting-grid__full">
          <fieldset class="card-inner" :disabled="tuneLocked">
            <p class="card-desc">{{ powered ? t('lighting.effectsDesc') : t('lighting.powerOffHint') }}</p>
            <div class="effect-grid">
              <button
                v-for="index in modeCount"
                :key="index - 1"
                type="button"
                class="effect-btn"
                :class="{ 'effect-btn--active': base.mode === index - 1 }"
                :aria-pressed="base.mode === index - 1"
                @click="onEffect(index - 1)"
              >
                {{ t('lighting.effectN', { n: index }) }}
              </button>
            </div>
          </fieldset>
        </Card>

        <div class="lighting-col">
          <!-- Per-key / per-LED colours -->
          <Card :title="activeTab === 'keys' ? t('lighting.perKeyTitle') : t('lighting.stripCustomTitle')">
            <fieldset class="card-inner" :disabled="locked">
              <p class="card-desc">{{ activeTab === 'keys' ? t('lighting.perKeyDesc') : t('lighting.stripCustomDesc') }}</p>
              <div v-if="activeTab === 'strip'" class="preset-toolbar">
                <Button variant="secondary" size="sm" @click="onStripPreset('all')">{{ t('lighting.selectAll') }}</Button>
                <Button variant="secondary" size="sm" @click="onStripPreset('top')">{{ t('lighting.selectTop') }}</Button>
                <Button variant="secondary" size="sm" @click="onStripPreset('bottom')">{{ t('lighting.selectBottom') }}</Button>
                <Button variant="secondary" size="sm" @click="onStripPreset('left')">{{ t('lighting.selectLeft') }}</Button>
                <Button variant="secondary" size="sm" @click="onStripPreset('right')">{{ t('lighting.selectRight') }}</Button>
                <Button variant="ghost" size="sm" @click="onStripPreset('none')">{{ t('lighting.selectNone') }}</Button>
              </div>
              <div class="status-bar">
                <span class="count-badge" :class="{ 'count-badge--active': selectedCount > 0 }">{{ selectedText }}</span>
                <span v-if="overrideCount > 0" class="active-meta">{{ overrideText }}</span>
              </div>
              <ColorPicker v-model="picked[area]" :disabled="locked" />
              <div class="actions-row">
                <Button variant="primary" :disabled="selectedCount === 0" @click="onApplyColor">
                  {{ activeTab === 'keys' ? t('lighting.applyKeyColor') : t('lighting.applyStripColor') }}
                </Button>
                <Button variant="secondary" :disabled="!selectionHasOverride" @click="onClearSelected">
                  {{ activeTab === 'keys' ? t('lighting.clearKeyColor') : t('lighting.clearStripColor') }}
                </Button>
                <Button variant="danger" :disabled="overrideCount === 0" @click="confirmClear = true">
                  {{ activeTab === 'keys' ? t('lighting.clearAllKeyColors') : t('lighting.clearAllStripColors') }}
                </Button>
              </div>
              <p v-if="activeTab === 'keys'" class="space-note">{{ t('lighting.spaceNote') }}</p>
            </fieldset>
          </Card>

          <!-- Palette -->
          <Card :title="t('lighting.paletteTitle')">
            <fieldset class="card-inner" :disabled="tuneLocked">
              <p class="card-desc">{{ t('lighting.paletteDesc') }}</p>
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
                    'palette-swatch--editing': editingSlot === index,
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
              <div class="palette-editor">
                <div v-if="base.paletteIndex === 0" class="palette-rainbow-info">
                  <span class="palette-rainbow-info__badge">{{ t('lighting.rainbow') }}</span>
                  <p>{{ t('lighting.rainbowHint') }}</p>
                </div>
                <div v-else class="palette-color-editor">
                  <span class="palette-color-editor__title">{{ t('lighting.editColor', { n: editingSlot }) }}</span>
                  <ColorPicker v-model="editingHex" :disabled="tuneLocked" @commit="onPaletteCommit" />
                </div>
              </div>
            </fieldset>
          </Card>
        </div>

        <div class="lighting-col">
          <!-- Power -->
          <Card :title="t('lighting.powerTitle')">
            <fieldset class="card-inner" :disabled="locked">
              <p class="card-desc">{{ activeTab === 'keys' ? t('lighting.powerKeysDesc') : t('lighting.powerStripDesc') }}</p>
              <Segmented
                v-model="openModel"
                class="seg-fit"
                :options="openOptions"
                :label="t('lighting.powerTitle')"
              />
            </fieldset>
          </Card>

          <!-- Tuning -->
          <Card :title="t('lighting.tuningTitle')">
            <fieldset class="card-inner" :disabled="tuneLocked">
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
              <div class="field-block">
                <div class="field-label-row">
                  <span class="field-label">{{ t('lighting.direction') }}</span>
                </div>
                <Segmented
                  v-model="directionModel"
                  class="seg-fit"
                  :options="directionOptions"
                  :label="t('lighting.direction')"
                />
              </div>
            </fieldset>
          </Card>
        </div>
      </div>
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
.lighting {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

.lighting-toolbar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}

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

.lighting-tabs-row {
  display: flex;
  align-items: center;
}

.lighting-stage {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  width: 100%;
  max-width: 940px;
  margin: 0 auto;
}

/* Edge strip: one group per edge, drawn clockwise from the top-left corner */
.strip-bar {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3) var(--s-4);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  user-select: none;
}

.strip-bar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}

.strip-bar__title {
  font-size: var(--fs-caption);
  font-weight: 600;
  color: var(--fg-2);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.strip-bar__hint {
  font-size: var(--fs-caption);
  color: var(--fg-3);
}

.strip-bar__track {
  display: flex;
  gap: var(--s-3);
}

.strip-bar__group {
  flex-basis: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.strip-bar__side {
  font-size: 10px;
  color: var(--fg-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.strip-bar__leds {
  display: grid;
  gap: 3px;
}

.strip-bar__led {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding: 4px 1px;
  border-radius: var(--r-control);
  background: var(--bg-3);
  border: 1px solid var(--line-1);
  cursor: default;
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}

.strip-bar--interactive .strip-bar__led {
  cursor: pointer;
}

.strip-bar--interactive .strip-bar__led:hover {
  border-color: var(--line-3);
  background: var(--bg-4);
}

.strip-bar__led:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 1px;
}

.strip-bar__led--selected {
  border-color: var(--acc) !important;
  background: var(--acc-soft) !important;
}

.strip-bar__led--custom {
  border-style: dashed;
  border-color: var(--fg-3);
}

.strip-bar__glow {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--led-color);
  opacity: 0.15;
  filter: blur(4px);
  pointer-events: none;
}

.strip-bar__dot {
  position: relative;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--led-color);
  box-shadow: 0 0 6px var(--led-color), inset 0 0 0 1px var(--line-3);
}

.strip-bar__num {
  font-size: 9px;
  color: var(--fg-3);
  line-height: 1;
}

.strip-bar__led--selected .strip-bar__num {
  color: var(--fg-1);
  font-weight: 600;
}

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

.lighting-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-5);
  align-items: start;
}

.lighting-grid__full {
  grid-column: 1 / -1;
}

.lighting-col {
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
  min-width: 0;
}

.lighting-skeleton {
  height: 220px;
  border-radius: var(--r-card);
}

.lighting-skeleton--effects {
  height: 140px;
}

@media (max-width: 900px) {
  .lighting-grid {
    grid-template-columns: 1fr;
  }
}

/* Card inner layout (a fieldset so `disabled` reaches every native control inside) */
.card-inner {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}

.card-inner:disabled {
  opacity: 0.55;
}

/* The fieldset already dims everything; Slider must not dim a second time. */
.card-inner :deep(.sl--disabled) {
  opacity: 1;
}

.seg-fit {
  align-self: flex-start;
}

.card-desc {
  font-size: var(--fs-caption);
  color: var(--fg-3);
  margin: 0;
}

.dlg-body {
  margin: 0;
  color: var(--fg-2);
}

/* Field blocks */
.field-block {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.field-label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.field-label {
  font-size: var(--fs-label);
  font-weight: 500;
  color: var(--fg-2);
}

.field-val {
  font-size: var(--fs-label);
  font-weight: 600;
  color: var(--fg-1);
}

/* Palette Swatches */
.palette-swatches {
  display: flex;
  gap: var(--s-2);
  align-items: center;
  flex-wrap: wrap;
}

.palette-swatch {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: var(--r-control);
  border: none;
  cursor: pointer;
  box-shadow: 0 0 0 1px var(--line-2), inset 0 0 0 1px rgba(255, 255, 255, 0.15);
  transition: transform var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}

.palette-swatch:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 0 0 1px var(--line-3), inset 0 0 0 1px rgba(255, 255, 255, 0.3);
}

.palette-swatch:focus-visible {
  outline: 2px solid var(--fg-1);
  outline-offset: 3px;
}

.palette-swatch:disabled {
  cursor: not-allowed;
}

.palette-swatch--active {
  box-shadow: 0 0 0 2px var(--acc), 0 0 12px var(--acc-soft) !important;
  transform: translateY(-1px);
}

.palette-swatch--editing:not(.palette-swatch--active) {
  box-shadow: 0 0 0 2px var(--line-3), inset 0 0 0 1px rgba(255, 255, 255, 0.2);
}

.palette-swatch--rainbow {
  background: linear-gradient(135deg, #ff0055 0%, #ff5500 16%, #ffcc00 33%, #00cc66 50%, #0099ff 67%, #6600cc 83%, #cc0099 100%);
}

.palette-swatch__label {
  font-size: 11px;
  font-weight: 700;
  color: var(--fg-1);
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  letter-spacing: 0.05em;
}

.palette-swatch__num {
  font-size: 11px;
  font-weight: 700;
  color: var(--fg-1);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
}

/* Light swatches (yellow, cyan, white): dark number, no halo */
.palette-swatch--dark-ink .palette-swatch__num {
  color: var(--bg-0);
  text-shadow: none;
}

.palette-editor {
  padding-top: var(--s-3);
  border-top: 1px solid var(--line-1);
}

.palette-rainbow-info {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  background: var(--bg-3);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
}

.palette-rainbow-info__badge {
  font-size: 11px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: var(--r-control);
  background: linear-gradient(135deg, #ff0055, #0099ff);
  color: var(--fg-1);
  letter-spacing: 0.05em;
}

.palette-rainbow-info p {
  font-size: var(--fs-caption);
  color: var(--fg-2);
  margin: 0;
}

.palette-color-editor {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.palette-color-editor__title {
  font-size: var(--fs-label);
  font-weight: 600;
  color: var(--fg-2);
}

/* Status bar & Actions */
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  flex-wrap: wrap;
}

.count-badge {
  font-size: var(--fs-label);
  padding: 4px 8px;
  border-radius: var(--r-control);
  background: var(--bg-3);
  color: var(--fg-3);
  border: 1px solid var(--line-1);
}

.count-badge--active {
  background: var(--acc-soft);
  color: var(--acc);
  border-color: var(--acc-line);
  font-weight: 600;
}

.active-meta {
  font-size: var(--fs-caption);
  color: var(--fg-3);
}

.actions-row {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  flex-wrap: wrap;
  padding-top: var(--s-2);
}

.space-note {
  font-size: var(--fs-caption);
  color: var(--fg-4);
  margin: 0;
  font-style: italic;
}

.preset-toolbar {
  display: flex;
  align-items: center;
  gap: var(--s-1);
  flex-wrap: wrap;
}

/* Effect Grid */
.effect-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
  gap: var(--s-2);
}

.effect-btn {
  padding: var(--s-2) var(--s-3);
  background: var(--bg-3);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  color: var(--fg-2);
  cursor: pointer;
  text-align: left;
  font-size: var(--fs-body);
  font-weight: 500;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}

.effect-btn:hover:not(:disabled) {
  background: var(--bg-4);
  border-color: var(--line-3);
  color: var(--fg-1);
}

.effect-btn:focus-visible {
  outline: 2px solid var(--acc);
  outline-offset: 1px;
}

.effect-btn:disabled {
  cursor: not-allowed;
}

.effect-btn--active {
  background: var(--acc-soft) !important;
  border-color: var(--acc) !important;
  color: var(--acc) !important;
}
</style>
