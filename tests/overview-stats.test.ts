// DESIGN F §11 item 1: the Overview page's pure summary functions (data/overviewStats.ts) and the keycap's mm format
// (data/keycapActuation.ts fmtMm, shared with the Travel tab).
import { describe, expect, it } from 'vitest';
import { actuationStats, rtCount } from '../src/data/overviewStats';
import { fmtMm } from '../src/data/keycapActuation';
import type { Performance } from '../src/protocol';

const BASE: Performance = {
  mode: 0, normalPress: 1, normalRelease: 1, rtFirstTouch: 1, rtPress: 0.5, rtRelease: 0.5,
  pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 0, calibrate: 1, axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500,
};
/** Standard key actuating at `a` mm. */
const std = (a: number): Performance => ({ ...BASE, mode: 0, normalPress: a, rtFirstTouch: 9 });
/** Rapid Trigger key (mode 1 or 2) actuating at `a` mm (first touch). */
const rt = (a: number, mode: 1 | 2 = 1): Performance => ({ ...BASE, mode, rtFirstTouch: a, normalPress: 9 });
/** A firmware mode the app does not know (the type only lists 0/1/2). */
const odd = (m: number) => m as Performance['mode'];
const values = (...recs: Performance[]): Record<number, Performance> => Object.fromEntries(recs.map((p, i) => [i, p]));

describe('actuationStats (DESIGN F §3.3)', () => {
  it('a tie goes to the smaller value: 2 × 1.0 and 2 × 1.5 → mode 1.0, count 2', () => {
    expect(actuationStats(values(std(1.5), std(1), rt(1.5), rt(1)), 3)).toEqual({ min: 1, max: 1.5, mode: 1, modeCount: 2, count: 4 });
    // the order the keys come in does not matter
    expect(actuationStats(values(std(1), std(1.5), std(1.5), std(1)), 3)!.mode).toBe(1);
  });

  it('the most common value wins over a smaller one', () => {
    expect(actuationStats(values(std(0.3), std(1.2), std(1.2), std(2)), 3)).toEqual({ min: 0.3, max: 2, mode: 1.2, modeCount: 2, count: 4 });
  });

  it('values are rounded to `decimals` before grouping: 0.30000000004 and 0.3 are one value', () => {
    const s = actuationStats(values(rt(0.30000000004), rt(0.3), std(1)), 3)!;
    expect(s).toEqual({ min: 0.3, max: 1, mode: 0.3, modeCount: 2, count: 3 });
    // 2 decimals (Pro): 0.151 and 0.149 both round to 0.15
    expect(actuationStats(values(rt(0.151), rt(0.149), std(2)), 2)).toEqual({ min: 0.15, max: 2, mode: 0.15, modeCount: 2, count: 3 });
  });

  it('keys in an unknown mode (3, 255) are left out of count, min, max and the mode', () => {
    const s = actuationStats(values(std(1), std(1), { ...std(0.1), mode: odd(3) }, { ...rt(3), mode: odd(255) }, { ...std(0.1), mode: odd(3) }), 3);
    expect(s).toEqual({ min: 1, max: 1, mode: 1, modeCount: 2, count: 2 });
  });

  it('no key with a known mode → null (also for no keys at all)', () => {
    expect(actuationStats(values({ ...std(1), mode: odd(3) }, { ...std(1), mode: odd(255) }), 3)).toBeNull();
    expect(actuationStats({}, 3)).toBeNull();
  });

  it('every key equal → modeCount === count and min === max', () => {
    const s = actuationStats(values(...Array.from({ length: 64 }, () => rt(1))), 3)!;
    expect(s.modeCount).toBe(s.count);
    expect(s.count).toBe(64);
    expect(s.min).toBe(s.max);
  });

  it('the value of a key is its actuation point: RT first touch, Standard press (mode 2 is RT too)', () => {
    expect(actuationStats(values(rt(0.4, 2)), 3)!.min).toBe(0.4);
    expect(actuationStats(values(std(1.7)), 3)!.min).toBe(1.7);
  });
});

describe('rtCount', () => {
  it('counts modes 1 and 2, not 0 nor unknown modes', () => {
    expect(rtCount(values(rt(1, 1), rt(1, 2), std(1), { ...rt(1), mode: odd(3) }, { ...rt(1), mode: odd(255) }))).toBe(2);
    expect(rtCount({})).toBe(0);
  });
});

describe('fmtMm (the keycap way of writing mm)', () => {
  it.each([
    [1, 3, '1.0'], [0.15, 2, '0.15'], [2, 3, '2.0'], [0.3, 3, '0.3'], [0.125, 3, '0.125'], [1.2, 2, '1.2'], [0.30000000004, 3, '0.3'],
  ])('fmtMm(%s, %s) = %s', (v, d, out) => {
    expect(fmtMm(v, d)).toBe(out);
  });
});
