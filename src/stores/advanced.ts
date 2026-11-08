// Advanced keys (family 06) for the active profile: DKS, MPT, SOCD and Rappy Snappy editors write;
// MT / TGL / END are decoded and shown read-only. Behaviour follows reference AE64_PROTOCOL.md
// ("Advanced keys and macros") and dks.js / mpt.js / rappy.js / profiles.js.
//
// Write path (one change = remove the edited assignment and/or add its new version):
//   history.push → sync.enqueue(one job per change) → sync.flush()
//   job.write  : read every involved key's record and refuse keys owned by another assignment,
//                snapshot each key's Performance, clear keys leaving the assignment, write the new record(s)
//   sync       : commit(SAVE_GROUP.ADVANCED)
//   job.verify : read every involved record back and compare every field, then restore the Hall tuning the
//                firmware resets (setPerformance with the pre-write values, read back) + commit(PERFORMANCE).
// A change is several dependent packets, so it is one sync job: the sync store already runs each batch inside
// one withTransport({ exclusive: true }) call, which keeps pollers out while the job runs.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { KEYCODE_GROUPS, SAVE_GROUP, SOCD_PAIR_MODES } from '../protocol';
import type { AdvancedRecord, Ae64Transport, KeyPos, Performance, PhysicalKey } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { PermanentSyncError, useSyncStore } from './sync';
import { DEFAULT_RANGE_MM, pickEdit, usePerformanceStore } from './performance';

type N4 = [number, number, number, number];
type N3 = [number, number, number];
type N2 = [number, number];
export type SocdMode = 0 | 1 | 2 | 3;

export interface DksAssignment { type: 'DKS'; keys: [number]; keycodes: N4; travels: N4; dbs: N2 }
export interface MptAssignment { type: 'MPT'; keys: [number]; keycodes: N3; depths: N3 }
export interface SocdAssignment { type: 'SOCD'; keys: N2; keycodes: N2; delay: number; mode: SocdMode }
export interface RsAssignment { type: 'RS'; keys: N2; keycodes: N2; delay: number }
/** MT / TGL / END / unknown modes and pair records whose partner is missing: shown, deletable, not editable. */
export interface ReadOnlyAssignment { type: 'READONLY'; keys: number[]; record: AdvancedRecord }
export type WritableAssignment = DksAssignment | MptAssignment | SocdAssignment | RsAssignment;
export type Assignment = WritableAssignment | ReadOnlyAssignment;
export type WritableType = WritableAssignment['type'];

// ----------------------------------------------------------------- limits and palettes (reference values)

/** DKS thresholds: fixed 0.1–3.3 mm, 0.1 mm steps (dks.js dksTravelLimit). */
export const DKS_TRAVEL = { min: 0.1, max: 3.3, step: 0.1 };
export const DKS_DEFAULT_DBS: N2 = [1.5, 3.0];
/** P1–S–P2–S–R2–S–R1 cells → lifecycle mask bits; the centre cell owns both turnaround bits (0x18). */
export const DKS_CELLS = [0x01, 0x02, 0x04, 0x18, 0x20, 0x40, 0x80] as const;
export const DKS_FULL_HOLD = 0xff;
/** SOCD / RS delay 0–50 ms (profiles.js). */
export const PAIR_DELAY = { min: 0, max: 50 };
export const MPT_STEP = 0.1;

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
export const MPT_BASIC_CODES: readonly number[] = [...range(4, 39), ...range(44, 56)];
export const MPT_EXTENDED_CODES: readonly number[] = [
  41, ...range(58, 69), ...range(104, 115), ...range(70, 78), 83, ...range(88, 98), ...range(84, 87), ...range(224, 230),
];
const DKS_MOUSE_CODES: readonly number[] = [0x4000, 0x4100, 0x4200, 0x4300, 0x4400, 0x4500, 0x4600, 0x4700, 0x4800, 0x4900, 0x4a01, 0x4b01];
const DKS_HOST_CODES = new Set([...range(4, 115), ...range(224, 231)]);
/** "Keyboard" usages (the reference KEYCODE_GROUPS.keyboard): MPT hosts, SOCD/RS outputs and macro actions. */
const KEYBOARD_GROUP_IDS = ['basic', 'modifier', 'fkeys', 'navigation', 'numpad'];
export const KEYBOARD_CODES: ReadonlySet<number> = new Set(
  KEYCODE_GROUPS.filter((g) => KEYBOARD_GROUP_IDS.includes(g.id)).flatMap((g) => g.codes.map((c) => c.code)).filter((c) => c > 1),
);

