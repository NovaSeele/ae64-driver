// CSW step 2: localStorage schemas, validators, LRU, unreadable serials, recal list and settings export/import/reset
// (DESIGN §9.1, §9.5, §10.1, §13, §19 Test 14; mutants M13, M16 backup half).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  ASSIGN_BOARD_MAX, CUSTOM_SWITCHES_KEY, CUSTOM_SWITCH_MAX, GENERIC_START, GENERIC_SWITCH_KEY, GENERIC_UID,
  SWITCH_ASSIGN_KEY, SWITCH_CAPS_KEY, SWITCH_COLORS, SWITCH_RECAL_KEY,
  addRecalKeys, applyAssignments, assignValid, clearRecalKeys, customValid, forgetAssignments, forgetBoard, forgetUid,
  genericValid, isSwitchCaps, newCustomUid, readAssignments, readCustomSwitches, readGenericDecl, readGenericRangeUm,
  readRecalKeys, recalBoardKey, recalValid, removeAssignments, setAssignments, switchCaps, writeCustomSwitches,
  writeGenericDecl, writeSwitchCaps,
} from '../src/data/customSwitch';
import type { CustomSwitch } from '../src/data/customSwitch';
import { buildExport, pageReload, parseImport, resetKeys, useAppSettings } from '../src/data/appSettings';
import { useDeviceStore } from '../src/stores/device';

const serialOf = (n: number) => `36081250433946353605${String(n).padStart(4, '0')}`;
const SERIAL_1 = serialOf(1);
const SERIAL_2 = serialOf(2);

