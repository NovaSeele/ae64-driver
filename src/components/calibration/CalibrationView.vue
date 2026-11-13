<script setup lang="ts">
// Calibrate (DESIGN §6.7, visual calibration DESIGN D): explain the steps, confirm, enter calibration mode (02 06 00),
// show each key lit in its calibration status with the deepest travel reached in the session, then finish (02 06 01 +
// commit 1) or cancel. Leaving the page mid-session always takes the keyboard out of calibration mode.
//
// Everything new in D is display: the counters, the "needs attention" list, the % on each key and the result card are
// read from the frames the store polls anyway. 0 new HID commands; the "Show raw ADC" switch only changes the view.
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import {
  IconActivity, IconAlertTriangle, IconArrowBarToDown, IconCheck, IconCircleCheck, IconCircleDashed, IconClock,
  IconPlayerPlay, IconRefresh, IconX,
} from '@tabler/icons-vue';
import KeyboardView from '../keyboard/KeyboardView.vue';
import { attachDemoPress } from '../live/demoPress';
import { checkScrollTarget } from '../live/keyCheck';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import Switch from '../ui/Switch.vue';
import { useToast } from '../ui/toast';
import CalStats from './CalStats.vue';
import { RECHECK_ROUTE } from './recheck';
import { useKeyLock } from '../../composables/useKeyLock';
import { useRovingFocus } from '../../composables/useRovingFocus';
import { useDeviceStore } from '../../stores/device';
import { usePerformanceStore } from '../../stores/performance';
import { useCalibrationStore } from '../../stores/calibration';
import type { MockTransport, PhysicalKey } from '../../protocol';
import type { LedGlow } from '../../ledGlow';
import { t } from '../../i18n/vi';

const device = useDeviceStore();
const perf = usePerformanceStore();
const cal = useCalibrationStore();
const toast = useToast();
const router = useRouter();

const confirmOpen = ref(false);
const running = computed(() => cal.phase === 'running');
const inSession = computed(() => cal.phase === 'running' || cal.phase === 'finishing');
const busy = computed(() => cal.phase === 'starting' || cal.phase === 'finishing');
let unmounted = false;

/** What the session card shows (DESIGN D §3.2). */
const mode = computed<'loading' | 'loaderr' | 'running' | 'saved' | 'none'>(() => {
  if (cal.phase !== 'idle') return 'running'; // starting too: the Start button spins as before
  if (!cal.loaded) return cal.error ? 'loaderr' : 'loading';
  return cal.lastSaved !== null ? 'saved' : 'none';
});

