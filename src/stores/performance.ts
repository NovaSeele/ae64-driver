// Per-key Hall performance for the active profile — the reference implementation of the per-key page
// pattern (docs/ARCHITECTURE.md): load all keys → edit through history + sync → verify by reading back.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { SAVE_GROUP, UnsafeCommandError, isRtMode, supportsIntervalRt } from '../protocol';
import type { Ae64Transport, Performance, PhysicalKey } from '../protocol';
import { DIST_FIELDS, MAX_TRAVEL_MM, checkPerformanceWrite } from '../protocol/safety';
import { FW_AXIS, coefBounds, findSwitch, rangeBounds, switchCatalogFor } from '../protocol/switches';
import type { SwitchEntry, SwitchTriple } from '../protocol/switches';
import { serialReadable } from '../protocol/firmware';
import {
  CUSTOM_SWITCH_MAX, GENERIC_UID,
  addRecalKeys, applyAssignments, clearRecalKeys, customTriple, forgetUid, genericSwitch, knownCustomUids,
  readAssignments, readCustomSwitches, readGenericDecl, readRecalKeys, readyToCustomLike, recalBoardKey,
  removeAssignments, userToCustomLike, writeCustomSwitches, writeGenericDecl,
} from '../data/customSwitch';
import type { CustomLike, CustomSwitch, GenericDecl } from '../data/customSwitch';
import { READY_BOUNDS, READY_SWITCHES } from '../data/readySwitches';
import { switchName } from '../data/switchDisplay';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import type { HistoryEntry } from './history';
import { useSyncStore } from './sync';
import { deleteTuningSnapshot } from './tuning';

/** Fields this app edits. axis and calibrate are always preserved; the switch triple changes only through applySwitch. */
export type PerfEdit = Pick<Performance, 'mode' | 'normalPress' | 'normalRelease' | 'rtFirstTouch' | 'rtPress' | 'rtRelease' | 'pressDeadStroke' | 'releaseDeadStroke'>;
const EDIT_FIELDS: (keyof PerfEdit)[] = ['mode', 'normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease', 'pressDeadStroke', 'releaseDeadStroke'];

export const LIMITS = {
  minMm: 0.001,
  rtMax: 2.0,
  deadMax: 1.0,
};

/** Smallest actuation / RT distance (mm) the connected board takes: its own step (Max 0.001, Pro 0.01). */
export function perfMinMm(rtPrecision: number): number {
  if (!Number.isFinite(rtPrecision) || rtPrecision <= 0) return LIMITS.minMm;
  return Math.max(LIMITS.minMm, Math.round(rtPrecision * 1000) / 1000);
}

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

/** Distance fields fitted to a switch's travel limit (same seven fields checkPerformanceWrite checks). */
export type TravelField = (typeof DIST_FIELDS)[number];
export type Clamped = { id: number; field: TravelField; from: number; to: number };

/** Choice passed to planSwitch / applySwitch (DESIGN CSW §7.2). */
export type SwitchChoice =
  | { kind: 'catalog'; entry: SwitchEntry }
  | { kind: 'custom'; custom: CustomLike };

/** Resolved identity of a loaded key's switch, in DESIGN CSW §9.2's exact order. */
export type KeySwitch =
  | { kind: 'lost'; triple: SwitchTriple }
  | { kind: 'custom'; custom: CustomLike; triple: SwitchTriple; assigned: boolean }
  | { kind: 'catalog'; entry: SwitchEntry }
  | { kind: 'unnamed'; triple: SwitchTriple }
  | { kind: 'unknown'; triple: SwitchTriple };

export type SwitchAction = 'write' | 'rename' | 'noop';

/** A key's switch triple together with its 8 edit fields: what a switch change and its undo restore. */
export interface SwitchState { triple: SwitchTriple; edit: PerfEdit }

export interface SwitchKeyPlan {
  id: number;
  action: SwitchAction;
  before: SwitchState;
  after: SwitchState;
  tripleChanged: boolean;
  idKept: boolean;
  idNew: boolean;
  clamped: Clamped[];
  assignBefore: string | null;
  assignAfter: string | null;
}

/** Plan and counts for the switch picker summary and applySwitch (DESIGN CSW §7.2, §7.3). */
export interface SwitchPlan {
  entries: SwitchKeyPlan[];
  keys: number[];
  renameKeys: number[];
  write: number;
  idNew: number;
  idKept: number;
  rename: number;
  deeper: boolean;
  clamped: Clamped[];
  limitMm: number;
  fallbackId: number | null;
}

export type SwapAnswer = 'replaced' | 'notReplaced' | 'back';

export type ApplySwitchResult =
  | { status: 'noop' }
  | { status: 'question'; plan: SwitchPlan }
  | { status: 'cancelled' }
  | { status: 'renamed'; renamed: number; name: string }
  | { status: 'applied'; written: number; renamed: number; marked: boolean; idNew: number; name: string };

/** Post-Apply key-check watch state (DESIGN CSW §7.9, in memory only). */
export interface SwitchVerify {
  board: string;
  keys: number[];
  name: string;
  rangeUm: number;
  passed: boolean;
}

/** An assigned key whose on-board R or c no longer matches its entry (and is not lost, §11.1). */
export interface StaleKey {
  id: number;
  uid: string;
  custom: CustomLike;
  actual: SwitchTriple;
  expected: { rangeUm: number; coefficient: number };
  isGeneric: boolean;
}

/** A key whose on-board R < 1000 µm (cannot actuate, §11.1). */
export interface LostKey {
  id: number;
  uid: string | null;
  custom: CustomLike | null;
  triple: SwitchTriple;
}

function formatUmMm(rangeUm: number): string {
  const mm = rangeUm / 1000;
  return mm.toFixed(Math.abs(mm * 100 - Math.round(mm * 100)) < 0.0005 ? 2 : 3);
}

/** Shown name of a custom switch (generic uses csw.genericLabel with the declared travel, §5.7). */
export function customSwitchName(c: CustomLike): string {
  return c.uid === GENERIC_UID ? tr('csw.genericLabel', { mm: formatUmMm(c.rangeUm) }) : c.name;
}

const READY_AS_CUSTOM: readonly CustomLike[] = Object.freeze(READY_SWITCHES.map(readyToCustomLike));

function clampInt(v: number, b: { min: number; max: number }): number {
  return Math.min(b.max, Math.max(b.min, Math.round(v)));
}

