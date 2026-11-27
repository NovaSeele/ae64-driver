<script setup lang="ts">
// Đèn — a workbench like Hành trình: toolbar → keyboard (the edge strip is a ring of LEDs on its frame) → selection bar →
// one editor dock. Every control calls the same lighting-store action as before; the colour field, the quick colours and
// the strip's Esc only change what the page shows, never the keyboard.
import { IconBorderOuter, IconChevronDown, IconKeyboard } from '@tabler/icons-vue';
import { computed, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from 'vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import SelectionBar from '../components/keyboard/SelectionBar.vue';
import type { LegendItem } from '../components/keyboard/SelectionBar.vue';
import { GLOW_BADGE_TONE } from '../components/keyboard/Keycap.vue';
import { LiveLedPainter } from '../components/keyboard/liveLedPainter';
import { effectIcon } from '../components/lighting/effectIcons';
import { PreviewControl } from '../components/lighting/previewControl';
import { TileDriver } from '../components/lighting/tileDriver';
import type { TileParams } from '../components/lighting/tileDriver';
import { readFxView, writeFxView } from '../components/lighting/fxView';
import type { FxView } from '../components/lighting/fxView';
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
import { LED_MATRIX_TOTAL, hexToRgb, rgbToHex, useLightingStore } from '../stores/lighting';
import type { LiveLedFrame } from '../stores/lighting';
import { inkFor } from '../colorInk';
import { bandGradient, ledGlow } from '../ledGlow';
import type { LedGlow, RingSide } from '../ledGlow';
import { LED_MATRIX_COLS, LED_STRIP_COUNT, STRIP_ORDER, STRIP_SIDES } from '../protocol';
import type { PhysicalKey } from '../protocol';
import { stripRing } from '../protocol/ledLayout';
import { effectHint, effectKnown, effectName } from '../data/ledEffects';
import { PREVIEW_FLOOR, TYPING_KEYS, frame as ledFrame, isReactive, rgb as ledRgb, stillAt, typingPresses } from '../data/ledPatterns';
import type { Rgb } from '../data/ledPatterns';
import { locale } from '../i18n/locale';
import { resolvedTheme } from '../theme';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const sync = useSyncStore();
const lighting = useLightingStore();

const isGeneric = computed(() => device.support === 'generic');
const boardForEffects = computed(() => (isGeneric.value ? undefined : device.info?.boardIdHex));

type TabId = 'keys' | 'strip';
const activeTab = ref<TabId>('keys');
/** Firmware lighting area of the active tab: 0 = keys, 1 = edge strip. */
const area = computed<0 | 1>(() => (activeTab.value === 'keys' ? 0 : 1));

const hasArea0 = computed(() => (!isGeneric.value ? true : lighting.area0Available || lighting.area0Unsupported));
const hasArea1 = computed(() => (!isGeneric.value ? true : lighting.area1Available || lighting.area1Unsupported));

const tabItems = computed(() => {
  const all = [
    { id: 'keys' as const, title: t('lighting.tabKeys'), sub: t('lighting.tabKeysSub'), icon: IconKeyboard },
    { id: 'strip' as const, title: t('lighting.tabStrip'), sub: t('lighting.tabStripSub'), icon: IconBorderOuter },
  ];
  if (!isGeneric.value) return all;
  return all.filter((it) => (it.id === 'keys' ? hasArea0.value : hasArea1.value));
});

/** ←/→ move and activate, Home/End jump (the tab pair is a plain tablist). */
function onTabKey(e: KeyboardEvent) {
  const items = tabItems.value;
  if (items.length <= 1) return;
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

const activeAreaUnsupported = computed(() => (isGeneric.value
  ? (area.value === 0 ? lighting.area0Unsupported : lighting.area1Unsupported)
  : false));
const activeAreaAvailable = computed(() => (!isGeneric.value
  ? true
  : (area.value === 0 ? lighting.area0Available : lighting.area1Available)));
const showKeyboard = computed(() => !isGeneric.value
  || (hasArea0.value && !lighting.area0Unsupported && lighting.area0Shape?.rows !== 1));

/** Generic 1D strip areas (rows === 1) shown as one text line with LED count from `02 08 00` (DESIGN MKB §10.2–§10.3). */
const genericStripLines = computed<{ id: number; cols: number }[]>(() => {
  if (!isGeneric.value || !ready.value) return [];
  const out: { id: number; cols: number }[] = [];
  if (lighting.area0Available && lighting.area0Shape?.rows === 1) out.push({ id: 0, cols: lighting.area0Shape.cols });
  if (lighting.area1Available && lighting.area1Shape?.rows === 1) out.push({ id: 1, cols: lighting.area1Shape.cols });
  return out;
});

watch([isGeneric, ready, hasArea0, hasArea1], ([generic, isReady, a0, a1]) => {
  if (!generic || !isReady) return;
  if (activeTab.value === 'keys' && !a0 && a1) activeTab.value = 'strip';
  else if (activeTab.value === 'strip' && !a1 && a0) activeTab.value = 'keys';
}, { immediate: true });

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
  if (!isGeneric.value) lighting.startLivePolling();
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
  window.removeEventListener('keydown', onPreviewEsc, true);
  document.removeEventListener('visibilitychange', onVisibility);
  previewCtl.dispose();
  stopPainting();
  tiles.destroy();
  gridObserver?.disconnect();
  gridResize?.disconnect();
  motionMql?.removeEventListener?.('change', onMotion);
});

