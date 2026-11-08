// Calibration session (DESIGN §6.7, AE64_PROTOCOL "Calibration"): 02 06 00 enters calibration mode, the
// ADC / route / calibration matrices are polled for every row (~15 Hz) while the user presses each key to
// the bottom, then 02 06 01 + commit(SAVE_GROUP.CALIBRATION) finishes. Status per key: 0 uncalibrated,
// 1 calibrated, 2 newly calibrated in this session (kept once seen).
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { FIRMWARE_ROWS, SAVE_GROUP } from '../protocol';
import type { Ae64Transport, AxisDataType } from '../protocol';
import { useDeviceStore } from './device';
import { usePerformanceStore } from './performance';
import { useSyncStore } from './sync';
import { useLiveStore } from './live';

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

export const useCalibrationStore = defineStore('calibration', () => {
  const device = useDeviceStore();

  const phase = ref<CalibrationPhase>('idle');
  /** Latest matrices by PhysicalKey.id; replaced once per polled frame. */
  const frame = shallowRef<CalibrationFrame>(emptyFrame());
  const error = ref<string | null>(null);
  const newCount = computed(() => frame.value.status.filter((s) => s === 2).length);
  const calibratedCount = computed(() => frame.value.status.filter((s) => s > 0).length);
  const uncalibratedCount = computed(() => frame.value.status.filter((s) => s === 0).length);

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
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  async function poll(gen: number): Promise<void> {
    while (gen === generation) {
      const started = performance.now();
      try {
        const next = await device.withTransport((t) => readFrame(t, true));
        if (gen !== generation) return;
        frame.value = next;
      } catch (err) {
        if (gen !== generation) return;
        error.value = err instanceof Error ? err.message : String(err);
        generation++;
        // Never leave the keyboard in calibration mode: best-effort stop, nothing committed.
        await device.withTransport((t) => t.stopCalibration()).catch(() => undefined);
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
    try {
      useLiveStore().stop();
      await useSyncStore().flush();
      await device.withTransport((t) => t.startCalibration());
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      // The start reply may be lost while the keyboard did enter calibration: always try to stop.
      await device.withTransport((t) => t.stopCalibration()).catch(() => undefined);
      phase.value = 'idle';
      return;
    }
    phase.value = 'running';
    frame.value = { ...frame.value, status: frame.value.status.map((s) => (s === 2 ? 1 : s)) };
    const gen = ++generation;
    loopDone = poll(gen);
  }

  async function end(save: boolean): Promise<void> {
    if (phase.value !== 'running') return;
    phase.value = 'finishing';
    generation++;
    await loopDone;
    try {
      await device.withTransport(async (t) => {
        await t.stopCalibration();
        if (save) await t.commit(SAVE_GROUP.CALIBRATION);
      });
      // The calibrate flag lives in the performance record; reload so later writes preserve the new value.
      const perf = usePerformanceStore();
      if (perf.loadedProfile !== null) void perf.load(true);
      // As the factory driver does: once the session ends, "newly calibrated" is just "calibrated".
      frame.value = { ...frame.value, status: frame.value.status.map((s) => (s === 2 ? 1 : s)) };
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
    } finally {
      phase.value = 'idle';
    }
  }

  /** Stop calibration and save (02 06 01, commit group 1). */
  function finish(): Promise<void> {
    return end(true);
  }

  /** Stop calibration without committing. Also used when the page unmounts mid-session. */
  function cancel(): Promise<void> {
    return end(false);
  }

  return { phase, frame, error, newCount, calibratedCount, uncalibratedCount, refresh, start, finish, cancel };
});
