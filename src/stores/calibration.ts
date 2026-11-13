// Calibration session (DESIGN §6.7, AE64_PROTOCOL "Calibration"): 02 06 00 enters calibration mode, the
// ADC / route / calibration matrices are polled for every row (~15 Hz) while the user presses each key to
// the bottom, then 02 06 01 + commit(SAVE_GROUP.CALIBRATION) finishes. Status per key: 0 uncalibrated,
// 1 calibrated, 2 newly calibrated in this session (kept once seen).
//
// Visual calibration (DESIGN D §3.1) adds no HID command: the deepest route per key in the session (`peakRoute`), the
// keys a saved session calibrated (`lastSaved`) and the lists the page shows are all read from the frames polled here.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { FIRMWARE_ROWS, SAVE_GROUP } from '../protocol';
import type { Ae64Transport, AxisDataType } from '../protocol';
import { useDeviceStore } from './device';
import { DEFAULT_RANGE_MM, usePerformanceStore } from './performance';
import { useSyncStore } from './sync';
import { FULL_TRAVEL, PRESSED_MM, useLiveStore } from './live';

export type CalibrationPhase = 'idle' | 'starting' | 'running' | 'finishing';

export interface CalibrationFrame {
  adc: number[];
  route: number[];
  status: number[];
}

const FRAME_MS = 66; // ~15 Hz
const TYPES: AxisDataType[] = ['adc', 'route', 'calibration'];

const emptyFrame = (): CalibrationFrame => ({ adc: Array(64).fill(0), route: Array(64).fill(0), status: Array(64).fill(0) });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** "Pressed" and "back at rest", in µm of route: part C's 0.3 mm, so the two pages mean the same. */
const PRESSED_UM = PRESSED_MM * 1000;

/** A new peak array: the deeper of the old peak and this frame's route, for every key of the board. */
function raisePeaks(peak: Uint32Array, next: CalibrationFrame, keys: { id: number }[]): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(peak);
  for (const k of keys) if (next.route[k.id] > out[k.id]) out[k.id] = next.route[k.id];
  return out;
}