const mkCustom = (i: number, over: Partial<CustomSwitch> = {}): CustomSwitch => ({
  uid: `u-${String(i).padStart(12, '0')}`,
  name: `Switch ${i}`,
  maker: 'Wuque Studio',
  travelUm: 3500,
  rangeUm: 3500,
  coefficient: 19850,
  curve: { kind: 'travel' },
  color: '#9b6cf0',
  note: '',
  ...over,
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('ae64.switch.custom validation and storage — CSW Test 14', () => {
  it('generates u- + 12 lowercase hex uids from crypto.getRandomValues', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const a = newCustomUid();
    const b = newCustomUid();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(a).toMatch(/^u-[0-9a-f]{12}$/);
    expect(b).toMatch(/^u-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });

  it('accepts valid lists up to 50 entries, all §9.4 colours, FW_AXIS read bounds, and reads missing note as ""', () => {
    const fifty = Array.from({ length: CUSTOM_SWITCH_MAX }, (_, i) => mkCustom(i, {
      color: SWITCH_COLORS[i % SWITCH_COLORS.length].hex,
      curve: i % 3 === 0 ? { kind: 'like', id: 13472, name: 'Skyline V3' } : i % 3 === 1 ? { kind: 'travel' } : { kind: 'manual' },
    }));
    const raw50 = JSON.stringify({ v: 1, list: fifty });
    expect(customValid(raw50)).toBe(true);
    localStorage.setItem(CUSTOM_SWITCHES_KEY, raw50);
    expect(readCustomSwitches()).toHaveLength(50);

    // FW_AXIS read bounds: rangeUm 1000..5000, coefficient 4096..65535, travelUm 1000..6000.
    const edges = [
      mkCustom(1, { travelUm: 1000, rangeUm: 1000, coefficient: 4096 }),
      mkCustom(2, { travelUm: 6000, rangeUm: 5000, coefficient: 65535 }),
    ];
    expect(customValid(JSON.stringify({ v: 1, list: edges }))).toBe(true);

    // A stored entry without `note` passes validation and reads as `note: ''`.
    const { note: _omitted, ...withoutNote } = mkCustom(7);
    const rawNoNote = JSON.stringify({ v: 1, list: [withoutNote] });
    expect(customValid(rawNoNote)).toBe(true);
    localStorage.setItem(CUSTOM_SWITCHES_KEY, rawNoNote);
    expect(readCustomSwitches()).toEqual([{ ...withoutNote, note: '' }]);

    // A saved { kind: 'travel' } entry keeps its stored coefficient verbatim (§19.3).
    const savedTravel = mkCustom(9, { travelUm: 3500, rangeUm: 3500, coefficient: 18123, curve: { kind: 'travel' } });
    writeCustomSwitches([savedTravel]);
    expect(readCustomSwitches()[0].coefficient).toBe(18123);
  });

  it('refuses wrong shapes, >50 entries and out-of-bounds values; reader ignores the whole stored value', () => {
    const valid = mkCustom(1);
    const bads: unknown[] = [
      null,
      [],
      { v: 2, list: [] },
      { v: 1, list: [], extra: 1 },
      { v: 1, list: 'nope' },
      { v: 1, list: Array.from({ length: CUSTOM_SWITCH_MAX + 1 }, (_, i) => mkCustom(i)) },
      { v: 1, list: [valid, { ...valid }] }, // duplicate uid
      { v: 1, list: [{ ...valid, extra: 1 }] },
      { v: 1, list: [{ ...valid, uid: 'r-wuque' }] },
      { v: 1, list: [{ ...valid, uid: 'u-' }] },
      { v: 1, list: [{ ...valid, name: '' }] },
      { v: 1, list: [{ ...valid, name: ' Space' }] },
      { v: 1, list: [{ ...valid, name: 'x'.repeat(41) }] },
      { v: 1, list: [{ ...valid, maker: 'x'.repeat(25) }] },
      { v: 1, list: [{ ...valid, note: 'x'.repeat(121) }] },
      { v: 1, list: [{ ...valid, note: 'bad\u202Etext' }] },
      { v: 1, list: [{ ...valid, note: 123 }] },
      { v: 1, list: [{ ...valid, travelUm: 999 }] },
      { v: 1, list: [{ ...valid, travelUm: 6001 }] },
      { v: 1, list: [{ ...valid, rangeUm: 999 }] },
      { v: 1, list: [{ ...valid, rangeUm: 5001 }] },
      { v: 1, list: [{ ...valid, rangeUm: 3500.5 }] },
      { v: 1, list: [{ ...valid, coefficient: 4095 }] },
      { v: 1, list: [{ ...valid, coefficient: 65536 }] },
      { v: 1, list: [{ ...valid, coefficient: 20000.5 }] },
      { v: 1, list: [{ ...valid, curve: { kind: 'measured' } }] },
      { v: 1, list: [{ ...valid, curve: { kind: 'like', id: 0, name: 'X' } }] },
      { v: 1, list: [{ ...valid, color: '#123456' }] },
      { v: 1, list: [{ ...valid, color: '#9B6CF0' }] },
    ];
    expect(customValid('{bad json')).toBe(false);
    for (const bad of bads) {
      const s = JSON.stringify(bad);
      expect(customValid(s), s.slice(0, 120)).toBe(false);
      localStorage.setItem(CUSTOM_SWITCHES_KEY, s);
      expect(readCustomSwitches(), s.slice(0, 120)).toEqual([]);
    }
    // One bad entry invalidates the whole stored value (never partially loaded).
    localStorage.setItem(CUSTOM_SWITCHES_KEY, JSON.stringify({ v: 1, list: [valid, { ...valid, uid: 'u-2', rangeUm: 999 }] }));
    expect(readCustomSwitches()).toEqual([]);
  });
});

describe('ae64.switch.generic validation and storage', () => {
  it('defaults to 3400 when absent or invalid, validates 1000–5000 integer bounds', () => {
    expect(readGenericDecl()).toBeNull();
    expect(readGenericRangeUm()).toBe(GENERIC_START);

    writeGenericDecl(3600);
    expect(genericValid(localStorage.getItem(GENERIC_SWITCH_KEY)!)).toBe(true);
    expect(readGenericDecl()).toEqual({ rangeUm: 3600 });
    expect(readGenericRangeUm()).toBe(3600);

    expect(genericValid(JSON.stringify({ v: 1, rangeUm: 1000 }))).toBe(true);
    expect(genericValid(JSON.stringify({ v: 1, rangeUm: 5000 }))).toBe(true);
    for (const bad of ['{', '{"v":2,"rangeUm":3400}', '{"v":1,"rangeUm":999}', '{"v":1,"rangeUm":5001}', '{"v":1,"rangeUm":3400.5}', '{"v":1,"rangeUm":3400,"c":20550}']) {
      expect(genericValid(bad), bad).toBe(false);
      localStorage.setItem(GENERIC_SWITCH_KEY, bad);
      expect(readGenericDecl(), bad).toBeNull();
      expect(readGenericRangeUm(), bad).toBe(3400);
    }
  });
});

describe('ae64.switch.assign — unreadable serial, LRU, unknown-uid drop (kills M13)', () => {
  it('stores nothing for unreadable serials and rejects them in assignValid (kills M13)', () => {
    const unreadable = [null, undefined, '', '000000000000000000000000', 'ffffffffffffffffffffffff', '1234', 'board:0030000d', 'profile:0'];
    for (const s of unreadable) {
      setAssignments(s, [0, 1], 'r-wuque-ws-flux-clacky');
      expect(localStorage.getItem(SWITCH_ASSIGN_KEY), String(s)).toBeNull();
      expect(readAssignments(s), String(s)).toEqual({});
    }
    for (const s of ['000000000000000000000000', 'ffffffffffffffffffffffff', 'board:0030000d', 'profile:0']) {
      const raw = JSON.stringify({ v: 1, boards: { [s]: { at: 1, keys: { 0: 'r-wuque-ws-flux-clacky' } } } });
      expect(assignValid(raw), s).toBe(false);
      localStorage.setItem(SWITCH_ASSIGN_KEY, raw);
      expect(readAssignments(s), s).toEqual({});
    }
    // Profile-keyed shape is rejected (M13); stored assignments key only by serialHex → { at, keys }.
    const byProfile = JSON.stringify({ v: 1, boards: { [SERIAL_1]: { at: 1, profiles: { 0: { 0: 'r-wuque-ws-flux-clacky' } } } } });
    expect(assignValid(byProfile)).toBe(false);
    localStorage.clear();
    setAssignments(SERIAL_1, [0], 'r-wuque-ws-flux-clacky', { now: 123 });
    const stored = JSON.parse(localStorage.getItem(SWITCH_ASSIGN_KEY)!);
    expect(Object.keys(stored).sort()).toEqual(['boards', 'v']);
    expect(Object.keys(stored.boards)).toEqual([SERIAL_1]);
    expect(Object.keys(stored.boards[SERIAL_1]).sort()).toEqual(['at', 'keys']);
    expect(stored.boards[SERIAL_1]).toEqual({ at: 123, keys: { 0: 'r-wuque-ws-flux-clacky' } });
  });

  it('enforces the 8-board LRU cap and refreshes timestamp on touch', () => {
    for (let i = 1; i <= ASSIGN_BOARD_MAX; i++) {
      setAssignments(serialOf(i), [0], 'r-wuque-ws-flux-clacky', { now: i * 100 });
    }
    // Touch board 1 so board 2 becomes the least recently used.
    setAssignments(serialOf(1), [1], GENERIC_UID, { now: 900 });
    // Add a 9th board: board 2 must be evicted, board 1 stays.
    setAssignments(serialOf(9), [0], 'r-wuque-ws-flux-clacky', { now: 1000 });

    const stored = JSON.parse(localStorage.getItem(SWITCH_ASSIGN_KEY)!);
    expect(Object.keys(stored.boards)).toHaveLength(ASSIGN_BOARD_MAX);
    expect(stored.boards[serialOf(2)]).toBeUndefined();
    expect(stored.boards[serialOf(1)].keys).toEqual({ 0: 'r-wuque-ws-flux-clacky', 1: GENERIC_UID });
    expect(stored.boards[serialOf(9)].keys).toEqual({ 0: 'r-wuque-ws-flux-clacky' });
    expect(assignValid(localStorage.getItem(SWITCH_ASSIGN_KEY)!)).toBe(true);

    // 9 boards in raw JSON fails assignValid and is ignored as a whole.
    const nine = { v: 1, boards: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [serialOf(i + 1), { at: i, keys: { 0: GENERIC_UID } }])) };
    expect(assignValid(JSON.stringify(nine))).toBe(false);
    localStorage.setItem(SWITCH_ASSIGN_KEY, JSON.stringify(nine));
    expect(readAssignments(serialOf(1))).toEqual({});
  });

  it('ignores unknown uids on read and drops them on the next write to that board (§9.1)', () => {
    const a = mkCustom(1);
    const b = mkCustom(2);
    writeCustomSwitches([a, b]);
    setAssignments(SERIAL_1, [0], a.uid, { now: 100 });
    setAssignments(SERIAL_1, [1], b.uid, { now: 101 });
    setAssignments(SERIAL_2, [2], b.uid, { now: 102 });

    // Simulate settings import removing switch b.
    writeCustomSwitches([a]);
    // Ignored on read, still in raw storage until next write to SERIAL_1.
    expect(readAssignments(SERIAL_1)).toEqual({ 0: a.uid });
    expect(JSON.parse(localStorage.getItem(SWITCH_ASSIGN_KEY)!).boards[SERIAL_1].keys['1']).toBe(b.uid);

    // Next write to SERIAL_1 drops b.uid on SERIAL_1 (SERIAL_2 untouched until written).
    setAssignments(SERIAL_1, [3], a.uid, { now: 200 });
    const after = JSON.parse(localStorage.getItem(SWITCH_ASSIGN_KEY)!);
    expect(after.boards[SERIAL_1].keys).toEqual({ 0: a.uid, 3: a.uid });
    expect(after.boards[SERIAL_2].keys).toEqual({ 2: b.uid });
  });

  it('supports set, remove / forget, apply, forgetUid and forgetBoard; validates key ids and uids', () => {
    const a = mkCustom(1);
    writeCustomSwitches([a]);
    setAssignments(SERIAL_1, [0, 1, 2], a.uid, { now: 10 });
    removeAssignments(SERIAL_1, [1], { now: 20 });
    expect(readAssignments(SERIAL_1)).toEqual({ 0: a.uid, 2: a.uid });
    forgetAssignments(SERIAL_1, [2], { now: 30 });
    expect(readAssignments(SERIAL_1)).toEqual({ 0: a.uid });

    applyAssignments(SERIAL_1, { 0: null, 5: GENERIC_UID, 64: a.uid, [-1]: a.uid }, { now: 40 });
    expect(readAssignments(SERIAL_1)).toEqual({ 5: GENERIC_UID });

    setAssignments(SERIAL_2, [10], a.uid, { now: 50 });
    forgetUid(a.uid);
    expect(readAssignments(SERIAL_2)).toEqual({});
    expect(readAssignments(SERIAL_1)).toEqual({ 5: GENERIC_UID });

    forgetBoard(SERIAL_1);
    expect(localStorage.getItem(SWITCH_ASSIGN_KEY)).toBeNull();

    // Key id out of 0..63 or non-assignable uid (x-*) fails assignValid.
    expect(assignValid(JSON.stringify({ v: 1, boards: { [SERIAL_1]: { at: 1, keys: { 64: GENERIC_UID } } } }))).toBe(false);
    expect(assignValid(JSON.stringify({ v: 1, boards: { [SERIAL_1]: { at: 1, keys: { '01': GENERIC_UID } } } }))).toBe(false);
    expect(assignValid(JSON.stringify({ v: 1, boards: { [SERIAL_1]: { at: 1, keys: { 0: 'x-kailh-flame-he' } } } }))).toBe(false);
  });
});