// ---- Keys (D2): the whole key lit in its status colour (part A's glow). The user chose this over the 5px LED bar of
// before (PLAN D2, 13/11). Plain --ok on a lit face: the text-mixed green the thin bar needed turns a light theme's key
// murky. The accessible name carries the status text and the ADC, so nothing is colour-only.
const STATUS_COLOR = ['var(--danger)', 'var(--info)', 'var(--ok)'];
const GLOW: LedGlow[] = STATUS_COLOR.map((led) => ({ led, level: 1 }));
const STATUS_TEXT = ['calibration.legendNone', 'calibration.legendDone', 'calibration.legendNew'] as const;
/** The status a key is shown in: newly calibrated stays green after saving, until the next session. */
const shown = (id: number) => (cal.isNew(id) ? 2 : cal.frame.status[id] ? 1 : 0);
// The store's lists are new arrays on every polled frame (66 ms, ~15 Hz), even when nothing changed. Kept the same array while
// the ids are the same, so the chips, the counters and the announcer only run when a key really joins or leaves a list
// (review D-PERF-1).
const sameIds = (a: readonly number[] | undefined, b: readonly number[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
const pressedIds = computed<readonly number[]>((prev) => (sameIds(prev, cal.pressedIds) ? prev! : cal.pressedIds));
const shallowIds = computed<readonly number[]>((prev) => (sameIds(prev, cal.shallowIds) ? prev! : cal.shallowIds));
const pressedSet = computed(() => new Set(pressedIds.value));
const shallowSet = computed(() => new Set(shallowIds.value));
// Until a real frame is read every status would be 0 ("not calibrated"): neutral, unlit keys instead.
const glow = (k: PhysicalKey) => (cal.loaded ? GLOW[shown(k.id)] : undefined);
const statusText = (k: PhysicalKey) => (cal.loaded ? `${t(STATUS_TEXT[shown(k.id)])} · ${t('calibration.keyAdc', { n: cal.frame.adc[k.id] })}` : undefined);
/** The key's current depth, filled from the top (as before). */
const fill = (k: PhysicalKey) => (cal.loaded ? Math.min(1, cal.frame.route[k.id] / cal.rangeUm(k.id)) : 0);
/** Rounded down (review D-ROUND-1): 94.6 % is "too shallow (under 95 %)" and must not read "95%". */
const pct = (id: number) => `${Math.min(100, Math.floor((cal.peakRoute[id] / cal.rangeUm(id)) * 100))}%`;
/** Raw ADC when asked; else the session's deepest %, on keys pressed in it (no "0%" on the rest, nothing before one). */
function sublabel(k: PhysicalKey): string | undefined {
  if (!cal.loaded) return undefined;
  if (showAdc.value) return String(cal.frame.adc[k.id]);
  return cal.peakTrusted && pressedSet.value.has(k.id) ? pct(k.id) : undefined;
}
const badgeIcon = (k: PhysicalKey) => (shallowSet.value.has(k.id) ? IconArrowBarToDown : undefined);
const badgeTitle = (k: PhysicalKey) => (shallowSet.value.has(k.id) ? t('calibration.keyShallow') : undefined);
const badgeClass = (k: PhysicalKey) => (shallowSet.value.has(k.id) ? 'cap__badge--shallow' : undefined);

/** "Show raw ADC" (display only, 0 HID), remembered in localStorage. */
const ADC_KEY = 'ae64.calibration.showAdc';
function readAdc(): boolean {
  try { return localStorage.getItem(ADC_KEY) === '1'; } catch { return false; }
}
const showAdc = ref(readAdc());
watch(showAdc, (on) => {
  try { localStorage.setItem(ADC_KEY, on ? '1' : '0'); } catch { /* storage may be blocked: the switch still works */ }
});
const keycapId = useId();
const adcHintId = useId();

// ---- Session card (D3, D4)
const keyById = computed(() => new Map(device.keys.map((k) => [k.id, k])));
const nameOf = (id: number) => { const k = keyById.value.get(id); return k ? device.legend(k) : String(id); };
const mm = (um: number) => (um / 1000).toFixed(2);
interface Chip { id: number; kind: 'shallow' | 'uncal'; before: string; name: string; after: string; label: string }
/** A chip sentence around the key's name (the name is drawn bold): the text before and after the `\u0000` placeholder. */
function splitKey(text: string): [string, string] {
  const at = text.indexOf('\u0000');
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
}
/** Needs attention (buildChips below). The same array while every chip is the same: a chip's text holds the peak, and the
 *  peaks are a new array every frame. */
const sameChips = (a: Chip[] | undefined, b: Chip[]) => !!a && a.length === b.length && a.every((c, i) => c.id === b[i].id && c.kind === b[i].kind && c.label === b[i].label);
const chips = computed<Chip[]>((prev) => {
  const next = buildChips();
  return sameChips(prev, next) ? prev! : next;
});
/** Needs attention, in keyboard order (DESIGN D §3.5): while running the keys too shallow; after a session or before
 *  one also every key still not calibrated (one chip per key, "not calibrated" winning). */
function buildChips(): Chip[] {
  const m = mode.value;
  if (m === 'loading' || m === 'loaderr') return [];
  const uncal = cal.loaded ? device.keys.filter((k) => cal.frame.status[k.id] === 0).map((k) => k.id) : [];
  const uncalSet = new Set(uncal);
  const out: Chip[] = [];
  for (const id of shallowIds.value) {
    if (m !== 'running' && uncalSet.has(id)) continue;
    const name = nameOf(id);
    const p = { mm: mm(cal.peakRoute[id]), range: mm(cal.rangeUm(id)) };
    const [before, after] = splitKey(t('calibration.chipShallow', { key: '\u0000', ...p }));
    out.push({ id, kind: 'shallow', before, name, after, label: `${t('calibration.announceShallow', { key: name, ...p })} ${t('calibration.markHint')}` });
  }
  if (m === 'saved' || m === 'none') {
    for (const id of uncal) {
      const name = nameOf(id);
      const [before, after] = splitKey(t('calibration.chipUncal', { key: '\u0000' }));
      out.push({ id, kind: 'uncal', before, name, after, label: `${t('calibration.uncalLabel', { key: name })} ${t('calibration.markHint')}` });
    }
  }
  return out;
}
/** The right column: the list; the green line only when every pressed key was confirmed by the firmware (status 2,
 *  DESIGN D §5: % and ⤓ are readings, not the firmware's word); a neutral line for keys still waiting / kept old. */
const right = computed<'attn' | 'ok' | 'wait' | 'empty' | null>(() => {
  if (chips.value.length) return 'attn';
  const m = mode.value;
  if ((m === 'running' || m === 'saved') && cal.pressedIds.length) return cal.waitIds.length ? 'wait' : 'ok';
  return m === 'running' ? 'empty' : null;
});
const progress = computed(() => (running.value ? cal.newCount : cal.calibratedCount));
/** Failure text for a session that ended badly: says whether the keyboard may still be calibrating. */
const sessionError = computed(() =>
  cal.error ? `${t('calibration.failed', { error: cal.error })} ${cal.stopFailed ? t('calibration.stopFailed') : t('calibration.stoppedNotSaved')}` : null,
);
const loadError = computed(() => (cal.error && !cal.loaded ? t('calibration.loadFailed', { error: cal.error }) : null));

// ---- Marking a key from its chip: an accent ring on the key (this board does not select). One key; cleared when it
// leaves the list, when a session starts, when the tab is left.
const pinId = ref<number | null>(null);
const marked = (k: PhysicalKey) => k.id === pinId.value;
watch(chips, (list) => { if (pinId.value !== null && !list.some((c) => c.id === pinId.value)) pinId.value = null; });
const chipsEl = ref<HTMLElement | null>(null);
const roving = useRovingFocus({ container: chipsEl, ids: () => chips.value.map((c) => c.id), orientation: 'both' });
const attnId = useId();
/** The chip list is exempt from the key lock (data-keylock): a keyboard user who Tabbed there moves between chips and
 *  marks one; only the keys that would scroll the page are stopped here. */
function onChipKey(e: KeyboardEvent, id: number): void {
  if (e.key === 'PageUp' || e.key === 'PageDown') { e.preventDefault(); return; }
  roving.onKeydown(e, id);
}

// ---- Screen reader: at most one sentence every 2 s, the newest replacing the one waiting (DESIGN D §7).
const ANNOUNCE_MS = 2000;
const announcement = ref('');
let announceAt = -Infinity;
let announceTimer: ReturnType<typeof setTimeout> | null = null;
let pending: string | null = null;
function say(text: string): void {
  pending = text;
  if (announceTimer) return;
  const wait = Math.max(0, announceAt + ANNOUNCE_MS - Date.now());
  announceTimer = setTimeout(() => {
    announceTimer = null;
    if (pending === null) return;
    announceAt = Date.now();
    announcement.value = ''; // emptied first, so the same sentence twice is read twice
    const text = pending;
    pending = null;
    void nextTick(() => { announcement.value = text; });
  }, wait);
}
let hadShallow = false;
watch(shallowIds, (now, before) => {
  if (!running.value) { hadShallow = now.length > 0; return; }
  const old = new Set(before ?? []);
  const added = now.filter((id) => !old.has(id));
  if (added.length) {
    const id = added[added.length - 1];
    say(t('calibration.announceShallow', { key: nameOf(id), mm: mm(cal.peakRoute[id]), range: mm(cal.rangeUm(id)) }));
  } else if (!now.length && hadShallow) say(t('calibration.allDeep'));
  hadShallow = now.length > 0;
});

// ---- Key lock while the session runs (DESIGN D §3.7, review D P2-b): keys typed by the board being calibrated must not
// scroll the page away from the keyboard and the card, nor press the focused button. Always on, no switch.
useKeyLock({ active: () => cal.phase === 'running' || cal.phase === 'finishing' });

// ---- Start, finish, cancel
const runningEl = ref<HTMLElement | null>(null);
const actionsEl = ref<HTMLElement | null>(null);
const resultEl = ref<HTMLElement | null>(null);
const sessionEl = ref<{ $el: HTMLElement } | null>(null);
const boardEl = ref<HTMLElement | null>(null);
const focusStart = () => actionsEl.value?.querySelector<HTMLElement>('button')?.focus();

/** Scroll the page so the whole session card shows, never past the keyboard's top (the rule of part C's ?check=1). */
function revealSession(): void {
  const card = sessionEl.value?.$el;
  const board = boardEl.value;
  const scroller = board?.closest<HTMLElement>('.main__scroll');
  if (!card || !board || !scroller) return;
  const view = scroller.getBoundingClientRect();
  const top = document.querySelector<HTMLElement>('.top');
  const target = checkScrollTarget({
    scrollTop: scroller.scrollTop,
    viewTop: view.top,
    viewHeight: view.height,
    titleBottom: top ? top.getBoundingClientRect().bottom : view.top,
    cardBottom: card.getBoundingClientRect().bottom,
    boardTop: board.getBoundingClientRect().top,
  });
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (Math.abs(target - scroller.scrollTop) >= 1) scroller.scrollTo({ top: target, behavior: reduce ? 'auto' : 'smooth' });
}

async function begin() {
  confirmOpen.value = false;
  await cal.start();
  if (unmounted) { await cal.cancel(); return; }
  if (cal.error) { toast.show(sessionError.value ?? '', 'error'); return; }
  if (cal.phase !== 'running') return;
  pinId.value = null;
  hadShallow = false;
  await nextTick();
  // focus a status line, not a button: Space / Enter typed by the board being calibrated press nothing
  runningEl.value?.focus({ preventScroll: true });
  revealSession();
}

/** Saved only when the store went through the commit: `lastSaved` is set there and nowhere else (review D, P1). */
async function commit() {
  const ok = await cal.finish();
  if (cal.lastSaved !== null) {
    toast.show(t('calibration.saved'), 'success');
    await nextTick();
    resultEl.value?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true }); // Finish is gone: not to body
    revealSession(); // the result row is taller than the status line: keep the whole card on screen (§2), same rule as at start
  } else if (!ok) {
    toast.show(sessionError.value ?? '', 'error');
    await nextTick();
    focusStart();
  }
}

