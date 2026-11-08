// Per-key Hall performance for the active profile — the reference implementation of the per-key page
// pattern (docs/ARCHITECTURE.md): load all keys → edit through history + sync → verify by reading back.
import { defineStore } from 'pinia';
import { ref, shallowRef } from 'vue';
import { SAVE_GROUP } from '../protocol';
import type { Ae64Transport, Performance, PhysicalKey } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { useSyncStore } from './sync';

/** Fields this app edits. Everything else (axis, calibrate, axisV2Id, axisRangeMax, axisCoefficient) is preserved. */
export type PerfEdit = Pick<Performance, 'mode' | 'normalPress' | 'normalRelease' | 'rtFirstTouch' | 'rtPress' | 'rtRelease' | 'pressDeadStroke' | 'releaseDeadStroke'>;
const EDIT_FIELDS: (keyof PerfEdit)[] = ['mode', 'normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease', 'pressDeadStroke', 'releaseDeadStroke'];

export const LIMITS = {
  actuationMin: 0.1,
  rtMin: 0.01,
  rtMax: 2.0,
  deadMax: 1.0,
};

/** Fallback travel range (mm) when a key reports no axisRangeMax. */
export const DEFAULT_RANGE_MM = 3.31;

/**
 * Presets (mm). normalRelease is left untouched, like the factory driver.
 * - Gõ phím: Standard 2.0 mm — deep enough to avoid accidental presses while typing.
 * - Gaming: Rapid Trigger, first actuation 1.0 mm, 0.3/0.3 sensitivity — responsive but forgiving.
 * - Cực nhạy: Rapid Trigger, 0.3 mm first actuation, 0.1/0.1 sensitivity — fastest, needs a light touch.
 */
export const PRESETS: { id: 'typing' | 'gaming' | 'sensitive'; values: Omit<PerfEdit, 'normalRelease'> }[] = [
  { id: 'typing', values: { mode: 0, normalPress: 2.0, rtFirstTouch: 1.5, rtPress: 0.5, rtRelease: 0.5, pressDeadStroke: 0.2, releaseDeadStroke: 0.2 } },
  { id: 'gaming', values: { mode: 1, normalPress: 1.2, rtFirstTouch: 1.0, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.15, releaseDeadStroke: 0.15 } },
  { id: 'sensitive', values: { mode: 1, normalPress: 0.5, rtFirstTouch: 0.3, rtPress: 0.1, rtRelease: 0.1, pressDeadStroke: 0.1, releaseDeadStroke: 0.1 } },
];

export function pickEdit(p: Performance): PerfEdit {
  const out = {} as Record<keyof PerfEdit, number>;
  for (const f of EDIT_FIELDS) out[f] = p[f];
  return out as PerfEdit;
}

/** The actuation point the firmware uses for this key's mode. */
export function actuationOf(p: Performance): number {
  return p.mode === 1 ? p.rtFirstTouch : p.normalPress;
}

export function rangeMm(p: Performance | undefined): number {
  return p && p.axisRangeMax > 0 ? p.axisRangeMax / 1000 : DEFAULT_RANGE_MM;
}

function sameEdit(a: PerfEdit, b: PerfEdit): boolean {
  return EDIT_FIELDS.every((f) => Math.abs(a[f] - b[f]) < 0.0005);
}

