<script setup lang="ts">
// Kiểm tra phím (the Key test tab of the Performance page, DESIGN E §3.6; was Đo hành trình, DESIGN §7): press a real
// key and watch the switch move against the trigger points from the key's settings. Polling lives in stores/live.ts; this
// tab renders from one rAF loop. Not kept alive: leaving the tab unmounts it and stops the polling, as leaving the page did.
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from 'vue';
import type { Component } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IconAdjustmentsHorizontal, IconAlertTriangle, IconArrowBarToDown, IconArrowBarToUp, IconCheck, IconEraser, IconHistory, IconLock, IconLockOpen,
  IconPlayerPause, IconPlayerPlay, IconRefresh, IconTrash,
} from '@tabler/icons-vue';
import KeyboardView from '../keyboard/KeyboardView.vue';
import TabKeyboard from '../keyboard/TabKeyboard.vue';
import { PTAB_TOOLS } from '../performance/tabTools';
import SwitchSim from './SwitchSim.vue';
import TravelGraph from './TravelGraph.vue';
import HealthCheck from './HealthCheck.vue';
import PeakTable from './PeakTable.vue';
import { ANNOUNCE_MS, CheckAnnouncer, checkScrollTarget, emptyCheckView, summarizeCheck } from './keyCheck';
import type { CheckKind, CheckView } from './keyCheck';
import { useKeyLock } from '../../composables/useKeyLock';
import { attachDemoPress } from './demoPress';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import Segmented from '../ui/Segmented.vue';
import Switch from '../ui/Switch.vue';
import { useDeviceStore } from '../../stores/device';
import { useSelectionStore } from '../../stores/selection';
import { DEFAULT_RANGE_MM, rangeMm, usePerformanceStore } from '../../stores/performance';
import { settingsFrom, useLiveStore } from '../../stores/live';
import { isRtMode } from '../../protocol';
import type { MockTransport, PhysicalKey } from '../../protocol';
import type { LedGlow } from '../../ledGlow';
import { t } from '../../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const perf = usePerformanceStore();
const live = useLiveStore();
const route = useRoute();
const router = useRouter();
defineOptions({ name: 'TestTab' });

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

/** Keyboard focus on the graph: the Tab that got there was followed; go back to the key being reviewed. */
function onGraphKeyFocus() {
  if (live.follow) live.undoAutoFollow();
}

// ----- Space/Enter that operates a control is not a test press
const SPACE_CODES = [0x2c];
const ENTER_CODES = [0x28, 0x58];
const CONTROL = 'button, [role=button], [role=switch], [role=radio], [role=tab], select';
// Arrows and Home/End move a radio group, tab list or select (the Auto/Pinned selector pins on ArrowRight).
const NAV_CONTROL = '[role=radio], [role=tab], select';
const NAV_CODES: Record<string, number> = { ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52, Home: 0x4a, End: 0x4d };
/** The tab's root element. */
const tabRef = ref<HTMLElement | null>(null);
/** The tab's root, where the page is measured from (scroller, keyboard frame, check card). */
let tabEl: HTMLElement | null = null;
/** The route's page element (PageLayout's .page): the one App's page transition slides in, and where the control-key
 *  capture listens, so the page toolbar's tab row counts as a control like everything else on the page. */
let pageEl: HTMLElement | null = null;

/** Capture phase, so it runs before the control's own action: undo the switch the keystroke caused and ignore that key until it is released. */
function onControlKey(e: KeyboardEvent) {
  const el = e.target;
  const nav = NAV_CODES[e.code];
  const codes = e.key === ' ' || e.code === 'Space' ? SPACE_CODES
    : e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter' ? ENTER_CODES
      : nav !== undefined && el instanceof Element && el.matches(NAV_CONTROL) ? [nav] : null;
  if (!codes || !(el instanceof Element) || !el.matches(CONTROL) || el.matches('[data-keytest], canvas.graph')) return;
  const keys = live.keysForCodes(codes);
  live.undoAutoFollow(keys);
  live.markUiPressed(keys);
}

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
const modeLabel = computed(() => {
  const s = settings.value;
  if (!s) return '';
  if (!isRtMode(s.mode)) return t('perf.modeStandard');
  // Mode 2 = Rapid Trigger without Continuous RT.
  return s.mode === 1 ? `${t('perf.modeRt')} · ${t('live.modeContinuous')}` : t('perf.modeRt');
});

