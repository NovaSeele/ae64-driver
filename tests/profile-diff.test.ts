// DESIGN G §11 items 1–2: diffProfiles and topChanges (src/data/profileDiff.ts). Pure functions, plus one run on the demo's
// real profiles 1 and 2 (the scene of the design's `main` shot).
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { DIFF_FIELDS, MM_TOLERANCE, diffProfiles, topChanges } from '../src/data/profileDiff';
import type { DiffRow } from '../src/data/profileDiff';
import { PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';

const BASE: Performance = {
  mode: 0, normalPress: 1, normalRelease: 1, rtFirstTouch: 1, rtPress: 0.5, rtRelease: 0.5,
  pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 0, calibrate: 1, axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500,
};
const std = (o: Partial<Performance> = {}): Performance => ({ ...BASE, mode: 0, ...o });
const rt = (o: Partial<Performance> = {}, mode: 1 | 2 = 1): Performance => ({ ...BASE, mode, ...o });
const odd = (m: number) => m as Performance['mode'];
const one = (p: Performance) => ({ 0: p });
const fields = (rows: DiffRow[]) => rows.map((r) => r.field);

describe('diffProfiles (DESIGN G §3.6, §11 item 1)', () => {
  it('two equal profiles → no rows', () => {
    const p = { 0: std(), 1: rt(), 2: rt({}, 2) };
    expect(diffProfiles(p, { ...p }, [0, 1, 2])).toEqual([]);
  });

  it('mm tolerance 0.5 µm: 1.0 vs 1.0004 → no row; 1.0 vs 1.001 → a row', () => {
    expect(diffProfiles(one(std({ normalPress: 1 })), one(std({ normalPress: 1.0004 })), [0])).toEqual([]);
    expect(diffProfiles(one(std({ normalPress: 1 })), one(std({ normalPress: 1.001 })), [0])).toEqual([{ id: 0, field: 'actuation', a: 1, b: 1.001 }]);
  });

  it('a difference of exactly MM_TOLERANCE is not a difference (deadTop 0 vs 0.0005; `>=` would make it one)', () => {
    expect(Math.abs(0 - 0.0005)).toBe(MM_TOLERANCE);
    expect(diffProfiles(one(std({ pressDeadStroke: 0 })), one(std({ pressDeadStroke: 0.0005 })), [0])).toEqual([]);
    expect(diffProfiles(one(rt({ rtPress: 0.0005 })), one(rt({ rtPress: 0 })), [0])).toEqual([]);
  });

  it('Standard vs RT → exactly the mode and actuation rows (no rtPress, rtRelease, continuous)', () => {
    const rows = diffProfiles(one(std({ normalPress: 1.2, rtPress: 0.2, rtRelease: 0.2 })), one(rt({ rtFirstTouch: 1, rtPress: 0.8, rtRelease: 0.3 })), [0]);
    expect(rows).toEqual([{ id: 0, field: 'mode', a: 'std', b: 'rt' }, { id: 0, field: 'actuation', a: 1.2, b: 1 }]);
  });

  it('continuous RT (1) vs RT (2) with the same numbers → one continuous row', () => {
    expect(diffProfiles(one(rt({}, 1)), one(rt({}, 2)), [0])).toEqual([{ id: 0, field: 'continuous', a: true, b: false }]);
  });

  it('RT vs RT, another press sensitivity → an rtPress row; release → rtRelease', () => {
    expect(diffProfiles(one(rt({ rtPress: 0.1 })), one(rt({ rtPress: 0.8 })), [0])).toEqual([{ id: 0, field: 'rtPress', a: 0.1, b: 0.8 }]);
    expect(fields(diffProfiles(one(rt({ rtRelease: 0.1 })), one(rt({ rtRelease: 0.3 })), [0]))).toEqual(['rtRelease']);
  });

  it('the actuation of a key is its mode\'s: RT first touch, Standard press (normalRelease is not compared)', () => {
    expect(diffProfiles(one(rt({ rtFirstTouch: 0.3, normalPress: 2 })), one(rt({ rtFirstTouch: 0.3, normalPress: 1 })), [0])).toEqual([]);
    expect(diffProfiles(one(std({ normalRelease: 2 })), one(std({ normalRelease: 1 })), [0])).toEqual([]);
    expect(fields(diffProfiles(one(rt({ rtFirstTouch: 0.3 })), one(rt({ rtFirstTouch: 0.4 })), [0]))).toEqual(['actuation']);
  });

  it('deadzones top and bottom; axisV2Id 12432 vs 4112 → a switch row; axis, calibrate, range, coefficient are not compared', () => {
    expect(fields(diffProfiles(one(std({ pressDeadStroke: 0.05 })), one(std()), [0]))).toEqual(['deadTop']);
    expect(fields(diffProfiles(one(std({ releaseDeadStroke: 0.3 })), one(std()), [0]))).toEqual(['deadBottom']);
    expect(diffProfiles(one(std({ axisV2Id: 12432 })), one(std({ axisV2Id: 4112 })), [0])).toEqual([{ id: 0, field: 'switch', a: 12432, b: 4112 }]);
    expect(diffProfiles(one(std({ axis: 1, calibrate: 0, axisRangeMax: 4000, axisCoefficient: 1 })), one(std()), [0])).toEqual([]);
  });

  it('an unknown mode (3, 255) on either side → no row at all for that key', () => {
    expect(diffProfiles(one(std({ mode: odd(3), normalPress: 2, axisV2Id: 4112 })), one(rt()), [0])).toEqual([]);
    expect(diffProfiles(one(rt()), one(std({ mode: odd(255), pressDeadStroke: 0.9 })), [0])).toEqual([]);
  });

  it('a key missing on either side is skipped', () => {
    expect(diffProfiles({ 0: std(), 1: std({ normalPress: 2 }) }, { 1: std() }, [0, 1, 2])).toEqual([{ id: 1, field: 'actuation', a: 2, b: 1 }]);
    expect(diffProfiles({ 1: std() }, { 0: std({ normalPress: 2 }), 1: std() }, [0, 1])).toEqual([]);
  });

  it('rows come in `ids` order, and within a key in DIFF_FIELDS order', () => {
    const a = { 5: std({ normalPress: 2, axisV2Id: 4112, pressDeadStroke: 0 }), 2: rt({ rtPress: 0.1 }, 2) };
    const b = { 5: rt(), 2: rt() };
    const rows = diffProfiles(a, b, [5, 2]);
    expect(rows.map((r) => `${r.id}:${r.field}`)).toEqual(['5:mode', '5:actuation', '5:deadTop', '5:switch', '2:rtPress', '2:continuous']);
    expect(DIFF_FIELDS).toEqual(['mode', 'actuation', 'rtPress', 'rtRelease', 'continuous', 'deadTop', 'deadBottom', 'switch']);
  });
});

describe('topChanges (§3.6, §11 item 2)', () => {
  const row = (id: number, field: DiffRow['field'], a: DiffRow['a'], b: DiffRow['b']): DiffRow => ({ id, field, a, b });

  it('a change on a single key is not a group; groups by number of keys, a tie by field order; at most 3', () => {
    const rows = [
      row(0, 'switch', 1, 2), row(1, 'switch', 1, 2), // 2 keys, last field
      row(2, 'deadTop', 0.1, 0.2), row(3, 'deadTop', 0.1, 0.2), // 2 keys, earlier field
      row(4, 'actuation', 1, 2), row(5, 'actuation', 1, 2), row(6, 'actuation', 1, 2), // 3 keys
      row(7, 'mode', 'std', 'rt'), // 1 key: dropped
      row(8, 'rtPress', 0.1, 0.2), row(9, 'rtPress', 0.1, 0.2), // 2 keys, between actuation and deadTop
    ];
    expect(topChanges(rows)).toEqual([
      { field: 'actuation', a: 1, b: 2, keys: 3 },
      { field: 'rtPress', a: 0.1, b: 0.2, keys: 2 },
      { field: 'deadTop', a: 0.1, b: 0.2, keys: 2 },
    ]);
    expect(topChanges(rows, 5).map((g) => g.field)).toEqual(['actuation', 'rtPress', 'deadTop', 'switch']);
    expect(topChanges([row(0, 'mode', 'std', 'rt')])).toEqual([]);
  });

  it('the same field with other values is another group; float noise is not', () => {
    const rows = [row(0, 'actuation', 1.2, 1), row(1, 'actuation', 1.2000000001, 1), row(2, 'actuation', 1.5, 1), row(3, 'actuation', 1.5, 1), row(4, 'actuation', 1.5, 1)];
    expect(topChanges(rows).map((g) => [g.a, g.keys])).toEqual([[1.5, 3], [1.2, 2]]);
  });
});

describe('the demo\'s profiles 1 and 2 as in the `main` shot', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('FPS (with the shot\'s edits) vs Default: 141 rows on 64 keys; Most common = mode 60, actuation 1.2→1.0 59, actuation 0.3→1.0 4', async () => {
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    await device.connectDemo();
    await perf.load();
    const def = perf.values;
    await device.switchProfile(1);
    await perf.load(true);
    const fps: Record<number, Performance> = Object.fromEntries(Object.entries(perf.values).map(([k, v]) => [k, { ...v }]));
    const id = (n: string) => PHYSICAL_KEYS.find((k) => k.name === n)!.id;
    fps[id('Shift')] = { ...fps[id('Shift')], normalPress: 1.5, normalRelease: 1.5 }; // the left Shift (the first one)
    for (const k of ['W', 'A', 'S', 'D']) fps[id(k)] = { ...fps[id(k)], mode: 2, pressDeadStroke: 0.05 };
    fps[id('Esc')] = { ...fps[id('Esc')], axisV2Id: 4112 };
    const rows = diffProfiles(fps, def, device.keys.map((k) => k.id));
    expect(rows).toHaveLength(141);
    expect(new Set(rows.map((r) => r.id)).size).toBe(64);
    expect(topChanges(rows)).toEqual([
      { field: 'mode', a: 'std', b: 'rt', keys: 60 },
      { field: 'actuation', a: 1.2, b: 1, keys: 59 },
      { field: 'actuation', a: 0.3, b: 1, keys: 4 },
    ]);
    expect(rows.filter((r) => r.id === id('W')).map((r) => r.field)).toEqual(['actuation', 'rtPress', 'rtRelease', 'continuous', 'deadTop']);
    expect(rows.filter((r) => r.id === id('Esc')).map((r) => r.field)).toEqual(['mode', 'actuation', 'switch']);
  });
});