/** Finish asks first (instead of window.confirm) when nothing is new or keys still need attention (DESIGN D §3.6). */
const finishAsk = ref(false);
const needAsk = () => cal.newCount === 0 || cal.shallowIds.length > 0 || cal.uncalibratedCount > 0;
const finishBody = computed(() => {
  if (cal.newCount === 0) return t('calibration.confirmEmpty');
  const parts: string[] = [];
  if (cal.shallowIds.length) parts.push(t('calibration.finishShallow', { n: cal.shallowIds.length }));
  if (cal.uncalibratedCount) parts.push(t('calibration.finishUncal', { n: cal.uncalibratedCount }));
  return t('calibration.finishBody', { list: parts.join(` ${t('calibration.and')} `) });
});
function onFinish() {
  if (needAsk()) finishAsk.value = true;
  else void commit();
}
let savingFromDialog = false;
async function saveAnyway() {
  savingFromDialog = true;
  finishAsk.value = false;
  if (cal.phase !== 'running') { savingFromDialog = false; return; } // the session ended while the dialog was open
  await commit();
  savingFromDialog = false;
}
// The dialog is not modal in time: the session can end while it is open (a failed read, a lost connection). Close it then.
watch(() => cal.phase, (p) => { if (p !== 'running') finishAsk.value = false; });
// Closed without saving (Keep pressing, Esc, backdrop, or closed above): the Dialog gives focus back to Finish, where a
// Space / Enter typed by the board would save. Move it on: the status line while running, Start once the session ended.
watch(finishAsk, async (open, was) => {
  if (open || !was || savingFromDialog) return;
  await nextTick();
  if (cal.phase === 'running') runningEl.value?.focus({ preventScroll: true });
  else if (cal.phase === 'idle') focusStart();
});