export const useCalibrationStore = defineStore('calibration', () => {
  const device = useDeviceStore();
  const perf = usePerformanceStore();

  const phase = ref<CalibrationPhase>('idle');
  /** Latest matrices by PhysicalKey.id; replaced once per polled frame. */
  const frame = shallowRef<CalibrationFrame>(emptyFrame());
  const error = ref<string | null>(null);
  /** True once a real frame was read from the keyboard; before that `frame` is only a zeroed placeholder. */
  const loaded = ref(false);
  /** The last failure may have left the keyboard in calibration mode (the stop command itself failed). */
  const stopFailed = ref(false);
  /** Deepest route per key (µm) since the last successful start(); kept after the session ends, until the next start. */
  const peakRoute = shallowRef(new Uint32Array(64));
  /** Keys newly calibrated by the last session that was saved (Finish went through the commit). null: no saved session
   *  since the last start, a cancel, a failed end, or a new connection. Proof that a session was really saved. */
  const lastSaved = ref<number[] | null>(null);
  // A new connection (demo → real keyboard): the old frame belongs to another keyboard.
  watch(() => device.connection, () => {
    frame.value = emptyFrame();
    loaded.value = false;
    error.value = null;
    stopFailed.value = false;
    peakRoute.value = new Uint32Array(64);
    lastSaved.value = null;
  });
  const newCount = computed(() => frame.value.status.filter((s) => s === 2).length);
  const calibratedCount = computed(() => frame.value.status.filter((s) => s > 0).length);
  const uncalibratedCount = computed(() => frame.value.status.filter((s) => s === 0).length);

  // ---- What the page shows of a session (DESIGN D §3.1). All from the polled frames: no HID command of their own.
  const inSession = computed(() => phase.value === 'running' || phase.value === 'finishing');
  /** A session is running, or the last one was saved (its numbers stay on screen to look back at). */
  const hasSession = computed(() => inSession.value || lastSaved.value !== null);
  const savedSet = computed(() => new Set(lastSaved.value ?? []));
  /** Newly calibrated: the firmware's 2 while the session runs; after it was saved, the keys it saved. */
  function isNew(id: number): boolean {
    return inSession.value ? frame.value.status[id] === 2 : savedSet.value.has(id);
  }
  /** Last travel read per key: Finish reloads the performance store (its values are empty for a second or two), and a
   *  key of a shorter switch must not turn "too shallow" against the 3.31 mm default meanwhile. Same keyboard only. */
  const knownRange = new Map<number, number>();
  watch(() => perf.values, (v) => {
    for (const [id, p] of Object.entries(v)) if (p?.axisRangeMax) knownRange.set(Number(id), p.axisRangeMax);
  }, { immediate: true, flush: 'sync' });
  watch(() => device.connection, () => knownRange.clear(), { flush: 'sync' });
  /** The key's travel in µm (its switch's axisRangeMax), as the keyboard's fill uses it. */
  function rangeUm(id: number): number {
    return perf.values[id]?.axisRangeMax || knownRange.get(id) || DEFAULT_RANGE_MM * 1000;
  }
  /** % and ⤓ are a reading of `route`, not the firmware's word (status 2 is): one switch to turn them off after the real
   *  keyboard test (PLAN, deferred list item 8). Every place that shows them goes through this. `trustPeaks` is that
   *  switch (on today). */
  const trustPeaks = ref(true);
  const peakTrusted = computed(() => trustPeaks.value);
  /** Keys pressed past 0.3 mm in the session, in keyboard order. A status-0 key may report route 0 all session long: it
   *  is then never "pressed" (on purpose, DESIGN D §10); it stays red with its "not calibrated" chip. */
  const pressedIds = computed(() => (hasSession.value ? device.keys.filter((k) => peakRoute.value[k.id] > PRESSED_UM).map((k) => k.id) : []));
  /** Pressed, not newly calibrated, deepest under 95 % of the key's travel, and back at rest (a key on its way down is
   *  not "too shallow" yet). Empty when the % is not trusted. */
  const shallowIds = computed(() => {
    if (!peakTrusted.value) return [];
    const f = frame.value;
    return pressedIds.value.filter((id) => !isNew(id) && peakRoute.value[id] < FULL_TRAVEL * rangeUm(id) && f.route[id] < PRESSED_UM);
  });
  /** Pressed, not newly calibrated, not too shallow: waiting for the firmware (or, after saving, kept the old calibration). */
  const waitIds = computed(() => {
    const shallow = new Set(shallowIds.value);
    return pressedIds.value.filter((id) => !isNew(id) && !shallow.has(id));
  });
  /** "Newly calibrated" of the session: counted live while it runs, the saved keys after. */
  const sessionNewCount = computed(() => (inSession.value ? newCount.value : lastSaved.value?.length ?? 0));

  let generation = 0;
  let loopDone: Promise<void> = Promise.resolve();

  async function readFrame(t: Ae64Transport, latch: boolean): Promise<CalibrationFrame> {
    const prev = frame.value;
    const next = emptyFrame();
    for (const row of FIRMWARE_ROWS) {
      const rows: number[][] = [];
      for (const type of TYPES) rows.push((await t.getAxisData(type, row)).values);
      for (const key of device.keys) {
        if (key.row !== row) continue;
        next.adc[key.id] = rows[0][key.col] ?? 0;
        next.route[key.id] = rows[1][key.col] ?? 0;
        const s = rows[2][key.col] ?? 0;
        // The firmware may drop back to 1 once a key is released; keep "newly calibrated" for the session.
        next.status[key.id] = latch && prev.status[key.id] === 2 ? 2 : s;
      }
    }
    return next;
  }

  /** One read of all matrices (page open, outside a session) so the keyboard shows the current state. */
  async function refresh(): Promise<void> {
    if (phase.value !== 'idle') return;
    try {
      frame.value = await device.withTransport((t) => readFrame(t, false));
      loaded.value = true;
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  /** Best-effort 02 06 01 without committing; false when the keyboard may still be calibrating. */
  async function tryStop(): Promise<boolean> {
    return device.withTransport((t) => t.stopCalibration()).then(() => true, () => false);
  }

  async function poll(gen: number): Promise<void> {
    while (gen === generation) {
      const started = performance.now();
      try {
        const next = await device.withTransport((t) => readFrame(t, true));
        if (gen !== generation) return;
        frame.value = next;
        // after the generation check: a frame read once Finish / Cancel was pressed is not the session's
        peakRoute.value = raisePeaks(peakRoute.value, next, device.keys);
        loaded.value = true;
      } catch (err) {
        if (gen !== generation) return;
        error.value = err instanceof Error ? err.message : String(err);
        generation++;
        // Never leave the keyboard in calibration mode: best-effort stop, nothing committed.
        stopFailed.value = !(await tryStop());
        phase.value = 'idle';
        return;
      }
      await sleep(Math.max(0, FRAME_MS - (performance.now() - started)));
    }
  }

  /** Enter calibration mode and start polling. Pending writes are flushed and live pollers stopped first. */
  async function start(): Promise<void> {
    if (phase.value !== 'idle') return;
    phase.value = 'starting';
    error.value = null;
    stopFailed.value = false;
    try {
      useLiveStore().stop();
      await useSyncStore().flush();
      await device.withTransport((t) => t.startCalibration());
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      // The start reply may be lost while the keyboard did enter calibration: always try to stop.
      stopFailed.value = !(await tryStop());
      phase.value = 'idle';
      return;
    }
    phase.value = 'running';
    peakRoute.value = new Uint32Array(64); lastSaved.value = null;
    frame.value = { ...frame.value, status: frame.value.status.map((s) => (s === 2 ? 1 : s)) };
    const gen = ++generation;
    loopDone = poll(gen);
  }

  /** Resolves true when the session ended as asked (stopped, and saved when `save`); false when it did not. */
  async function end(save: boolean): Promise<boolean> {
    if (phase.value !== 'running') return true;
    phase.value = 'finishing';
    generation++;
    await loopDone;
    let stopped = false;
    try {
      await device.withTransport(async (t) => {
        await t.stopCalibration();
        stopped = true;
        if (save) await t.commit(SAVE_GROUP.CALIBRATION);
      });
      stopFailed.value = false;
      // The calibrate flag lives in the performance record; reload so later writes preserve the new value.
      const perf = usePerformanceStore();
      if (perf.loadedProfile !== null) void perf.load(true);
      // What this session saved, read before the 2 → 1 below (after it no key is 2). Only here: proof of a commit.
      lastSaved.value = save ? device.keys.filter((k) => frame.value.status[k.id] === 2).map((k) => k.id) : null;
      // As the factory driver does: once the session ends, "newly calibrated" is just "calibrated".
      frame.value = { ...frame.value, status: frame.value.status.map((s) => (s === 2 ? 1 : s)) };
      return true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      stopFailed.value = !stopped;
      return false;
    } finally {
      phase.value = 'idle';
    }
  }

  /** Stop calibration and save (02 06 01, commit group 1). */
  function finish(): Promise<boolean> {
    return end(true);
  }

  /** Stop calibration without committing. Also used when the page unmounts mid-session. */
  function cancel(): Promise<boolean> {
    return end(false);
  }

  return {
    phase, frame, error, loaded, stopFailed, newCount, calibratedCount, uncalibratedCount, refresh, start, finish, cancel,
    peakRoute, lastSaved, hasSession, isNew, rangeUm, trustPeaks, peakTrusted, pressedIds, shallowIds, waitIds, sessionNewCount,
  };
});