function editKey() {
  if (live.focusId === null) return;
  sel.select(live.focusId);
  void router.push({ path: '/performance', query: { tab: 'travel' } }); // the Travel tab (DESIGN E §3.1)
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
const graphHold = ref(false);
const graphPan = ref<number | null>(null);
const graph = ref<InstanceType<typeof TravelGraph> | null>(null);
const panText = computed(() => (graphPan.value === null ? '' : t('live.panned', { s: graphPan.value.toFixed(1) })));

let raf = 0;
let seen = -1;
let lastHeat = 0;
let lastRate = -1;
const HEAT_MS = 33;

function frame(now: number) {
  raf = requestAnimationFrame(frame);
  const d = live.data;
  // The keycap marks and results change in the same frame as the heat (one keyboard render), the two cards at most
  // every CARD_MS: they are read, not watched, and 64 table rows at 30 Hz cost more than the rest of the page.
  const due = now - lastHeat >= HEAT_MS;
  let ticked = false;
  if (due && (d.checkVersion !== seenCheck || perf.values !== seenValues || device.keys !== seenKeys)) {
    ticked = true;
    refreshCheck();
  }
  if (cardView.value !== checkView.value && now - lastCard >= CARD_MS) {
    lastCard = now;
    cardView.value = checkView.value;
  }
  if (now - lastAnnounce >= ANNOUNCE_MS) {
    lastAnnounce = now;
    announce();
  }
  if (d.version === seen && d.rateHz === lastRate) {
    if (ticked) lastHeat = now;
    return;
  }
  seen = d.version;
  lastRate = d.rateHz;
  view.value = {
    current: d.current, peak: d.peak, count: d.count, lastActuation: d.lastActuation, lastRelease: d.lastRelease,
    rate: d.rateHz, firmware: d.firmwarePressed, mismatch: d.mismatch,
    resetAt: d.model?.resetAt ?? null, reactuateAt: d.model?.reactuateAt ?? null, touched: d.touched,
  };
  if (due) {
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

// ----- key check (part C): deepest reading per key, full / short / not back to 0, key lock
const LOCK_KEY = 'ae64.live.keyLock';
const COLOR_KEY = 'ae64.live.colorByResult';
/** A remembered switch: '1' / '0'; anything else (missing, unreadable storage, a stray value) is the default. */
function readFlag(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === '1' ? true : v === '0' ? false : fallback;
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0');
  } catch { /* storage blocked: the choice lasts for this page only */ }
}
const keyLock = ref(readFlag(LOCK_KEY, true));
const colorByResult = ref(readFlag(COLOR_KEY, false));
watch(keyLock, (on) => writeFlag(LOCK_KEY, on));
watch(colorByResult, (on) => writeFlag(COLOR_KEY, on));

const checkView = shallowRef<CheckView>(emptyCheckView(device.keys.length));
/** By key id: "deepest 3.31 mm" for the keycap's accessible name; rebuilt only with checkView. */
let peakText: (string | undefined)[] = [];
let seenCheck = -1;
let seenValues: unknown = null;
let seenKeys: unknown = null;
/** What the two cards show: checkView, at most every CARD_MS (Start over and ?check=1 show theirs at once). */
const cardView = shallowRef<CheckView>(checkView.value);
const CARD_MS = 100;
let lastCard = -Infinity;
let lastAnnounce = 0;
const sinceReset = ref(false);
const announcer = new CheckAnnouncer();
const announcement = ref('');

/** `now`: the cards show it at once too (a reset, not a reading). */
function refreshCheck(now = false) {
  const d = live.data;
  seenCheck = d.checkVersion;
  seenValues = perf.values;
  seenKeys = device.keys;
  const v = summarizeCheck(d, device.keys, perf.values, device.legend, checkView.value);
  if (v !== checkView.value) {
    peakText = [];
    for (const r of v.rows) peakText[r.id] = t('live.keyPeak', { mm: r.mm.toFixed(2) });
    checkView.value = v;
  }
  if (now) cardView.value = v;
}

/** Put the next batched sentence in the live region (emptied first, so the same sentence twice is read twice). */
function announce() {
  const s = announcer.tick(live.data, checkView.value, live.drainReleased(), (id) => device.legend(device.keys[id]), performance.now(), t);
  if (!s) return;
  announcement.value = '';
  void nextTick(() => { announcement.value = s; });
}

function restartCheck() {
  live.resetPeaks();
  sinceReset.value = true;
  announcer.restart();
  refreshCheck(true);
}

function pinKey(id: number) {
  sel.select(id);
}

/** Pinned with "All keys" off: only the pinned key's row is read, so keys elsewhere are not counted. */
const partialKey = computed(() => (!live.follow && !live.allKeys && focusKey.value ? keyName.value : null));
const pinnedId = computed(() => (live.follow ? null : live.focusId));

const RESULT: Record<CheckKind, { glow: LedGlow; icon: Component; title: string }> = {
  ok: { glow: { led: 'var(--ok)', level: 1 }, icon: IconCheck, title: t('live.cFull') },
  short: { glow: { led: 'var(--warn)', level: 1 }, icon: IconArrowBarToDown, title: t('live.cShort') },
  stuck: { glow: { led: 'var(--danger)', level: 1 }, icon: IconArrowBarToUp, title: t('live.cStuck') },
};
const resultOf = (k: PhysicalKey) => (colorByResult.value ? checkView.value.kinds[k.id] : undefined);
/** A key with a result glows in its colour (part A glow); the others keep the bar, so the followed key keeps its accent. */
const capLed = (k: PhysicalKey) => (resultOf(k) ? 'glow' as const : 'bar' as const);
const capGlow = (k: PhysicalKey) => { const r = resultOf(k); return r && RESULT[r].glow; };
const capIcon = (k: PhysicalKey) => { const r = resultOf(k); return r && RESULT[r].icon; };
const capTitle = (k: PhysicalKey) => { const r = resultOf(k); return r && RESULT[r].title; };
/** The deepest-reading line, only on keys pressed past PRESSED_MM (noise draws no line at the top of every key). */
const capMark = (k: PhysicalKey) => checkView.value.marks[k.id];
const capStatus = (k: PhysicalKey) => (checkView.value.kinds[k.id] ? peakText[k.id] : undefined);

// Key lock. It listens on document, so every window capture listener runs first: the demo keyboard (attachDemoPress,
// attached above) handles its keys before the lock sees them, whichever of the two was switched on first.
const NUDGE_MS = 1200;
const NUDGE_SAY_MS = 10_000;
const lockNudge = ref(false);
const lockSay = ref('');
let nudgeTimer: ReturnType<typeof setTimeout> | undefined;
let lastNudgeSaid = -Infinity;
/** A key was blocked on a control focused by keyboard: light the banner and, at most every 10 s, say why. */
function onLockBlocked(e: KeyboardEvent) {
  const el = e.target;
  let keyboardFocus = false;
  try {
    keyboardFocus = el instanceof Element && el !== document.body && el.matches(':focus-visible');
  } catch { /* :focus-visible unsupported: no reminder */ }
  if (!keyboardFocus) return;
  lockNudge.value = true;
  clearTimeout(nudgeTimer);
  nudgeTimer = setTimeout(() => { lockNudge.value = false; }, NUDGE_MS);
  const now = performance.now();
  if (now - lastNudgeSaid < NUDGE_SAY_MS) return;
  lastNudgeSaid = now;
  lockSay.value = '';
  void nextTick(() => { lockSay.value = t('live.lockNudge'); });
}
useKeyLock({ active: () => keyLock.value && live.running, onBlocked: onLockBlocked });
const lockState = computed(() => (!live.running ? 'idle' : keyLock.value ? 'on' : 'off'));
const lockText = computed(() => (lockState.value === 'idle' ? t('live.lockIdle') : lockState.value === 'on' ? t('live.lockOn') : t('live.lockOff')));
const lockTextId = useId();
const lockHintId = useId();
const colorHintId = useId();
const followId = useId();
// "Theo dõi phím" and its switches are view tools: on the right of the page's scope line, as Travel's chips (DESIGN E §3.5,
// patch 2026-11-14). Under the keyboard only the hint + key-lock row stays, so ?check=1 still shows the whole check card.
const toolsEl = inject(PTAB_TOOLS, ref(null));
/** Mounted (this tab is not kept alive): the tools are in the scope line. */
const active = ref(false);

// ----- ?check=1: open straight on the key check
const hcRef = ref<InstanceType<typeof HealthCheck> | null>(null);

/**
 * Start the check over, scroll the least that shows the whole health check card without scrolling the keyboard's top
 * under the title bar (8px clear), focus the card title, and drop `check` from the URL so a reload does not reset again.
 */
function enterCheck() {
  live.resetPeaks();
  refreshCheck(true);
  const { check: _check, ...query } = route.query;
  void router.replace({ query });
  // The keyboard takes its size from a ResizeObserver and the page slides in: wait until the card stops moving (the
  // same place two frames running, at most ~0.5 s) before measuring, or the card is measured too high and nothing scrolls.
  let last = NaN;
  let still = 0;
  let tries = 0;
  let entering = 0;
  const settle = () => {
    if (unmounted) return;
    // The page slides in (App's page transition, translateY 8px → 0): its last ~2px move by less than a pixel a frame,
    // so "the same place two frames running" came true 2px early (C-ENTRY-2). Measure once the slide has ended. It is
    // the route's page that slides (an old link from another page), never the tab: opening the tab from another tab of
    // the page has no slide, and this returns at once.
    if (pageEl?.matches('.page-enter-active, .page-enter-from') && ++entering < 90) {
      still = 0;
      last = NaN;
      settleRaf = requestAnimationFrame(settle);
      return;
    }
    const hc = hcRef.value?.$el as HTMLElement | undefined;
    const scroller = tabEl?.closest<HTMLElement>('.main__scroll');
    // where the card ends in the page (not on screen): scroll anchoring may move the view while the page settles
    const at = hc ? Math.round(hc.getBoundingClientRect().bottom + (scroller?.scrollTop ?? 0)) : NaN;
    still = at === last ? still + 1 : 0;
    last = at;
    if (still < 2 && ++tries < 30) {
      settleRaf = requestAnimationFrame(settle);
      return;
    }
    scrollToCheck();
  };
  void nextTick(() => { settleRaf = requestAnimationFrame(settle); });
}
let settleRaf = 0;
let unmounted = false;

function scrollToCheck() {
  const hc = hcRef.value?.$el as HTMLElement | undefined;
  const scroller = tabEl?.closest<HTMLElement>('.main__scroll');
  const board = tabEl?.querySelector<HTMLElement>('.board');
  const top = document.querySelector<HTMLElement>('.top');
  if (hc && scroller && board) {
    const view = scroller.getBoundingClientRect();
    const target = checkScrollTarget({
      scrollTop: scroller.scrollTop,
      viewTop: view.top,
      viewHeight: view.height,
      titleBottom: top ? top.getBoundingClientRect().bottom : view.top,
      cardBottom: hc.getBoundingClientRect().bottom,
      boardTop: board.getBoundingClientRect().top,
    });
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // up or down: the page may open scrolled (a link from a page that was scrolled)
    if (Math.abs(target - scroller.scrollTop) >= 1) scroller.scrollTo({ top: target, behavior: reduce ? 'auto' : 'smooth' });
  }
  hcRef.value?.focusTitle();
}

function clearGraph() {
  live.clear();
  graphHold.value = false;
  graphPan.value = null;
}

// ----- lifecycle
let offProfile: (() => void) | null = null;
onMounted(() => {
  active.value = true;
  const q = Number(route.query.key);
  if (route.query.key !== undefined && Number.isInteger(q) && device.keys[q]) sel.select(q);
  syncFocusFromSelection();
  if (live.focusId === null) live.setFocus(device.keys.find((k) => k.name === 'W')?.id ?? 0);
  live.clear();
  live.resetPeaks(); // the check lives as long as the page: coming back starts it over
  graphHold.value = false;
  live.start();
  offProfile = device.onProfileChanged(async () => {
    live.stop();
    live.reset();
    await perf.load(true);
    live.start();
  });
  raf = requestAnimationFrame(frame);
  tabEl = tabRef.value;
  pageEl = tabEl?.closest<HTMLElement>('.page') ?? tabEl;
  pageEl?.addEventListener('keydown', onControlKey, true);
  if (route.query.check === '1') enterCheck();
});
onBeforeUnmount(() => {
  active.value = false;
  pageEl?.removeEventListener('keydown', onControlKey, true);
  live.suspendFollow(false);
  live.stop();
  offProfile?.();
  detachDemo?.();
  cancelAnimationFrame(raf);
  cancelAnimationFrame(settleRaf);
  unmounted = true;
  clearTimeout(nudgeTimer);
});

const fmt = (v: number | null) => (v === null ? '—' : v.toFixed(2));
const unit = (v: number | null) => (v === null ? '' : 'mm');
const followOptions = computed(() => [
  { value: 'auto' as const, label: t('live.followAuto'), title: t('live.followAutoHint') },
  { value: 'pin' as const, label: t('live.followPinned'), title: t('live.followPinnedHint') },
]);
const simLabel = computed(() => t('live.simLabel', { key: keyName.value, mm: view.value.current.toFixed(2) }));

// ----- typing test box (pure UI, no HID traffic)
const typed = ref('');
const lastKey = ref('');
const boxRef = ref<HTMLTextAreaElement | null>(null);

function clearTyped() {
  typed.value = '';
  lastKey.value = '';
  boxRef.value?.focus();
}

function onTypeKey(e: KeyboardEvent) {
  if (e.key === ' ') {
    lastKey.value = 'Space';
  } else if (e.key === 'Unidentified' || e.key === 'Dead' || e.key === 'Process') {
    lastKey.value = e.code;
  } else if (e.key.length === 1) {
    lastKey.value = e.key.toUpperCase();
  } else {
    lastKey.value = e.key;
  }
}
</script>

<template>
  <div ref="tabRef" class="testtab">
    <TabKeyboard :selection-bar="false" board-class="board">
        <KeyboardView
          :keys="device.keys"
          :legend="device.legend"
          :sublabel="heatSub"
          :fill="heatFill"
          :state="heatState"
          :color="heatColor"
          :mark="capMark"
          :led-style="capLed"
          :glow="capGlow"
          :badge-icon="capIcon"
          :badge-title="capTitle"
          :status="capStatus"
          selectable
        />
      <template #below>
        <div class="kbfoot">
          <p class="kblegend">
            <span class="kl__k">{{ t('sel.shows') }}</span><span class="kl__num">0.42</span> {{ t('live.showsNow') }}<span class="kl__dot" aria-hidden="true">·</span><span class="kl__mark" aria-hidden="true" />{{ t('live.showsPeak') }}<template v-if="colorByResult"><span class="kl__dot" aria-hidden="true">·</span><span class="kl__ico kl__ico--ok"><IconCheck :size="14" stroke-width="1.8" aria-hidden="true" /></span>{{ t('live.showsOk') }}<span class="kl__dot" aria-hidden="true">·</span><span class="kl__ico kl__ico--short"><IconArrowBarToDown :size="14" stroke-width="1.8" aria-hidden="true" /></span>{{ t('live.showsShort') }}<span class="kl__dot" aria-hidden="true">·</span><span class="kl__ico kl__ico--stuck"><IconArrowBarToUp :size="14" stroke-width="1.8" aria-hidden="true" /></span>{{ t('live.showsStuck') }}</template>
          </p>
          <Switch v-model="colorByResult" class="toggle" :label="t('live.colorByResult')" :title="t('live.colorByResultHint')" :describedby="colorHintId" />
          <span :id="colorHintId" class="sr-only">{{ t('live.colorByResultHint') }}</span>
        </div>
      <div class="ktrow">
        <p class="hint">{{ live.follow ? t('live.followAutoHint') : t('live.followPinnedHint') }}</p>
        <div class="klock" :class="{ 'klock--off': lockState === 'off', 'klock--idle': lockState === 'idle', 'klock--nudge': lockNudge }">
          <span class="klock__ico" aria-hidden="true">
            <IconLock v-if="lockState === 'on'" :size="16" stroke-width="1.5" />
            <IconLockOpen v-else :size="16" stroke-width="1.5" />
          </span>
          <span :id="lockTextId" class="klock__text">{{ lockText }}</span>
          <span class="klock__div" aria-hidden="true" />
          <Switch v-model="keyLock" data-keylock class="toggle" :label="t('live.lockLabel')" :title="t('live.lockHint')" :describedby="`${lockTextId} ${lockHintId}`" />
          <span :id="lockHintId" class="sr-only">{{ t('live.lockHint') }}</span>
          <span class="klock__live" aria-live="polite">{{ lockSay }}</span>
        </div>
      </div>
      <Teleport v-if="active" defer :to="toolsEl" :disabled="!toolsEl">
        <div class="ktools">
          <span :id="followId" class="micro">{{ t('live.follow') }}</span>
          <Segmented
            :model-value="live.follow ? 'auto' : 'pin'"
            :options="followOptions"
            :label="t('live.follow')"
            :labelledby="followId"
            size="sm"
            @update:model-value="setFollow"
          />
          <Switch v-if="!live.follow" v-model="live.allKeys" class="toggle" :label="t('live.allKeys')" :title="t('live.allKeysHint')" />
          <Switch v-if="device.demo" v-model="demoKeys" class="toggle" :label="t('live.demoKeys')" :title="t('live.demoKeysHint')" />
        </div>
      </Teleport>
      </template>
    </TabKeyboard>

    <p v-if="!view.touched" class="start" aria-live="polite">
      <span class="start__dot" />
      {{ device.demo && demoKeys ? t('live.startHintDemo') : t('live.startHint') }}
    </p>
    <p v-if="live.paused" class="status num">{{ t('live.paused') }}</p>
    <p v-else-if="!live.running" class="status">
      {{ t('live.stopped') }}
      <Button size="sm" variant="ghost" :icon="IconRefresh" @click="live.start()">{{ t('live.restart') }}</Button>
    </p>

    <div class="checkrow">
      <HealthCheck
        ref="hcRef"
        :pressed="cardView.pressed"
        :full="cardView.full"
        :short="cardView.short"
        :stuck="cardView.stuck"
        :total="device.keys.length"
        :issues="cardView.issues"
        :estimated="cardView.estimated"
        :partial-key="partialKey"
        :pinned-id="pinnedId"
        :announcement="announcement"
        @pin="pinKey"
        @restart="restartCheck"
        @all-keys="live.allKeys = true"
      />
      <PeakTable :rows="cardView.rows" :pinned-id="pinnedId" :estimated="cardView.estimated" :since-reset="sinceReset" @pin="pinKey" />
    </div>

    <div class="grid">
      <Card class="simcard" :title="t('live.sim')" :subtitle="focusKey ? `${keyName} · ${modeLabel}` : undefined">
        <template #actions>
          <Button size="sm" variant="ghost" :icon="IconAdjustmentsHorizontal" :disabled="live.focusId === null" @click="editKey">
            {{ t('live.editKey') }}
          </Button>
        </template>
        <p v-if="view.mismatch" class="mismatch" role="alert">
          <IconAlertTriangle :size="14" />
          {{ t('live.mismatch') }}
        </p>
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
        <div class="ratefoot">
          <span class="ratefoot__label">{{ t('live.rate') }}</span>
          <span class="ratefoot__val num">{{ Math.round(view.rate) }}<small>Hz</small></span>
        </div>
      </Card>

      <Card class="readcard">
        <div class="lamp" :class="{ 'lamp--on': view.firmware }" role="status">
          <span class="lamp__light" />
          <div>
            <div class="lamp__text">{{ view.firmware ? t('live.actuated') : t('live.idle') }}</div>
            <div class="lamp__src">{{ t('live.lampSource') }}</div>
          </div>
        </div>

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
        </dl>

        <div class="typetest">
          <div class="typetest__head">
            <span class="micro">{{ t('live.typeTest') }}</span>
            <span v-if="lastKey" class="typetest__last num">{{ t('live.typeTestLast') }}: <b>{{ lastKey }}</b></span>
            <IconButton :icon="IconEraser" :label="t('live.typeTestClear')" size="sm" :disabled="!typed && !lastKey" @click="clearTyped" />
          </div>
          <textarea
            ref="boxRef"
            v-model="typed"
            data-keytest
            class="typetest__box"
            rows="3"
            maxlength="2000"
            spellcheck="false"
            autocomplete="off"
            autocapitalize="off"
            :placeholder="t('live.typeTestPlaceholder')"
            :aria-label="t('live.typeTest')"
            @keydown="onTypeKey"
          />
        </div>
      </Card>

      <Card class="graphcard" :title="t('live.graph')">
        <template #actions>
          <template v-if="graphPan !== null">
            <span class="holdchip"><IconHistory :size="14" aria-hidden="true" />{{ panText }}</span>
            <Button size="sm" variant="ghost" @click="graph?.toLive()">{{ t('live.backToLive') }}</Button>
          </template>
          <span v-else-if="graphHold && !graphPaused" class="holdchip"><IconPlayerPause :size="14" aria-hidden="true" />{{ t('live.holding') }}</span>
          <span class="legend"><i class="dot dot--act" />{{ t('live.legendPress') }}</span>
          <span class="legend"><i class="dot dot--release" />{{ t('live.legendRelease') }}</span>
          <IconButton
            :icon="graphPaused ? IconPlayerPlay : IconPlayerPause"
            :label="graphPaused ? t('live.resume') : t('live.pause')"
            :active="graphPaused"
            size="sm"
            @click="graphPaused = !graphPaused"
          />
          <IconButton :icon="IconTrash" :label="t('live.clear')" size="sm" @click="clearGraph" />
        </template>
        <TravelGraph
          ref="graph"
          :data="live.data"
          :settings="settings"
          :range="range"
          :paused="graphPaused"
          :label="t('live.graphLabel', { key: keyName }) + (graphPan !== null ? ' · ' + panText : graphHold && !graphPaused ? ' · ' + t('live.holding') : '') + ' · ' + t('live.graphPanHint')"
          @hold="graphHold = $event"
          @pan="graphPan = $event"
          @keyfocus="onGraphKeyFocus"
          @review="live.suspendFollow($event)"
        />
      </Card>
    </div>
  </div>
</template>

<style scoped>
/* No gap between the blocks, as on the page this tab was (r108): the hint sits right under the keyboard's rows and the
   check row keeps its own 16 px margins, so ?check=1 can show the keyboard and the whole check card together. */
.testtab { display: flex; flex-direction: column; min-width: 0; }
/* DESIGN E §3.5 (patch 2026-11-14): the keyboard frame is TabKeyboard's (the class `board` stays: the ?check=1 scroll
   measures it). Under it: the keycap legend row, then one row with the follow hint (left, wraps in its own cell) and the
   key-lock banner (right). "Theo dõi phím" and its switches are in the scope line (.ktools, teleported like Travel's chips). */
.ktools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); white-space: nowrap; }
.ktools :deep(.seg__opt) { flex: 1; }
.ktrow { display: flex; align-items: center; gap: var(--s-3) var(--s-4); min-height: 32px; }
.ktrow .hint { flex: 1 1 0; min-width: 0; margin: 0; text-wrap: pretty; }
.hint { color: var(--fg-3); font-size: var(--fs-label); }
.toggle { font-size: var(--fs-label); }
.klock { flex: none; }