// The session ended on its own (a failed read, a lost connection): the status line that held focus is gone and focus would
// fall to body. Start, as after the dialog closes on an ended session (§7). Only when focus was really lost.
watch(() => cal.phase, async (p, was) => {
  if (p !== 'idle' || (was !== 'running' && was !== 'finishing') || !cal.error) return;
  await nextTick();
  const a = document.activeElement;
  if (!a || a === document.body) focusStart();
});

async function cancel() {
  const ok = await cal.cancel();
  if (ok) toast.show(t('calibration.cancelled'), 'info');
  else toast.show(`${t('calibration.cancelFailed', { error: cal.error ?? '' })} ${cal.stopFailed ? t('calibration.stopFailed') : ''}`.trim(), 'error');
  await nextTick();
  focusStart();
}

function recheck() {
  void router.push(RECHECK_ROUTE);
}

// Leaving mid-session stops calibration without saving (onBeforeUnmount): ask first.
onBeforeRouteLeave(() => (running.value ? window.confirm(t('calibration.confirmLeave')) : true));

// demo: PC keyboard presses bottom out the matching key
let detachDemo: (() => void) | null = null;
watch(() => device.demo && device.transport?.kind === 'mock', (on) => {
  detachDemo?.();
  detachDemo = on ? attachDemoPress(device.transport as MockTransport) : null;
}, { immediate: true });