function effectiveCustomPair(c: CustomLike, cat: readonly SwitchEntry[] | null): { rangeUm: number; coefficient: number } {
  const rb = rangeBounds(cat), cb = coefBounds(cat);
  if (rb && cb) return { rangeUm: clampInt(c.rangeUm, rb), coefficient: clampInt(c.coefficient, cb) };
  return { rangeUm: Math.round(c.rangeUm), coefficient: Math.round(c.coefficient) };
}

const isWritableTriple = (t: SwitchTriple): boolean =>
  t.axisRangeMax >= FW_AXIS.rangeMin && t.axisCoefficient >= FW_AXIS.coefMin;

/** The guard's distance limit (mm) for a switch range (µm): min(R / 1000, MAX_TRAVEL_MM). */
export function travelLimitMm(rangeUm: number): number {
  return Math.min(rangeUm / 1000, MAX_TRAVEL_MM);
}

/**
 * Fits every distance field of `edit` to `travelLimitMm(rangeUm)` so the plan matches checkPerformanceWrite's seven-field rule.
 * Returns a new edit object without mutating the input. Values at or under the limit are untouched; travel fields above it
 * become the limit; dead-zone fields above it become LIMITS.deadMax (1.0 mm) because the firmware computes bottom dead zone
 * as R − setting (setting ≥ R covers the whole travel or wraps).
 */
export function fitTravel(edit: PerfEdit, rangeUm: number): { edit: PerfEdit; clamped: { field: TravelField; from: number; to: number }[] } {
  const limit = travelLimitMm(rangeUm);
  const next: PerfEdit = { ...edit };
  const clamped: { field: TravelField; from: number; to: number }[] = [];
  for (const field of DIST_FIELDS) {
    const from = next[field];
    if (from > limit + 1e-9) {
      const to = field === 'pressDeadStroke' || field === 'releaseDeadStroke' ? LIMITS.deadMax : limit;
      clamped.push({ field, from, to });
      next[field] = to;
    }
  }
  return { edit: next, clamped };
}

const tripleOf = (p: Performance): SwitchTriple => ({ axisV2Id: p.axisV2Id, axisRangeMax: p.axisRangeMax, axisCoefficient: p.axisCoefficient });
const sameTriple = (a: SwitchTriple, b: SwitchTriple): boolean =>
  a.axisV2Id === b.axisV2Id && a.axisRangeMax === b.axisRangeMax && a.axisCoefficient === b.axisCoefficient;

interface VerifyBatch {
  id: number;
  board: string;
  name: string;
  rangeUm: number;
  keys: Set<number>;
}

/** Per-key outcome of restoring backed-up switch values after a firmware update (OFU v1.10 addendum §4.3). */
export interface RestoreAxisResult {
  restored: number[];
  failed: number[];
  refused: { id: number; reason: string }[];
}

interface PendingSwitch {
  seq: number;
  writeTriple: boolean;
  assign?: string | null;
  recal: boolean;
  verifyOp?: VerifyBatch;
  /** Firmware switch-values restore: settles restored/failed from read-back instead of switchNotices. */
  onRestore?: (ok: boolean) => void;
  /** Firmware switch-values restore: called if BaseTransport's guard refuses the write. */
  onRefuse?: (reason: string) => void;
}

/** Field group for a board-clamped read-back notice (DESIGN FST §10.3 M8). */
export type KeptField = 'act' | 'rtPress' | 'rtRelease';
export interface KeptNotice {
  field: KeptField;
  wanted: number;
  got: number;
  ids: number[];
}

function sameEdit(a: PerfEdit, b: PerfEdit): boolean {
  return EDIT_FIELDS.every((f) => Math.abs(a[f] - b[f]) < 0.0005);
}

