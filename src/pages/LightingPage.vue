<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import Segmented from '../components/ui/Segmented.vue';
import Slider from '../components/ui/Slider.vue';
import ColorPicker from '../components/ui/ColorPicker.vue';
import Tabs from '../components/ui/Tabs.vue';
import Switch from '../components/ui/Switch.vue';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { hexToRgb, rgbToHex, useLightingStore } from '../stores/lighting';
import type { PhysicalKey } from '../protocol';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const lighting = useLightingStore();

type TabId = 'keys' | 'strip';
const activeTab = ref<TabId>('keys');

const tabItems = computed(() => [
  { id: 'keys', label: t('lighting.tabKeys') },
  { id: 'strip', label: t('lighting.tabStrip') },
]);

// Strip LED selection (0..37)
const stripSelection = ref<Set<number>>(new Set());

// Strip side layout for quick selection
const STRIP_SIDES = {
  top: [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 0, 1],
  right: [2, 3, 4, 5, 6],
  bottom: [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7],
  left: [26, 25, 24, 23, 22, 21],
};

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

// ------------------------------------------------------------------ Color mapping
function keyColor(key: PhysicalKey): string | undefined {
  if (lighting.livePreview && lighting.liveColors[key.id]) {
    return lighting.liveColors[key.id];
  }
  const custom = lighting.keyCustomColors[key.id];
  if (custom?.custom) {
    return custom.colorHex;
  }
  if (!lighting.area0Base.open || lighting.area0Base.openMode === 0) {
    return undefined;
  }
  if (lighting.area0Base.paletteIndex > 0) {
    const pal = lighting.area0Palette[lighting.area0Base.paletteIndex];
    if (pal) return rgbToHex(pal);
  }
  return undefined;
}

const stripColors = computed<string[]>(() => {
  return Array.from({ length: 38 }, (_, index) => {
    if (lighting.livePreview && lighting.liveStripColors[index]) {
      return lighting.liveStripColors[index];
    }
    const custom = lighting.stripCustomColors[index];
    if (custom?.custom) {
      return custom.colorHex;
    }
    if (!lighting.area1Base.open || lighting.area1Base.openMode === 0) {
      return '#121417';
    }
    if (lighting.area1Base.paletteIndex > 0) {
      const pal = lighting.area1Palette[lighting.area1Base.paletteIndex];
      if (pal) return rgbToHex(pal);
    }
    return '#3fe0c5';
  });
});

const stripLeds = computed(() => {
  return Array.from({ length: 38 }, (_, index) => {
    const color = stripColors.value[index] || '#1a1d22';
    const isSel = stripSelection.value.has(index);
    return { index, color, isSel };
  });
});

function onToggleStripLed(index: number) {
  const next = new Set(stripSelection.value);
  if (next.has(index)) next.delete(index);
  else next.add(index);
  stripSelection.value = next;
}

function onStripPreset(preset: 'all' | 'none' | 'top' | 'bottom' | 'left' | 'right') {
  if (preset === 'all') {
    stripSelection.value = new Set(Array.from({ length: 38 }, (_, i) => i));
  } else if (preset === 'none') {
    stripSelection.value = new Set();
  } else {
    stripSelection.value = new Set(STRIP_SIDES[preset]);
  }
}

// ------------------------------------------------------------------ Area 0 options & edits
const area0OpenMode = computed<number>({
  get: () => (lighting.area0Base.open ? lighting.area0Base.openMode || 1 : 0),
  set: (val: number | null) => {
    const openMode = val ?? 0;
    lighting.applyBase(0, { openMode, open: openMode !== 0 }, t('lighting.syncBase', { area: t('lighting.tabKeys') }));
  },
});

const keyOpenOptions = computed(() => [
  { value: 0, label: t('lighting.modeOff') },
  { value: 1, label: t('lighting.modeBottom') },
  { value: 2, label: t('lighting.modeTop') },
  { value: 3, label: t('lighting.modeBoth') },
]);