function warnLeave(e: BeforeUnloadEvent) {
  if (cal.phase !== 'idle') e.preventDefault();
}

let offProfile: (() => void) | null = null;
onMounted(() => {
  void perf.load();
  void cal.refresh();
  offProfile = device.onProfileChanged(() => void cal.refresh());
  window.addEventListener('beforeunload', warnLeave);
});
onDeactivated(() => { pinId.value = null; });
onBeforeUnmount(() => {
  unmounted = true;
  // Never leave the keyboard in calibration mode (no commit: leaving is not "Hoàn tất").
  if (running.value) void cal.cancel();
  offProfile?.();
  detachDemo?.();
  window.removeEventListener('beforeunload', warnLeave);
  if (announceTimer) clearTimeout(announceTimer);
});
</script>

<template>
  <section class="kbrow">
    <div ref="boardEl" class="board" :class="{ 'board--live': running }">
      <KeyboardView
        :keys="device.keys"
        :legend="device.legend"
        :sublabel="sublabel"
        :fill="fill"
        led-style="glow"
        :glow="glow"
        :badge-icon="badgeIcon"
        :badge-title="badgeTitle"
        :badge-class="badgeClass"
        :status="statusText"
        :marked="marked"
        :describedby="keycapId"
      />
    </div>
    <aside class="aside">
      <p :id="keycapId" class="kblegend">
        <span class="kl__item"><span class="kl__k">{{ t('sel.shows') }}:</span>{{ t('calibration.keycapColor') }}
          <span v-for="(c, s) in STATUS_COLOR" :key="c" class="lg"><i class="lg__sw" :style="{ '--led': c }" />{{ t(STATUS_TEXT[s]) }}</span></span>
        <span v-if="showAdc" class="kl__item"><span class="kl__num">2760</span> {{ t('calibration.keycapAdc') }}</span>
        <span v-else-if="cal.hasSession && cal.peakTrusted" class="kl__item"><span class="kl__num">86%</span> {{ t('calibration.keycapPct') }}</span>
        <!-- for the whole session and after it, not only while a key is too shallow: chips come and go as keys are pressed
             and the line would wrap and unwrap, moving the card (review D-LEGEND-1) -->
        <span v-if="cal.hasSession && cal.peakTrusted" class="kl__item"><span class="kl__ico"><IconArrowBarToDown :size="14" stroke-width="1.8" aria-hidden="true" /></span>{{ t('calibration.keycapShallow') }}</span>
      </p>
      <Switch v-model="showAdc" class="aside__adc" :label="t('calibration.showAdc')" :title="t('calibration.showAdcHint')" :describedby="adcHintId" />
      <span :id="adcHintId" class="sr-only">{{ t('calibration.showAdcHint') }}</span>
    </aside>
  </section>

  <Card ref="sessionEl" class="progress">
    <div class="ses__top">
      <div class="ses__state">
        <div v-if="mode === 'loaderr'" class="alert" role="alert">
          <IconAlertTriangle :size="14" />
          <span>{{ loadError }}</span>
          <Button size="sm" variant="ghost" :icon="IconRefresh" @click="cal.refresh()">{{ t('calibration.retry') }}</Button>
        </div>
        <p v-else-if="mode === 'loading'" class="hint" role="status">{{ t('calibration.loading') }}</p>
        <p v-else-if="mode === 'running'" ref="runningEl" class="running" role="status" tabindex="-1"><span class="pulse" />{{ t('calibration.running') }}</p>
        <div v-else-if="mode === 'saved'" ref="resultEl" class="result" role="status">
          <IconCircleCheck :size="20" aria-hidden="true" />
          <div>
            <p class="result__t">{{ t('calibration.result', { n: cal.sessionNewCount }) }}</p>
            <p class="result__s">{{ t('calibration.resultSub') }}</p>
          </div>
          <Button variant="primary" size="sm" :icon="IconActivity" @click="recheck">{{ t('calibration.recheck') }}</Button>
        </div>
        <p v-else-if="cal.uncalibratedCount === 0" class="done" role="status"><IconCheck :size="14" />{{ t('calibration.allDone') }}</p>
        <p v-else class="warn">{{ t('calibration.uncalibrated', { n: cal.uncalibratedCount }) }}</p>
      </div>
      <div ref="actionsEl" class="actions">
        <template v-if="inSession">
          <Button variant="primary" :icon="IconCheck" :loading="cal.phase === 'finishing'" @click="onFinish">{{ t('calibration.finish') }}</Button>
          <Button variant="ghost" :icon="IconX" :disabled="busy" @click="cancel">{{ t('calibration.cancel') }}</Button>
        </template>
        <Button
          v-else
          :variant="mode === 'saved' ? 'secondary' : 'primary'"
          :icon="IconPlayerPlay"
          :loading="cal.phase === 'starting'"
          :disabled="!device.boardAllowed || !cal.loaded"
          @click="confirmOpen = true"
        >
          {{ t('calibration.start') }}
        </Button>
      </div>
    </div>

    <div class="ses__body" :class="{ 'ses__body--two': right !== null }">
      <div class="ses__stats">
        <CalStats
          :pressed="cal.hasSession ? pressedIds.length : null"
          :fresh="cal.hasSession ? cal.sessionNewCount : null"
          :shallow="cal.hasSession ? shallowIds.length : null"
          :uncal="cal.loaded ? cal.uncalibratedCount : null"
          :total="device.keys.length"
        />
        <p v-if="cal.loaded" class="sub">{{ running ? t('calibration.progressSession', { n: progress }) : t('calibration.progress', { n: progress }) }}</p>
        <div class="bar" :class="{ 'bar--new': running }" aria-hidden="true"><span :style="{ transform: `scaleX(${cal.loaded ? progress / 64 : 0})` }" /></div>
      </div>
      <div v-if="right === 'attn'" class="attn">
        <div class="attn__head"><span :id="attnId" class="micro">{{ t('calibration.attention') }}</span><span class="attn__n">{{ chips.length }}</span></div>
        <ul ref="chipsEl" class="chips" :aria-labelledby="attnId" data-keylock>
          <li v-for="c in chips" :key="c.id">
            <button
              type="button"
              class="chip"
              :class="`chip--${c.kind}`"
              :data-rid="c.id"
              :tabindex="roving.tabindex(c.id)"
              :aria-pressed="pinId === c.id"
              :aria-label="c.label"
              :title="t('calibration.markHint')"
              @focus="roving.onFocus(c.id)"
              @keydown="onChipKey($event, c.id)"
              @click="pinId = pinId === c.id ? null : c.id"
            >
              <IconArrowBarToDown v-if="c.kind === 'shallow'" :size="14" stroke-width="1.8" aria-hidden="true" />
              <IconCircleDashed v-else :size="14" stroke-width="1.8" aria-hidden="true" />
              <span>{{ c.before }}<b>{{ c.name }}</b>{{ c.after }}</span>
            </button>
          </li>
        </ul>
        <p class="attn__hint">{{ mode === 'running' ? t('calibration.attentionHint') : t('calibration.attentionHintAfter') }}</p>
      </div>
      <p v-else-if="right === 'ok'" class="okline"><IconCircleCheck :size="16" aria-hidden="true" />{{ t('calibration.allDeep') }}</p>
      <p v-else-if="right === 'wait'" class="okline okline--wait">
        <IconClock :size="16" aria-hidden="true" />{{ mode === 'running' ? t('calibration.waitConfirm', { n: cal.waitIds.length }) : t('calibration.keptOld', { n: cal.waitIds.length }) }}
      </p>
      <p v-else-if="right === 'empty'" class="empty">{{ t('calibration.noneYet') }}</p>
    </div>

    <div v-if="(sessionError && cal.phase === 'idle') || !device.boardAllowed || device.demo" class="ses__notes">
      <p v-if="sessionError && cal.phase === 'idle'" class="alert" role="alert"><IconAlertTriangle :size="14" />{{ sessionError }}</p>
      <p v-if="!device.boardAllowed" class="warn">{{ t('calibration.readOnly') }}</p>
      <p v-if="device.demo" class="hint">{{ t('calibration.demoHint') }}</p>
    </div>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </Card>

  <div class="grid">
    <Card :title="t('page.calibration')" :subtitle="t('calibration.intro')">
      <span class="micro">{{ t('calibration.steps') }}</span>
      <ol class="steps">
        <li :class="{ done: running }"><span class="steps__n num">1</span>{{ t('calibration.step1') }}</li>
        <li :class="{ now: running }"><span class="steps__n num">2</span>{{ t('calibration.step2') }}</li>
        <li><span class="steps__n num">3</span>{{ t('calibration.step3') }}</li>
      </ol>
    </Card>
  </div>

  <Dialog v-model:open="confirmOpen" :title="t('calibration.confirmTitle')">
    <p class="dlg-body">{{ t('calibration.confirmBody') }}</p>
    <template #footer>
      <Button variant="ghost" @click="confirmOpen = false">{{ t('calibration.cancel') }}</Button>
      <Button variant="primary" :icon="IconPlayerPlay" @click="begin">{{ t('calibration.start') }}</Button>
    </template>
  </Dialog>

  <Dialog v-model:open="finishAsk" :title="t('calibration.finishTitle')">
    <p class="dlg-body">{{ finishBody }}</p>
    <template #footer>
      <Button variant="ghost" @click="finishAsk = false">{{ t('calibration.keepPressing') }}</Button>
      <Button variant="primary" :icon="IconCheck" @click="saveAnyway">{{ t('calibration.saveAnyway') }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
/* The keycap legend is a row under the keyboard at every width, so the keyboard sits where the Switch tab's does. */
.kbrow { display: flex; flex-direction: column; gap: var(--s-3); margin-bottom: var(--s-4); }
.board { width: 100%; min-width: 0; max-width: 940px; margin: 0 auto; border-radius: var(--r-panel); transition: box-shadow var(--t-slow) var(--ease); }
.board--live { box-shadow: 0 0 0 1px var(--acc-line); }
/* review D-PERF-1: the fill follows a ~15 Hz poll (66 ms), so its transform transition (--t-med) kept up to 64 fills animating
   all session long and put the keys' % in composited layers over them. It jumps to each reading instead. */
.board :deep(.cap__fill) { transition: none; }
@media (min-width: 1600px) { .board { max-width: 1100px; } }

/* D5. Row under the keyboard: keycap legend left (one item per meaning, items wrap whole), "Show raw ADC" right. */
.aside { display: flex; flex-wrap: nowrap; align-items: flex-start; gap: var(--s-4); min-height: 36px; } /* = the Switch tab's selection bar */
.kblegend {
  flex: 1 1 auto; min-width: 0; margin: 0; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--s-5);
  font-size: var(--fs-label); line-height: 22px; color: var(--fg-2);
}
.kl__k { color: var(--fg-3); font-weight: 500; margin-right: 6px; }
.kl__num { font-weight: 600; color: var(--fg-1); font-variant-numeric: tabular-nums; }
.kl__item { white-space: nowrap; }
.kl__ico { display: inline-flex; vertical-align: -2px; margin-right: 3px; color: color-mix(in srgb, var(--warn) 60%, var(--fg-1)); }
/* status swatch: a tiny glowing keycap in the status colour, the same recipe as part A's .cap--glow */
.lg { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; vertical-align: top; margin-left: 6px; margin-right: 6px; color: var(--fg-1); }
.lg:last-child { margin-right: 0; }
.lg__sw {
  flex: none; width: 14px; height: 14px; border-radius: 3px;
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--led) var(--led-tint-top), var(--cap-top)),
    color-mix(in srgb, var(--led) var(--led-tint-bottom), var(--cap-bottom)));
  border: 1px solid color-mix(in srgb, var(--led) 65%, transparent);
  box-shadow: inset 0 -4px 6px -2px color-mix(in srgb, var(--led) 55%, transparent), 0 0 6px -1px color-mix(in srgb, var(--led) 50%, transparent);
}
.aside__adc { flex: none; margin-top: 1px; white-space: nowrap; }