/* Keyboard footer: keycap legend (left), "Color by result" (right: it acts on the keycaps) */
.kbfoot { display: flex; align-items: center; gap: var(--s-4); min-height: 28px; }
/* DESIGN J §3.5: the legend carries --fg-4 dots and the ok / short / stuck icon colours, so over a wallpaper the whole foot
   row sits on the panel (padded by the spread shadow like .sb: no layout change) */
:root[data-wall] .kbfoot { background: var(--panel); border-radius: var(--r-control); box-shadow: 0 0 0 6px var(--panel); }
.kblegend { flex: 1 1 auto; min-width: 0; margin: 0; font-size: var(--fs-label); line-height: 20px; color: var(--fg-2); text-wrap: balance; }
.kbfoot .sw { flex: none; }
.kl__k { color: var(--fg-3); font-weight: 500; margin-right: 6px; }
.kl__dot { color: var(--fg-4); margin: 0 6px; }
.kl__num { font-weight: 600; color: var(--fg-1); font-variant-numeric: tabular-nums; }
/* the keycap's deepest-reading line (Keycap .cap__mark) */
.kl__mark { display: inline-block; width: 16px; height: 1.5px; vertical-align: 4px; margin-right: 4px; background: var(--fg-2); }
.kl__ico { display: inline-flex; vertical-align: -2px; margin-right: 3px; }
.kl__ico--ok { color: var(--ok); }
.kl__ico--short { color: var(--warn); }
.kl__ico--stuck { color: var(--danger); }