const area0DirModel = computed<number>({
  get: () => lighting.area0Base.direction,
  set: (val: number | null) => {
    lighting.applyBase(0, { direction: val ?? 0 }, t('lighting.syncBase', { area: t('lighting.tabKeys') }));
  },
});

const directionOptions = computed(() => [
  { value: 0, label: `→ ${t('lighting.directionForward')}` },
  { value: 1, label: `← ${t('lighting.directionBackward')}` },
]);

// Area 0 Palette editing
const area0EditingSlot = ref<number>(lighting.area0Base.paletteIndex > 0 ? lighting.area0Base.paletteIndex : 1);
watch(() => lighting.area0Base.paletteIndex, (idx) => {
  if (idx > 0) area0EditingSlot.value = idx;
});

const area0EditingHex = computed<string>({
  get: () => {
    const entry = lighting.area0Palette[area0EditingSlot.value];
    return entry ? rgbToHex(entry) : '#ffffff';
  },
  set: (hex: string) => {
    lighting.applyPaletteColor(0, area0EditingSlot.value, hexToRgb(hex), t('lighting.syncPalette', { area: t('lighting.tabKeys') }), 'color');
  },
});

function selectArea0Swatch(index: number) {
  lighting.applyBase(0, { paletteIndex: index }, t('lighting.syncBase', { area: t('lighting.tabKeys') }));
  if (index > 0) area0EditingSlot.value = index;
}

// Per-key custom colors
const perKeyPickedHex = ref('#3fe0c5');

function onApplyKeyColor() {
  if (sel.count > 0) {
    lighting.applyKeyColors(sel.ids, hexToRgb(perKeyPickedHex.value), t('lighting.syncMatrix', { area: t('lighting.tabKeys') }));
  }
}

function onClearKeyColor() {
  lighting.clearKeyColors(sel.ids, t('lighting.syncMatrix', { area: t('lighting.tabKeys') }));
}

function onClearAllKeyColors() {
  lighting.clearAllKeyColors(t('lighting.syncMatrix', { area: t('lighting.tabKeys') }));
}

// ------------------------------------------------------------------ Area 1 options & edits
const area1OpenMode = computed<number>({
  get: () => (lighting.area1Base.open ? lighting.area1Base.openMode || 1 : 0),
  set: (val: number | null) => {
    const openMode = val ?? 0;
    lighting.applyBase(1, { openMode, open: openMode !== 0 }, t('lighting.syncBase', { area: t('lighting.tabStrip') }));
  },
});

const stripOpenOptions = computed(() => [
  { value: 0, label: t('lighting.modeOff') },
  { value: 1, label: t('lighting.modeOn') },
]);

const area1DirModel = computed<number>({
  get: () => lighting.area1Base.direction,
  set: (val: number | null) => {
    lighting.applyBase(1, { direction: val ?? 0 }, t('lighting.syncBase', { area: t('lighting.tabStrip') }));
  },
});

// Area 1 Palette editing
const area1EditingSlot = ref<number>(lighting.area1Base.paletteIndex > 0 ? lighting.area1Base.paletteIndex : 1);
watch(() => lighting.area1Base.paletteIndex, (idx) => {
  if (idx > 0) area1EditingSlot.value = idx;
});

const area1EditingHex = computed<string>({
  get: () => {
    const entry = lighting.area1Palette[area1EditingSlot.value];
    return entry ? rgbToHex(entry) : '#ffffff';
  },
  set: (hex: string) => {
    lighting.applyPaletteColor(1, area1EditingSlot.value, hexToRgb(hex), t('lighting.syncPalette', { area: t('lighting.tabStrip') }), 'color');
  },
});

function selectArea1Swatch(index: number) {
  lighting.applyBase(1, { paletteIndex: index }, t('lighting.syncBase', { area: t('lighting.tabStrip') }));
  if (index > 0) area1EditingSlot.value = index;
}

// Strip custom colors
const stripPickedHex = ref('#3fe0c5');

function onApplyStripColor() {
  if (stripSelection.value.size > 0) {
    lighting.applyStripColors([...stripSelection.value], hexToRgb(stripPickedHex.value), t('lighting.syncMatrix', { area: t('lighting.tabStrip') }));
  }
}