// ------------------------------------------------------------------ Live colours (LED60)
// While live preview shows keyboard frames, the keys, ring dots and bands are painted outside Vue (liveLedPainter.ts): one
// rAF loop paints the newest frame (frames in between are skipped, never queued), only what changed. Vue then draws the
// keys unlit and no settings band; everything hand-written is taken off when live preview stops showing frames (off, a
// read error, the tab hidden, leaving the page, another profile loading), and the colours from the settings show again.
const tabVisible = ref(typeof document === 'undefined' || !document.hidden);
function onVisibility() { tabVisible.value = !document.hidden; }
document.addEventListener('visibilitychange', onVisibility);
const livePaint = computed(() => !isGeneric.value && ready.value && lighting.livePreview && !lighting.liveError && lighting.liveHasFrame && tabVisible.value);

// "Xem thử" (FXP §7): while a tile is rested on or focused, the previewed area of the big keyboard plays that effect from
// the pattern module (src/data/ledPatterns.ts) instead of its live or saved colours. Display only: the live read loop keeps
// running unchanged (its frames are just not painted for the previewed area), and nothing is written.
interface Preview { area: 0 | 1; n: number; known: boolean }
/** The tile shown: a known effect plays on the board; an unknown one only gets the "no preview" cue. */
const preview = ref<Preview | null>(null);
const playing = computed(() => (!isGeneric.value && ready.value && preview.value?.known ? preview.value : null));
/** The halves painted outside Vue: everything while live frames show; else only the area being previewed. */
const paintKeys = computed(() => livePaint.value || playing.value?.area === 0);
const paintStrip = computed(() => livePaint.value || playing.value?.area === 1);
const painted = computed(() => paintKeys.value || paintStrip.value);

const reducedMotion = ref(false);
let motionMql: MediaQueryList | null = null;
function onMotion() { reducedMotion.value = !!motionMql?.matches; }
if (typeof matchMedia === 'function') {
  motionMql = matchMedia('(prefers-reduced-motion: reduce)');
  reducedMotion.value = motionMql.matches;
  motionMql.addEventListener?.('change', onMotion);
}

/** The cells the scripted typing of the reactive previews presses (H, E, L, O, A, S, D, K). */
const typingCells = computed(() => TYPING_KEYS.flatMap((name) => {
  const k = device.keys.find((x) => x.name === name);
  return k ? [k.row * LED_MATRIX_COLS + k.col] : [];
}));
/** An area's palette colour, null = the rainbow. */
function areaPal(a: 0 | 1): Rgb | null {
  const b = a === 0 ? lighting.area0Base : lighting.area1Base;
  if (b.paletteIndex === 0) return null;
  const e = (a === 0 ? lighting.area0Palette : lighting.area1Palette)[b.paletteIndex];
  return e ? { r: e.r, g: e.g, b: e.b } : null;
}

/** At most one preview frame per this many ms (30 fps). */
const PREVIEW_FRAME_MS = 1000 / 30;
const previewFrame: LiveLedFrame = { seq: 0, keys: new Uint8Array(LED_MATRIX_TOTAL * 3), strip: new Uint8Array(LED_STRIP_COUNT * 3) };
let previewBuiltAt = -Infinity;
let previewLiveSeq = -1;
let previewOf = '';
/**
 * The preview frame at `sec`: the previewed area from the pattern with its palette, speed, direction and brightness (never
 * under PREVIEW_FLOOR, so the shape still shows at 0–14 %); an LED with its own colour keeps it, as on the keyboard. The
 * other half is the live frame's, when live frames show (else it is not painted).
 */
function buildPreviewFrame(p: Preview, sec: number): void {
  if (livePaint.value) {
    previewFrame.keys.set(lighting.liveFrame.keys);
    previewFrame.strip.set(lighting.liveFrame.strip);
  }
  const b = p.area === 0 ? lighting.area0Base : lighting.area1Base;
  const mode = p.n - 1;
  const at = reducedMotion.value ? stillAt(p.area, mode) : sec;
  const pal = areaPal(p.area);
  const presses = isReactive(p.area, mode) ? typingPresses(at, typingCells.value) : [];
  const pattern = ledFrame(p.area, mode, b.speed, b.direction, !pal, at, presses);
  const k = Math.max(PREVIEW_FLOOR, b.brightness) / 100;
  const dst = p.area === 0 ? previewFrame.keys : previewFrame.strip;
  const matrix = p.area === 0 ? lighting.area0Matrix : lighting.area1Matrix;
  const count = p.area === 0 ? LED_MATRIX_TOTAL : LED_STRIP_COUNT;
  for (let i = 0; i < count; i++) {
    const rec = matrix[i];
    const [r, g, bl] = rec?.custom ? [rec.r, rec.g, rec.b] : ledRgb(pattern(i), pal, k);
    dst[i * 3] = Math.round(r);
    dst[i * 3 + 1] = Math.round(g);
    dst[i * 3 + 2] = Math.round(bl);
  }
}