/* Key-lock banner: right side of the row under the keyboard legend. */
.klock {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  min-height: 32px;
  padding: 4px var(--s-2) 4px var(--s-3);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  background: var(--bg-2);
  font-size: var(--fs-label);
  color: var(--fg-2);
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.klock__ico { flex: none; display: inline-flex; color: var(--fg-2); }
.klock__text { flex: 0 1 auto; min-width: 0; }
.klock--off .klock__ico, .klock--idle .klock__ico, .klock--off .klock__text, .klock--idle .klock__text { color: var(--fg-3); }
.klock .sw { flex: none; }
.klock__div { flex: none; width: 1px; height: 16px; background: var(--line-2); }
/* a key blocked on a keyboard-focused control: the frame lights up for 1.2 s (no motion) */
.klock--nudge { border-color: var(--acc); background: color-mix(in srgb, var(--acc) 8%, var(--bg-2)); }
.klock__live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .klock { transition: none; } }

/* Key check row: same columns as .grid below so the edges line up; 16px above and below whatever is around it */
.checkrow {
  display: grid;
  grid-template-columns: minmax(360px, 1.15fr) minmax(280px, 1fr);
  gap: var(--s-4);
  align-items: stretch;
  margin: var(--s-4) 0;
}
@media (max-width: 1100px) { .checkrow { grid-template-columns: 1fr; } }

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
}
.graphcard { grid-column: 1 / -1; }
@media (max-width: 1100px) {
  .grid { grid-template-columns: 1fr; }
  .typetest, .typetest__box { flex: none; }
}
.simcard :deep(.sim) { margin: auto; }
.ratefoot {
  display: flex; align-items: baseline; justify-content: space-between;
  padding-top: var(--s-3); border-top: 1px solid var(--line-1);
  font-size: var(--fs-label); color: var(--fg-3);
}
.ratefoot__val { font-size: 15px; font-weight: 600; color: var(--fg-1); }
.ratefoot__val small { margin-left: 3px; font-size: var(--fs-caption); font-weight: 500; color: var(--fg-3); }

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
  box-shadow: inset 0 1px 1px var(--cap-shade);
  transition: background var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.lamp__text { font-weight: 600; color: var(--fg-3); font-size: var(--fs-body); }