function onClearStripColor() {
  lighting.clearStripColors([...stripSelection.value], t('lighting.syncMatrix', { area: t('lighting.tabStrip') }));
}

function onClearAllStripColors() {
  lighting.clearAllStripColors(t('lighting.syncMatrix', { area: t('lighting.tabStrip') }));
}

const activeKeyCount = computed(() => {
  return Object.values(lighting.keyCustomColors).filter((v) => v.custom).length;
});

const activeStripCount = computed(() => {
  return lighting.stripCustomColors.filter((v) => v.custom).length;
});
</script>

<template>
  <PageLayout :title="t('page.lighting')" keyboard>
    <!-- Toolbar: Live Preview Toggle -->
    <template #toolbar>
      <div class="lighting-toolbar">
        <span class="lighting-live-badge" :class="{ 'lighting-live-badge--live': lighting.livePreview }">
          <span class="lighting-live-badge__dot" />
          {{ lighting.livePreview ? t('lighting.liveStatus') : t('lighting.pausedStatus') }}
        </span>
        <Switch
          v-model="lighting.livePreview"
          :label="t('lighting.livePreview')"
        />
      </div>
    </template>

    <!-- Keyboard and Strip View -->
    <template #keyboard>
      <div class="lighting-stage">
        <KeyboardView
          :keys="device.keys"
          :legend="device.legend"
          :color="keyColor"
          selectable
        />

        <!-- Perimeter Strip Bar under Keyboard -->
        <div class="strip-bar" :class="{ 'strip-bar--interactive': activeTab === 'strip' }">
          <div class="strip-bar__header">
            <span class="strip-bar__title">{{ t('lighting.stripTitle') }}</span>
            <span v-if="activeTab === 'strip'" class="strip-bar__hint">{{ t('lighting.stripSubtitle') }}</span>
          </div>
          <div class="strip-bar__track">
            <button
              v-for="led in stripLeds"
              :key="led.index"
              type="button"
              class="strip-bar__led"
              :class="{ 'strip-bar__led--selected': led.isSel }"
              :style="{ '--led-color': led.color }"
              :title="`LED ${led.index} · ${led.color}`"
              :disabled="activeTab !== 'strip'"
              @click="onToggleStripLed(led.index)"
            >
              <span class="strip-bar__glow" />
              <span class="strip-bar__dot" />
              <span class="strip-bar__num">{{ led.index }}</span>
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Keyboard Aside: Status Chips -->
    <template #keyboard-aside>
      <div class="lighting-aside">
        <div class="lighting-chip">
          <span class="lighting-chip__label">{{ t('lighting.effectsTitle') }}</span>
          <span class="lighting-chip__val">
            L{{ (activeTab === 'keys' ? lighting.area0Base.mode : lighting.area1Base.mode) + 1 }}
          </span>
        </div>
        <div class="lighting-chip">
          <span class="lighting-chip__label">{{ t('lighting.brightness') }}</span>
          <span class="lighting-chip__val">
            {{ activeTab === 'keys' ? lighting.area0Base.brightness : lighting.area1Base.brightness }}%
          </span>
        </div>
        <div class="lighting-chip">
          <span class="lighting-chip__label">{{ t('lighting.speed') }}</span>
          <span class="lighting-chip__val">
            {{ activeTab === 'keys' ? lighting.area0Base.speed : lighting.area1Base.speed }}%
          </span>
        </div>
      </div>
    </template>

    <!-- Error State -->
    <div v-if="lighting.loadError" class="lighting-error">
      <p>{{ t('lighting.loadFailed') }}: {{ lighting.loadError }}</p>
      <Button variant="secondary" size="sm" @click="lighting.load(true)">
        {{ t('lighting.reload') }}
      </Button>
    </div>

    <!-- Main Content Panels -->
    <div v-else class="lighting-content">
      <div class="lighting-tabs-row">
        <Tabs
          v-model="activeTab"
          :items="tabItems"
          :label="t('lighting.tabsLabel')"
        />
      </div>

      <!-- Area 0: Keys -->
      <div v-if="activeTab === 'keys'" class="lighting-grid">
        <!-- Power Card -->
        <Card :title="t('lighting.powerTitle')">
          <div class="card-inner">
            <p class="card-desc">{{ t('lighting.powerKeysDesc') }}</p>
            <Segmented
              v-model="area0OpenMode"
              :options="keyOpenOptions"
              :label="t('lighting.powerTitle')"
            />
          </div>
        </Card>

        <!-- Tuning Card -->
        <Card :title="t('lighting.tuningTitle')">
          <div class="card-inner">
            <div class="field-block">
              <div class="field-label-row">
                <span class="field-label">{{ t('lighting.brightness') }}</span>
                <span class="field-val">{{ lighting.area0Base.brightness }}%</span>
              </div>
              <Slider
                :model-value="lighting.area0Base.brightness"
                :min="0"
                :max="100"
                :step="1"
                :label="t('lighting.brightness')"
                @update:model-value="lighting.area0Base.brightness = $event"
                @commit="lighting.applyBase(0, { brightness: $event }, t('lighting.syncBase', { area: t('lighting.tabKeys') }), 'brightness')"
              />
            </div>
            <div class="field-block">
              <div class="field-label-row">
                <span class="field-label">{{ t('lighting.speed') }}</span>
                <span class="field-val">{{ lighting.area0Base.speed }}%</span>
              </div>
              <Slider
                :model-value="lighting.area0Base.speed"
                :min="0"
                :max="100"
                :step="1"
                :label="t('lighting.speed')"
                @update:model-value="lighting.area0Base.speed = $event"
                @commit="lighting.applyBase(0, { speed: $event }, t('lighting.syncBase', { area: t('lighting.tabKeys') }), 'speed')"
              />
            </div>
            <div class="field-block">
              <div class="field-label-row">
                <span class="field-label">{{ t('lighting.direction') }}</span>
              </div>
              <Segmented
                v-model="area0DirModel"
                :options="directionOptions"
                :label="t('lighting.direction')"
              />
            </div>
          </div>
        </Card>

        <!-- Palette Card -->
        <Card :title="t('lighting.paletteTitle')">
          <div class="card-inner">
            <p class="card-desc">{{ t('lighting.paletteDesc') }}</p>
            <div class="palette-swatches">
              <button
                type="button"
                class="palette-swatch palette-swatch--rainbow"
                :class="{ 'palette-swatch--active': lighting.area0Base.paletteIndex === 0 }"
                :title="t('lighting.rainbowSlot')"
                @click="selectArea0Swatch(0)"
              >
                <span class="palette-swatch__label">RGB</span>
              </button>
              <button
                v-for="index in 7"
                :key="index"
                type="button"
                class="palette-swatch"
                :class="{
                  'palette-swatch--active': lighting.area0Base.paletteIndex === index,
                  'palette-swatch--editing': area0EditingSlot === index,
                }"
                :style="{
                  backgroundColor: lighting.area0Palette[index] ? rgbToHex(lighting.area0Palette[index]) : '#000000',
                }"
                :title="t('lighting.paletteSlot', { n: index })"
                @click="selectArea0Swatch(index)"
              >
                <span class="palette-swatch__num">{{ index }}</span>
              </button>
            </div>
            <div class="palette-editor">
              <div v-if="lighting.area0Base.paletteIndex === 0" class="palette-rainbow-info">
                <span class="palette-rainbow-info__badge">{{ t('lighting.rainbow') }}</span>
                <p>{{ t('lighting.rainbowHint') }}</p>
              </div>
              <div v-else class="palette-color-editor">
                <span class="palette-color-editor__title">
                  {{ t('lighting.editColor', { n: area0EditingSlot }) }}
                </span>
                <ColorPicker
                  v-model="area0EditingHex"
                  @commit="lighting.applyPaletteColor(0, area0EditingSlot, hexToRgb($event), t('lighting.syncPalette', { area: t('lighting.tabKeys') }), 'color')"
                />
              </div>
            </div>
          </div>
        </Card>

        <!-- Per-key Card -->
        <Card :title="t('lighting.perKeyTitle')">
          <div class="card-inner">
            <p class="card-desc">{{ t('lighting.perKeyDesc') }}</p>
            <div class="status-bar">
              <span class="count-badge" :class="{ 'count-badge--active': sel.count > 0 }">
                {{ sel.count > 0 ? t('lighting.selectedKeys', { count: sel.count }) : t('lighting.noKeysSelected') }}
              </span>
              <span v-if="activeKeyCount > 0" class="active-meta">
                {{ t('lighting.customActive', { count: activeKeyCount }) }}
              </span>
            </div>
            <ColorPicker v-model="perKeyPickedHex" />
            <div class="actions-row">
              <Button variant="primary" :disabled="sel.count === 0" @click="onApplyKeyColor">
                {{ t('lighting.applyKeyColor') }}
              </Button>
              <Button variant="secondary" :disabled="sel.count === 0" @click="onClearKeyColor">
                {{ t('lighting.clearKeyColor') }}
              </Button>
              <Button variant="ghost" :disabled="activeKeyCount === 0" @click="onClearAllKeyColors">
                {{ t('lighting.clearAllKeyColors') }}
              </Button>
            </div>
            <p class="space-note">{{ t('lighting.spaceNote') }}</p>
          </div>
        </Card>

        <!-- Effect Card (Full Width) -->
        <div class="lighting-grid__full">
          <Card :title="t('lighting.effectsTitle')">
            <div class="card-inner">
              <p class="card-desc">{{ t('lighting.effectsDesc') }}</p>
              <div class="effect-grid">
                <button
                  v-for="index in lighting.area0ModeCount"
                  :key="index - 1"
                  type="button"
                  class="effect-btn"
                  :class="{ 'effect-btn--active': lighting.area0Base.mode === index - 1 }"
                  @click="lighting.applyBase(0, { mode: index - 1 }, t('lighting.syncBase', { area: t('lighting.tabKeys') }))"
                >
                  <span class="effect-btn__code">L{{ index }}</span>
                  <span class="effect-btn__name">{{ t('lighting.effectN', { n: index }) }}</span>
                </button>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <!-- Area 1: LED Strip -->
      <div v-else class="lighting-grid">
        <!-- Power Card -->
        <Card :title="t('lighting.powerTitle')">
          <div class="card-inner">
            <p class="card-desc">{{ t('lighting.powerStripDesc') }}</p>
            <Segmented
              v-model="area1OpenMode"
              :options="stripOpenOptions"
              :label="t('lighting.powerTitle')"
            />
          </div>
        </Card>

        <!-- Tuning Card -->
        <Card :title="t('lighting.tuningTitle')">
          <div class="card-inner">
            <div class="field-block">
              <div class="field-label-row">
                <span class="field-label">{{ t('lighting.brightness') }}</span>
                <span class="field-val">{{ lighting.area1Base.brightness }}%</span>
              </div>
              <Slider
                :model-value="lighting.area1Base.brightness"
                :min="0"
                :max="100"
                :step="1"
                :label="t('lighting.brightness')"
                @update:model-value="lighting.area1Base.brightness = $event"
                @commit="lighting.applyBase(1, { brightness: $event }, t('lighting.syncBase', { area: t('lighting.tabStrip') }), 'brightness')"
              />
            </div>
            <div class="field-block">
              <div class="field-label-row">
                <span class="field-label">{{ t('lighting.speed') }}</span>
                <span class="field-val">{{ lighting.area1Base.speed }}%</span>
              </div>
              <Slider
                :model-value="lighting.area1Base.speed"
                :min="0"
                :max="100"
                :step="1"
                :label="t('lighting.speed')"
                @update:model-value="lighting.area1Base.speed = $event"
                @commit="lighting.applyBase(1, { speed: $event }, t('lighting.syncBase', { area: t('lighting.tabStrip') }), 'speed')"
              />
            </div>
            <div class="field-block">
              <div class="field-label-row">
                <span class="field-label">{{ t('lighting.direction') }}</span>
              </div>
              <Segmented
                v-model="area1DirModel"
                :options="directionOptions"
                :label="t('lighting.direction')"
              />
            </div>
          </div>
        </Card>

        <!-- Palette Card -->
        <Card :title="t('lighting.paletteTitle')">
          <div class="card-inner">
            <p class="card-desc">{{ t('lighting.paletteDesc') }}</p>
            <div class="palette-swatches">
              <button
                type="button"
                class="palette-swatch palette-swatch--rainbow"
                :class="{ 'palette-swatch--active': lighting.area1Base.paletteIndex === 0 }"
                :title="t('lighting.rainbowSlot')"
                @click="selectArea1Swatch(0)"
              >
                <span class="palette-swatch__label">RGB</span>
              </button>
              <button
                v-for="index in 7"
                :key="index"
                type="button"
                class="palette-swatch"
                :class="{
                  'palette-swatch--active': lighting.area1Base.paletteIndex === index,
                  'palette-swatch--editing': area1EditingSlot === index,
                }"
                :style="{
                  backgroundColor: lighting.area1Palette[index] ? rgbToHex(lighting.area1Palette[index]) : '#000000',
                }"
                :title="t('lighting.paletteSlot', { n: index })"
                @click="selectArea1Swatch(index)"
              >
                <span class="palette-swatch__num">{{ index }}</span>
              </button>
            </div>
            <div class="palette-editor">
              <div v-if="lighting.area1Base.paletteIndex === 0" class="palette-rainbow-info">
                <span class="palette-rainbow-info__badge">{{ t('lighting.rainbow') }}</span>
                <p>{{ t('lighting.rainbowHint') }}</p>
              </div>
              <div v-else class="palette-color-editor">
                <span class="palette-color-editor__title">
                  {{ t('lighting.editColor', { n: area1EditingSlot }) }}
                </span>
                <ColorPicker
                  v-model="area1EditingHex"
                  @commit="lighting.applyPaletteColor(1, area1EditingSlot, hexToRgb($event), t('lighting.syncPalette', { area: t('lighting.tabStrip') }), 'color')"
                />
              </div>
            </div>
          </div>
        </Card>

        <!-- Strip Custom Card -->
        <Card :title="t('lighting.stripCustomTitle')">
          <div class="card-inner">
            <p class="card-desc">{{ t('lighting.stripCustomDesc') }}</p>
            <div class="preset-toolbar">
              <Button variant="secondary" size="sm" @click="onStripPreset('all')">
                {{ t('lighting.selectAll') }}
              </Button>
              <Button variant="secondary" size="sm" @click="onStripPreset('top')">
                {{ t('lighting.selectTop') }}
              </Button>
              <Button variant="secondary" size="sm" @click="onStripPreset('bottom')">
                {{ t('lighting.selectBottom') }}
              </Button>
              <Button variant="secondary" size="sm" @click="onStripPreset('left')">
                {{ t('lighting.selectLeft') }}
              </Button>
              <Button variant="secondary" size="sm" @click="onStripPreset('right')">
                {{ t('lighting.selectRight') }}
              </Button>
              <Button variant="ghost" size="sm" @click="onStripPreset('none')">
                {{ t('lighting.selectNone') }}
              </Button>
            </div>
            <div class="status-bar">
              <span class="count-badge" :class="{ 'count-badge--active': stripSelection.size > 0 }">
                {{ stripSelection.size > 0 ? t('lighting.selectedLeds', { count: stripSelection.size }) : t('lighting.noLedsSelected') }}
              </span>
              <span v-if="activeStripCount > 0" class="active-meta">
                {{ t('lighting.stripCustomActive', { count: activeStripCount }) }}
              </span>
            </div>
            <ColorPicker v-model="stripPickedHex" />
            <div class="actions-row">
              <Button variant="primary" :disabled="stripSelection.size === 0" @click="onApplyStripColor">
                {{ t('lighting.applyStripColor') }}
              </Button>
              <Button variant="secondary" :disabled="stripSelection.size === 0" @click="onClearStripColor">
                {{ t('lighting.clearStripColor') }}
              </Button>
              <Button variant="ghost" :disabled="activeStripCount === 0" @click="onClearAllStripColors">
                {{ t('lighting.clearAllStripColors') }}
              </Button>
            </div>
          </div>
        </Card>

        <!-- Effect Card (Full Width) -->
        <div class="lighting-grid__full">
          <Card :title="t('lighting.effectsTitle')">
            <div class="card-inner">
              <p class="card-desc">{{ t('lighting.effectsDesc') }}</p>
              <div class="effect-grid">
                <button
                  v-for="index in lighting.area1ModeCount"
                  :key="index - 1"
                  type="button"
                  class="effect-btn"
                  :class="{ 'effect-btn--active': lighting.area1Base.mode === index - 1 }"
                  @click="lighting.applyBase(1, { mode: index - 1 }, t('lighting.syncBase', { area: t('lighting.tabStrip') }))"
                >
                  <span class="effect-btn__code">L{{ index }}</span>
                  <span class="effect-btn__name">{{ t('lighting.effectN', { n: index }) }}</span>
                </button>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  </PageLayout>