export interface OutputGroup { id: string; label: string; codes: readonly number[] }

/** Firmware ≥ 1.1.3.0 adds modifiers to the DKS Extended palette and a Mouse group (unknown/unparsable → yes). */
export function firmwareAtLeast(firmware: string | undefined, target: string): boolean {
  const cur = String(firmware ?? '').trim().split('.').map(Number);
  if (!firmware || cur.some((p) => !Number.isFinite(p))) return true;
  const req = target.split('.').map(Number);
  for (let i = 0; i < Math.max(cur.length, req.length); i++) {
    const d = (cur[i] || 0) - (req[i] || 0);
    if (d) return d > 0;
  }
  return true;
}

export function mptGroups(): OutputGroup[] {
  return [
    { id: 'basic', label: tr('advanced.groupBasic'), codes: MPT_BASIC_CODES },
    { id: 'extended', label: tr('advanced.groupExtended'), codes: MPT_EXTENDED_CODES },
  ];
}

export function dksGroups(firmware: string | undefined): OutputGroup[] {
  const expanded = firmwareAtLeast(firmware, '1.1.3.0');
  const groups: OutputGroup[] = [
    { id: 'basic', label: tr('advanced.groupBasic'), codes: MPT_BASIC_CODES },
    { id: 'extended', label: tr('advanced.groupExtended'), codes: expanded ? MPT_EXTENDED_CODES : MPT_EXTENDED_CODES.filter((c) => c < 224) },
  ];
  if (expanded) groups.push({ id: 'mouse', label: tr('advanced.groupMouse'), codes: DKS_MOUSE_CODES });
  return groups;
}

export function keyboardGroups(): OutputGroup[] {
  return KEYCODE_GROUPS.filter((g) => KEYBOARD_GROUP_IDS.includes(g.id))
    .map((g) => ({ id: g.id, label: g.label, codes: g.codes.map((c) => c.code).filter((c) => c > 1) }));
}

export function dksHostEligible(layer0Code: number | undefined): boolean {
  return DKS_HOST_CODES.has(Number(layer0Code));
}
export function mptHostEligible(layer0Code: number | undefined): boolean {
  return KEYBOARD_CODES.has(Number(layer0Code));
}

// ----------------------------------------------------------------- DKS / MPT helpers