.lamp__src { font-size: var(--fs-caption); color: var(--fg-4); }
.lamp--on { background: color-mix(in srgb, var(--m-actuation) var(--soft-pct), transparent); border-color: color-mix(in srgb, var(--m-actuation) 45%, transparent); }
.lamp--on .lamp__light { background: var(--m-actuation); box-shadow: 0 0 12px var(--m-actuation), 0 0 2px var(--m-actuation); }
.lamp--on .lamp__text { color: var(--fg-1); }
.lamp--on .lamp__src { color: var(--fg-2); }

.mismatch {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0;
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
.bar span { display: block; height: 100%; background: var(--m-actuation); transform-origin: left; }

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
.stats dt { font-size: var(--fs-caption); color: var(--fg-3); }
.stats dd { margin: 0; font-size: var(--fs-hero); font-weight: 600; letter-spacing: -0.01em; }
.stats dd small { margin-left: 4px; font-size: var(--fs-label); font-weight: 500; color: var(--fg-3); }
.stats dd.acc { color: var(--m-actuation); }

.holdchip {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px;
  font-size: var(--fs-label); font-weight: 500; color: var(--fg-2); background: var(--bg-3);
  border: 1px solid var(--line-2); border-radius: var(--r-control); white-space: nowrap;
}
.legend { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-label); color: var(--fg-3); margin-right: var(--s-2); }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
.dot--act { background: var(--m-press); }
.dot--release { background: var(--m-release); }

.typetest { flex: 1 1 auto; display: flex; flex-direction: column; }
.typetest__head {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-top: var(--s-4);
}
.typetest__last {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--fg-3);
}
.typetest__last b {
  color: var(--fg-1);
  font-weight: 600;
}
.typetest__box {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  flex: 1 1 auto;
  min-height: 72px;
  margin-top: var(--s-2);
  padding: var(--s-2) var(--s-3);
  background: var(--bg-2);
  color: var(--fg-1);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  font: inherit;
  font-size: var(--fs-body);
  transition: border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.typetest__box:focus {
  outline: none;
  border-color: var(--acc-line);
  box-shadow: var(--focus-ring);
}
.typetest__box::placeholder {
  color: var(--fg-4);
}
</style>
