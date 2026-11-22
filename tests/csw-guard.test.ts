// CSW step 1: custom-switch bounds, isCustomTriple, and checkPerformanceWrite guard (DESIGN §14.1, §19 Test 1).
import { describe, expect, it } from 'vitest';
import { FW_AXIS, coefBounds, findSwitch, isCustomTriple, rangeBounds, switchCatalogFor } from '../src/protocol/switches';
import type { SwitchEntry, SwitchTriple } from '../src/protocol/switches';
import { DIST_FIELDS, MAX_TRAVEL_MM, checkPerformanceWrite } from '../src/protocol/safety';
import type { Performance } from '../src/protocol/types';

const MAX_BOARD = '0030000d';
const PRO_BOARD = '0030000a';
const MAX_CATALOG = switchCatalogFor(MAX_BOARD)!;
const PRO_CATALOG = switchCatalogFor(PRO_BOARD)!;

/** Key starting with Magnetic Jade (4112 / 3430 / 22800), calibrated, safe travel values. */
const jade: Performance = {
  mode: 0, normalPress: 2.0, normalRelease: 2.0, rtFirstTouch: 1.0, rtPress: 0.5, rtRelease: 0.5,
  pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 0, calibrate: 1,
  axisV2Id: 4112, axisRangeMax: 3430, axisCoefficient: 22800,
};

const withTriple = (p: Performance, t: SwitchTriple): Performance => ({ ...p, ...t });

describe('FW_AXIS and catalog bounds (switches.ts)', () => {
  it('exports the firmware 04 02 axis limits', () => {
    expect(FW_AXIS).toEqual({ idMin: 0x1000, rangeMin: 1000, rangeMax: 5000, coefMin: 4096 });
  });

  it('computes rangeBounds and coefBounds from each board catalog (3130–4015, 13300–26800 today) and returns null for null/empty', () => {
    expect(rangeBounds(MAX_CATALOG)).toEqual({ min: 3130, max: 4015 });
    expect(coefBounds(MAX_CATALOG)).toEqual({ min: 13300, max: 26800 });
    expect(rangeBounds(PRO_CATALOG)).toEqual({ min: 3130, max: 4015 });
    expect(coefBounds(PRO_CATALOG)).toEqual({ min: 13300, max: 26800 });
    expect(rangeBounds(null)).toBeNull();
    expect(coefBounds(null)).toBeNull();
    expect(rangeBounds([])).toBeNull();
    expect(coefBounds([])).toBeNull();

    // Never hard-coded: computed from whatever catalog is passed in.
    const synth: SwitchEntry[] = [
      { id: 0x1000, name: 'A', group: 'Other', rangeMax: 3250, coefficient: 15000, color: '' },
      { id: 0x1001, name: 'B', group: 'Other', rangeMax: 3750, coefficient: 22500, color: '' },
    ];
    expect(rangeBounds(synth)).toEqual({ min: 3250, max: 3750 });
    expect(coefBounds(synth)).toEqual({ min: 15000, max: 22500 });
  });

  it('exports MAX_TRAVEL_MM (4.0) and the seven DIST_FIELDS from safety.ts', () => {
    expect(MAX_TRAVEL_MM).toBe(4.0);
    expect(DIST_FIELDS).toEqual([
      'normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease', 'pressDeadStroke', 'releaseDeadStroke',
    ]);
  });
});

describe('isCustomTriple', () => {
  it('accepts the key own id (>= 0x1000) and board list ids within range/coef bounds', () => {
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 17536 }, 4112)).toBe(true);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 13472, axisRangeMax: 3130, axisCoefficient: 26800 }, 4112)).toBe(true);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 13472, axisRangeMax: 4015, axisCoefficient: 13300 }, 4112)).toBe(true);
    // An unlisted key's own id >= 0x1000 is allowed when kept.
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 0x1000, axisRangeMax: 3500, axisCoefficient: 20000 }, 0x1000)).toBe(true);
    // Pro-only list id 13184 passes on Pro, not on Max (when not currentId).
    expect(isCustomTriple(PRO_CATALOG, { axisV2Id: 13184, axisRangeMax: 3500, axisCoefficient: 20000 }, 14544)).toBe(true);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 13184, axisRangeMax: 3500, axisCoefficient: 20000 }, 4112)).toBe(false);
  });

  it('refuses null catalog, non-integers, out-of-bounds R/c, unknown ids and ids < 0x1000', () => {
    expect(isCustomTriple(null, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 17536 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 13299 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 26801 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 17536.5 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 4112, axisRangeMax: 3129, axisCoefficient: 17536 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 4112, axisRangeMax: 4016, axisCoefficient: 17536 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 4112, axisRangeMax: 3500.5, axisCoefficient: 17536 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 99999, axisRangeMax: 3500, axisCoefficient: 17536 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 4112.5, axisRangeMax: 3500, axisCoefficient: 17536 }, 4112.5)).toBe(false);
    // 2128 (Star Eye) is in the Max list, yet < 0x1000 — refused both as a list id and as currentId.
    expect(findSwitch(MAX_CATALOG, 2128)).toBeDefined();
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 2128, axisRangeMax: 3500, axisCoefficient: 17536 }, 4112)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 2128, axisRangeMax: 3500, axisCoefficient: 17536 }, 2128)).toBe(false);
    expect(isCustomTriple(MAX_CATALOG, { axisV2Id: 0x0fff, axisRangeMax: 3500, axisCoefficient: 17536 }, 0x0fff)).toBe(false);
  });
});