export function dksCellActive(mask: number, cell: number): boolean {
  const m = DKS_CELLS[cell];
  return (mask & m) === m;
}
/** Keep only whole cells (a lone 0x08 or 0x10 turnaround bit is dropped, as the reference does). */
export function normalizeDksMask(mask: number): number {
  return DKS_CELLS.reduce((acc, m, i) => (dksCellActive(mask, i) ? acc | m : acc), 0);
}
export function setDksCell(mask: number, cell: number, on: boolean): number {
  const m = DKS_CELLS[cell];
  return normalizeDksMask(on ? mask | m : mask & ~m);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

export function normalizeDksDbs(dbs: readonly number[]): N2 {
  const s = r1(Math.min(DKS_TRAVEL.max - DKS_TRAVEL.step, Math.max(DKS_TRAVEL.min, Number(dbs[0]) || DKS_DEFAULT_DBS[0])));
  const d = r1(Math.min(DKS_TRAVEL.max, Math.max(s + DKS_TRAVEL.step, Number(dbs[1]) || DKS_DEFAULT_DBS[1])));
  return [s, d];
}

/** MPT maximum depth: the key's axisRangeMax rounded down to 0.1 mm (at least 0.3 mm). */
export function mptLimit(p: Performance | undefined): number {
  const mm = p && p.axisRangeMax > 0 ? p.axisRangeMax / 1000 : DEFAULT_RANGE_MM;
  return Math.max(0.3, Math.floor((mm + 1e-7) * 10) / 10);
}

/** Strictly increasing depths in 0.1 mm steps inside [0.1, max] (mpt.js normalizeMultipointDepths). */
export function normalizeMptDepths(depths: readonly number[], max: number): N3 {
  const maxStep = Math.max(3, Math.floor(max * 10 + 1e-7));
  const src = [0.5, 1, 1.5].map((fb, i) => Math.round((Number(depths[i]) || fb) * 10));
  const third = Math.max(3, Math.min(maxStep, src[2]));
  const second = Math.max(2, Math.min(third - 1, src[1]));
  const first = Math.max(1, Math.min(second - 1, src[0]));
  return [first / 10, second / 10, third / 10];
}

/** Bounds of MPT depth `i` given its neighbours. */
export function mptBounds(i: number, depths: N3, max: number): { min: number; max: number } {
  if (i === 0) return { min: 0.1, max: r1(depths[1] - MPT_STEP) };
  if (i === 1) return { min: r1(depths[0] + MPT_STEP), max: r1(depths[2] - MPT_STEP) };
  return { min: r1(depths[1] + MPT_STEP), max };
}

// ----------------------------------------------------------------- validation (reference stage* rules)

export function validateAssignment(a: WritableAssignment, ctx: { firmware?: string; layer0: (id: number) => number | undefined; mptMax?: number }): string | null {
  switch (a.type) {
    case 'DKS': {
      if (!dksHostEligible(ctx.layer0(a.keys[0]))) return tr('advanced.errDksHost');
      const used = a.keycodes.filter((c) => c);
      if (!used.length) return tr('advanced.errDksEmpty');
      const allowed = new Set(dksGroups(ctx.firmware).flatMap((g) => g.codes));
      if (used.some((c) => !allowed.has(c))) return tr('advanced.errOutput');
      if (!(a.dbs[0] >= DKS_TRAVEL.min && a.dbs[0] < a.dbs[1] && a.dbs[1] <= DKS_TRAVEL.max + 1e-9)) return tr('advanced.errDksDbs');
      return null;
    }
    case 'MPT': {
      if (!mptHostEligible(ctx.layer0(a.keys[0]))) return tr('advanced.errMptHost');
      const [k1, k2] = a.keycodes;
      if (!k1 || !k2) return tr('advanced.errMptStages');
      const used = a.keycodes.filter((c) => c);
      if (new Set(used).size !== used.length) return tr('advanced.errMptDistinct');
      const allowed = new Set(mptGroups().flatMap((g) => g.codes));
      if (used.some((c) => !allowed.has(c))) return tr('advanced.errOutput');
      const [d1, d2, d3] = a.depths;
      if (!(d1 >= 0.1 && d1 < d2 && d2 < d3 && d3 <= (ctx.mptMax ?? Infinity) + 1e-9)) return tr('advanced.errMptDepths');
      return null;
    }
    case 'SOCD':
    case 'RS':
      if (a.keys[0] === a.keys[1]) return tr('advanced.errPairSame');
      if (!a.keycodes[0] || !a.keycodes[1]) return tr('advanced.errPairOutput');
      if (!Number.isInteger(a.delay) || a.delay < PAIR_DELAY.min || a.delay > PAIR_DELAY.max) return tr('advanced.errDelay');
      return null;
  }
}

// ----------------------------------------------------------------- records ↔ assignments

function partnerOf(r: AdvancedRecord): KeyPos | null {
  return r.type === 'SOCD' || r.type === 'RS' ? { row: r.pairedRow, col: r.pairedCol } : null;
}

/** The record(s) the firmware should hold for an assignment, by key id. */
export function recordsOf(a: WritableAssignment, keys: readonly PhysicalKey[]): Map<number, AdvancedRecord> {
  const out = new Map<number, AdvancedRecord>();
  const k0 = keys[a.keys[0]];
  switch (a.type) {
    case 'DKS':
      out.set(k0.id, { mode: 1, row: k0.row, col: k0.col, type: 'DKS', keycodes: [...a.keycodes], travels: a.travels.map(normalizeDksMask) as N4, deadzones: [...a.dbs] });
      break;
    case 'MPT':
      out.set(k0.id, { mode: 2, row: k0.row, col: k0.col, type: 'MPT', keycodes: [...a.keycodes], depths: [...a.depths] });
      break;
    case 'SOCD': {
      const k1 = keys[a.keys[1]];
      const [ma, mb] = SOCD_PAIR_MODES[a.mode];
      out.set(k0.id, { mode: 6, row: k0.row, col: k0.col, type: 'SOCD', pairedRow: k1.row, pairedCol: k1.col, keycodes: [a.keycodes[0], a.keycodes[1]], delay: a.delay, socdMode: ma });
      out.set(k1.id, { mode: 6, row: k1.row, col: k1.col, type: 'SOCD', pairedRow: k0.row, pairedCol: k0.col, keycodes: [a.keycodes[1], a.keycodes[0]], delay: a.delay, socdMode: mb });
      break;
    }
    case 'RS': {
      const k1 = keys[a.keys[1]];
      out.set(k0.id, { mode: 7, row: k0.row, col: k0.col, type: 'RS', pairedRow: k1.row, pairedCol: k1.col, keycodes: [a.keycodes[0], a.keycodes[1]], delay: a.delay });
      out.set(k1.id, { mode: 7, row: k1.row, col: k1.col, type: 'RS', pairedRow: k0.row, pairedCol: k0.col, keycodes: [a.keycodes[1], a.keycodes[0]], delay: a.delay });
      break;
    }
  }
  return out;
}

function noneRecord(k: PhysicalKey): AdvancedRecord {
  return { mode: 0, row: k.row, col: k.col, type: 'NONE' };
}

/** Deep compare with a 0.5 µm tolerance for millimetre fields. */
export function sameRecord(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.0005;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameRecord(v, b[i]));
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => sameRecord((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return a === b;
}

/** Group per-key records into assignments; SOCD / RS pairs are listed once (from the lower key id). */
export function assignmentsFrom(records: Record<number, AdvancedRecord>, keys: readonly PhysicalKey[]): Assignment[] {
  const at = (p: KeyPos) => keys.find((k) => k.row === p.row && k.col === p.col);
  const out: Assignment[] = [];
  const seen = new Set<number>();
  for (const key of keys) {
    const r = records[key.id];
    if (!r || r.type === 'NONE' || seen.has(key.id)) continue;
    seen.add(key.id);
    if (r.type === 'DKS') out.push({ type: 'DKS', keys: [key.id], keycodes: [...r.keycodes], travels: r.travels.map(normalizeDksMask) as N4, dbs: [...r.deadzones] });
    else if (r.type === 'MPT') out.push({ type: 'MPT', keys: [key.id], keycodes: [...r.keycodes], depths: [...r.depths] });
    else if (r.type === 'SOCD' || r.type === 'RS') {
      const partner = at(partnerOf(r)!);
      const pr = partner ? records[partner.id] : undefined;
      if (!partner || partner.id === key.id || seen.has(partner.id) || pr?.type !== r.type) {
        out.push({ type: 'READONLY', keys: [key.id], record: r });
        continue;
      }
      seen.add(partner.id);
      if (r.type === 'SOCD') {
        const other = pr.type === 'SOCD' ? pr.socdMode : r.socdMode;
        const idx = SOCD_PAIR_MODES.findIndex(([ma, mb]) => ma === r.socdMode && mb === other);
        const mode = (idx >= 0 ? idx : Math.min(3, Math.max(0, r.socdMode))) as SocdMode;
        out.push({ type: 'SOCD', keys: [key.id, partner.id], keycodes: [...r.keycodes], delay: r.delay, mode });
      } else out.push({ type: 'RS', keys: [key.id, partner.id], keycodes: [...r.keycodes], delay: r.delay });
    } else out.push({ type: 'READONLY', keys: [key.id], record: r });
  }
  return out;
}

/** Same type on the same set of keys (an edit of this assignment rather than a different one). */
export function sameSlot(a: Assignment, b: Assignment): boolean {
  const ka = [...a.keys].sort((x, y) => x - y).join(',');
  const kb = [...b.keys].sort((x, y) => x - y).join(',');
  return a.type === b.type && ka === kb;
}

export class AdvancedConflictError extends Error {
  constructor(readonly conflict: Assignment, keyName: string) {
    super(tr('advanced.conflict', { key: keyName }));
    this.name = 'AdvancedConflictError';
  }
}

function sameTuning(a: Performance, b: Performance): boolean {
  const ea = pickEdit(a);
  const eb = pickEdit(b);
  return (Object.keys(ea) as (keyof typeof ea)[]).every((f) => Math.abs(ea[f] - eb[f]) < 0.0005);
}

// ----------------------------------------------------------------- store

interface Change { before: Assignment | null; after: WritableAssignment | null }

export const useAdvancedStore = defineStore('advanced', () => {
  const device = useDeviceStore();
  const history = useHistoryStore();
  const sync = useSyncStore();

  /** Current (optimistic) record per PhysicalKey.id. */
  const records = shallowRef<Record<number, AdvancedRecord>>({});
  const loading = ref(false);
  const loadedCount = ref(0);
  const loadError = ref<string | null>(null);
  const loadedProfile = ref<number | null>(null);
  let loadPromise: Promise<void> | null = null;
  /** Performance per key read for MPT limits (cleared with the profile). */
  const perfCache = new Map<number, Performance>();
  // Another keyboard (or the demo) was connected: nothing cached belongs to it.
  watch(() => device.connection, () => {
    records.value = {};
    perfCache.clear();
    loadedProfile.value = null;
  });

  const assignments = computed(() => assignmentsFrom(records.value, device.keys));
  const byKey = computed(() => {
    const m = new Map<number, Assignment>();
    for (const a of assignments.value) for (const id of a.keys) m.set(id, a);
    return m;
  });

  function load(force = false): Promise<void> {
    if (loadPromise) return force ? loadPromise.then(() => load(true)) : loadPromise;
    if (!force && loadedProfile.value === device.activeProfile && Object.keys(records.value).length) return Promise.resolve();
    loadPromise = (async () => {
      loading.value = true;
      loadError.value = null;
      loadedCount.value = 0;
      records.value = {};
      perfCache.clear();
      const profile = device.activeProfile;
      try {
        const next: Record<number, AdvancedRecord> = {};
        await device.withTransport(async (t) => {
          for (const key of device.keys) {
            next[key.id] = await t.getAdvanced(key);
            loadedCount.value++;
          }
        });
        records.value = next;
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

  /** Performance of a key (performance page cache, else one read) — for the MPT depth limit. */
  async function performanceOf(id: number): Promise<Performance> {
    const cached = usePerformanceStore().values[id] ?? perfCache.get(id);
    if (cached) return cached;
    const p = await device.withTransport((t) => t.getPerformance(device.keys[id]));
    perfCache.set(id, p);
    return p;
  }

  /** Another assignment occupying one of `a`'s keys (ignoring `editing`, the assignment being edited). */
  function conflictFor(a: WritableAssignment, editing: Assignment | null): Assignment | null {
    for (const id of a.keys) {
      const cur = byKey.value.get(id);
      if (!cur) continue;
      if (editing && sameSlot(cur, editing)) continue;
      if (sameSlot(cur, a)) continue;
      return cur;
    }
    return null;
  }

  function jobFor(change: Change, profile: number) {
    const keys = device.keys;
    const involved = [...new Set([...(change.before?.keys ?? []), ...(change.after?.keys ?? [])])].sort((x, y) => x - y);
    const expected = change.after ? recordsOf(change.after, keys) : new Map<number, AdvancedRecord>();
    const allowedOn = (id: number, r: AdvancedRecord): boolean => {
      if (r.type === 'NONE') return true;
      return [change.before, change.after].some((a) => {
        if (!a || !a.keys.includes(id)) return false;
        if (a.type === 'READONLY') return sameRecord(r, a.record);
        if (r.type !== a.type) return false;
        const p = partnerOf(r);
        if (!p) return true;
        const otherId = a.keys.find((k) => k !== id);
        const other = otherId === undefined ? undefined : keys[otherId];
        return other !== undefined && p.row === other.row && p.col === other.col;
      });
    };
    // Captured once: a retried job must restore the tuning from before the first write, not the reset one.
    let tuning: Map<number, Performance> | null = null;
    const names = involved.map((id) => device.legend(keys[id])).join(' + ');
    return {
      key: `adv:${profile}:${involved.join(',')}`,
      group: SAVE_GROUP.ADVANCED,
      profile,
      label: tr('advanced.jobLabel', { keys: names }),
      write: async (t: Ae64Transport) => {
        for (const id of involved) {
          const cur = await t.getAdvanced(keys[id]);
          if (!allowedOn(id, cur)) throw new PermanentSyncError(tr('advanced.conflictDevice', { key: device.legend(keys[id]) }));
        }
        if (!tuning) {
          const snap = new Map<number, Performance>();
          for (const id of involved) snap.set(id, await t.getPerformance(keys[id]));
          tuning = snap;
        }
        for (const id of involved) if (!expected.has(id)) await t.clearAdvanced(keys[id]);
        const a = change.after;
        if (!a) return;
        const pos = (i: number) => keys[a.keys[i]];
        if (a.type === 'DKS') await t.setDks({ pos: pos(0), keycodes: [...a.keycodes], travels: a.travels.map(normalizeDksMask), dbs: [...a.dbs] });
        else if (a.type === 'MPT') await t.setMpt({ pos: pos(0), keycodes: [...a.keycodes], depths: [...a.depths] });
        else if (a.type === 'SOCD') await t.setSocdPair({ first: pos(0), second: pos(1), keycodes: [...a.keycodes], delay: a.delay, mode: a.mode });
        else await t.setRappySnappyPair({ first: pos(0), second: pos(1), keycodes: [...a.keycodes], delay: a.delay });
      },
      verify: async (t: Ae64Transport) => {
        let ok = true;
        const readBack: Record<number, AdvancedRecord> = {};
        for (const id of involved) {
          const r = await t.getAdvanced(keys[id]);
          readBack[id] = r;
          if (!sameRecord(r, expected.get(id) ?? noneRecord(keys[id]))) ok = false;
        }
        if (profile === device.activeProfile && loadedProfile.value === profile) records.value = { ...records.value, ...readBack };
        if (!ok) return false;
        // Restore the Hall tuning the firmware resets on assignment changes (reference applyMultipointDraft …).
        for (const id of involved) {
          const before = tuning!.get(id)!;
          const current = await t.getPerformance(keys[id]);
          const desired: Performance = { ...current, ...before, axis: current.axis, calibrate: current.calibrate };
          await t.setPerformance(keys[id], desired);
          const restored = await t.getPerformance(keys[id]);
          if (!sameTuning(restored, desired)) throw new Error(tr('advanced.tuningFailed', { key: device.legend(keys[id]) }));
        }
        await t.commit(SAVE_GROUP.PERFORMANCE);
        return true;
      },
    };
  }

  function commit(change: Change): void {
    const profile = device.activeProfile;
    if (profile !== loadedProfile.value) return; // stale history entry from another profile
    const next = { ...records.value };
    for (const id of change.before?.keys ?? []) next[id] = noneRecord(device.keys[id]);
    if (change.after) for (const [id, r] of recordsOf(change.after, device.keys)) next[id] = r;
    records.value = next;
    sync.enqueue(jobFor(change, profile));
  }

  function typeName(a: Assignment): string {
    return a.type === 'READONLY' ? a.record.type : tr(`advanced.type${a.type}`);
  }

  /**
   * Write `next` (replacing `editing`, if any). Refuses keys owned by another assignment with
   * AdvancedConflictError. Resolves once written, committed, verified and the Hall tuning restored.
   */
  async function save(next: WritableAssignment, editing: Assignment | null = null): Promise<void> {
    if (loadedProfile.value !== device.activeProfile) throw new Error(tr('advanced.notLoaded'));
    const mptMax = next.type === 'MPT' ? mptLimit(await performanceOf(next.keys[0])) : undefined;
    const invalid = validateAssignment(next, { firmware: device.info?.firmware, layer0: (id) => device.layer0[id], mptMax });
    if (invalid) throw new Error(invalid);
    const conflict = conflictFor(next, editing);
    if (conflict) {
      const id = next.keys.find((k) => conflict.keys.includes(k))!;
      throw new AdvancedConflictError(conflict, device.legend(device.keys[id]));
    }
    const before = editing ?? next.keys.map((id) => byKey.value.get(id)).find((a) => a && sameSlot(a, next)) ?? null;
    if (before && before.type !== 'READONLY' && sameRecord(before, next)) return;
    const change: Change = { before, after: next };
    commit(change);
    const keysLabel = next.keys.map((id) => device.legend(device.keys[id])).join(' + ');
    history.push({
      label: tr('advanced.histSave', { type: typeName(next), keys: keysLabel }),
      undo: () => commit({ before: next, after: before && before.type !== 'READONLY' ? before : null }),
      redo: () => commit(change),
    });
    await sync.flush();
  }

  /** Clear an assignment (both keys of a pair). Read-only kinds cannot be re-created, so they get no undo. */
  async function remove(a: Assignment): Promise<void> {
    if (loadedProfile.value !== device.activeProfile) throw new Error(tr('advanced.notLoaded'));
    commit({ before: a, after: null });
    if (a.type !== 'READONLY') {
      const keysLabel = a.keys.map((id) => device.legend(device.keys[id])).join(' + ');
      history.push({
        label: tr('advanced.histRemove', { type: typeName(a), keys: keysLabel }),
        undo: () => commit({ before: null, after: a }),
        redo: () => commit({ before: a, after: null }),
      });
    }
    await sync.flush();
  }

  return { records, loading, loadedCount, loadError, loadedProfile, assignments, byKey, load, performanceOf, conflictFor, save, remove, typeName };
});
