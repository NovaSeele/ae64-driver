// Live travel ("Đo hành trình thật"): a single-in-flight poller over `04 03` axis data, a ring buffer for
// the focused key, and an actuation model that predicts from the key's settings what the firmware should
// report, so the page can mark where the key fired and flag when firmware and settings disagree.
//
// Hot data (samples, per-key travel) lives in a plain `markRaw` object that pages read from rAF; only
// rarely-changing state (focus, running/paused) is reactive.
import { defineStore } from 'pinia';
import { markRaw, ref, watch } from 'vue';
import { FIRMWARE_ROWS, isRtMode } from '../protocol';
import type { AxisDataType, Performance, PhysicalKey } from '../protocol';
import { useDeviceStore } from './device';
import { rangeMm, usePerformanceStore } from './performance';

// ---------------------------------------------------------------------------------------------- model

/** The settings of one key that decide when it actuates (mm). */
export interface ActuationSettings {
  mode: number;
  normalPress: number;
  normalRelease: number;
  rtFirstTouch: number;
  rtPress: number;
  rtRelease: number;
  pressDeadStroke: number;
  releaseDeadStroke: number;
  range: number;
}

export function settingsFrom(p: Performance): ActuationSettings {
  return {
    mode: p.mode, normalPress: p.normalPress, normalRelease: p.normalRelease, rtFirstTouch: p.rtFirstTouch,
    rtPress: p.rtPress, rtRelease: p.rtRelease, pressDeadStroke: p.pressDeadStroke, releaseDeadStroke: p.releaseDeadStroke,
    range: rangeMm(p),
  };
}

/** Standard-mode release point: normalRelease when set and not deeper than the press point, else normalPress. */
export function releasePoint(s: ActuationSettings): number {
  return s.normalRelease > 0 ? Math.min(s.normalRelease, s.normalPress) : s.normalPress;
}

const EPS = 1e-6;

/**
 * What the key should do for a travel sequence, from its settings.
 * - Dead zones: travel inside the top band [0, pressDeadStroke] counts as 0 (never actuates); travel inside
 *   the bottom band [range − releaseDeadStroke, range] counts as fully pressed.
 * - Standard: actuates at ≥ normalPress, releases below the release point.
 * - Rapid Trigger: first actuation at rtFirstTouch; while actuated it releases once the key rises rtRelease
 *   above its deepest point (peak); while released it re-actuates once it goes rtPress below its highest
 *   point (trough). With Continuous RT (mode 1) this tracking lasts until the key is fully up (inside
 *   the top dead zone); without it (mode 2) rising above rtFirstTouch resets, like the factory driver's
 *   IntervalRT.
 */
export class ActuationModel {
  actuated = false;
  /** RT: the first actuation happened and the key has not reset since (fully up, or above rtFirstTouch in mode 2). */
  armed = false;
  peak = 0;
  trough = 0;

  constructor(public settings: ActuationSettings) {}

  reset(): void {
    this.actuated = false;
    this.armed = false;
    this.peak = 0;
    this.trough = 0;
  }

  effective(mm: number): number {
    const s = this.settings;
    if (mm <= s.pressDeadStroke + EPS) return 0;
    if (s.releaseDeadStroke > 0 && mm >= s.range - s.releaseDeadStroke - EPS) return s.range;
    return mm;
  }

  /** Feed one travel sample (mm); returns the transition it caused, if any. */
  update(mm: number): 'press' | 'release' | null {
    const s = this.settings;
    const e = this.effective(mm);
    if (!isRtMode(s.mode)) {
      if (!this.actuated && e >= s.normalPress - EPS) return this.transition(true);
      if (this.actuated && e < releasePoint(s) - EPS) return this.transition(false);
      return null;
    }
    // Continuous RT (mode 1) stays active until the key is fully up; without it (mode 2) RT resets as
    // soon as the key rises above the first actuation point.
    const reset = s.mode === 1 ? e <= EPS : e < s.rtFirstTouch - EPS;
    if (reset) {
      this.armed = false;
      return this.actuated ? this.transition(false) : null;
    }
    if (!this.armed) {
      if (e < s.rtFirstTouch - EPS) return null;
      this.armed = true;
      this.peak = e;
      return this.transition(true);
    }
    if (this.actuated) {
      this.peak = Math.max(this.peak, e);
      if (e <= this.peak - s.rtRelease + EPS) {
        this.trough = e;
        return this.transition(false);
      }
      return null;
    }
    this.trough = Math.min(this.trough, e);
    if (e >= this.reactuateThreshold() - EPS) {
      this.peak = e;
      return this.transition(true);
    }
    return null;
  }