const boardEl = ref<HTMLElement | null>(null);
let painter: LiveLedPainter | null = null;
let paintRaf: number | null = null;
let paintedSeq = -1;
let paintedFrom: LiveLedFrame | null = null;
let paintedParts = { keys: false, strip: false };
function paintFrame(): void {
  if (!painter) return;
  const parts = { keys: paintKeys.value, strip: paintStrip.value };
  if ((paintedParts.keys && !parts.keys) || (paintedParts.strip && !parts.strip)) {
    painter.clear(); // a half no longer painted here gets Vue's colours back
    paintedFrom = null;
  }
  paintedParts = parts;
  let frame = lighting.liveFrame;
  const p = playing.value;
  if (p) {
    const t = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const of = `${p.area}:${p.n}`;
    const liveSeq = livePaint.value ? lighting.liveFrame.seq : -1;
    if (of !== previewOf || liveSeq !== previewLiveSeq || t - previewBuiltAt >= PREVIEW_FRAME_MS - 1) {
      buildPreviewFrame(p, t / 1000);
      previewOf = of;
      previewLiveSeq = liveSeq;
      previewBuiltAt = t;
      previewFrame.seq++;
    }
    frame = previewFrame;
  } else {
    previewOf = '';
  }
  if (frame === paintedFrom && frame.seq === paintedSeq && !painter.dirty) return;
  paintedFrom = frame;
  paintedSeq = frame.seq;
  painter.paint(frame, device.keys, parts);
}
function paintLoop(): void {
  paintRaf = requestAnimationFrame(paintLoop);
  paintFrame();
}
// A lit key's look depends on its state (hover, keyboard focus, selected, flashing), so a state change repaints the keys
// on the next display frame even when the keyboard sent nothing new. Selection and flash are Vue's classes on `.cap`.
const invalidatePaint = () => painter?.invalidate();
const STATE_EVENTS = ['pointerover', 'pointerout', 'focusin', 'focusout'] as const;
let capObserver: MutationObserver | null = null;
function startPainting(): void {
  const el = boardEl.value;
  if (!el) return;
  painter ??= new LiveLedPainter(el);
  paintedSeq = -1;
  paintedFrom = null;
  paintFrame(); // at once: Vue has just drawn the keys unlit
  if (paintRaf === null) paintRaf = requestAnimationFrame(paintLoop);
  for (const ev of STATE_EVENTS) el.addEventListener(ev, invalidatePaint);
  if (!capObserver && typeof MutationObserver !== 'undefined') {
    capObserver = new MutationObserver((records) => {
      if (records.some((r) => (r.target as Element).classList?.contains('cap'))) invalidatePaint();
    });
    capObserver.observe(el, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
}
function stopPainting(): void {
  if (paintRaf !== null) cancelAnimationFrame(paintRaf);
  paintRaf = null;
  const el = boardEl.value;
  if (el) for (const ev of STATE_EVENTS) el.removeEventListener(ev, invalidatePaint);
  capObserver?.disconnect();
  capObserver = null;
  painter?.clear();
  paintedSeq = -1;
  paintedFrom = null;
  paintedParts = { keys: false, strip: false };
}
watch(painted, (on) => (on ? startPainting() : stopPainting()), { flush: 'post' });
// a lit key's tint mask holds the theme's stops (the painter notices a moved or resized board itself)
watch(resolvedTheme, () => painter?.resized(), { flush: 'post' });
onMounted(() => { if (painted.value) startPainting(); });

// ------------------------------------------------------------------ Preview colours
/** Static stand-in for the firmware's rainbow: hue by position (0..1). */
function rainbowAt(pos: number): string {
  return `hsl(${Math.round(pos * 360)} 80% 60%)`;
}

function keyColor(key: PhysicalKey): string | undefined {
  if (!ready.value || paintKeys.value) return undefined; // live or previewed: painted outside Vue
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

/** The key lit as a whole (glow style): the LED colour at full brightness and its level; undefined = off. */
function keyGlow(key: PhysicalKey): LedGlow | undefined {
  return ledGlow(keyColor(key));
}

/** Marks keys that carry their own colour (the LED line alone is easy to miss). */
function keyBadge(key: PhysicalKey): string | undefined {
  return ready.value && lighting.keyCustomColors[key.id]?.custom ? '●' : undefined;
}

function stripColor(index: number): string {
  if (!ready.value) return 'var(--bg-3)';
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
  const color = stripColor(index);
  const glow = ready.value ? ledGlow(color) : undefined;
  return {
    index,
    side,
    pos,
    label,
    glow,
    // the dot carries the normalised colour, never darker than 35 % cover, so a dim LED is a pale dot and not a black one
    color: glow ? `color-mix(in srgb, ${glow.led} ${Math.max(35, Math.round(glow.level * 1000) / 10)}%, transparent)` : color,
    isSel: activeTab.value === 'strip' && stripSelection.value.has(index), // the display-only ring on the keys tab draws no selection
    custom: ready.value && lighting.stripCustomColors[index]?.custom,
  };
}));

/** One blurred band per side through that side's LED colours; a side with no lit LED has none (DESIGN A §3.3). */
const RING_SIDES: RingSide[] = ['top', 'right', 'bottom', 'left'];
const ringBands = computed(() => RING_SIDES.flatMap((side) => {
  const bg = bandGradient(side, ringLeds.value.filter((l) => l.side === side).map((l) => ({ pos: l.pos, glow: l.glow })));
  return bg ? [{ side, bg }] : [];
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

/** UI effect number and, when the board's name for it is sure, " · name" (display only; AE64 names never used on generic). */
const effectLabel = (n: number) => {
  if (isGeneric.value) return t('mkb.light.effect', { n });
  const name = effectName(boardForEffects.value, area.value, n, locale.value);
  return name ? `${n} · ${name}` : String(n);
};
const effectReadout = computed(() => {
  const mode = base.value.mode;
  if (isGeneric.value) {
    return mode >= 0 && mode < modeCount.value ? t('mkb.light.effect', { n: mode + 1 }) : t('mkb.common.unknown');
  }
  return effectLabel(mode + 1);
});
const effectBtnLabel = (n: number) => (isGeneric.value
  ? t('mkb.light.effect', { n })
  : t('lighting.effectN', { n: effectLabel(n) }));
const effectBtnTitle = (n: number) => {
  if (isGeneric.value) return t('mkb.light.effect', { n });
  // today's format "Hiệu ứng N · Tên — gợi ý"; an unknown effect says it has no preview (FXP §8)
  if (!effectKnown(boardForEffects.value, area.value, n)) return `${effectBtnLabel(n)} — ${t('lighting.fx.noPreview')}`;
  const hint = effectHint(boardForEffects.value, area.value, n, locale.value);
  return hint ? `${effectBtnLabel(n)} — ${hint}` : effectBtnLabel(n);
};

function onEffect(index: number) {
  previewCtl.end();
  lighting.applyBase(area.value, { mode: index }, baseLabel());
}

// ------------------------------------------------------------------ Effect buttons: three views (FXP §3, §4)
const uid = useId();
const fxView = ref<FxView>(readFxView());
const activeFxView = computed<FxView>(() => (isGeneric.value ? 'off' : fxView.value));
const fxViewOptions = computed(() => [
  { value: 'off' as const, label: t('lighting.fx.viewOff') },
  { value: 'lite' as const, label: t('lighting.fx.viewLite') },
  { value: 'detail' as const, label: t('lighting.fx.viewDetail') },
]);
/** Display only: remembered per browser, never sent to the keyboard; a change ends a running preview. */
watch(fxView, (v) => { writeFxView(v); previewCtl.end(); });

const fxTiles = computed(() => Array.from({ length: modeCount.value }, (_, i) => {
  const n = i + 1;
  if (isGeneric.value) {
    return { n, known: false, on: base.value.mode === i, name: t('mkb.light.effect', { n }), icon: '' };
  }
  const known = effectKnown(boardForEffects.value, area.value, n);
  return {
    n,
    known,
    on: base.value.mode === i,
    name: effectName(boardForEffects.value, area.value, n, locale.value) ?? t('lighting.fx.unknown'),
    icon: effectIcon(area.value, n, known),
  };
}));

// ------------------------------------------------------------------ "Xem thử": when it starts and ends (FXP §7)
/** The effects hint says only what works now (FXP v2.1 H1): the "try it" words only where a preview can start (the same
 *  gate as `allowed` below), the Tắt words in Tắt, and nothing while the effects are locked. */
const fxHint = computed(() => (isGeneric.value || tuneLocked.value ? null : fxView.value === 'off' ? t('lighting.fx.gridHintOff') : t('lighting.fx.gridHint')));
const gridEl = ref<HTMLElement | null>(null);
const previewCtl = new PreviewControl({
  allowed: (n) => !isGeneric.value && fxView.value !== 'off' && !tuneLocked.value && base.value.mode !== n - 1 && n <= modeCount.value,
  show: (n) => {
    preview.value = n === null || isGeneric.value ? null : { area: area.value, n, known: effectKnown(boardForEffects.value, area.value, n) };
  },
});
// a tab change, the area off or locked, or the chosen effect becoming the previewed one: the preview ends
watch([area, tuneLocked], () => previewCtl.end());
watch(() => base.value.mode, (m) => { if (preview.value?.n === m + 1) previewCtl.end(); });

const tileOf = (target: EventTarget | null): number => {
  const el = (target as Element | null)?.closest?.('[data-n]');
  return el && gridEl.value?.contains(el) ? Number((el as HTMLElement).dataset.n) : 0;
};
/** Keyboard focus, not a click's focus. */
function keyboardFocus(el: Element): boolean {
  try { return el.matches(':focus-visible'); } catch { return true; }
}
function onGridOver(e: PointerEvent) {
  const n = tileOf(e.target);
  if (n) previewCtl.over(n, e.pointerType ?? '');
}
function onGridLeave() {
  const a = document.activeElement;
  previewCtl.leave(a && gridEl.value?.contains(a) && keyboardFocus(a) ? tileOf(a) || null : null);
}
function onGridFocus(e: FocusEvent) {
  const n = tileOf(e.target);
  if (n && keyboardFocus(e.target as Element)) previewCtl.focus(n);
}
function onGridBlur(e: FocusEvent) {
  if (!gridEl.value?.contains(e.relatedTarget as Node | null)) previewCtl.blur();
}
/** Esc ends a preview before anything else sees it (the key selection stays). */
function onPreviewEsc(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  if (previewCtl.escape()) e.preventDefault();
}
window.addEventListener('keydown', onPreviewEsc, true);

const previewCue = computed(() => {
  const p = preview.value;
  if (!p) return null;
  return p.known
    ? { none: false, text: t('lighting.fx.trying', { label: effectLabel(p.n) }) }
    : { none: true, text: t('lighting.fx.tryingNone', { n: p.n }) };
});

// ------------------------------------------------------------------ Chi tiết: the mini keyboards (FXP §11)
const tiles = new TileDriver(() => device.keys, stripRing());
const gridOnScreen = ref(true);
let gridObserver: IntersectionObserver | null = null;
let gridResize: ResizeObserver | null = null;
function syncTiles() {
  if (isGeneric.value) {
    tiles.setTiles([]);
    return;
  }
  const el = gridEl.value;
  tiles.setTiles(el ? [...el.querySelectorAll<HTMLCanvasElement>('canvas[data-mode]')].map((canvas) => ({
    canvas, mode: Number(canvas.dataset.mode), known: canvas.dataset.known === '1',
  })) : []);
}
watch(gridEl, (el) => {
  gridObserver?.disconnect();
  gridResize?.disconnect();
  gridObserver = null;
  gridResize = null;
  if (!el) return;
  if (typeof IntersectionObserver === 'function') {
    gridObserver = new IntersectionObserver((entries) => { gridOnScreen.value = entries.some((x) => x.isIntersecting); });
    gridObserver.observe(el);
  }
  if (typeof ResizeObserver === 'function') {
    gridResize = new ResizeObserver(() => tiles.resize());
    gridResize.observe(el);
  }
}, { flush: 'post' });
watch([isGeneric, gridEl, fxView, area, fxTiles], syncTiles, { flush: 'post' });
const tileParams = computed<TileParams>(() => {
  const b = base.value;
  const light = resolvedTheme.value.includes('light');
  return {
    area: area.value,
    open: b.open,
    speed: b.speed,
    direction: b.direction,
    pal: areaPal(area.value),
    typing: typingCells.value,
    plate: light ? '#2a2c33' : '#0c0d10',
    cap: light ? '#3d4049' : '#24262b',
    ringOff: light ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.10)',
  };
});
watch(tileParams, (p) => tiles.setParams(p), { immediate: true });
watch([isGeneric, fxView, gridOnScreen, tabVisible, reducedMotion], () => tiles.setGate({
  detail: !isGeneric.value && fxView.value === 'detail', onScreen: gridOnScreen.value, tabVisible: tabVisible.value, reduced: reducedMotion.value,
}), { immediate: true });

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
/** The dock went away mid-drag (WX6 item 10): the draft goes, the next arrow steps from the stored value. */
function onTuneCancel(field: TuneField) {
  delete drafts[draftKey(field)];
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

/** Only the first chip of the picked colour is marked (white and a palette slot can be the same colour). */
const pickedChip = computed(() => quickColors.value.indexOf(picked[area.value].toLowerCase()));

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
// The keycap legend (DESIGN B §3.4): where the key colours come from, and the ● of a key with its own colour. Paused or
// failed live reading shows the colours computed from the settings.
type Source = 'lighting.showsLive' | 'lighting.showsSim' | 'lighting.showsSaved';
function legendFor(source: Source): LegendItem[] | undefined {
  if (!ready.value) return undefined;
  const items: LegendItem[] = [{ text: t(source) }];
  if (device.keys.some((k) => keyBadge(k))) items.push({ glyph: '●', tone: GLOW_BADGE_TONE, text: t('lighting.showsOwn') });
  return items;
}
const source = computed<Source>(() => (isGeneric.value || liveState.value !== 'live' ? 'lighting.showsSaved' : device.demo ? 'lighting.showsSim' : 'lighting.showsLive'));
const shows = computed(() => legendFor(source.value));
/** Turning live preview on or off (or a read error) switches the source: the bar keeps one row count across them. */
const showsAlt = computed(() => (['lighting.showsLive', 'lighting.showsSim', 'lighting.showsSaved'] as const)
  .filter((s) => s !== source.value).map(legendFor).filter((l): l is LegendItem[] => !!l));
</script>

<template>
  <PageLayout :title="t('page.lighting')">
    <div class="wb" :class="{ 'wb--generic': isGeneric }">
      <!-- toolbar -->
      <div class="wb__bar">
        <div v-if="tabItems.length" class="tabs" role="tablist" :aria-label="t('lighting.tabsLabel')" @keydown="onTabKey">
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
        <div v-if="!isGeneric || (activeAreaAvailable && !activeAreaUnsupported)" class="wb__group">
          <span class="wb__label">{{ t('lighting.powerTitle') }}</span>
          <Segmented v-model="openModel" :options="openOptions" :label="t('lighting.powerTitle')" :disabled="locked" />
          <InfoTip :text="t(area === 0 ? 'lighting.powerHintKeys' : 'lighting.powerHintStrip')" />
        </div>
        <div v-if="!isGeneric" class="wb__group wb__live">
          <span class="lighting-live-badge" :class="playing ? 'lighting-live-badge--try' : `lighting-live-badge--${liveState}`" data-testid="live-chip">
            <span class="lighting-live-badge__dot" />
            {{ playing ? t('lighting.liveBadge.try') : liveState === 'error' ? t('lighting.liveError') : liveState === 'live' ? t(device.demo ? 'lighting.simStatus' : 'lighting.liveStatus') : t('lighting.pausedStatus') }}
          </span>
          <InfoTip :text="device.demo ? t('lighting.demoSimNote') : t('lighting.livePreviewHint')" />
          <Switch v-model="lighting.livePreview" :label="t('lighting.livePreview')" />
        </div>
      </div>

      <p v-if="readOnly && !isGeneric" class="lighting-notice" role="status">{{ t('lighting.readOnly') }}</p>

      <!-- keyboard (keys are only selectable on the keys tab) with the edge strip as a ring on its frame (AE64 only) -->
      <div v-if="showKeyboard" ref="boardEl" class="wb__board">
        <KeyboardView
          :keys="device.keys"
          :legend="device.legend"
          led-style="glow"
          :glow="keyGlow"
          :badge="keyBadge"
          :selectable="activeTab === 'keys'"
          :loading="!ready"
        />
        <div
          v-if="!isGeneric"
          ref="ringEl"
          class="ring ring--band"
          :class="{ 'ring--on': activeTab === 'strip' && ready, 'ring--live': paintStrip }"
          role="group"
          :aria-label="t('lighting.ringLabel')"
          :aria-hidden="activeTab === 'strip' ? undefined : true"
        >
          <template v-if="paintStrip">
            <!-- live or previewed: one band per side, its --band written by the painter (no style binding here) -->
            <span v-for="side in RING_SIDES" :key="`live-${side}`" class="ring__band ring__band--live" :class="`ring__band--${side}`" aria-hidden="true" />
          </template>
          <template v-else>
            <span v-for="band in ringBands" :key="band.side" class="ring__band" :class="`ring__band--${band.side}`" :style="{ '--band': band.bg }" aria-hidden="true" />
          </template>
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

      <div v-if="isGeneric && ready && genericStripLines.length" class="lighting-meta-list">
        <p v-for="s in genericStripLines" :key="s.id" class="lighting-meta-line" data-testid="generic-strip-line">
          {{ t('mkb.light.strip', { n: s.cols }) }}
        </p>
      </div>

      <!-- selection bar; a preview covers it in place with its cue, so nothing moves -->
      <div v-if="!isGeneric || (activeTab === 'keys' && showKeyboard)" class="legend" :class="{ 'legend--try': previewCue }">
      <SelectionBar v-if="activeTab === 'keys'" :shows="shows" :shows-alt="showsAlt" />
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
      <span v-if="previewCue" class="fx-try" :class="{ 'fx-try--none': previewCue.none }" aria-hidden="true" data-testid="preview-cue">
        <svg v-if="!previewCue.none" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" /><path d="M21 12c-2.4 4 -5.4 6 -9 6c-3.6 0 -6.6 -2 -9 -6c2.4 -4 5.4 -6 9 -6c3.6 0 6.6 2 9 6" /></svg>
        <span class="fx-try__t">{{ previewCue.text }}</span>
      </span>
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

      <!-- unsupported generic area (rows > 6 or cols > 21) -->
      <p v-else-if="isGeneric && activeAreaUnsupported" class="lighting-unsupported" data-testid="generic-area-unsupported">
        {{ t('mkb.common.unsupported') }}
      </p>

      <!-- editor dock -->
      <section v-else-if="!isGeneric || activeAreaAvailable" class="dock" :aria-label="t('lighting.effectsTitle')">
        <p v-if="!powered" class="dock__off" role="status">{{ t('lighting.powerOffHint') }}</p>
        <!-- a. Effects: a full-width first row, its buttons drawn in the chosen view (FXP §2–§4) -->
        <!-- the hint is the group's description: a plain div's description is never read when a tile gets focus -->
        <div class="fx col--fx" role="group" :aria-labelledby="`${uid}-fx-title`" :aria-describedby="fxHint ? `${uid}-fx-hint` : undefined">
          <div class="col__head fx__head">
            <h3 :id="`${uid}-fx-title`" class="col__title">{{ t('lighting.effectsShort') }}</h3>
            <InfoTip class="col__tip" :text="t('lighting.effectsDesc')" placement="top" />
            <span class="col__readout" data-testid="effect-readout" :title="isGeneric ? effectReadout : effectBtnLabel(base.mode + 1)">{{ effectReadout }}</span>
            <div v-if="!isGeneric" class="fx__view">
              <span :id="`${uid}-fx-view`" class="fx__viewlabel">{{ t('lighting.fx.view') }}</span>
              <Segmented v-model="fxView" :options="fxViewOptions" :label="t('lighting.fx.view')" :labelledby="`${uid}-fx-view`" size="sm" data-testid="fx-view" />
              <InfoTip :text="t('lighting.fx.viewTip')" placement="top" />
            </div>
          </div>
          <fieldset class="col__body fx__body" :disabled="tuneLocked">
            <div
              ref="gridEl"
              class="fx__grid"
              :class="[`fx__grid--${activeFxView}`, `fx__grid--a${area}`]"
              :style="{ '--n': modeCount }"
              @pointerover="onGridOver"
              @pointerleave="onGridLeave"
              @focusin="onGridFocus"
              @focusout="onGridBlur"
            >
              <button
                v-for="tile in fxTiles"
                :key="`${area}-${tile.n}`"
                type="button"
                class="effect-btn"
                :class="[`effect-btn--${activeFxView}`, {
                  'effect-btn--active': tile.on,
                  'effect-btn--unknown': !isGeneric && !tile.known,
                  'effect-btn--try': preview?.n === tile.n,
                }]"
                :data-n="tile.n"
                :aria-label="effectBtnLabel(tile.n)"
                :title="effectBtnTitle(tile.n)"
                :aria-pressed="tile.on"
                @click="onEffect(tile.n - 1)"
              >
                <span v-if="activeFxView === 'off'" class="num">{{ tile.n }}</span>
                <template v-else-if="activeFxView === 'lite'">
                  <!-- eslint-disable-next-line vue/no-v-html -- our own static glyphs (effectIcons.ts), no user text -->
                  <svg class="effect-btn__icon" viewBox="0 0 20 20" aria-hidden="true" v-html="tile.icon" />
                  <span class="effect-btn__n num">{{ tile.n }}</span>
                  <span class="effect-btn__name">{{ tile.name }}</span>
                  <svg v-if="tile.on" class="effect-btn__check" viewBox="0 0 16 16" aria-hidden="true" data-testid="fx-check"><path d="M3.5 8.4 6.6 11.4 12.6 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </template>
                <template v-else>
                  <span class="effect-btn__pic">
                    <canvas class="effect-btn__cv" :data-mode="tile.n - 1" :data-known="tile.known ? 1 : 0" aria-hidden="true" />
                    <span v-if="!tile.known" class="effect-btn__q" aria-hidden="true">?</span>
                  </span>
                  <span class="effect-btn__label">
                    <span class="effect-btn__n num">{{ tile.n }}</span>
                    <span class="effect-btn__name">{{ tile.name }}</span>
                  </span>
                  <svg v-if="tile.on" class="effect-btn__check" viewBox="0 0 16 16" aria-hidden="true" data-testid="fx-check"><path d="M3.5 8.4 6.6 11.4 12.6 4.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
                </template>
              </button>
            </div>
            <!-- no hint, no span: browse mode reads text in the group whatever aria-describedby says (H1a) -->
            <span v-if="fxHint" :id="`${uid}-fx-hint`" class="sr-only">{{ fxHint }}</span>
          </fieldset>
        </div>

        <div class="dock__cols">
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
                  @cancel="onTuneCancel(field.id)"
                />
              </div>
              <div class="field-inline">
                <span class="field-label">{{ t('lighting.directionShort') }}</span>
                <Segmented v-model="directionModel" :options="directionOptions" :label="t('lighting.direction')" :disabled="tuneLocked" />
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
                  v-if="!palIsRainbow"
                  ref="palEditBtn"
                  class="pal__edit"
                  size="sm"
                  variant="secondary"
                  aria-haspopup="dialog"
                  :aria-expanded="palOpen"
                  :aria-label="t('lighting.editColorAria', { n: editingSlot })"
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
          <div v-if="!(isGeneric && activeTab === 'strip')" class="col col--own">
            <div class="col__head">
              <h3 class="col__title">{{ activeTab === 'keys' ? t('lighting.perKeyTitle') : t('lighting.stripCustomTitle') }}</h3>
              <InfoTip
                :text="activeTab === 'keys' ? (isGeneric ? t('lighting.perKeyDesc') : `${t('lighting.perKeyDesc')} ${t('lighting.spaceNote')}`) : t('lighting.stripCustomDesc')"
                placement="top"
              />
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
                  :class="{ 'quick__chip--on': i === pickedChip }"
                  :style="{ backgroundColor: hex }"
                  :aria-label="hex"
                  :title="hex"
                  :aria-pressed="i === pickedChip"
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
                  {{ overrideCount > 0 ? t('lighting.clearAllN', { count: overrideCount }) : t('lighting.clearAll') }}
                </Button>
              </div>
            </fieldset>
            <Popover v-model:open="colorOpen" :anchor="colorBtn" :title="t('lighting.pickColor')">
              <ColorPicker v-model="picked[area]" :disabled="locked" />
            </Popover>
          </div>
        </div>
      </section>

      <div v-if="isGeneric && ready && (lighting.extraAreas.length || lighting.areasTruncated)" class="lighting-extra" data-testid="generic-extra-areas">
        <p v-for="ea in lighting.extraAreas" :key="ea.id" class="lighting-meta-line" :data-testid="`generic-extra-area-${ea.id}`">
          {{ t('mkb.light.extraArea', { n: ea.id, m: ea.modes }) }}
        </p>
        <p v-if="lighting.areasTruncated" class="lighting-meta-line lighting-meta-line--muted" data-testid="generic-areas-truncated">
          … {{ t('mkb.common.unknown') }}
        </p>
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
.wb { display: flex; flex-direction: column; gap: var(--s-2); }
.wb__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4); }
.wb__group { display: flex; flex: none; align-items: center; gap: var(--s-2); white-space: nowrap; }
.wb__label { font-size: var(--fs-label); color: var(--fg-2); white-space: nowrap; }
.wb__live { margin-left: auto; }

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
/* Live: the colour steps with each frame (up to every display frame), a fade would never settle. */
.ring--live .led__dot { transition: box-shadow var(--t-fast) var(--ease); }
.ring--live .led__glow { transition: none; }