</template>

<style scoped>
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
  border-color: rgba(74, 222, 128, 0.3);
}

.lighting-live-badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
}

.lighting-stage {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  width: 100%;
}

/* Strip Bar styling */
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
  display: grid;
  grid-template-columns: repeat(38, minmax(0, 1fr));
  gap: 3px;
  align-items: center;
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
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}

.strip-bar--interactive .strip-bar__led {
  cursor: pointer;
}

.strip-bar--interactive .strip-bar__led:hover {
  border-color: var(--line-3);
  background: var(--bg-4);
}

.strip-bar__led--selected {
  border-color: var(--acc) !important;
  background: var(--acc-soft) !important;
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
  box-shadow: 0 0 6px var(--led-color), inset 0 0 0 1px rgba(255, 255, 255, 0.2);
}

.strip-bar__num {
  font-size: 9px;
  font-family: monospace;
  color: var(--fg-3);
  line-height: 1;
}

.strip-bar__led--selected .strip-bar__num {
  color: var(--fg-1);
  font-weight: 600;
}

/* Aside Chips */
.lighting-aside {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}

.lighting-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--s-2) var(--s-3);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  min-width: 110px;
}

.lighting-chip__label {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--fg-3);
  letter-spacing: 0.05em;
}

.lighting-chip__val {
  font-size: var(--fs-body);
  font-weight: 600;
  color: var(--fg-1);
  font-family: monospace;
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

.lighting-content {
  display: flex;
  flex-direction: column;
  gap: var(--s-5);
}

.lighting-tabs-row {
  display: flex;
  align-items: center;
}

.lighting-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--s-5);
}