type KeptEditField = 'normalPress' | 'normalRelease' | 'rtFirstTouch' | 'rtPress' | 'rtRelease';
const KEPT_FIELDS: ReadonlySet<keyof PerfEdit> = new Set<KeptEditField>(['normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease']);
const isKeptField = (f: keyof PerfEdit): f is KeptEditField => KEPT_FIELDS.has(f);
const KEPT_CEIL = 0.1;
const KEPT_READ_MAX = 0.1005;
const keptGroup = (f: KeptEditField): KeptField =>
  (f === 'rtPress' ? 'rtPress' : f === 'rtRelease' ? 'rtRelease' : 'act');

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
  /** Readable serial of the keyboard the last full load() read, or null if not loaded / unreadable serial. */
  const loadedSerial = ref<string | null>(null);
  /** Bumped after every completed full read or verified single-key read (drives firmware switch-restore re-compare). */
  const readSeq = ref(0);
  /** Last record read from the board per key: the source of preserved axis/calibration fields. */
  const fresh = new Map<number, Performance>();
  /** Connection-scoped history of performance records read per key (mirrors BaseTransport.perfSeen for checkPerformanceWrite). */
  const seenByKey = new Map<number, Performance[]>();
  /** Keys with a pending switch write / undo / redo (id → metadata): their job writes the triple and settles assignment/recal/verify on exact read-back. */
  const switchKeys = new Map<number, PendingSwitch>();
  let switchSeq = 0;
  /** Keys whose read-back triple differed from what was written (the firmware normalised it). Cleared by the next applySwitch write. */
  const switchNotices = ref<{ id: number; wanted: SwitchTriple; got: SwitchTriple }[]>([]);
  /** Notices from verify() when the board stored a raised floor value (< 0.1 -> <= 0.1005, DESIGN FST §10.3 M8). */
  const keptNotices = ref<KeptNotice[]>([]);
  function clearKeptNotices(): void {
    keptNotices.value = [];
  }
  /** Keys whose latest record read from the board (`fresh`) has calibrate 0. Kept in step with every fresh.set. Sorted. */
  const uncalibrated = ref<number[]>([]);
  function noteFresh(id: number, read: Performance): void {
    fresh.set(id, read);
    const seen = seenByKey.get(id) ?? [];
    seen.push({ ...read });
    if (seen.length > 8) seen.splice(1, seen.length - 8);
    seenByKey.set(id, seen);
    const has = uncalibrated.value.includes(id);
    if (read.calibrate !== 0) {
      if (has) uncalibrated.value = uncalibrated.value.filter((k) => k !== id);
    } else if (!has) {
      uncalibrated.value = [...uncalibrated.value, id].sort((a, b) => a - b);
    }
    if (!loading.value) readSeq.value++;
  }
  /** Records read from key `id` during this connection (newest last), for checkPerformanceWrite. */
  function seenFor(id: number): readonly Performance[] {
    return seenByKey.get(id) ?? [];
  }
  /**
   * A record of key `id` that another store read from profile `profile` (advanced keys restore the tuning after their
   * write): later writes of this key start from it, and the hardware-owned fields shown follow it. Ignored for another profile.
   */
  function noteRead(profile: number, id: number, read: Performance): void {
    if (loadedProfile.value !== profile || device.activeProfile !== profile) return;
    noteFresh(id, read);
    const cur = values.value[id];
    if (cur) values.value = { ...values.value, [id]: { ...cur, calibrate: read.calibrate, axis: read.axis } };
  }
  /** Catalog for the connected board, or null (generic or unlisted board; DESIGN MKB §3.4, §11). */
  const catalog = computed(() => (device.support === 'generic' ? null : switchCatalogFor(device.info?.boardIdHex)));

  // ---- Custom switches, generic switch, per-board assignments, recal list, and post-Apply verify (§5.7, §7.9, §9, §10, §11, §13)
  const customSwitches = shallowRef<CustomSwitch[]>(readCustomSwitches());
  const genericDecl = ref<GenericDecl | null>(readGenericDecl());
  const genericEntry = computed<CustomLike>(() => genericSwitch(genericDecl.value, catalog.value));
  const knownUids = computed(() => knownCustomUids(customSwitches.value));
  const namedCustoms = computed<CustomLike[]>(() => [...READY_AS_CUSTOM, ...customSwitches.value.map(userToCustomLike)]);
  const boardSerial = computed(() => (serialReadable(device.info?.serialHex) ? device.info!.serialHex : null));
  const boardKey = computed(() => recalBoardKey(device.info) ?? device.info?.boardIdHex ?? null);
  /** Assignments for the connected board (keyId → custom uid); always empty without a readable serial. */
  const assignments = shallowRef<Record<number, string>>({});
  /** App-tracked recalibration keys for the connected board (`ae64.switch.recal`). Sorted. */
  const recalKeys = shallowRef<number[]>([]);
  /** Post-Apply key-check watch record (in memory only, §7.9). */
  const verify = ref<SwitchVerify | null>(null);
  let activeVerifyOpId = 0;

  function syncBoardStorage(): void {
    assignments.value = readAssignments(boardSerial.value, knownUids.value);
    recalKeys.value = readRecalKeys(device.info);
  }

  /** Re-read custom switches, generic declaration, assignments and recal list from localStorage (0 HID). */
  function reloadCustomSwitches(): void {
    customSwitches.value = readCustomSwitches();
    genericDecl.value = readGenericDecl();
    syncBoardStorage();
  }

  function updateBoardAssignments(changes: Record<number, string | null>): void {
    applyAssignments(boardSerial.value, changes, { knownUids: knownUids.value });
    assignments.value = readAssignments(boardSerial.value, knownUids.value);
  }

  function addRecal(ids: Iterable<number>): void {
    recalKeys.value = addRecalKeys(device.info, ids);
  }

  /** Clear keys from the app's recal list (called only from a saved calibration session's `lastSaved`, §10.1; 0 HID). */
  function clearRecal(ids: Iterable<number>): void {
    recalKeys.value = clearRecalKeys(device.info, ids);
  }

  /** Keys needing calibration: board calibrate 0 ∪ app recal list for this board (§10.1). Sorted. */
  const needsCal = computed<number[]>(() => {
    if (!recalKeys.value.length) return uncalibrated.value;
    if (!uncalibrated.value.length) return recalKeys.value;
    const set = new Set<number>(uncalibrated.value);
    for (const id of recalKeys.value) set.add(id);
    return [...set].sort((a, b) => a - b);
  });

  function clearVerify(): void {
    activeVerifyOpId++;
    verify.value = null;
  }

  function markVerifyPassed(): void {
    if (verify.value && !verify.value.passed) verify.value = { ...verify.value, passed: true };
  }

  /** Create or update a user custom switch in localStorage (0 HID). Returns false when adding past the 50-entry cap. */
  function saveCustomSwitch(entry: CustomSwitch): boolean {
    const cur = customSwitches.value;
    const idx = cur.findIndex((x) => x.uid === entry.uid);
    if (idx < 0 && cur.length >= CUSTOM_SWITCH_MAX) return false;
    const next = idx >= 0 ? cur.map((x, i) => (i === idx ? entry : x)) : [...cur, entry];
    writeCustomSwitches(next);
    customSwitches.value = readCustomSwitches();
    return true;
  }

  /** Append imported user custom switches up to the 50-entry cap (0 HID). Returns how many were added. */
  function addCustomSwitches(entries: readonly CustomSwitch[]): number {
    const cur = customSwitches.value;
    const existing = new Set(cur.map((x) => x.uid));
    const room = Math.max(0, CUSTOM_SWITCH_MAX - cur.length);
    const toAdd: CustomSwitch[] = [];
    for (const e of entries) {
      if (toAdd.length >= room) break;
      if (existing.has(e.uid)) continue;
      existing.add(e.uid);
      toAdd.push(e);
    }
    if (!toAdd.length) return 0;
    writeCustomSwitches([...cur, ...toAdd]);
    customSwitches.value = readCustomSwitches();
    return toAdd.length;
  }

  /** Delete a user custom switch and remove its assignments across all boards (0 HID, not on undo stack). */
  function deleteCustomSwitch(uid: string): void {
    const next = customSwitches.value.filter((x) => x.uid !== uid);
    writeCustomSwitches(next);
    forgetUid(uid);
    customSwitches.value = readCustomSwitches();
    syncBoardStorage();
  }

  /** Save the generic switch's declared travel (clamped to bounds, 0 HID; assigned keys become stale, §5.7 / §11). */
  function setGenericRange(rangeUm: number): void {
    const rb = rangeBounds(catalog.value) ?? { min: READY_BOUNDS.rMin, max: READY_BOUNDS.rMax };
    writeGenericDecl(clampInt(rangeUm, rb));
    genericDecl.value = readGenericDecl();
  }

  /** "Quên" (§11.2): remove custom assignments for `ids` on this board (0 HID, not on undo stack). */
  function forgetKeys(ids: Iterable<number>): void {
    removeAssignments(boardSerial.value, ids, { knownUids: knownUids.value });
    assignments.value = readAssignments(boardSerial.value, knownUids.value);
  }

  function findCustomByUid(uid: string): CustomLike | null {
    if (uid === GENERIC_UID) return genericEntry.value;
    return namedCustoms.value.find((c) => c.uid === uid) ?? null;
  }

  watch(
    () => [device.connection, device.info?.serialHex, device.info?.boardIdHex, customSwitches.value] as const,
    () => { syncBoardStorage(); },
    { immediate: true, flush: 'sync' },
  );
  watch(
    () => [device.connection, device.connected, boardKey.value] as const,
    ([conn, connected, bk], prev) => {
      if (!connected || !prev || conn !== prev[0] || (verify.value && verify.value.board !== bk)) {
        activeVerifyOpId++;
        verify.value = null;
      }
    },
    { flush: 'sync' },
  );

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
    keptNotices.value = [];
  }, { flush: 'sync' });
  // Another keyboard (or the demo) was connected: nothing cached belongs to it.
  watch(() => device.connection, () => {
    profileSnapshots.value = new Map();
    leftAt = null;
    values.value = {};
    fresh.clear();
    seenByKey.clear();
    switchKeys.clear();
    switchNotices.value = [];
    keptNotices.value = [];
    uncalibrated.value = [];
    loadedProfile.value = null;
    loadedSerial.value = null;
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
    if (!force && loadedProfile.value === device.activeProfile && (Object.keys(values.value).length || !device.keys.length)) return Promise.resolve();
    const gen = device.connection;
    const readSerial = serialReadable(device.info?.serialHex) ? device.info!.serialHex : null;
    let mine: Promise<void> | null = null;
    mine = (async () => {
      loading.value = true;
      loadError.value = null;
      loadedCount.value = 0;
      loadedSerial.value = null;
      keptNotices.value = [];
      reloadCustomSwitches();
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
        loadedSerial.value = readSerial;
        readSeq.value++;
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

  /**
   * Clamps and rounds only the fields present in `p` (DESIGN FST §10.2 M3 / FST-R0).
   * Unedited fields stay untouched even outside LIMITS or off the board's precision grid.
   * When `p` sets `mode`, any field that mode puts into use and `p` does not set is raised to
   * the minimum if below it (never lowered, never rounded); `normalRelease` stays tied to `normalPress` (SYNC-REL-1).
   */
  function clampSet(cur: Performance, p: Partial<PerfEdit>): Partial<PerfEdit> {
    const min = perfMinMm(device.rtPrecision);
    const max = rangeMm(cur);
    const c = (v: number, lo: number, hi: number) => round(Math.min(hi, Math.max(lo, v)));
    const out: Partial<PerfEdit> = {};
    if (p.mode !== undefined) out.mode = p.mode;
    if (p.normalPress !== undefined) {
      out.normalPress = c(p.normalPress, min, max);
      out.normalRelease = out.normalPress; // the firmware ties it to normalPress (SYNC-REL-1)
    } else if (p.normalRelease !== undefined) {
      out.normalRelease = cur.normalPress;
    }
    if (p.rtFirstTouch !== undefined) out.rtFirstTouch = c(p.rtFirstTouch, min, max);
    if (p.rtPress !== undefined) out.rtPress = c(p.rtPress, min, LIMITS.rtMax);
    if (p.rtRelease !== undefined) out.rtRelease = c(p.rtRelease, min, LIMITS.rtMax);
    if (p.pressDeadStroke !== undefined) out.pressDeadStroke = c(p.pressDeadStroke, 0, LIMITS.deadMax);
    if (p.releaseDeadStroke !== undefined) out.releaseDeadStroke = c(p.releaseDeadStroke, 0, LIMITS.deadMax);

    if (p.mode !== undefined) {
      if (isRtMode(p.mode)) {
        const entering = !isRtMode(cur.mode);
        if (out.rtFirstTouch === undefined && (entering ? cur.rtFirstTouch < min : cur.rtFirstTouch <= 0)) {
          out.rtFirstTouch = min;
        }
        if (out.rtPress === undefined && (entering ? cur.rtPress < min : cur.rtPress <= 0)) {
          out.rtPress = min;
        }
        if (out.rtRelease === undefined && (entering ? cur.rtRelease < min : cur.rtRelease <= 0)) {
          out.rtRelease = min;
        }
      } else if (p.mode === 0) {
        const entering = cur.mode !== 0;
        if (out.normalPress === undefined && (entering ? cur.normalPress < min : cur.normalPress <= 0)) {
          out.normalPress = min;
          out.normalRelease = out.normalPress;
        }
      }
    }
    return out;
  }

  function recordKeptNotice(field: KeptField, wanted: number, got: number, id: number): void {
    const list = keptNotices.value.slice();
    const idx = list.findIndex((n) => n.field === field);
    if (idx >= 0 && Math.abs(list[idx].wanted - wanted) < 0.0005 && Math.abs(list[idx].got - got) < 0.0005) {
      if (!list[idx].ids.includes(id)) list[idx] = { ...list[idx], ids: [...list[idx].ids, id].sort((a, b) => a - b) };
    } else if (idx >= 0) {
      list[idx] = { field, wanted, got, ids: [id] };
    } else {
      list.push({ field, wanted, got, ids: [id] });
    }
    keptNotices.value = list;
  }

  function clearKeptKey(field: KeptField, id: number): void {
    const idx = keptNotices.value.findIndex((n) => n.field === field && n.ids.includes(id));
    if (idx < 0) return;
    const ids = keptNotices.value[idx].ids.filter((k) => k !== id);
    const next = keptNotices.value.slice();
    if (ids.length) next[idx] = { ...next[idx], ids };
    else next.splice(idx, 1);
    keptNotices.value = next;
  }

  function jobFor(id: number, profile: number) {
    const key = keyById(id);
    const createdSeq = switchKeys.get(id)?.seq;
    let written: PerfEdit | null = null;
    let writtenBase: PerfEdit | null = null;
    let writtenTriple: SwitchTriple | null = null;
    let pending: PendingSwitch | undefined;
    return {
      key: `perf:${profile}:${id}`,
      group: SAVE_GROUP.PERFORMANCE,
      keys: [id],
      profile,
      label: tr('perf.keyLabel', { key: device.legend(key) }),
      write: async (t: Ae64Transport) => {
        const current = values.value[id];
        const base = fresh.get(id) ?? current;
        writtenBase = pickEdit(base);
        written = pickEdit(current);
        written.normalRelease = written.normalPress; // the firmware sets release = press on every write
        // Preserve axis / calibration metadata from the last fresh read; only a switch change writes its own triple.
        pending = switchKeys.get(id);
        writtenTriple = tripleOf(pending?.writeTriple ? current : base);
        try {
          await t.setPerformance(key, { ...base, ...written, ...writtenTriple });
        } catch (err) {
          if (err instanceof UnsafeCommandError && pending?.onRefuse) pending.onRefuse(err.reason);
          throw err;
        }
      },
      verify: async (t: Ae64Transport) => {
        const read = await t.getPerformance(key);
        noteFresh(id, read);
        if (written === null) return false;
        // `write` ties release to press like the firmware, so a read-back of a saved write equals `written`,
        // except for M8's narrow floor raise: one of the five actuation/RT fields, written < 0.1, written < read <= 0.1005.
        const gotEdit = pickEdit(read);
        const raised: { field: KeptEditField; wanted: number; got: number }[] = [];
        for (const f of EDIT_FIELDS) {
          const w = written[f];
          const r = gotEdit[f];
          if (Math.abs(r - w) < 0.0005) continue;
          if (isKeptField(f) && w < KEPT_CEIL - 1e-9 && r > w && r <= KEPT_READ_MAX + 1e-9) {
            raised.push({ field: f, wanted: w, got: r });
          } else {
            return false;
          }
        }
        const latest = pending !== undefined && switchKeys.get(id)?.seq === pending.seq;
        if (latest) switchKeys.delete(id);
        deleteTuningSnapshot(profile, id); // the hand edit is the truth now: an old snapshot must not overwrite it
        if (loadedProfile.value === profile) {
          // M8: apply raised read values only where the key's shown value still equals what was written (a newer edit wins).
          if (raised.length && values.value[id]) {
            const cur = values.value[id];
            const patchShown: Partial<PerfEdit> = {};
            for (const { field, wanted, got } of raised) {
              if (Math.abs(cur[field] - wanted) < 0.0005) patchShown[field] = got;
            }
            if (Object.keys(patchShown).length) {
              values.value = { ...values.value, [id]: { ...cur, ...patchShown } };
            }
          }
          const raisedByGroup = new Map<KeptField, { wanted: number; got: number }>();
          for (const item of raised) {
            const g = keptGroup(item.field);
            // Prefer the active mode's actuation field when multiple actuation fields are raised together.
            const activeAct = isRtMode(written.mode) ? 'rtFirstTouch' : 'normalPress';
            if (!raisedByGroup.has(g) || item.field === activeAct) {
              raisedByGroup.set(g, { wanted: item.wanted, got: item.got });
            }
          }
          for (const [g, { wanted, got }] of raisedByGroup) recordKeptNotice(g, wanted, got, id);
          // Clear this key from a prior kept notice when a later write of that field reads back exactly.
          if (writtenBase) {
            for (const g of ['act', 'rtPress', 'rtRelease'] as const) {
              if (raisedByGroup.has(g)) continue;
              const fields: (keyof PerfEdit)[] = g === 'act' ? ['normalPress', 'normalRelease', 'rtFirstTouch'] : [g];
              if (fields.some((f) => Math.abs(written![f] - writtenBase![f]) >= 0.0005)) clearKeptKey(g, id);
            }
          }
        }
        const got = tripleOf(read);
        const tripleOk = !writtenTriple || sameTriple(got, writtenTriple);
        if (!tripleOk) {
          // The firmware normalised or refused the triple: show what the key really has, set no assignment/recal/verify, do not retry.
          if (pending?.onRestore) pending.onRestore(false);
          else switchNotices.value = [...switchNotices.value, { id, wanted: writtenTriple!, got }];
          if (latest && loadedProfile.value === profile && values.value[id]) values.value = { ...values.value, [id]: { ...values.value[id], ...got } };
        } else if (latest && pending) {
          if (pending.onRestore) pending.onRestore(true);
          if (pending.assign !== undefined) updateBoardAssignments({ [id]: pending.assign });
          if (pending.recal) addRecal([id]);
          if (pending.verifyOp && pending.verifyOp.id === activeVerifyOpId) {
            pending.verifyOp.keys.add(id);
            verify.value = {
              board: pending.verifyOp.board,
              keys: [...pending.verifyOp.keys].sort((a, b) => a - b),
              name: pending.verifyOp.name,
              rangeUm: pending.verifyOp.rangeUm,
              passed: false,
            };
          }
        }
        // The firmware may change calibrate/axis on its own (a switch id change resets calibration): show the board's values.
        if (latest && loadedProfile.value === profile && values.value[id]) {
          values.value = { ...values.value, [id]: { ...values.value[id], calibrate: read.calibrate, axis: read.axis } };
        }
        return true;
      },
      // Not saved: show what the key really has (last record read from it) instead of the unsaved edit.
      onDrop: () => {
        const mySeq = pending?.seq ?? createdSeq;
        const latest = mySeq !== undefined && switchKeys.get(id)?.seq === mySeq;
        if (latest) switchKeys.delete(id);
        const real = fresh.get(id);
        if (!real || loadedProfile.value !== profile || !values.value[id]) return;
        // A newer switch change is pending: its triple stays in `values`.
        const revertTriple = latest && (pending ? pending.writeTriple : true);
        values.value = { ...values.value, [id]: { ...values.value[id], ...pickEdit(real), calibrate: real.calibrate, axis: real.axis, ...(revertTriple ? tripleOf(real) : {}) } };
      },
    };
  }

  /** Writes the edits to the loaded keys; `triples` / `switchMeta` (switch path only) also set the switch triple and verify metadata. */
  function commit(
    map: Record<number, PerfEdit>,
    triples?: Record<number, SwitchTriple>,
    switchMeta?: Record<number, Omit<PendingSwitch, 'seq' | 'writeTriple'>>,
  ): void {
    const profile = device.activeProfile;
    if (profile !== loadedProfile.value) return; // stale history entry from another profile
    const next = { ...values.value };
    const changed: number[] = [];
    for (const [idStr, edit] of Object.entries(map)) {
      const id = Number(idStr);
      if (!next[id]) continue; // not loaded (a reload is running): nothing to write it from
      next[id] = { ...next[id], ...edit, ...triples?.[id] };
      next[id].normalRelease = next[id].normalPress; // the firmware sets release = press on every write
      const hasTriple = Boolean(triples?.[id]);
      const meta = switchMeta?.[id];
      if (hasTriple || meta) {
        switchKeys.set(id, {
          seq: ++switchSeq,
          writeTriple: hasTriple,
          assign: meta?.assign,
          recal: meta?.recal ?? false,
          verifyOp: meta?.verifyOp,
          onRestore: meta?.onRestore,
          onRefuse: meta?.onRefuse,
        });
      }
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
      const p = patch(cur);
      const a = { ...b, ...clampSet(cur, p) };
      if (sameEdit(a, b)) continue;
      before[id] = b;
      after[id] = a;
    }
    const n = Object.keys(after).length;
    if (!n) return 0;
    commit(after);
    history.push(editEntry(before, after, what, coalesce ? `${coalesce}:${ids.join(',')}` : undefined));
    return n;
  }

  /**
   * One history entry for an edit. Steps of one gesture (same `coalesce`) merge (U-02): per key the value from before the
   * gesture wins (the first step that changed it), the last value goes to redo. A step may change keys the step before left
   * alone (a mixed field clamped at a bound, a drag that starts on one key's value): one undo puts every key back.
   */
  type EditMaps = { before: Record<number, PerfEdit>; after: Record<number, PerfEdit> };
  function editEntry(before: Record<number, PerfEdit>, after: Record<number, PerfEdit>, what: string, coalesce?: string): HistoryEntry & { edit: EditMaps } {
    return {
      label: tr('perf.editLabel', { what, n: Object.keys(after).length }),
      undo: () => commit(before),
      redo: () => commit(after),
      coalesce,
      edit: { before, after },
      absorb: (older) => {
        const o = (older as { edit?: EditMaps }).edit;
        if (!o) return { ...older, redo: () => commit(after) };
        return editEntry({ ...before, ...o.before }, { ...o.after, ...after }, what, coalesce);
      },
    };
  }

  /** The switch each loaded key reports by id (legacy helper; new code uses keySwitch). */
  function switchOf(id: number): SwitchEntry | undefined {
    const p = values.value[id];
    return p ? findSwitch(catalog.value, p.axisV2Id) : undefined;
  }

  /** Resolved switch identity of a triple on key `id`, in DESIGN CSW §9.2's exact five-step order. */
  function switchIdentity(triple: SwitchTriple, id: number): KeySwitch {
    // 1. R < 1000: lost (cannot actuate)
    if (triple.axisRangeMax < FW_AXIS.rangeMin) return { kind: 'lost', triple };
    const cat = catalog.value;
    // 2. Assignment for (board, key) with a known entry whose R and c match the key's
    const uid = assignments.value[id];
    if (uid) {
      const assigned = findCustomByUid(uid);
      if (assigned) {
        const pair = effectiveCustomPair(assigned, cat);
        if (triple.axisRangeMax === pair.rangeUm && triple.axisCoefficient === pair.coefficient) {
          return { kind: 'custom', custom: assigned, triple, assigned: true };
        }
      }
    }
    // 3. Exact list triple (id, R and c)
    const catEntry = findSwitch(cat, triple.axisV2Id);
    if (catEntry && catEntry.rangeMax === triple.axisRangeMax && catEntry.coefficient === triple.axisCoefficient) {
      return { kind: 'catalog', entry: catEntry };
    }
    // 4. R and c within the list's bounds → unique known entry (ready-made or yours), else unnamed
    const rb = rangeBounds(cat), cb = coefBounds(cat);
    if (
      rb && cb
      && Number.isInteger(triple.axisRangeMax) && triple.axisRangeMax >= rb.min && triple.axisRangeMax <= rb.max
      && Number.isInteger(triple.axisCoefficient) && triple.axisCoefficient >= cb.min && triple.axisCoefficient <= cb.max
    ) {
      const matches = namedCustoms.value.filter((c) => {
        const pair = effectiveCustomPair(c, cat);
        return pair.rangeUm === triple.axisRangeMax && pair.coefficient === triple.axisCoefficient;
      });
      if (matches.length === 1) return { kind: 'custom', custom: matches[0], triple, assigned: false };
      return { kind: 'unnamed', triple };
    }
    // 5. Anything else
    return { kind: 'unknown', triple };
  }

  /** Resolved switch identity of a loaded key, in DESIGN CSW §9.2's exact five-step order. */
  function keySwitch(id: number): KeySwitch | undefined {
    const p = values.value[id];
    return p ? switchIdentity(tripleOf(p), id) : undefined;
  }

  /** Full-read check (§11.1): stale (assigned known entry whose R or c differs, not lost) and lost (R < 1000). */
  const switchCheck = computed(() => {
    const stale: StaleKey[] = [];
    const lost: LostKey[] = [];
    if (loading.value || loadedProfile.value !== device.activeProfile || !device.keys.length) return { stale, lost };
    const vals = values.value;
    if (device.keys.some((k) => !vals[k.id])) return { stale, lost };
    const cat = catalog.value;
    const assign = assignments.value;
    for (const k of device.keys) {
      const p = vals[k.id];
      const triple = tripleOf(p);
      const uid = assign[k.id] ?? null;
      const entry = uid ? findCustomByUid(uid) : null;
      if (triple.axisRangeMax < FW_AXIS.rangeMin) {
        lost.push({ id: k.id, uid: entry ? entry.uid : null, custom: entry, triple });
      } else if (entry) {
        const expected = effectiveCustomPair(entry, cat);
        if (triple.axisRangeMax !== expected.rangeUm || triple.axisCoefficient !== expected.coefficient) {
          stale.push({ id: k.id, uid: entry.uid, custom: entry, actual: triple, expected, isGeneric: entry.uid === GENERIC_UID });
        }
      }
    }
    return { stale, lost };
  });
  const staleKeys = computed<StaleKey[]>(() => switchCheck.value.stale);
  const lostKeys = computed<LostKey[]>(() => switchCheck.value.lost);

  /** Loaded keys on the active profile with any of the seven distances above travelLimitMm(R) + 0.5 µm (§8). */
  const deepKeys = computed<number[]>(() => {
    if (loading.value || loadedProfile.value !== device.activeProfile) return [];
    const out: number[] = [];
    for (const k of device.keys) {
      const p = values.value[k.id];
      if (!p || !isKnownMode(p.mode) || p.axisRangeMax < FW_AXIS.rangeMin) continue;
      const limit = travelLimitMm(p.axisRangeMax);
      if (DIST_FIELDS.some((f) => p[f] > limit + 0.0005)) out.push(k.id);
    }
    return out;
  });

  /** Travel tab "Lower to fit the switch" fix (§8): writes only the deep values via fitTravel (triple unchanged, one history entry). */
  function fixDeepTravel(): number {
    if (loadedProfile.value !== device.activeProfile) return 0;
    const before: Record<number, PerfEdit> = {};
    const after: Record<number, PerfEdit> = {};
    for (const id of deepKeys.value) {
      const cur = values.value[id];
      if (!cur || !isKnownMode(cur.mode) || cur.axisRangeMax < FW_AXIS.rangeMin) continue;
      const b = pickEdit(cur);
      const fitted = fitTravel(b, cur.axisRangeMax);
      if (!fitted.clamped.length) continue;
      const a: PerfEdit = { ...fitted.edit, normalRelease: fitted.edit.normalPress };
      if (sameEdit(a, b)) continue;
      before[id] = b;
      after[id] = a;
    }
    const n = Object.keys(after).length;
    if (!n) return 0;
    commit(after);
    history.push(editEntry(before, after, tr('perf.deepFix')));
    return n;
  }

  /** What applying `choice` to `ids` would do (per-key plan + §7.3 counts + clamp list). Writes nothing (0 HID). */
  function planSwitch(choice: SwitchChoice, ids: number[]): SwitchPlan {
    const cat = catalog.value;
    const targetRangeUm = choice.kind === 'catalog'
      ? choice.entry.rangeMax
      : effectiveCustomPair(choice.custom, cat).rangeUm;
    const limitMm = travelLimitMm(targetRangeUm);
    const entries: SwitchKeyPlan[] = [];
    const keys: number[] = [];
    const renameKeys: number[] = [];
    const clamped: Clamped[] = [];
    let idNew = 0;
    let idKept = 0;
    let deeper = false;
    let fallback: number | null = null;
    const canAssign = boardSerial.value !== null;

    if (cat && loadedProfile.value === device.activeProfile) {
      const seen = new Set<number>();
      for (const id of ids) {
        if (seen.has(id)) continue;
        seen.add(id);
        const cur = values.value[id];
        if (!cur || !isKnownMode(cur.mode)) continue;
        const curTriple = tripleOf(cur);
        const beforeEdit = pickEdit(cur);
        let triple: SwitchTriple;
        let kept: boolean;
        if (choice.kind === 'catalog') {
          triple = { axisV2Id: choice.entry.id, axisRangeMax: choice.entry.rangeMax, axisCoefficient: choice.entry.coefficient };
          kept = triple.axisV2Id === curTriple.axisV2Id;
        } else {
          const ct = customTriple(choice.custom, curTriple, cat);
          if (!ct) continue;
          triple = ct.triple;
          kept = ct.idKept;
        }
        const tripleChanged = !sameTriple(triple, curTriple);
        const fitted = fitTravel(beforeEdit, triple.axisRangeMax);
        const keyClamped: Clamped[] = fitted.clamped.map((c) => ({ id, ...c }));
        const assignBefore = assignments.value[id] ?? null;
        const assignAfter = choice.kind === 'custom' ? choice.custom.uid : null;

        if (tripleChanged || keyClamped.length) {
          const keyIdKept = tripleChanged && kept;
          const keyIdNew = tripleChanged && !kept;
          entries.push({
            id,
            action: 'write',
            before: { triple: curTriple, edit: beforeEdit },
            after: { triple, edit: fitted.edit },
            tripleChanged,
            idKept: keyIdKept,
            idNew: keyIdNew,
            clamped: keyClamped,
            assignBefore,
            assignAfter,
          });
          keys.push(id);
          clamped.push(...keyClamped);
          if (keyIdNew) {
            idNew++;
            if (fallback === null) fallback = triple.axisV2Id;
          }
          if (keyIdKept) idKept++;
          if (tripleChanged && triple.axisRangeMax < curTriple.axisRangeMax) deeper = true;
        } else if (choice.kind === 'custom') {
          const ks = keySwitch(id);
          const alreadyNamed = ks?.kind === 'custom' && ks.custom.uid === choice.custom.uid;
          if (!alreadyNamed && canAssign) {
            entries.push({
              id,
              action: 'rename',
              before: { triple: curTriple, edit: beforeEdit },
              after: { triple: curTriple, edit: beforeEdit },
              tripleChanged: false,
              idKept: false,
              idNew: false,
              clamped: [],
              assignBefore,
              assignAfter,
            });
            renameKeys.push(id);
          }
        } else if (assignBefore !== null && canAssign) {
          // Key already has this catalog entry's exact triple, but carries a custom assignment: clear the assignment (0 HID).
          entries.push({
            id,
            action: 'rename',
            before: { triple: curTriple, edit: beforeEdit },
            after: { triple: curTriple, edit: beforeEdit },
            tripleChanged: false,
            idKept: false,
            idNew: false,
            clamped: [],
            assignBefore,
            assignAfter: null,
          });
          renameKeys.push(id);
        }
      }
    }

    return {
      entries,
      keys,
      renameKeys,
      write: keys.length,
      idNew,
      idKept,
      rename: renameKeys.length,
      deeper,
      clamped,
      limitMm,
      fallbackId: fallback,
    };
  }

  /** Apply undo or redo of a switch history entry (§12: restores triple, 8 edit fields and assignment; never writes back a lost triple; never touches recal list; clears perf.verify). */
  function replaySwitchEntries(entries: readonly SwitchKeyPlan[], dir: 'undo' | 'redo'): void {
    clearVerify();
    if (loadedProfile.value !== device.activeProfile) return;
    const edits: Record<number, PerfEdit> = {};
    const triples: Record<number, SwitchTriple> = {};
    const meta: Record<number, Omit<PendingSwitch, 'seq' | 'writeTriple'>> = {};
    const directAssign: Record<number, string | null> = {};

    for (const item of entries) {
      const targetState = dir === 'undo' ? item.before : item.after;
      const targetAssign = dir === 'undo' ? item.assignBefore : item.assignAfter;
      if (item.action === 'rename') {
        directAssign[item.id] = targetAssign;
        continue;
      }
      const cur = values.value[item.id];
      if (!cur) continue;
      if (dir === 'undo' && !isWritableTriple(targetState.triple)) {
        // Lost before-triple: never write back; keep the current triple and restore the 8 edit fields (fitted to current R) and assignment.
        const keptRange = cur.axisRangeMax >= FW_AXIS.rangeMin ? cur.axisRangeMax : item.after.triple.axisRangeMax;
        const safeEdit = fitTravel(targetState.edit, keptRange).edit;
        const normalized: PerfEdit = { ...safeEdit, normalRelease: safeEdit.normalPress };
        if (!sameEdit(normalized, pickEdit(cur))) {
          edits[item.id] = normalized;
          meta[item.id] = { assign: targetAssign, recal: false };
        } else {
          directAssign[item.id] = targetAssign;
        }
      } else {
        edits[item.id] = targetState.edit;
        triples[item.id] = targetState.triple;
        meta[item.id] = { assign: targetAssign, recal: false };
      }
    }

    if (Object.keys(directAssign).length) updateBoardAssignments(directAssign);
    if (Object.keys(edits).length) commit(edits, triples, meta);
  }

  /**
   * Apply a listed or custom switch choice to `ids` (§7.5, §7.6, §7.8, §7.9, §12).
   * - When `idKept > 0` and `answer` is omitted, returns `{ status: 'question', plan }` and writes nothing (0 HID).
   * - `answer === 'back'` returns `{ status: 'cancelled' }` and writes nothing (0 HID).
   * - Rename-only writes 0 HID, swaps assignments, and pushes one history entry.
   * - Write enqueues sync jobs; verify checks all three triple fields before updating assignments, recal list ('replaced' only), and `perf.verify` (custom Apply only).
   */
  function applySwitch(choice: SwitchChoice, ids: number[], answer?: SwapAnswer): ApplySwitchResult {
    const plan = planSwitch(choice, ids);
    if (!plan.write && !plan.rename) return { status: 'noop' };
    if (answer === 'back') return { status: 'cancelled' };
    if (plan.idKept > 0 && answer === undefined) return { status: 'question', plan };

    const name = choice.kind === 'catalog' ? switchName(choice.entry) : customSwitchName(choice.custom);

    // Rename only: 0 HID, one history entry swapping assignments, does not set perf.verify (listed Apply clears it).
    if (!plan.write) {
      if (choice.kind === 'catalog') clearVerify();
      const afterAssign: Record<number, string | null> = {};
      for (const e of plan.entries) afterAssign[e.id] = e.assignAfter;
      updateBoardAssignments(afterAssign);
      const snapshot = plan.entries;
      history.push({
        label: tr('perf.switchLabel', { name, n: plan.rename }),
        undo: () => {
          const map: Record<number, string | null> = {};
          for (const e of snapshot) map[e.id] = e.assignBefore;
          updateBoardAssignments(map);
        },
        redo: () => {
          const map: Record<number, string | null> = {};
          for (const e of snapshot) map[e.id] = e.assignAfter;
          updateBoardAssignments(map);
        },
      });
      return { status: 'renamed', renamed: plan.rename, name };
    }

    switchNotices.value = [];
    // Next switch Apply replaces/clears any previous watch; only a verified custom Apply creates a new one (§7.9).
    clearVerify();
    const markRecal = answer === 'replaced';
    const verifyOp: VerifyBatch | undefined = choice.kind === 'custom'
      ? {
          id: ++activeVerifyOpId,
          board: boardKey.value ?? '',
          name,
          rangeUm: effectiveCustomPair(choice.custom, catalog.value).rangeUm,
          keys: new Set<number>(),
        }
      : undefined;

    const edits: Record<number, PerfEdit> = {};
    const triples: Record<number, SwitchTriple> = {};
    const meta: Record<number, Omit<PendingSwitch, 'seq' | 'writeTriple'>> = {};
    const directAssign: Record<number, string | null> = {};

    for (const e of plan.entries) {
      if (e.action === 'rename') {
        directAssign[e.id] = e.assignAfter;
      } else if (e.action === 'write') {
        edits[e.id] = e.after.edit;
        triples[e.id] = e.after.triple;
        meta[e.id] = { assign: e.assignAfter, recal: markRecal, verifyOp };
      }
    }

    if (Object.keys(directAssign).length) updateBoardAssignments(directAssign);
    commit(edits, triples, meta);

    const snapshot = plan.entries;
    history.push({
      label: tr('perf.switchLabel', { name, n: plan.write + plan.rename }),
      undo: () => replaySwitchEntries(snapshot, 'undo'),
      redo: () => replaySwitchEntries(snapshot, 'redo'),
    });

    return { status: 'applied', written: plan.write, renamed: plan.rename, marked: markRecal, idNew: plan.idNew, name };
  }

  /**
   * Restore backed-up per-key switch triples and fitted distances (OFU v1.10 addendum §4.3).
   * Writes through the same sync job, checkPerformanceWrite guard and 3-field read-back as applySwitch,
   * with NO history entry, NO assignment change, NO recal entry and NO perf.verify watch.
   * Never bypasses or widens checkPerformanceWrite: any refused key is never sent.
   */
  async function restoreAxis(records: Record<number, Performance>): Promise<RestoreAxisResult> {
    const ids = Object.keys(records).map(Number).filter((id) => Number.isInteger(id)).sort((a, b) => a - b);
    if (!ids.length) return { restored: [], failed: [], refused: [] };
    if (!device.connected || loadedProfile.value !== device.activeProfile) {
      return { restored: [], failed: ids, refused: [] };
    }

    const boardIdHex = device.support === 'generic' ? undefined : device.info?.boardIdHex?.toLowerCase();
    const intervalRt = supportsIntervalRt(device.version);
    const edits: Record<number, PerfEdit> = {};
    const triples: Record<number, SwitchTriple> = {};
    const meta: Record<number, Omit<PendingSwitch, 'seq' | 'writeTriple'>> = {};
    const outcomes = new Map<number, 'restored' | 'failed'>();
    const refused: { id: number; reason: string }[] = [];

    for (const id of ids) {
      const rec = records[id];
      const cur = values.value[id];
      const base = fresh.get(id) ?? cur;
      if (!rec || !cur || !base) {
        outcomes.set(id, 'failed');
        continue;
      }
      const edit = pickEdit(rec);
      edit.normalRelease = edit.normalPress;
      const triple = tripleOf(rec);
      const candidate: Performance = { ...base, ...edit, ...triple };
      const why = checkPerformanceWrite(candidate, seenFor(id), { intervalRt, boardIdHex });
      if (why !== null) {
        refused.push({ id, reason: why });
        continue;
      }
      edits[id] = edit;
      triples[id] = triple;
      meta[id] = {
        recal: false,
        onRestore: (ok) => { outcomes.set(id, ok ? 'restored' : 'failed'); },
        onRefuse: (reason) => { refused.push({ id, reason }); },
      };
    }

    if (Object.keys(edits).length) {
      commit(edits, triples, meta);
      await sync.flush().catch(() => undefined);
    }

    const refusedIds = new Set(refused.map((r) => r.id));
    const restored: number[] = [];
    const failed: number[] = [];
    for (const id of ids) {
      if (refusedIds.has(id)) continue;
      if (outcomes.get(id) === 'restored') restored.push(id);
      else failed.push(id);
    }
    return { restored, failed, refused };
  }

  return {
    values, loading, loadedCount, loadError, loadedProfile, loadedSerial, readSeq, uncalibrated, recalKeys, needsCal, profileSnapshots,
    load, apply, catalog, switchOf, switchIdentity, keySwitch, planSwitch, applySwitch, switchNotices, keptNotices, clearKeptNotices, noteRead, seenFor, restoreAxis,
    customSwitches, genericDecl, genericEntry, assignments, verify, staleKeys, lostKeys, deepKeys,
    saveCustomSwitch, addCustomSwitches, deleteCustomSwitch, setGenericRange, forgetKeys,
    clearRecal, clearVerify, markVerifyPassed, fixDeepTravel, reloadCustomSwitches,
  };
});