/* Continuous band: one blurred strip per side under the LED buttons, centred on the frame line. The dots shrink once the
   band carries the colour; they stay to click and to show where each of the 38 LEDs is. */
.ring__band { position: absolute; pointer-events: none; background: var(--band); filter: blur(6px); opacity: 0.55; border-radius: 999px; }
.ring__band--top, .ring__band--bottom { left: var(--inset); right: var(--inset); height: 10px; }
.ring__band--top { top: -5px; }
.ring__band--bottom { top: calc(100% - 5px); }
.ring__band--left, .ring__band--right { top: var(--inset); bottom: var(--inset); width: 10px; }
.ring__band--left { left: -5px; }
.ring__band--right { left: calc(100% - 5px); }
.ring--band .led__glow { display: none; }
.ring--band .led__dot { width: 7px; height: 7px; }
.ring--band.ring--on .led__dot { width: 8px; height: 8px; }

/* Strip selection bar: the same row as the keys' SelectionBar. */
.sb { display: flex; align-items: center; gap: var(--s-4); min-height: 36px; }
/* DESIGN J §3.5: the hint is --fg-4, so over a wallpaper the strip bar sits on the panel like the keys' SelectionBar */
:root[data-wall] .sb { background: var(--panel); border-radius: var(--r-control); box-shadow: 0 0 0 6px var(--panel); }
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
  background: var(--panel);
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
  background: var(--panel);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  min-width: 0;
}
.dock--skel { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s-4); }
.lighting-skeleton { height: 160px; border-radius: var(--r-card); }
.dock__off { margin: 0; color: var(--fg-3); font-size: var(--fs-label); }
/* FXP §2: Effects is the dock's first row; Tuning | Palette | Own colours below, three columns at every supported width */
.dock__cols { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 0.85fr) minmax(0, 1.1fr); gap: var(--s-4) 0; }
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
.col__title { margin: 0; font-size: var(--fs-card); font-weight: 600; white-space: nowrap; flex: none; }
.col__head .col__tip { flex: none; }
.col__readout {
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  font-size: var(--fs-caption);
  color: var(--fg-2);
  white-space: nowrap;
  text-overflow: ellipsis;
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

/* a. Effects (FXP §2–§4): a full-width row; one button, three looks */
.fx { display: flex; flex-direction: column; gap: var(--s-2); min-width: 0; padding-bottom: 10px; border-bottom: 1px solid var(--line-1); }
.fx__head { flex-wrap: wrap; row-gap: 4px; }
.fx__head .col__readout { margin-left: var(--s-2); }
.fx__view { display: flex; flex: none; align-items: center; gap: var(--s-2); margin-left: auto; }
.fx__viewlabel { font-size: var(--fs-label); color: var(--fg-3); white-space: nowrap; }
.fx__grid { display: grid; gap: 6px; }
.fx__grid--off { grid-template-columns: repeat(var(--n), minmax(0, 64px)); }
.fx__grid--lite { grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); }
.fx__grid--a1.fx__grid--lite { grid-template-columns: repeat(auto-fill, minmax(196px, 1fr)); }
.fx__grid--detail { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
.effect-btn {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  margin: 0;
  background: var(--bg-3);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  color: var(--fg-2);
  cursor: pointer;
  font: inherit;
  font-size: var(--fs-body);
  font-weight: 500;
  text-align: left;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.effect-btn:hover:not(:disabled) { background: var(--bg-4); border-color: var(--line-3); color: var(--fg-1); }
.effect-btn:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
.effect-btn:disabled { cursor: not-allowed; }
.effect-btn--off { justify-content: center; height: 32px; padding: 0; }
.effect-btn--lite { gap: 6px; height: 32px; padding: 0 10px; } /* 6, not 8: the longest bold name keeps ~4 px at 177 px wide */
.effect-btn__icon { flex: none; width: 20px; height: 20px; color: var(--fg-2); }
.effect-btn:hover:not(:disabled) .effect-btn__icon { color: var(--fg-1); }
.effect-btn__n { flex: none; min-width: 2ch; color: var(--fg-3); font-size: var(--fs-label); font-variant-numeric: tabular-nums; text-align: right; }
.effect-btn__name { flex: 1 1 auto; min-width: 0; overflow: hidden; font-size: var(--fs-label); white-space: nowrap; text-overflow: ellipsis; }
.effect-btn__check { flex: none; width: 14px; height: 14px; }
.effect-btn--unknown .effect-btn__name { color: var(--fg-3); }
.effect-btn--detail { flex-direction: column; align-items: stretch; gap: 4px; padding: 4px; }
.effect-btn__pic { position: relative; display: block; height: 40px; overflow: hidden; border-radius: 4px; background: #0c0d10; }
.effect-btn__cv { position: absolute; inset: 0; display: block; width: 100%; height: 100%; }
/* the keyboard picture stays dark in every theme, as the big one does: the "?" is drawn for that dark plate */
.effect-btn__q { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(12, 13, 16, 0.55); color: #c9cbd3; font-size: 18px; font-weight: 700; }
.effect-btn__label { display: flex; align-items: center; gap: 6px; min-width: 0; height: 18px; padding: 0 2px; }
.effect-btn--detail .effect-btn__n, .effect-btn--detail .effect-btn__name { font-size: var(--fs-caption); }
/* the chosen effect: soft accent fill, a 2 px accent edge, accent text and icon, bold, a check mark (never colour alone) */
.effect-btn--active,
.effect-btn--active:hover:not(:disabled) {
  background: var(--acc-soft);
  border-color: var(--acc);
  box-shadow: inset 0 0 0 1px var(--acc);
  color: var(--acc);
  font-weight: 600;
}
.effect-btn--active .effect-btn__icon,
.effect-btn--active .effect-btn__n,
.effect-btn--active:hover:not(:disabled) .effect-btn__icon { color: var(--acc); }
/* Sơ lược: the check is a small filled disc on the icon's corner, so the name keeps its width (a bold long name with a
   check beside it was cut at 1280 and 900) */
.effect-btn--lite .effect-btn__check { position: absolute; top: 2px; left: 21px; width: 13px; height: 13px; padding: 1.5px; border-radius: 50%; background: var(--acc); color: var(--bg-1); }
/* Chi tiết: the check is a filled disc on the picture's corner, so the label keeps its width */
.effect-btn--detail .effect-btn__check { position: absolute; top: 7px; right: 7px; width: 16px; height: 16px; padding: 2px; border-radius: 50%; background: var(--acc); color: var(--bg-1); }
/* the effect being tried on the big keyboard */
.effect-btn--try:not(.effect-btn--active) { border-color: var(--acc-line); }
@media (prefers-reduced-motion: reduce) {
  .effect-btn { transition: none; }
}

/* the preview's cues: the chip, and the line that covers the legend row in place */
.lighting-live-badge.lighting-live-badge--try { background: var(--acc-soft); color: var(--fg-1); border-color: var(--acc); }
.lighting-live-badge--try .lighting-live-badge__dot { background: var(--acc); }
.legend { position: relative; }
.legend--try > :not(.fx-try) { visibility: hidden; }
.fx-try { position: absolute; inset: 0; display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--acc); font-size: var(--fs-label); }
.fx-try svg { flex: none; }
.fx-try__t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.fx-try--none { color: var(--fg-3); }

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
  .field-inline { flex-direction: column; align-items: flex-start; gap: 4px; }
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
/* the chosen chip already wears an accent ring: focus is a further one, as on the palette swatches */
.quick__chip:focus-visible { outline: 2px solid var(--fg-1); outline-offset: 4px; }
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

.lighting-meta-list,
.lighting-extra {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--s-2) var(--s-3);
  background: var(--panel);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
}
.lighting-meta-line {
  margin: 0;
  font-size: var(--fs-label);
  color: var(--fg-2);
}
.lighting-meta-line--muted { color: var(--fg-3); }
.lighting-unsupported {
  margin: 0;
  padding: var(--s-4);
  background: var(--panel);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  color: var(--fg-2);
  font-size: var(--fs-body);
}
.wb--generic .fx__grid--off {
  grid-template-columns: repeat(auto-fill, minmax(36px, 48px));
}
@container (max-width: 680px) {
  .wb--generic .dock__cols { grid-template-columns: 1fr; }
  .wb--generic .col { padding: var(--s-3) 0 0; border-left: 0; border-top: 1px solid var(--line-1); }
  .wb--generic .col:first-child { padding-top: 0; border-top: 0; }
}
</style>
