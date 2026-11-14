// Per-key Hall performance for the active profile — the reference implementation of the per-key page
// pattern (docs/ARCHITECTURE.md): load all keys → edit through history + sync → verify by reading back.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { SAVE_GROUP, isRtMode } from '../protocol';
import type { Ae64Transport, Performance, PhysicalKey } from '../protocol';
import { findSwitch, switchCatalogFor } from '../protocol/switches';
import type { SwitchEntry, SwitchTriple } from '../protocol/switches';
import { switchName } from '../data/switchDisplay';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { useSyncStore } from './sync';
import { deleteTuningSnapshot } from './tuning';

/** Fields this app edits. axis and calibrate are always preserved; the switch triple changes only through applySwitch. */
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
 * Presets (mm). normalRelease is not part of a preset: the firmware ties it to normalPress on every write.
 * normalPress and rtFirstTouch are equal in every preset: one actuation point for Standard and Rapid Trigger.
 * - Gõ phím: Standard 2.0 mm — deep enough to avoid accidental presses while typing.
 * - Gaming: Rapid Trigger, first actuation 1.0 mm, 0.3/0.3 sensitivity — responsive but forgiving.
 * - Cực nhạy: Rapid Trigger, 0.3 mm first actuation, 0.1/0.1 sensitivity — fastest, needs a light touch.
 */
export const PRESETS: { id: 'typing' | 'gaming' | 'sensitive'; values: Omit<PerfEdit, 'normalRelease'> }[] = [
  { id: 'typing', values: { mode: 0, normalPress: 2.0, rtFirstTouch: 2.0, rtPress: 0.5, rtRelease: 0.5, pressDeadStroke: 0.2, releaseDeadStroke: 0.2 } },
  { id: 'gaming', values: { mode: 1, normalPress: 1.0, rtFirstTouch: 1.0, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.15, releaseDeadStroke: 0.15 } },
  { id: 'sensitive', values: { mode: 1, normalPress: 0.3, rtFirstTouch: 0.3, rtPress: 0.1, rtRelease: 0.1, pressDeadStroke: 0.1, releaseDeadStroke: 0.1 } },
];

export function pickEdit(p: Performance): PerfEdit {
  const out = {} as Record<keyof PerfEdit, number>;
  for (const f of EDIT_FIELDS) out[f] = p[f];
  return out as PerfEdit;
}

/**
 * Modes this app understands (0 Standard, 1 Continuous RT, 2 RT). A key reporting anything else is left
 * alone: apply() skips it, so an unknown firmware mode is never overwritten or retried against the guard.
 */
export function isKnownMode(mode: number): boolean {
  return mode === 0 || mode === 1 || mode === 2;
}

/** The actuation point the firmware uses for this key's mode. */
export function actuationOf(p: Performance): number {
  return isRtMode(p.mode) ? p.rtFirstTouch : p.normalPress;
}

export function rangeMm(p: Performance | undefined): number {
  return p && p.axisRangeMax > 0 ? p.axisRangeMax / 1000 : DEFAULT_RANGE_MM;
}

/** Travel values that a switch with a shorter range lowers (only values above the limit change, never rounded). */
export type TravelField = 'normalPress' | 'normalRelease' | 'rtFirstTouch' | 'rtPress' | 'rtRelease';
const TRAVEL_FIELDS: TravelField[] = ['normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease'];
type Clamped = { id: number; field: TravelField; from: number; to: number };

const tripleOf = (p: Performance): SwitchTriple => ({ axisV2Id: p.axisV2Id, axisRangeMax: p.axisRangeMax, axisCoefficient: p.axisCoefficient });
const sameTriple = (a: SwitchTriple, b: SwitchTriple): boolean =>
  a.axisV2Id === b.axisV2Id && a.axisRangeMax === b.axisRangeMax && a.axisCoefficient === b.axisCoefficient;