  /** Bring the state in line with the key's current depth (mm) without emitting an event (a stale model restored after the key moved unseen). */
  sync(mm: number): void {
    const s = this.settings;
    const e = this.effective(mm);
    if (!isRtMode(s.mode)) {
      if (e >= s.normalPress - EPS) this.actuated = true;
      else if (e < releasePoint(s) - EPS) this.actuated = false;
      return;
    }
    if (s.mode === 1 ? e <= EPS : e < s.rtFirstTouch - EPS) {
      this.reset();
      return;
    }
    this.armed = true;
    this.actuated = e >= s.rtFirstTouch - EPS;
    this.peak = e;
    this.trough = e;
  }

  /** Raw depth (mm) where the bottom dead zone starts (everything from here reads as full travel); the range without one. */
  bottomAt(): number { // public for the same reason as transition()
    const s = this.settings;
    return s.releaseDeadStroke > 0 ? s.range - s.releaseDeadStroke : s.range;
  }

  /**
   * RT, actuated: the key releases when it rises above this raw depth (mm), the depth where update() emits the release
   * (LIVE-REACT-1). Inside the top dead zone travel reads 0, so with Continuous RT a release target there happens at
   * pressDeadStroke; a target inside the bottom dead zone happens on leaving it.
   */
  get resetAt(): number | null {
    const s = this.settings;
    if (!isRtMode(s.mode) || !this.actuated) return null;
    return Math.max(Math.min(this.peak - s.rtRelease, this.bottomAt()), s.mode === 1 ? s.pressDeadStroke : s.rtFirstTouch);
  }

  /**
   * RT, released after a first actuation: the key re-actuates when it goes below this raw depth (mm), the depth where
   * update() emits the press (LIVE-REACT-1): the bottom dead zone reads as full travel, so a target inside it happens
   * as soon as the key enters it, as the firmware does.
   */
  get reactuateAt(): number | null {
    const s = this.settings;
    return isRtMode(s.mode) && this.armed && !this.actuated ? Math.min(this.reactuateThreshold(), this.bottomAt()) : null;
  }

  /** trough + rtPress, but never past the bottom: a key lifted near the bottom re-actuates on reaching it
   *  (the bottom dead zone reads as full travel), as the firmware does. In effective travel, used by update(). */
  reactuateThreshold(): number {
    return Math.min(this.trough + this.settings.rtPress, this.settings.range);
  }

  /** Record a transition (public only so Pinia's unwrapped store type stays assignable). */
  transition(on: boolean): 'press' | 'release' {
    this.actuated = on;
    return on ? 'press' : 'release';
  }
}

// ------------------------------------------------------------------------------------------ buffers

/** Fixed-size ring of {t, mm} samples (t = performance.now() ms). */
export class TravelRing {
  readonly t: Float64Array;
  readonly mm: Float32Array;
  head = 0;
  size = 0;

  constructor(readonly capacity: number) {
    this.t = new Float64Array(capacity);
    this.mm = new Float32Array(capacity);
  }