describe('checkPerformanceWrite — CSW Test 1 (guard)', () => {
  it('accepts valid custom, catalog and reported triples on Max and Pro', () => {
    // Key's own id 4112 with custom 3500 / 17536
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 17536 }), [jade], { boardIdHex: MAX_BOARD })).toBeNull();
    // List id 13472 with both bound corners (3130/26800 and 4015/13300)
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 13472, axisRangeMax: 3130, axisCoefficient: 26800 }), [jade], { boardIdHex: MAX_BOARD })).toBeNull();
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 13472, axisRangeMax: 4015, axisCoefficient: 13300 }), [jade], { boardIdHex: MAX_BOARD })).toBeNull();
    // Exact list triple (Apollo on Max, Polar Sakura Clear on Pro)
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500 }), [jade], { boardIdHex: MAX_BOARD })).toBeNull();
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 13184, axisRangeMax: 3625, axisCoefficient: 22200 }), [jade], { boardIdHex: PRO_BOARD })).toBeNull();
    // Reported triple (restoring an earlier valid triple from seen, even without a board list)
    const other = withTriple(jade, { axisV2Id: 13472, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(checkPerformanceWrite(jade, [jade, other])).toBeNull();
    expect(checkPerformanceWrite(jade, [jade, other], { boardIdHex: '0030000b' })).toBeNull();
  });

  it('refuses coefficient outside the list bounds (kills M1)', () => {
    const low = checkPerformanceWrite(withTriple(jade, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 13299 }), [jade], { boardIdHex: MAX_BOARD });
    const high = checkPerformanceWrite(withTriple(jade, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 26801 }), [jade], { boardIdHex: MAX_BOARD });
    expect(low).toContain("or a custom triple (key's own or a list id ≥ 0x1000, range and coefficient within the list's bounds)");
    expect(high).toContain("or a custom triple (key's own or a list id ≥ 0x1000, range and coefficient within the list's bounds)");
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 13472, axisRangeMax: 3500, axisCoefficient: 13299 }), [jade], { boardIdHex: PRO_BOARD })).toMatch(/custom triple/);
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 13472, axisRangeMax: 3500, axisCoefficient: 26801 }), [jade], { boardIdHex: PRO_BOARD })).toMatch(/custom triple/);
  });

  it('refuses range outside the list bounds or non-integer', () => {
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 4112, axisRangeMax: 3129, axisCoefficient: 17536 }), [jade], { boardIdHex: MAX_BOARD })).toMatch(/custom triple/);
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 4112, axisRangeMax: 4016, axisCoefficient: 17536 }), [jade], { boardIdHex: MAX_BOARD })).toMatch(/custom triple/);
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 4112, axisRangeMax: 3500.5, axisCoefficient: 17536 }), [jade], { boardIdHex: MAX_BOARD })).toMatch(/custom triple/);
  });

  it('refuses an id that is neither the key own id nor in the board list (kills M2)', () => {
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 99999, axisRangeMax: 3500, axisCoefficient: 17536 }), [jade], { boardIdHex: MAX_BOARD })).toMatch(/custom triple/);
    // Pro-only id 13184 is not in the Max list and is not the key's id (4112).
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 13184, axisRangeMax: 3500, axisCoefficient: 17536 }), [jade], { boardIdHex: MAX_BOARD })).toMatch(/custom triple/);
  });

  it('refuses id 2128 (< 0x1000) for a custom triple even on the Max where 2128 is listed (kills M3)', () => {
    // 2128 is in the Max list, but < 0x1000 so a custom triple with 2128 must be refused.
    expect(checkPerformanceWrite(withTriple(jade, { axisV2Id: 2128, axisRangeMax: 3500, axisCoefficient: 17536 }), [jade], { boardIdHex: MAX_BOARD })).toMatch(/custom triple/);
    // Even if the key itself currently has id 2128, a custom triple keeping 2128 is refused.
    const starEye: Performance = { ...jade, axisV2Id: 2128, axisRangeMax: 3600, axisCoefficient: 20224 };
    expect(checkPerformanceWrite(withTriple(starEye, { axisV2Id: 2128, axisRangeMax: 3500, axisCoefficient: 17536 }), [starEye], { boardIdHex: MAX_BOARD })).toMatch(/custom triple/);
    // Key with id 0 (lost) cannot keep id 0 in a custom triple.
    const lost: Performance = { ...jade, axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0, calibrate: 0 };
    expect(checkPerformanceWrite(withTriple(lost, { axisV2Id: 0, axisRangeMax: 3500, axisCoefficient: 17536 }), [lost], { boardIdHex: MAX_BOARD })).toMatch(/custom triple/);
  });

  it('refuses a reported 0/0/0 or 4112/3500/0 on a changed triple (kills M6)', () => {
    const zero: Performance = { ...jade, axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 };
    expect(checkPerformanceWrite(zero, [zero, jade], { boardIdHex: MAX_BOARD })).toMatch(/1000\/4096/);
    const zeroCoef: Performance = { ...jade, axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 0 };
    expect(checkPerformanceWrite(zeroCoef, [zeroCoef, jade], { boardIdHex: MAX_BOARD })).toMatch(/1000\/4096/);
    // Just under each firmware floor (R 999, c 4095) is also refused even when reported earlier.
    const lowR: Performance = { ...jade, axisV2Id: 4112, axisRangeMax: 999, axisCoefficient: 20000 };
    expect(checkPerformanceWrite(lowR, [lowR, jade], { boardIdHex: MAX_BOARD })).toMatch(/1000\/4096/);
    const lowC: Performance = { ...jade, axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 4095 };
    expect(checkPerformanceWrite(lowC, [lowC, jade], { boardIdHex: MAX_BOARD })).toMatch(/1000\/4096/);
  });

  it('refuses any non-reported triple on a board without a list', () => {
    const custom = withTriple(jade, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 17536 });
    const catalog = withTriple(jade, { axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500 });
    expect(checkPerformanceWrite(custom, [jade], { boardIdHex: '0030000b' })).toMatch(/custom triple/);
    expect(checkPerformanceWrite(custom, [jade])).toMatch(/custom triple/);
    expect(checkPerformanceWrite(catalog, [jade], { boardIdHex: '0030000b' })).toMatch(/custom triple/);
  });

  it('keeps the calibrate and axis rules unchanged on custom triple writes', () => {
    const custom = withTriple(jade, { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(checkPerformanceWrite({ ...custom, calibrate: 0 }, [jade], { boardIdHex: MAX_BOARD })).toMatch(/calibrate/);
    expect(checkPerformanceWrite({ ...custom, calibrate: 1 }, [jade, { ...jade, calibrate: 0 }], { boardIdHex: MAX_BOARD })).toMatch(/calibrate/);
    expect(checkPerformanceWrite({ ...custom, calibrate: 0 }, [jade, { ...jade, calibrate: 0 }], { boardIdHex: MAX_BOARD })).toBeNull();
    expect(checkPerformanceWrite({ ...custom, axis: 1 }, [jade], { boardIdHex: MAX_BOARD })).toMatch(/axis/);
  });

  it('checks all seven distances (changed or not) on a changed triple, and only changed ones when triple is unchanged (kills M32)', () => {
    const deep: Performance = { ...jade, axisRangeMax: 3390, axisCoefficient: 20000, releaseDeadStroke: 3.5 };
    // Changed triple to R 3390 (e.g. different id or c): unchanged releaseDeadStroke 3.5 is REFUSED.
    const changedTriple = withTriple(deep, { axisV2Id: 4112, axisRangeMax: 3390, axisCoefficient: 17536 });
    expect(checkPerformanceWrite(changedTriple, [deep], { boardIdHex: MAX_BOARD })).toMatch(/releaseDeadStroke 3\.5 mm outside 0–3\.39 mm/);
    // Also refused when switching to a listed 3390 switch (4128 Magnetic Jade Pro).
    const listed3390 = withTriple(deep, { axisV2Id: 4128, axisRangeMax: 3390, axisCoefficient: 20000 });
    expect(checkPerformanceWrite(listed3390, [deep], { boardIdHex: MAX_BOARD })).toMatch(/releaseDeadStroke 3\.5 mm outside 0–3\.39 mm/);
    // Unchanged triple (current R 3390): unchanged releaseDeadStroke 3.5 PASSES, while changing it fails.
    expect(checkPerformanceWrite({ ...deep, normalPress: 1.5 }, [deep], { boardIdHex: MAX_BOARD })).toBeNull();
    const clean3390: Performance = { ...deep, releaseDeadStroke: 0.1 };
    expect(checkPerformanceWrite({ ...clean3390, releaseDeadStroke: 3.5 }, [clean3390], { boardIdHex: MAX_BOARD })).toMatch(/releaseDeadStroke 3\.5 mm outside 0–3\.39 mm/);
    // Changed triple to R 4015 still enforces MAX_TRAVEL_MM = 4.0 on unchanged distances.
    const over4: Performance = { ...jade, normalPress: 4.01, normalRelease: 4.01 };
    expect(checkPerformanceWrite(withTriple(over4, { axisV2Id: 4416, axisRangeMax: 4015, axisCoefficient: 13300 }), [over4], { boardIdHex: MAX_BOARD })).toMatch(/normalPress 4\.01 mm outside 0–4 mm/);
  });
});