/** A key's switch triple together with its 8 edit fields: what a switch change and its undo restore. */
interface SwitchState { triple: SwitchTriple; edit: PerfEdit }

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
  /** Keys whose switch triple was changed by applySwitch (or its undo/redo) and is not verified yet (id → sequence): their job writes the triple from `values`. A job clears only its own sequence. */
  const switchKeys = new Map<number, number>();
  let switchSeq = 0;
  /** Keys whose read-back triple differed from what was written (the firmware normalised it). Cleared by the next applySwitch. */
  const switchNotices = ref<{ id: number; wanted: SwitchTriple; got: SwitchTriple }[]>([]);
  /** Keys whose latest record read from the board (`fresh`) has calibrate 0. Kept in step with every fresh.set. Sorted. */
  const uncalibrated = ref<number[]>([]);
  function noteFresh(id: number, read: Performance): void {
    fresh.set(id, read);
    const has = uncalibrated.value.includes(id);
    if (read.calibrate !== 0) {
      if (has) uncalibrated.value = uncalibrated.value.filter((k) => k !== id);
    } else if (!has) {
      uncalibrated.value = [...uncalibrated.value, id].sort((a, b) => a - b);
    }
  }
  /** Catalog for the connected board, or null (selector read-only). */
  const catalog = computed(() => switchCatalogFor(device.info?.boardIdHex));
  /**
   * The values of the profiles left this session (DESIGN G §3.7): taken when load() starts reading another profile, with
   * the edits made after the last read. `at` = when the app left that profile. In memory only; not the active profile's
   * live values (those are `values`). Named so, because "snapshot" here already means a tuning snapshot.
   */
  const profileSnapshots = shallowRef(new Map<number, { values: Record<number, Performance>; at: number }>());
  /** When the app left the profile held in `values` (null while it is still the active one). */
  let leftAt: number | null = null;
  watch(() => device.activeProfile, (now, old) => {
    leftAt = old === loadedProfile.value ? Date.now() : now === loadedProfile.value ? null : leftAt;
  }, { flush: 'sync' });
  // Another keyboard (or the demo) was connected: nothing cached belongs to it.
  watch(() => device.connection, () => {
    profileSnapshots.value = new Map();
    leftAt = null;
    values.value = {};
    fresh.clear();
    switchKeys.clear();
    switchNotices.value = [];
    uncalibrated.value = [];
    loadedProfile.value = null;
    loadPromise = null; // a load of the old keyboard may still be running: a new load() must start fresh
    loading.value = false;
  }, { flush: 'sync' });
  let loadPromise: Promise<void> | null = null;

  function keyById(id: number): PhysicalKey {
    return device.keys[id];
  }

  /** Sequentially read all 64 keys of the active profile. Cached until the profile changes or force. */
  function load(force = false): Promise<void> {
    // A forced reload requested mid-load (profile switched) runs again once the current load ends.
    if (loadPromise) return force ? loadPromise.then(() => load(true)) : loadPromise;
    if (!force && loadedProfile.value === device.activeProfile && Object.keys(values.value).length) return Promise.resolve();
    const gen = device.connection;
    let mine: Promise<void> | null = null;
    mine = (async () => {
      loading.value = true;
      loadError.value = null;
      loadedCount.value = 0;
      // Keep the profile being left (with its latest edits) before its values go.
      if (loadedProfile.value !== null && Object.keys(values.value).length) {
        const kept = new Map(profileSnapshots.value);
        kept.set(loadedProfile.value, { values: values.value, at: leftAt ?? Date.now() });
        profileSnapshots.value = kept;
        leftAt = null;
      }
      values.value = {};
      fresh.clear();
      const profile = device.activeProfile;
      try {
        const next: Record<number, Performance> = {};
        await device.withTransport(async (t) => {
          for (const key of device.keys) {
            const p = await t.getPerformance(key);
            if (gen !== device.connection) return;
            // A read carries no profile number: it reads the keyboard's active profile. Switched mid-read: drop it all.
            if (device.activeProfile !== profile) return;
            next[key.id] = p;
            noteFresh(key.id, p);
            loadedCount.value++;
          }
        });
        if (gen !== device.connection) return;
        // Not an error: the read stops, `values` stays empty, and the new profile's load() reads it fresh.
        if (device.activeProfile !== profile) return;
        values.value = next;
        loadedProfile.value = profile;
      } catch (err) {
        if (gen !== device.connection) return;
        loadError.value = err instanceof Error ? err.message : String(err);
      } finally {
        if (loadPromise === mine) {
          loading.value = false;
          loadPromise = null;
        }
      }
    })();
    loadPromise = mine;
    return mine;
  }

  function round(mm: number): number {
    const step = device.rtPrecision || 0.001;
    return Math.round(Math.round(mm / step) * step * 1000) / 1000;
  }

  function clamp(p: Performance, e: PerfEdit): PerfEdit {
    const max = rangeMm(p);
    const c = (v: number, lo: number, hi: number) => round(Math.min(hi, Math.max(lo, v)));
    const normalPress = c(e.normalPress, LIMITS.actuationMin, max);
    return {
      // Keep the mode as is (0, 1 or 2); anything else stays unchanged and the write guard refuses it.
      mode: e.mode,
      normalPress,
      normalRelease: normalPress, // the firmware ties it to normalPress
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
    let writtenTriple: SwitchTriple | null = null;
    let mark: number | undefined; // switchKeys sequence this job wrote with
    return {
      key: `perf:${profile}:${id}`,
      group: SAVE_GROUP.PERFORMANCE,
      keys: [id],
      profile,
      label: tr('perf.keyLabel', { key: device.legend(key) }),
      write: async (t: Ae64Transport) => {
        const current = values.value[id];
        const base = fresh.get(id) ?? current;
        written = pickEdit(current);
        written.normalRelease = written.normalPress; // the firmware sets release = press on every write
        // Preserve axis / calibration metadata from the last fresh read; only a switch change writes its own triple.
        mark = switchKeys.get(id);
        writtenTriple = tripleOf(mark !== undefined ? current : base);
        await t.setPerformance(key, { ...base, ...written, ...writtenTriple });
      },
      verify: async (t: Ae64Transport) => {
        const read = await t.getPerformance(key);
        noteFresh(id, read);
        // `write` ties release to press like the firmware, so a read-back of a saved write equals `written`.
        const ok = written !== null && sameEdit(pickEdit(read), written);
        if (!ok) return false;
        const latest = switchKeys.get(id) === mark; // false: a newer switch change is queued for this key
        if (latest) switchKeys.delete(id);
        deleteTuningSnapshot(profile, id); // the hand edit is the truth now: an old snapshot must not overwrite it
        const got = tripleOf(read);
        if (writtenTriple && !sameTriple(got, writtenTriple)) {
          // The firmware normalised the triple: show what the key really has, do not retry.
          switchNotices.value = [...switchNotices.value, { id, wanted: writtenTriple, got }];
          if (latest && loadedProfile.value === profile && values.value[id]) values.value = { ...values.value, [id]: { ...values.value[id], ...got } };
        }
        // The firmware may change calibrate/axis on its own (a switch change resets calibration): show the board's values.
        if (latest && loadedProfile.value === profile && values.value[id]) {
          values.value = { ...values.value, [id]: { ...values.value[id], calibrate: read.calibrate, axis: read.axis } };
        }
        return true;
      },
      // Not saved: show what the key really has (last record read from it) instead of the unsaved edit.
      onDrop: () => {
        const latest = switchKeys.get(id) === mark;
        if (latest) switchKeys.delete(id);
        const real = fresh.get(id);
        if (!real || loadedProfile.value !== profile || !values.value[id]) return;
        // A newer switch change is pending: its triple stays in `values`.
        values.value = { ...values.value, [id]: { ...values.value[id], ...pickEdit(real), calibrate: real.calibrate, axis: real.axis, ...(latest ? tripleOf(real) : {}) } };
      },
    };
  }

  /** Writes the edits to the loaded keys; `triples` (switch path only) also sets the switch triple and marks the key. */
  function commit(map: Record<number, PerfEdit>, triples?: Record<number, SwitchTriple>): void {
    const profile = device.activeProfile;
    if (profile !== loadedProfile.value) return; // stale history entry from another profile
    const next = { ...values.value };
    const changed: number[] = [];
    for (const [idStr, edit] of Object.entries(map)) {
      const id = Number(idStr);
      if (!next[id]) continue; // not loaded (a reload is running): nothing to write it from
      next[id] = { ...next[id], ...edit, ...triples?.[id] };
      next[id].normalRelease = next[id].normalPress; // the firmware sets release = press on every write
      if (triples?.[id]) switchKeys.set(id, ++switchSeq);
      changed.push(id);
    }
    values.value = next;
    for (const id of changed) sync.enqueue(jobFor(id, profile));
  }

  /**
   * Apply an edit to keys. `patch` receives each key's current record and returns the fields to change.
   * Pushes one history entry (coalesced by `coalesce` for continuous gestures) and enqueues sync jobs.
   * Returns how many keys changed (0: nothing was written and no history entry was pushed).
   */
  function apply(ids: number[], patch: (p: Performance) => Partial<PerfEdit>, what: string, coalesce?: string): number {
    if (loadedProfile.value !== device.activeProfile) return 0;
    const before: Record<number, PerfEdit> = {};
    const after: Record<number, PerfEdit> = {};
    for (const id of ids) {
      const cur = values.value[id];
      if (!cur || !isKnownMode(cur.mode)) continue;
      const b = pickEdit(cur);
      const a = clamp(cur, { ...b, ...patch(cur) });
      if (sameEdit(a, b)) continue;
      before[id] = b;
      after[id] = a;
    }
    const n = Object.keys(after).length;
    if (!n) return 0;
    commit(after);
    history.push({
      label: tr('perf.editLabel', { what, n }),
      undo: () => commit(before),
      redo: () => commit(after),
      coalesce: coalesce ? `${coalesce}:${ids.join(',')}` : undefined,
    });
    return n;
  }

  /** The switch each loaded key reports (undefined = not in the catalog; the UI shows the raw axisV2Id). */
  function switchOf(id: number): SwitchEntry | undefined {
    const p = values.value[id];
    return p ? findSwitch(catalog.value, p.axisV2Id) : undefined;
  }

  /** The change `entry` makes to one key, or null when the key is skipped or already is that switch with nothing to clamp. */
  function switchChange(id: number, entry: SwitchEntry): { before: SwitchState; after: SwitchState; clamped: Clamped[] } | null {
    const cur = values.value[id];
    if (!cur || !isKnownMode(cur.mode)) return null;
    const limit = entry.rangeMax / 1000;
    const edit = pickEdit(cur);
    const clamped: Clamped[] = [];
    for (const field of TRAVEL_FIELDS) {
      if (edit[field] > limit) {
        clamped.push({ id, field, from: edit[field], to: limit });
        edit[field] = limit;
      }
    }
    const triple: SwitchTriple = { axisV2Id: entry.id, axisRangeMax: entry.rangeMax, axisCoefficient: entry.coefficient };
    if (!clamped.length && sameTriple(triple, tripleOf(cur))) return null;
    return { before: { triple: tripleOf(cur), edit: pickEdit(cur) }, after: { triple, edit }, clamped };
  }

  /** What applying `entry` to `ids` would do, for the warning before Apply. Writes nothing. */
  function planSwitch(ids: number[], entry: SwitchEntry): { keys: number[]; clamped: Clamped[]; limitMm: number } {
    const keys: number[] = [];
    const clamped: Clamped[] = [];
    if (catalog.value && loadedProfile.value === device.activeProfile) {
      for (const id of ids) {
        const change = switchChange(id, entry);
        if (!change) continue;
        keys.push(id);
        clamped.push(...change.clamped);
      }
    }
    return { keys, clamped, limitMm: entry.rangeMax / 1000 };
  }

  function commitSwitch(map: Record<number, SwitchState>): void {
    const edits: Record<number, PerfEdit> = {};
    const triples: Record<number, SwitchTriple> = {};
    for (const [id, st] of Object.entries(map)) {
      edits[Number(id)] = st.edit;
      triples[Number(id)] = st.triple;
    }
    commit(edits, triples);
  }

  /** One history entry: sets the switch triple and clamps travel values on every listed key that is loaded and in a known mode. */
  function applySwitch(ids: number[], entry: SwitchEntry): void {
    switchNotices.value = [];
    if (!catalog.value || loadedProfile.value !== device.activeProfile) return;
    const before: Record<number, SwitchState> = {};
    const after: Record<number, SwitchState> = {};
    for (const id of ids) {
      const change = switchChange(id, entry);
      if (!change) continue;
      before[id] = change.before;
      after[id] = change.after;
    }
    if (!Object.keys(after).length) return;
    commitSwitch(after);
    history.push({
      label: tr('perf.switchLabel', { name: switchName(entry), n: Object.keys(after).length }),
      undo: () => commitSwitch(before),
      redo: () => commitSwitch(after),
    });
  }

  return { values, loading, loadedCount, loadError, loadedProfile, uncalibrated, profileSnapshots, load, apply, catalog, switchOf, planSwitch, applySwitch, switchNotices };
});