.hint { color: var(--fg-3); font-size: var(--fs-label); }
.warn { color: var(--warn); font-size: var(--fs-label); }
.alert {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0;
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-control);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-label);
}
.alert svg { flex: none; margin-top: 1px; }
.done { display: flex; align-items: center; gap: 6px; color: var(--ok); font-size: var(--fs-label); }

/* D3/D4. Session card: full width right under the keyboard, so the counters, the attention list and Finish stay on
   screen with the keyboard at 1280×720 once the page scrolls to the keyboard's top. */
.progress { display: flex; flex-direction: column; gap: var(--s-4); margin-bottom: var(--s-4); container-type: inline-size; }
.ses__top { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-3) var(--s-4); min-height: 34px; }
.ses__state { flex: 1 1 320px; min-width: 0; }
.ses__state > * { margin: 0; }
.actions { display: flex; gap: var(--s-2); flex: none; margin-left: auto; }
.ses__body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s-4) var(--s-6); align-items: start; }
.ses__body--two { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
@container (max-width: 760px) { .ses__body--two { grid-template-columns: minmax(0, 1fr); } }
.ses__stats { display: flex; flex-direction: column; gap: var(--s-2); }
.ses__notes { display: flex; flex-direction: column; gap: var(--s-2); }
.ses__notes > * { margin: 0; }
.running { display: flex; align-items: center; gap: var(--s-2); margin: 0; color: var(--acc); font-size: var(--fs-label); font-weight: 500; }
/* focused on start so a typed Space/Enter does not hit a button; it is a status line, not a control: no ring (§7), also
   once keys were typed (the global :focus-visible ring is a box-shadow) */
.running:focus, .running:focus-visible { outline: none; box-shadow: none; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--acc); animation: pulse 1.4s var(--ease) infinite; }
@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.sub { margin: var(--s-1) 0 0; color: var(--fg-2); font-size: var(--fs-label); }
.bar { height: 6px; border-radius: 3px; background: var(--bg-4); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--info); transform-origin: left; transition: transform var(--t-slow) var(--ease); }
.bar--new span { background: var(--ok); }