  push(t: number, mm: number): void {
    this.t[this.head] = t;
    this.mm[this.head] = mm;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  /** Drop the n newest samples (a rollback). More than the ring holds: the older ones are already overwritten, keep what is there. */
  dropNewest(n: number): void {
    if (n > this.size) return;
    this.head = (this.head - n + this.capacity) % this.capacity;
    this.size -= n;
  }

  /** Visit samples oldest → newest whose time is ≥ from. */
  forEach(from: number, cb: (t: number, mm: number) => void): void {
    const start = (this.head - this.size + this.capacity) % this.capacity;
    for (let i = 0; i < this.size; i++) {
      const k = (start + i) % this.capacity;
      if (this.t[k] >= from) cb(this.t[k], this.mm[k]);
    }
  }
}

export interface LiveEvent { t: number; kind: 'press' | 'release'; depth: number }

/** ≥ 3 s at the measured 1,670 row reads/s. */
const RING_SIZE = 8192;
const EVENT_CAP = 200;
/** Firmware status is read every STATUS_EVERY ticks for the focused row. */
const STATUS_EVERY = 4;
/** computed ≠ firmware must persist this long (ms) before it counts as a mismatch (status lags route). */
export const MISMATCH_MS = 120;
/** Auto-follow: a key must be this deep (mm) and this much deeper than the focused key to take focus. */
const FOLLOW_MIN = 0.15;
const FOLLOW_MARGIN = 0.1;
/** A press starts (peak resets) when travel leaves this band at the top (mm). */
const REST_MM = 0.05;
const PAUSE_POLL_MS = 40;
const RATE_WINDOW_MS = 500;
/** Auto-follow switches kept for undoAutoFollow. */
const SWITCH_LOG_CAP = 64; // Shift held + n Tabs logs 2 links per Tab; keep the chain back to the reviewed key
/** HID usages the OS moves keyboard focus on: Tab, Left Shift, Right Shift. */
const FOCUS_CODES = [0x2b, 0xe1, 0xe5];
/** Physical key names standing in for a keycode while the keymap is not loaded. */
const FALLBACK_NAMES = new Map<number, string>([[0x2b, 'Tab'], [0xe1, 'Shift'], [0xe5, 'Shift'], [0x2c, 'Space'], [0x28, 'Enter'], [0x58, 'Enter']]);
/** A UI-pressed mark that saw no travel within this long (ms) is dropped (the keystroke never registered as travel). */
const UI_MARK_MS = 400;

// Key check ("Kiểm tra sức khoẻ"): computed only from the `04 03` reads the poller already makes.
/** A key counts as pressed (row in the table, mark on the keycap, counters) once deeper than this (mm). */
export const PRESSED_MM = 0.3;
/**
 * "Not back to 0": a key that went deeper than REST_ARM_MM, then reads released (status 0) while still deeper than
 * REST_OFF_MM for longer than REST_OFF_MS, is stuck. It clears as soon as travel drops below REST_OFF_MM. Status is read
 * interleaved with route (the focused row every 4 ticks, other rows in turn), so the test uses the newest status read;
 * that lag is why the time threshold is 800 ms and not less. A key held partway with Rapid Trigger (released mid-travel)
 * counts too: it is not at 0.
 */
export const REST_ARM_MM = 0.5;
export const REST_OFF_MM = 0.2;
export const REST_OFF_MS = 800;
/** Screen readers hear a stuck key only once it stayed stuck this long (ms), so a short pause of the finger is not read aloud. */
export const STUCK_ANNOUNCE_MS = 2000;
/** A key reached full travel when its deepest reading is at least this share of the switch travel. */
export const FULL_TRAVEL = 0.95;

export interface LiveData {
  /** Latest per-key travel (mm), fill ratio (route / axisRangeMax) and firmware status, by PhysicalKey.id. */
  travel: Float32Array;
  ratio: Float32Array;
  status: Uint8Array;
  /** Focused key. */
  ring: TravelRing;
  events: LiveEvent[];
  model: ActuationModel | null;
  current: number;
  peak: number;
  count: number;
  lastActuation: number | null;
  lastRelease: number | null;
  /** Firmware status of the focused key (1…7 = pressed). */
  firmwarePressed: boolean;
  mismatch: boolean;
  mismatchSince: number | null;
  /** Focused-row route reads per second. */
  rateHz: number;
  /** True once any sample arrived for the focused key since focus changed. */
  touched: boolean;
  /** Incremented on every ingest so renderers can skip unchanged frames. */
  version: number;
  /** Incremented only when the focused-key buffers are reset (clear(); setFocus() calls clear). Display code uses it to drop held state. */
  epoch: number;
  /** Deepest travel (mm) and ratio since the check started (resetPeaks), by PhysicalKey.id. */
  peakMm: Float32Array;
  peakRatio: Float32Array;
  /** Travel (mm) a key is stuck at: deeper than REST_OFF_MM for REST_OFF_MS while the firmware says released. 0 = none. */
  restOffMm: Float32Array;
  /** When each key's current stuck stretch began (ingest clock), -1 when it is not stuck-candidate. */
  offSince: Float64Array;
  /** performance.now() (ingest clock) at the last resetPeaks(). */
  checkStartedAt: number;
  /** Keys whose peakMm went above PRESSED_MM since checkStartedAt. */
  pressedIds: Set<number>;
  /** Incremented whenever peakMm, restOffMm or pressedIds change (lets the page skip unchanged frames). */
  checkVersion: number;
}

function emptyData(): LiveData {
  return markRaw({
    travel: new Float32Array(64), ratio: new Float32Array(64), status: new Uint8Array(64),
    ring: new TravelRing(RING_SIZE), events: [], model: null,
    current: 0, peak: 0, count: 0, lastActuation: null, lastRelease: null,
    firmwarePressed: false, mismatch: false, mismatchSince: null, rateHz: 0, touched: false, version: 0, epoch: 0,
    peakMm: new Float32Array(64), peakRatio: new Float32Array(64), restOffMm: new Float32Array(64),
    offSince: new Float64Array(64).fill(-1), checkStartedAt: 0, pressedIds: new Set<number>(), checkVersion: 0,
  });
}

/** The focused-key buffers of a key auto-follow switched away from, kept so undoAutoFollow can give them back. */
interface FocusStash {
  /** The key the buffers belong to. */
  id: number;
  ring: TravelRing;
  events: LiveEvent[];
  model: ActuationModel | null;
  peak: number;
  count: number;
  lastActuation: number | null;
  lastRelease: number | null;
  mismatch: boolean;
  mismatchSince: number | null;
  touched: boolean;
}

/** The focused key's state when its current press began, so a UI stroke's already-ingested frames can be rolled back. */
interface PressSnapshot {
  count: number;
  peak: number;
  lastActuation: number | null;
  lastRelease: number | null;
  mismatch: boolean;
  mismatchSince: number | null;
  touched: boolean;
  model: { actuated: boolean; armed: boolean; peak: number; trough: number } | null;
  /** ringPushes when the press began. */
  pushes: number;
  /** eventPushes when the press began. */
  eventPushes: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------- store

export const useLiveStore = defineStore('live', () => {
  const device = useDeviceStore();
  const perf = usePerformanceStore();

  const data = emptyData();
  const focusId = ref<number | null>(null);
  /** Auto-follow the deepest key; false = pinned to focusId. */
  const follow = ref(true);
  /** True while the travel graph is panned or focused: auto-follow keeps the focused key so the review is not wiped. */
  let followSuspended = false;
  /** Pinned mode: also poll the other rows for the keyboard heat view. */
  const allKeys = ref(true);
  const running = ref(false);
  /** Polling is held while a write job runs, the tab is hidden or the device is busy. */
  const paused = ref(false);

  /** Recent auto-follow switches (same clock as ingest's `now`); cleared by anything that is not auto-follow. */
  let switchLog: { from: number | null; to: number; at: number }[] = [];
  /** Buffers of the root of the current unbroken chain (the key undoAutoFollow returns to): at most one TravelRing is held. */
  let stash: FocusStash | null = null;
  let autoSwitching = false;
  /** Last time (ingest clock) each key was at rest: travel below FOLLOW_MIN and firmware status 0. */
  const lastRest = new Float64Array(64).fill(-Infinity);
  /** Samples pushed into the focused ring so far, and the state when the focused key's current press began (null at rest). */
  let ringPushes = 0;
  /** Events pushed so far (the array is capped, so its length cannot tell how many a press added). */
  let eventPushes = 0;
  let pressSnap: PressSnapshot | null = null;

  let generation = 0;
  let rateCount = 0;
  let rateFrom = 0;

  // row/col → key, rebuilt when the layout changes (ingest runs ~1,700 times a second).
  let keyIndex = new Map<number, PhysicalKey>();
  /**
   * Keys whose press moves keyboard focus: the only ones undoAutoFollow may undo. By the loaded layer-0 keycode
   * (the OS acts on the code, and Tab may be remapped); by physical name only while the keymap is not loaded.
   */
  let focusMoving = new Set<number>();
  watch(() => device.keys, (keys) => {
    keyIndex = new Map(keys.map((k) => [k.row * 256 + k.col, k]));
  }, { immediate: true });
  watch([() => device.keys, () => device.layer0], () => {
    focusMoving = keysForCodes(FOCUS_CODES);
  }, { immediate: true, flush: 'sync' });

  /** Physical key ids whose layer-0 keycode is one of `codes` (by physical name while the keymap is not loaded). */
  function keysForCodes(codes: number[]): Set<number> {
    const layer0 = device.layer0;
    const out = new Set<number>();
    for (const k of device.keys) {
      if (layer0.length > 0 ? codes.includes(layer0[k.id]) : codes.some((c) => FALLBACK_NAMES.get(c) === k.name)) out.add(k.id);
    }
    return out;
  }

  /**
   * Keys pressed to operate a page control (Space/Enter on a button): not test presses, so auto-follow ignores them.
   * Value = the time of the mark while no travel was seen yet, -1 once the key moved; the mark ends when it is back at rest.
   */
  const uiPressed = new Map<number, number>();

  function markUiPressed(ids: Iterable<number>, now = performance.now()): void {
    for (const id of ids) {
      uiPressed.set(id, now);
      if (id === focusId.value) rollbackPress();
    }
  }

  /** The focused key's UI stroke began before its mark (AE64 travel arrives ahead of the keydown): take its frames back. */
  function rollbackPress(): void {
    const snap = pressSnap;
    if (!snap) return;
    pressSnap = null;
    data.events.length -= Math.min(eventPushes - snap.eventPushes, data.events.length); // the cap may have shifted older events out: those stay gone
    data.count = snap.count;
    data.peak = snap.peak;
    data.lastActuation = snap.lastActuation;
    data.lastRelease = snap.lastRelease;
    data.mismatch = snap.mismatch;
    data.mismatchSince = snap.mismatchSince;
    data.touched = snap.touched;
    data.ring.dropNewest(ringPushes - snap.pushes);
    if (data.model && snap.model) Object.assign(data.model, snap.model);
    data.model?.sync(data.current);
    data.version++;
    data.epoch++;
  }

  function trackUiPressed(id: number, mm: number, now: number): void {
    const at = uiPressed.get(id);
    if (at === undefined) return;
    if (mm > REST_MM) uiPressed.set(id, -1);
    else if (at < 0) {
      if (data.status[id] === 0) {
        uiPressed.delete(id);
        if (id === focusId.value) data.model?.sync(mm); // back at rest: the next frame must not emit the UI stroke's release
      }
    } else if (now - at > UI_MARK_MS) uiPressed.delete(id);
  }

  /** Forget the auto-follow chain and its stash (anything that is not an auto-follow switch). */
  function dropChain(): void {
    switchLog = [];
    stash = null;
  }

  function keyAt(row: number, col: number): PhysicalKey | undefined {
    return keyIndex.get(row * 256 + col);
  }

  function rangeRaw(id: number): number {
    const max = perf.values[id]?.axisRangeMax;
    return max && max > 0 ? max : Math.round(rangeMm(undefined) * 1000);
  }

  function settingsFor(id: number | null): ActuationSettings | null {
    const p = id === null ? undefined : perf.values[id];
    return p ? settingsFrom(p) : null;
  }

  /** Reset the focused-key buffers (focus changed, cleared by the user, or restarted). */
  function clear(): void {
    data.ring.clear();
    data.events.length = 0;
    data.model?.reset();
    data.peak = 0;
    data.count = 0;
    data.lastActuation = null;
    data.lastRelease = null;
    data.mismatch = false;
    data.mismatchSince = null;
    data.touched = false;
    pressSnap = null;
    data.version++;
    data.epoch++;
  }

  /** The user's Clear: also forgets the auto-follow chain, so undoAutoFollow cannot bring the cleared stroke back. */
  function clearByUser(): void {
    dropChain();
    clear();
  }

  function setFocus(id: number | null): void {
    if (id === focusId.value) return;
    if (!autoSwitching) dropChain();
    focusId.value = id;
    const s = settingsFor(id);
    data.model = s ? markRaw(new ActuationModel(s)) : null;
    data.current = id === null ? 0 : data.travel[id];
    data.firmwarePressed = id !== null && data.status[id] > 0;
    clear();
  }

  // Markers follow the user's current settings: re-read whenever the performance store changes.
  watch(() => (focusId.value === null ? undefined : perf.values[focusId.value]), () => {
    const s = settingsFor(focusId.value);
    if (!s) data.model = null;
    else if (data.model) data.model.settings = s;
    else data.model = markRaw(new ActuationModel(s));
    data.version++;
  });

  function checkMismatch(now: number): void {
    const m = data.model;
    if (!m || m.actuated === data.firmwarePressed) {
      data.mismatchSince = null;
      data.mismatch = false;
      return;
    }
    data.mismatchSince ??= now;
    data.mismatch = now - data.mismatchSince >= MISMATCH_MS;
  }

  function ingestFocused(mm: number, now: number): void {
    // The focused key is operating a page control (Space on Pause while Space is under review): not a test press,
    // so it leaves no stroke, event or count. The model only tracks its depth so the next real press starts clean.
    if (uiPressed.size && focusId.value !== null && uiPressed.has(focusId.value)) {
      data.current = mm;
      data.model?.sync(mm);
      return;
    }
    if (data.current <= REST_MM && mm > REST_MM) {
      const m = data.model;
      pressSnap = {
        eventPushes, count: data.count, peak: data.peak, lastActuation: data.lastActuation,
        lastRelease: data.lastRelease, mismatch: data.mismatch, mismatchSince: data.mismatchSince, touched: data.touched,
        model: m ? { actuated: m.actuated, armed: m.armed, peak: m.peak, trough: m.trough } : null, pushes: ringPushes,
      };
      data.peak = 0;
    } else if (mm <= REST_MM) pressSnap = null;
    data.current = mm;
    data.peak = Math.max(data.peak, mm);
    data.touched ||= mm > REST_MM;
    data.ring.push(now, mm);
    ringPushes++;
    const ev = data.model?.update(mm);
    if (ev) {
      data.events.push({ t: now, kind: ev, depth: mm });
      eventPushes++;
      if (data.events.length > EVENT_CAP) data.events.splice(0, data.events.length - EVENT_CAP);
      if (ev === 'press') {
        data.count++;
        data.lastActuation = mm;
      } else data.lastRelease = mm;
    }
    checkMismatch(now);
    rateCount++;
    if (now - rateFrom >= RATE_WINDOW_MS) {
      data.rateHz = (rateCount * 1000) / (now - rateFrom);
      rateCount = 0;
      rateFrom = now;
    }
  }

  // Key check state that is not shown: went deeper than REST_ARM_MM since the key was last near 0, and is above PRESSED_MM.
  const armed = new Uint8Array(64);
  const down = new Uint8Array(64);
  /** Keys that just came back above PRESSED_MM after a press (the page drains it for its announcements). At most 64. */
  const releasedIds = new Set<number>();

  /** Peak, pressed and "not back to 0" bookkeeping for one route sample of key `id`. */
  function trackCheck(id: number, mm: number, ratio: number, now: number): void {
    // peakMm and restOffMm are Float32Array: compare with the sample as it would be stored, or 3.31 (double) reads
    // deeper than the stored 3.3099999 forever and a key held still bumps checkVersion on every sample. The thresholds
    // below compare the sample itself.
    const stored = Math.fround(mm);
    if (stored > data.peakMm[id]) {
      data.peakMm[id] = mm;
      data.peakRatio[id] = ratio;
      data.checkVersion++;
    }
    if (mm > PRESSED_MM) {
      down[id] = 1;
      if (!data.pressedIds.has(id)) {
        data.pressedIds.add(id);
        data.checkVersion++;
      }
    } else if (down[id]) {
      down[id] = 0;
      releasedIds.add(id);
    }
    if (mm < REST_OFF_MM) {
      armed[id] = 0;
      clearStuck(id);
      return;
    }
    if (mm > REST_ARM_MM) armed[id] = 1;
    if (!armed[id] || data.status[id] !== 0) {
      clearStuck(id);
      return;
    }
    if (data.offSince[id] < 0) data.offSince[id] = now;
    if (now - data.offSince[id] >= REST_OFF_MS && data.restOffMm[id] !== stored) {
      data.restOffMm[id] = mm;
      data.checkVersion++;
    }
  }

  /** The stuck condition broke (back near 0, or the firmware reads the key pressed again). */
  function clearStuck(id: number): void {
    data.offSince[id] = -1;
    if (data.restOffMm[id] > 0) {
      data.restOffMm[id] = 0;
      data.checkVersion++;
    }
  }

  /** Start the key check over: every key's deepest reading, pressed state and "not back to 0" go back to none. */
  function resetPeaks(now = performance.now()): void {
    data.peakMm.fill(0);
    data.peakRatio.fill(0);
    data.restOffMm.fill(0);
    data.offSince.fill(-1);
    armed.fill(0);
    down.fill(0);
    releasedIds.clear();
    data.pressedIds.clear();
    data.checkStartedAt = now;
    data.checkVersion++;
  }

  /** Keys released since the last call (they went above PRESSED_MM and came back), oldest first; empties the list. */
  function drainReleased(): number[] {
    const out = [...releasedIds];
    releasedIds.clear();
    return out;
  }

  function ingest(type: AxisDataType, row: number, values: number[], now: number): void {
    const focus = focusId.value;
    let focusedHere = false;
    for (let col = 0; col < values.length; col++) {
      const key = keyAt(row, col);
      if (!key) continue;
      if (type === 'route') {
        const range = rangeRaw(key.id);
        const v = Math.min(Math.max(values[col], 0), range);
        data.travel[key.id] = v / 1000;
        data.ratio[key.id] = v / range;
        trackCheck(key.id, v / 1000, v / range, now);
        if (uiPressed.size) trackUiPressed(key.id, v / 1000, now);
        if (v / 1000 < FOLLOW_MIN && data.status[key.id] === 0) lastRest[key.id] = now;
      } else {
        data.status[key.id] = values[col];
        if (values[col] !== 0) clearStuck(key.id);
      }
      if (key.id === focus) focusedHere = true;
    }
    if (type === 'route' && follow.value && !followSuspended) {
      let best = -1;
      const ui = uiPressed.size > 0;
      for (let id = 0; id < data.travel.length; id++) {
        if (ui && uiPressed.has(id)) continue;
        if (best < 0 || data.travel[id] > data.travel[best]) best = id;
      }
      const cur = focus === null || (ui && uiPressed.has(focus)) ? 0 : data.travel[focus];
      if (best >= 0 && best !== focus && data.travel[best] >= FOLLOW_MIN && data.travel[best] > cur + FOLLOW_MARGIN) {
        // Leaving a key that is not focus-moving starts a new chain: its buffers become the single root stash.
        // A hop from a focus-moving key (Tab, Shift) stays inside the chain and keeps the root stash.
        if (focus !== null && !focusMoving.has(focus)) {
          stash = {
            id: focus, ring: data.ring, events: data.events, model: data.model, peak: data.peak, count: data.count,
            lastActuation: data.lastActuation, lastRelease: data.lastRelease, mismatch: data.mismatch,
            mismatchSince: data.mismatchSince, touched: data.touched,
          };
          data.ring = new TravelRing(RING_SIZE);
          data.events = [];
        }
        autoSwitching = true;
        setFocus(best);
        autoSwitching = false;
        switchLog.push({ from: focus, to: best, at: now });
        if (switchLog.length > SWITCH_LOG_CAP) switchLog.shift();
        ingestFocused(data.travel[best], now);
        data.version++;
        return;
      }
    }
    if (focusedHere && focus !== null) {
      if (type === 'route') ingestFocused(data.travel[focus], now);
      else {
        data.firmwarePressed = data.status[focus] > 0;
        checkMismatch(now);
      }
    }
    data.version++;
  }

  function shouldPause(): boolean {
    return device.exclusiveActive || (typeof document !== 'undefined' && document.hidden);
  }

  async function loop(gen: number): Promise<void> {
    let tick = 0;
    let rr = 0;
    while (gen === generation) {
      if (!device.connected) { stop(); return; }
      if (shouldPause()) {
        paused.value = true;
        await sleep(PAUSE_POLL_MS);
        continue;
      }
      paused.value = false;
      const focusRow = focusId.value === null ? FIRMWARE_ROWS[0] : device.keys[focusId.value].row;
      const plan: [AxisDataType, number][] = [['route', focusRow]];
      if (tick % STATUS_EVERY === 0) plan.push(['keyStatus', focusRow]);
      if (follow.value || allKeys.value) {
        // Other rows round-robin: route and status alternate per row.
        const others = FIRMWARE_ROWS.filter((r) => r !== focusRow);
        const step = rr++ % (others.length * 2);
        plan.push([step % 2 === 0 ? 'route' : 'keyStatus', others[step >> 1]]);
      }
      tick++;
      try {
        // Sequential requests in one call: exactly one request in flight at any time.
        await device.withTransport(async (t) => {
          for (const [type, row] of plan) {
            const r = await t.getAxisData(type, row);
            if (gen !== generation) return;
            ingest(type, row, r.values, performance.now());
          }
        });
      } catch {
        if (gen === generation) stop();
        return;
      }
    }
  }

  /** Start polling (no-op when running). Loads performance settings for the markers if needed. */
  function start(): void {
    if (running.value || !device.connected) return;
    running.value = true;
    paused.value = false;
    const gen = ++generation;
    rateCount = 0;
    rateFrom = performance.now();
    data.rateHz = 0;
    void perf.load();
    void loop(gen);
  }

  function stop(): void {
    dropChain();
    uiPressed.clear();
    generation++;
    running.value = false;
    paused.value = false;
    data.rateHz = 0;
  }

  /** Forget all live state (profile changed): per-key travel/status, focus buffers. */
  function reset(): void {
    dropChain();
    uiPressed.clear();
    data.travel.fill(0);
    lastRest.fill(-Infinity);
    data.ratio.fill(0);
    data.status.fill(0);
    data.current = 0;
    data.firmwarePressed = false;
    data.model?.reset();
    resetPeaks();
    clear();
  }

  function pin(id: number): void {
    dropChain();
    follow.value = false;
    setFocus(id);
  }

  function setFollow(on: boolean): void {
    follow.value = on;
  }

  function suspendFollow(on: boolean): void {
    followSuspended = on;
  }

  /**
   * The graph was reached by keyboard: the Tab (or Shift+Tab) that got it there was itself measured and
   * auto-follow moved to it. Undo the switches those keystrokes caused (one unbroken chain ending at the current
   * focus) and return to the key followed just before. No age limit: the first Tab of a slow typing box → Pause →
   * Clear → graph walk made the switch long before the graph got focus. Follow stays auto.
   * A focus-moving key (Tab/Shift) link is undone held or released, with or without `keys`: a released Tab/Shift in
   * the chain was keyboard navigation, never a test. A link to any other key is undone only when it is in `keys`
   * (the page passes Space/Enter/arrows when one operates a control), still held and the newest link; otherwise it stops the walk
   * (a held A is deliberate). Never back to "nothing followed": a focus-moving link with no key before it makes the
   * undo return false and change nothing. Running out of log entries at a key is fine and returns to that key; at a
   * Tab/Shift (the capped log lost the start of a long Shift+Tab walk) it returns to the root stash key, if any.
   */
  function undoAutoFollow(keys?: Set<number>): boolean {
    let current = focusId.value;
    let restore: number | undefined;
    for (let i = switchLog.length - 1; i >= 0; i--) {
      const sw = switchLog[i];
      const nav = focusMoving.has(sw.to);
      // A key in `keys` is undone only as the newest link (the switch this keystroke caused): an older link to the
      // same key was a real test of it (typing box Space → Tab → Space on Pause returns to Space, not past it).
      // It must also have happened during the key's current press (after its last rest): a link from an earlier press
      // of the same key (Space tested, Pause clicked, Space pressed again) is not the switch this keystroke caused.
      const ui = i === switchLog.length - 1 && !!keys?.has(sw.to) && sw.at > lastRest[sw.to];
      if (sw.to !== current || !(nav || ui)) break;
      if (sw.from === null) {
        if (nav) return false;
        break;
      }
      if (!nav && !(data.travel[sw.to] >= FOLLOW_MIN || data.status[sw.to] > 0)) break;
      restore = sw.from;
      current = sw.from;
    }
    // The log is capped: a long Shift+Tab walk can push the link out of the key that started the chain, so the walk
    // runs out at a Tab/Shift. The root stash is that key (every link kept after it leaves a Tab/Shift): go there.
    if (restore !== undefined && focusMoving.has(restore) && stash) restore = stash.id;
    // Back to the key already focused is a no-op only when no stroke of it is stashed (Tab hop away and back).
    if (restore === undefined || (restore === focusId.value && stash?.id !== restore)) return false;
    const root = stash; // setFocus drops the chain
    setFocus(restore);
    dropChain(); // setFocus does not when the key is already focused
    if (root && root.id === restore) {
      // Give the key its stroke back; epoch/version bump so the graph re-reads the whole ring.
      const s = settingsFor(restore);
      const m = root.model;
      const same = !!s && !!m && (Object.keys(s) as (keyof ActuationSettings)[]).every((k) => s[k] === m.settings[k]);
      data.ring = root.ring;
      data.events = root.events;
      data.model = same ? m : s ? markRaw(new ActuationModel(s)) : null;
      data.model?.sync(data.travel[restore]); // the key may have moved while it was stashed
      data.peak = root.peak;
      data.count = root.count;
      data.lastActuation = root.lastActuation;
      data.lastRelease = root.lastRelease;
      data.mismatch = root.mismatch;
      data.mismatchSince = root.mismatchSince;
      data.touched = root.touched;
      pressSnap = null; // it described the buffers just replaced
      data.version++;
      data.epoch++;
    }
    return true;
  }

  // Another keyboard (or the demo) was connected: its travel, switch log, stash, focus and model state are not this one's.
  watch(() => device.connection, () => {
    stop();
    setFocus(null);
    follow.value = true;
    reset();
  }, { flush: 'sync' });

  return {
    data, focusId, follow, allKeys, running, paused, start, stop, reset, clear: clearByUser, pin, setFocus, setFollow,
    suspendFollow, ingest, undoAutoFollow, keysForCodes, markUiPressed, resetPeaks, drainReleased,
  };
});
