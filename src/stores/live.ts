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

  /** RT, actuated: the key releases when it rises above this depth (mm). */
  get resetAt(): number | null {
    const s = this.settings;
    if (!isRtMode(s.mode) || !this.actuated) return null;
    return Math.max(this.peak - s.rtRelease, s.mode === 1 ? 0 : s.rtFirstTouch);
  }

  /** RT, released after a first actuation: the key re-actuates when it goes below this depth (mm). */
  get reactuateAt(): number | null {
    const s = this.settings;
    return isRtMode(s.mode) && this.armed && !this.actuated ? this.reactuateThreshold() : null;
  }

  /** trough + rtPress, but never past the bottom: a key lifted near the bottom re-actuates on reaching it
   *  (the bottom dead zone reads as full travel), as the firmware does. Shared by update() and reactuateAt. */
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
const FOCUS_CODES = new Set([0x2b, 0xe1, 0xe5]);

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
}

function emptyData(): LiveData {
  return markRaw({
    travel: new Float32Array(64), ratio: new Float32Array(64), status: new Uint8Array(64),
    ring: new TravelRing(RING_SIZE), events: [], model: null,
    current: 0, peak: 0, count: 0, lastActuation: null, lastRelease: null,
    firmwarePressed: false, mismatch: false, mismatchSince: null, rateHz: 0, touched: false, version: 0, epoch: 0,
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
  watch([() => device.keys, () => device.layer0], ([keys, layer0]) => {
    focusMoving = new Set(keys.filter((k) => layer0.length > 0
      ? FOCUS_CODES.has(layer0[k.id])
      : k.name === 'Tab' || k.name === 'Shift').map((k) => k.id));
  }, { immediate: true, flush: 'sync' });

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
    data.version++;
    data.epoch++;
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
    if (data.current <= REST_MM && mm > REST_MM) data.peak = 0;
    data.current = mm;
    data.peak = Math.max(data.peak, mm);
    data.touched ||= mm > REST_MM;
    data.ring.push(now, mm);
    const ev = data.model?.update(mm);
    if (ev) {
      data.events.push({ t: now, kind: ev, depth: mm });
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
      } else data.status[key.id] = values[col];
      if (key.id === focus) focusedHere = true;
    }
    if (type === 'route' && follow.value && !followSuspended) {
      let best = -1;
      for (let id = 0; id < data.travel.length; id++) if (best < 0 || data.travel[id] > data.travel[best]) best = id;
      const cur = focus === null ? 0 : data.travel[focus];
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
    generation++;
    running.value = false;
    paused.value = false;
    data.rateHz = 0;
  }

  /** Forget all live state (profile changed): per-key travel/status, focus buffers. */
  function reset(): void {
    dropChain();
    data.travel.fill(0);
    data.ratio.fill(0);
    data.status.fill(0);
    data.current = 0;
    data.firmwarePressed = false;
    data.model?.reset();
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
   * focus, each link's key still held) and return to the key followed just before. No age limit: the first Tab of
   * a slow typing box → Pause → Clear → graph walk made the switch long before the graph got focus, and the held
   * check already stops at a key the user tested on purpose (it has been released). Follow stays auto.
   */
  function undoAutoFollow(): boolean {
    let current = focusId.value;
    let restore: number | undefined;
    for (let i = switchLog.length - 1; i >= 0; i--) {
      const sw = switchLog[i];
      // Only a focus-moving key is undone (a held A is deliberate), and never back to "nothing followed".
      if (sw.from === null || !focusMoving.has(sw.to) || sw.to !== current) break;
      if (!(data.travel[sw.to] >= FOLLOW_MIN || data.status[sw.to] > 0)) break;
      restore = sw.from;
      current = sw.from;
    }
    if (restore === undefined) return false;
    const root = stash; // setFocus drops the chain
    setFocus(restore);
    if (root && root.id === restore) {
      // Give the key its stroke back; epoch/version bump so the graph re-reads the whole ring.
      const s = settingsFor(restore);
      const m = root.model;
      const same = !!s && !!m && (Object.keys(s) as (keyof ActuationSettings)[]).every((k) => s[k] === m.settings[k]);
      data.ring = root.ring;
      data.events = root.events;
      data.model = same ? m : s ? markRaw(new ActuationModel(s)) : null;
      data.peak = root.peak;
      data.count = root.count;
      data.lastActuation = root.lastActuation;
      data.lastRelease = root.lastRelease;
      data.mismatch = root.mismatch;
      data.mismatchSince = root.mismatchSince;
      data.touched = root.touched;
      data.version++;
      data.epoch++;
    }
    return true;
  }

  return { data, focusId, follow, allKeys, running, paused, start, stop, reset, clear, pin, setFocus, setFollow, suspendFollow, ingest, undoAutoFollow };
});