.lighting-grid__full {
  grid-column: 1 / -1;
}

@media (max-width: 900px) {
  .lighting-grid {
    grid-template-columns: 1fr;
  }
}

/* Card inner layout */
.card-inner {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}

.card-desc {
  font-size: var(--fs-caption);
  color: var(--fg-3);
  margin: 0;
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
  font-family: monospace;
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

.palette-swatch:hover {
  transform: translateY(-1px);
  box-shadow: 0 0 0 1px var(--line-3), inset 0 0 0 1px rgba(255, 255, 255, 0.3);
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
  color: #ffffff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  letter-spacing: 0.05em;
}

.palette-swatch__num {
  font-size: 11px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
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
  color: #fff;
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
  font-size: 11px;
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
  grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
  gap: var(--s-2);
}

.effect-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: var(--s-2) var(--s-3);
  background: var(--bg-3);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  color: var(--fg-2);
  cursor: pointer;
  text-align: left;
  transition: all var(--t-fast) var(--ease);
}

.effect-btn:hover {
  background: var(--bg-4);
  border-color: var(--line-3);
  color: var(--fg-1);
}

.effect-btn--active {
  background: var(--acc-soft) !important;
  border-color: var(--acc) !important;
  color: var(--acc) !important;
}

.effect-btn__code {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.05em;
  opacity: 0.8;
}

.effect-btn__name {
  font-size: var(--fs-body);
  font-weight: 500;
}
</style>