/* D3. "Needs attention" (the same chip look as part C) */
.attn { display: flex; flex-direction: column; gap: var(--s-2); min-width: 0; contain: content; } /* D-PERF-1: a chip change stays inside */
.attn__head { display: flex; align-items: baseline; gap: 6px; }
.attn__n { font-size: var(--fs-caption); color: var(--fg-2); font-variant-numeric: tabular-nums; font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 2px; list-style: none; max-height: 96px; overflow-y: auto; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px 0 7px;
  font: inherit; font-size: var(--fs-label); color: var(--fg-2); white-space: nowrap; cursor: pointer;
  background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--r-control);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.chip b { color: var(--fg-1); font-weight: 600; }
.chip svg { flex: none; }
.chip--shallow svg { color: var(--warn); }
.chip--uncal svg { color: var(--danger); }
.chip--uncal { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.chip:hover { background: var(--bg-4); }
.chip[aria-pressed='true'] { border-color: var(--acc); background: var(--sel-bg); color: var(--fg-1); }
.attn__hint, .empty { margin: 0; font-size: var(--fs-label); color: var(--fg-3); }
.okline {
  display: flex; align-items: center; gap: var(--s-2); margin: 0; padding: var(--s-2) var(--s-3);
  border-radius: var(--r-control); font-size: var(--fs-label); background: var(--ok-soft); color: var(--fg-1); font-weight: 500;
}
.okline svg { flex: none; color: var(--ok); } /* text stays --fg-1: --ok on --ok-soft is only 3.3:1 in the light themes */
/* review D P2-c: pressed keys still waiting for the firmware, or kept their old calibration after saving. Neutral, not
   green: % and ⤓ come from route, only status 2 is the firmware's word. */
.okline.okline--wait { background: var(--bg-2); color: var(--fg-2); }
.okline.okline--wait svg { color: var(--fg-3); }
@media (prefers-reduced-motion: reduce) { .chip { transition: none; } }

/* D4. Result after a successful Finish (top row of the session card) */
.result {
  display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap;
  padding: var(--s-2) var(--s-3); border-radius: var(--r-control); background: var(--ok-soft); color: var(--fg-1);
}
.result > svg { flex: none; color: var(--ok); }
.result > div { flex: 1 1 220px; min-width: 0; }
.result__t { margin: 0; font-weight: 600; font-size: var(--fs-body); }
.result__s { margin: 1px 0 0; font-size: var(--fs-label); color: var(--fg-2); }

/* Steps card: alone on its row now, so the three steps sit side by side (they stack again under 760 px of card). */
.grid { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--s-4); }
.grid > :deep(.card) { container-type: inline-size; }
.steps { list-style: none; margin: var(--s-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--s-3); }
@container (min-width: 760px) {
  .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-4); }
}
.steps li { display: flex; gap: var(--s-3); align-items: flex-start; color: var(--fg-2); transition: color var(--t-fast) var(--ease); }
.steps__n {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: var(--fs-caption);
  font-weight: 600;
  border: 1px solid var(--line-2);
  color: var(--fg-3);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.steps li.done { color: var(--fg-3); }
.steps li.done .steps__n { background: var(--bg-4); color: var(--fg-2); }
.steps li.now { color: var(--fg-1); }
.steps li.now .steps__n { background: var(--acc); border-color: var(--acc); color: var(--on-acc); }
.dlg-body { color: var(--fg-2); line-height: 1.55; }
</style>