export const usePerformanceStore = defineStore('performance', () => {
  const device = useDeviceStore();
  const history = useHistoryStore();
  const sync = useSyncStore();

  /** Current (possibly not yet written) values by PhysicalKey.id. */
  const values = shallowRef<Record<number, Performance>>({});
  const loading = ref(false);
  const loadedCount = ref(0);
  const loadError = ref<string | null>(null);
  const loadedProfile = ref<number | null>(null);
  /** Last record read from the board per key: the source of preserved axis/calibration fields. */
  const fresh = new Map<number, Performance>();
  let loadPromise: Promise<void> | null = null;

  function keyById(id: number): PhysicalKey {
    return device.keys[id];
  }

  /** Sequentially read all 64 keys of the active profile. Cached until the profile changes or force. */
  function load(force = false): Promise<void> {
    // A forced reload requested mid-load (profile switched) runs again once the current load ends.
    if (loadPromise) return force ? loadPromise.then(() => load(true)) : loadPromise;
    if (!force && loadedProfile.value === device.activeProfile && Object.keys(values.value).length) return Promise.resolve();
    loadPromise = (async () => {
      loading.value = true;
      loadError.value = null;
      loadedCount.value = 0;
      values.value = {};
      fresh.clear();
      const profile = device.activeProfile;
      try {
        const next: Record<number, Performance> = {};
        await device.withTransport(async (t) => {
          for (const key of device.keys) {
            const p = await t.getPerformance(key);
            next[key.id] = p;
            fresh.set(key.id, p);
            loadedCount.value++;
          }
        });
        values.value = next;
        loadedProfile.value = profile;
      } catch (err) {
        loadError.value = err instanceof Error ? err.message : String(err);
      } finally {
        loading.value = false;
        loadPromise = null;
      }
    })();
    return loadPromise;
  }

  function round(mm: number): number {
    const step = device.rtPrecision || 0.001;
    return Math.round(Math.round(mm / step) * step * 1000) / 1000;
  }

  function clamp(p: Performance, e: PerfEdit): PerfEdit {
    const max = rangeMm(p);
    const c = (v: number, lo: number, hi: number) => round(Math.min(hi, Math.max(lo, v)));
    return {
      mode: e.mode === 1 ? 1 : 0,
      normalPress: c(e.normalPress, LIMITS.actuationMin, max),
      normalRelease: e.normalRelease,
      rtFirstTouch: c(e.rtFirstTouch, LIMITS.actuationMin, max),
      rtPress: c(e.rtPress, LIMITS.rtMin, LIMITS.rtMax),
      rtRelease: c(e.rtRelease, LIMITS.rtMin, LIMITS.rtMax),
      pressDeadStroke: c(e.pressDeadStroke, 0, LIMITS.deadMax),
      releaseDeadStroke: c(e.releaseDeadStroke, 0, LIMITS.deadMax),
    };
  }

  function jobFor(id: number, profile: number) {
    const key = keyById(id);
    let written: PerfEdit | null = null;
    return {
      key: `perf:${profile}:${id}`,
      group: SAVE_GROUP.PERFORMANCE,
      label: tr('perf.keyLabel', { key: device.legend(key) }),
      write: async (t: Ae64Transport) => {
        const current = values.value[id];
        const base = fresh.get(id) ?? current;
        written = pickEdit(current);
        // Preserve axis / calibration metadata from the last fresh read.
        await t.setPerformance(key, { ...base, ...written });
      },
      verify: async (t: Ae64Transport) => {
        const read = await t.getPerformance(key);
        fresh.set(id, read);
        return written !== null && sameEdit(pickEdit(read), written);
      },
    };
  }

  function commit(map: Record<number, PerfEdit>): void {
    const profile = device.activeProfile;
    if (profile !== loadedProfile.value) return; // stale history entry from another profile
    const next = { ...values.value };
    for (const [idStr, edit] of Object.entries(map)) {
      const id = Number(idStr);
      if (!next[id]) continue;
      next[id] = { ...next[id], ...edit };
    }
    values.value = next;
    for (const id of Object.keys(map)) sync.enqueue(jobFor(Number(id), profile));
  }

  /**
   * Apply an edit to keys. `patch` receives each key's current record and returns the fields to change.
   * Pushes one history entry (coalesced by `coalesce` for continuous gestures) and enqueues sync jobs.
   */
  function apply(ids: number[], patch: (p: Performance) => Partial<PerfEdit>, what: string, coalesce?: string): void {
    if (loadedProfile.value !== device.activeProfile) return;
    const before: Record<number, PerfEdit> = {};
    const after: Record<number, PerfEdit> = {};
    for (const id of ids) {
      const cur = values.value[id];
      if (!cur) continue;
      const b = pickEdit(cur);
      const a = clamp(cur, { ...b, ...patch(cur) });
      if (sameEdit(a, b)) continue;
      before[id] = b;
      after[id] = a;
    }
    const n = Object.keys(after).length;
    if (!n) return;
    commit(after);
    history.push({
      label: tr('perf.editLabel', { what, n }),
      undo: () => commit(before),
      redo: () => commit(after),
      coalesce: coalesce ? `${coalesce}:${ids.join(',')}` : undefined,
    });
  }

  return { values, loading, loadedCount, loadError, loadedProfile, load, apply };
});