describe('ae64.switch.recal and ae64.switch.caps', () => {
  it('stores recal keys by serialHex or board:{boardIdHex} fallback, validates, adds and clears', () => {
    expect(recalBoardKey({ serialHex: SERIAL_1, boardIdHex: '0030000d' })).toBe(SERIAL_1);
    expect(recalBoardKey({ serialHex: '000000000000000000000000', boardIdHex: '0030000D' })).toBe('board:0030000d');
    expect(recalBoardKey({ serialHex: null, boardIdHex: '0030000a' })).toBe('board:0030000a');
    expect(recalBoardKey({ serialHex: null, boardIdHex: null })).toBeNull();

    expect(addRecalKeys({ serialHex: SERIAL_1, boardIdHex: '0030000d' }, [5, 2, 5, 64, -1])).toEqual([2, 5]);
    expect(addRecalKeys({ serialHex: 'ffffffffffffffffffffffff', boardIdHex: '0030000d' }, [10, 1])).toEqual([1, 10]);
    expect(recalValid(localStorage.getItem(SWITCH_RECAL_KEY)!)).toBe(true);
    expect(readRecalKeys(SERIAL_1)).toEqual([2, 5]);
    expect(readRecalKeys('board:0030000d')).toEqual([1, 10]);

    expect(clearRecalKeys(SERIAL_1, [2])).toEqual([5]);
    expect(clearRecalKeys(SERIAL_1, [5])).toEqual([]);
    expect(clearRecalKeys('board:0030000d', [1, 10])).toEqual([]);
    expect(localStorage.getItem(SWITCH_RECAL_KEY)).toBeNull();

    for (const bad of [
      '{',
      JSON.stringify({ v: 2, boards: {} }),
      JSON.stringify({ v: 1, boards: { '000000000000000000000000': [0] } }),
      JSON.stringify({ v: 1, boards: { [SERIAL_1]: [64] } }),
      JSON.stringify({ v: 1, boards: { [SERIAL_1]: [1, 1] } }),
      JSON.stringify({ v: 1, boards: { [SERIAL_1]: [1.5] } }),
    ]) {
      expect(recalValid(bad), bad).toBe(false);
      localStorage.setItem(SWITCH_RECAL_KEY, bad);
      expect(readRecalKeys(SERIAL_1), bad).toEqual([]);
    }
  });

  it('switchCaps defaults to photo, accepts photo or travel, and survives storage errors', () => {
    expect(switchCaps()).toBe('photo');
    expect(isSwitchCaps('photo')).toBe(true);
    expect(isSwitchCaps('travel')).toBe(true);
    expect(isSwitchCaps('other')).toBe(false);
    writeSwitchCaps('travel');
    expect(localStorage.getItem(SWITCH_CAPS_KEY)).toBe('travel');
    expect(switchCaps()).toBe('travel');
    localStorage.setItem(SWITCH_CAPS_KEY, 'bad');
    expect(switchCaps()).toBe('photo');
  });

  it('handles a throwing localStorage without throwing', () => {
    const boom = () => { throw new Error('blocked'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);

    expect(readCustomSwitches()).toEqual([]);
    expect(() => writeCustomSwitches([mkCustom(1)])).not.toThrow();
    expect(readGenericDecl()).toBeNull();
    expect(readGenericRangeUm()).toBe(GENERIC_START);
    expect(() => writeGenericDecl(3600)).not.toThrow();
    expect(readAssignments(SERIAL_1)).toEqual({});
    expect(() => setAssignments(SERIAL_1, [0], GENERIC_UID)).not.toThrow();
    expect(() => removeAssignments(SERIAL_1, [0])).not.toThrow();
    expect(() => forgetUid(GENERIC_UID)).not.toThrow();
    expect(() => forgetBoard(SERIAL_1)).not.toThrow();
    expect(readRecalKeys(SERIAL_1)).toEqual([]);
    expect(() => addRecalKeys(SERIAL_1, [0])).not.toThrow();
    expect(() => clearRecalKeys(SERIAL_1, [0])).not.toThrow();
    expect(switchCaps()).toBe('photo');
    expect(() => writeSwitchCaps('travel')).not.toThrow();
  });
});

describe('settings backup export / import / reset for custom switches (kills M16 backup half)', () => {
  it('exports custom, generic, assign and caps (never recal); import replaces them; reset clears them and keeps recal', async () => {
    const a = mkCustom(1, { name: 'Alpha' });
    const b = mkCustom(2, { name: 'Beta' });
    writeCustomSwitches([a]);
    writeGenericDecl(3600);
    setAssignments(SERIAL_1, [0, 1], a.uid, { now: 100 });
    addRecalKeys(SERIAL_1, [0, 2]);
    writeSwitchCaps('travel');

    const exp = buildExport();
    const parsed = JSON.parse(exp.json);
    expect(Object.keys(parsed.data).sort()).toEqual([
      SWITCH_ASSIGN_KEY, SWITCH_CAPS_KEY, CUSTOM_SWITCHES_KEY, GENERIC_SWITCH_KEY,
    ].sort());
    expect(parsed.data[SWITCH_RECAL_KEY]).toBeUndefined();

    // Import replaces custom, generic, assign and caps with the new file's values.
    const nextFile = JSON.stringify({
      app: 'ae64-control',
      version: '0.1.0',
      savedAt: '2026-11-22T00:00:00.000Z',
      data: {
        [CUSTOM_SWITCHES_KEY]: JSON.stringify({ v: 1, list: [b] }),
        [GENERIC_SWITCH_KEY]: JSON.stringify({ v: 1, rangeUm: 3800 }),
        [SWITCH_ASSIGN_KEY]: JSON.stringify({ v: 1, boards: { [SERIAL_2]: { at: 500, keys: { 3: b.uid } } } }),
        [SWITCH_CAPS_KEY]: 'photo',
      },
    });
    const imp = parseImport(nextFile, nextFile.length);
    expect(imp.ok).toBe(true);
    vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    await useAppSettings().applyAndReload('import', imp.ok ? imp.data : {});
    expect(readCustomSwitches()).toEqual([b]);
    expect(readGenericRangeUm()).toBe(3800);
    expect(readAssignments(SERIAL_1)).toEqual({});
    expect(readAssignments(SERIAL_2)).toEqual({ 3: b.uid });
    expect(switchCaps()).toBe('photo');
    expect(readRecalKeys(SERIAL_1)).toEqual([0, 2]);

    // Reset removes custom, generic, assign, caps and KEEPS recal.
    expect(resetKeys()).not.toContain(SWITCH_RECAL_KEY);
    await useAppSettings().applyAndReload('reset');
    expect(readCustomSwitches()).toEqual([]);
    expect(readGenericDecl()).toBeNull();
    expect(readAssignments(SERIAL_2)).toEqual({});
    expect(switchCaps()).toBe('photo');
    expect(readRecalKeys(SERIAL_1)).toEqual([0, 2]);
  });
});
