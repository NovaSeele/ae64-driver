// CSW step 2: customTriple, fallbackId, suggestCurve, COEF_POINTS, coefFromTravel and genericSwitch
// (DESIGN §5.7, §6.4, §7.1, §19 Tests 2 and 3; mutants M4, M5, M20).
import { describe, expect, it } from 'vitest';
import {
  COEF_POINTS, GENERIC_CLASSES, GENERIC_START, GENERIC_UID, coefFromTravel, customTriple, fallbackId,
  genericSwitch, readyToCustomLike, suggestCurve, userToCustomLike,
} from '../src/data/customSwitch';
import type { CustomLike, CustomSwitch } from '../src/data/customSwitch';
import { READY_BOUNDS, READY_SWITCHES } from '../src/data/readySwitches';
import { makerTabs, switchBrand } from '../src/data/switchDisplay';
import { coefBounds, findSwitch, isCustomTriple, rangeBounds, switchCatalogFor } from '../src/protocol/switches';
import type { SwitchEntry, SwitchTriple } from '../src/protocol/switches';

const MAX_CATALOG = switchCatalogFor('0030000d')!;
const PRO_CATALOG = switchCatalogFor('0030000a')!;

const flux: CustomLike = readyToCustomLike(READY_SWITCHES.find((s) => s.uid === 'r-wuque-ws-flux-clacky')!);
const omega: CustomLike = readyToCustomLike(READY_SWITCHES.find((s) => s.uid === 'r-huano-omega-magnetic')!);

describe('customTriple and fallbackId — CSW Test 2', () => {
  it('keeps a valid list id >= 0x1000 on Max and Pro (kills M4)', () => {
    const maxCur: SwitchTriple = { axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 };
    const rMax = customTriple(flux, maxCur, MAX_CATALOG);
    expect(rMax).toEqual({
      triple: { axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536 },
      idKept: true,
    });

    // Pro-only list id 13184 (Polar Sakura Clear) is kept on Pro.
    const proCur: SwitchTriple = { axisV2Id: 13184, axisRangeMax: 3625, axisCoefficient: 22200 };
    const rPro = customTriple(flux, proCur, PRO_CATALOG);
    expect(rPro).toEqual({
      triple: { axisV2Id: 13184, axisRangeMax: 3500, axisCoefficient: 17536 },
      idKept: true,
    });
  });

  it('replaces 0, an unlisted id and 2128 (< 0x1000) with fallbackId (kills M5)', () => {
    const badCurrents: SwitchTriple[] = [
      { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 },
      { axisV2Id: 99999, axisRangeMax: 3400, axisCoefficient: 20000 },
      // Pro-only id is unlisted on Max.
      { axisV2Id: 13184, axisRangeMax: 3625, axisCoefficient: 22200 },
      // 2128 Star Eye is in Max's list, yet < 0x1000 — must NEVER be kept.
      { axisV2Id: 2128, axisRangeMax: 3600, axisCoefficient: 20224 },
    ];
    for (const cur of badCurrents) {
      const r = customTriple(flux, cur, MAX_CATALOG)!;
      expect(r.idKept, `id ${cur.axisV2Id}`).toBe(false);
      expect(r.triple.axisV2Id, `id ${cur.axisV2Id}`).toBe(13472); // flux.curveFrom = Skyline V3
      expect(isCustomTriple(MAX_CATALOG, r.triple, cur.axisV2Id), `id ${cur.axisV2Id}`).toBe(true);
    }
  });

  it('fallbackId picks curveFrom when listed and >= 0x1000, else nearest range with ties in picker order (makerTabs)', () => {
    // curveFrom 13472 listed and >= 0x1000 → 13472.
    expect(fallbackId(MAX_CATALOG, flux, 3500)).toBe(13472);

    // HUANO OMEGA has curveFrom 2128 (< 0x1000): must skip 2128 and take nearest usable entry for 3500 (13472 Skyline V3, exact 3500).
    expect(omega.curveFrom?.id).toBe(2128);
    expect(fallbackId(MAX_CATALOG, omega, 3500)).toBe(13472);

    // curveFrom unlisted on this board (Pro-only 13184 on Max) → nearest usable in picker order for 3400.
    const withProCurve: CustomLike = { uid: 'u-1', name: 'X', maker: '', rangeUm: 3400, coefficient: 20000, curveFrom: { id: 13184 } };
    const pickerOrdered = makerTabs(MAX_CATALOG).flatMap((t) => t.entries).filter((e) => e.id >= 0x1000);
    const first3400 = pickerOrdered.find((e) => e.rangeMax === 3400)!;
    // Both Gateron 4144 (Magnetic Jade Gaming) and 4480 (Magnetic Black) and Everglide 14544 have rangeMax 3400; Gateron 4144 is first in picker order.
    expect(first3400.id).toBe(4144);
    expect(fallbackId(MAX_CATALOG, withProCurve, 3400)).toBe(4144);

    // Explicit tie where raw catalog order differs from picker order:
    // Raw catalog puts Everglide Cullinan (19504, 3600) at index 0, BEFORE Gateron (4112..).
    // Give Gateron 5 entries so Gateron gets tab 0 and Everglide goes to Other, with an exact rangeMax tie at 3600:
    // picker order puts Gateron first even though Everglide is index 0 in the input array.
    const synth: SwitchEntry[] = [
      { id: 19504, name: 'Cullinan', group: 'JIANGWAN', rangeMax: 3600, coefficient: 19456, color: '' }, // Everglide
      { id: 4112, name: 'Jade', group: 'GATERON', rangeMax: 3430, coefficient: 22800, color: '' },
      { id: 4128, name: 'Jade Pro', group: 'GATERON', rangeMax: 3390, coefficient: 20000, color: '' },
      { id: 4144, name: 'Jade Gaming', group: 'GATERON', rangeMax: 3400, coefficient: 19000, color: '' },
      { id: 4160, name: 'Jade Air', group: 'GATERON', rangeMax: 3430, coefficient: 19600, color: '' },
      { id: 4528, name: 'Genty', group: 'GATERON', rangeMax: 3600, coefficient: 16800, color: '' },
    ];
    const noCurve: CustomLike = { uid: 'u-tie', name: 'Tie', maker: '', rangeUm: 3600, coefficient: 20000 };
    expect(fallbackId(synth, noCurve, 3600)).toBe(4528); // Gateron tab beats Everglide (Other) despite index 0
  });

  it('clamps and rounds R and c to the board list bounds and returns null without a list', () => {
    const cur: SwitchTriple = { axisV2Id: 4112, axisRangeMax: 3430, axisCoefficient: 22800 };
    const over: CustomLike = { uid: 'u-hi', name: 'Hi', maker: '', rangeUm: 4500.6, coefficient: 30000.7 };
    const under: CustomLike = { uid: 'u-lo', name: 'Lo', maker: '', rangeUm: 2900.2, coefficient: 9000.3 };
    const frac: CustomLike = { uid: 'u-fr', name: 'Fr', maker: '', rangeUm: 3500.6, coefficient: 19999.6 };

    expect(customTriple(over, cur, MAX_CATALOG)?.triple).toEqual({ axisV2Id: 4112, axisRangeMax: 4015, axisCoefficient: 26800 });
    expect(customTriple(under, cur, MAX_CATALOG)?.triple).toEqual({ axisV2Id: 4112, axisRangeMax: 3130, axisCoefficient: 13300 });
    expect(customTriple(frac, cur, MAX_CATALOG)?.triple).toEqual({ axisV2Id: 4112, axisRangeMax: 3501, axisCoefficient: 20000 });

    // Computed dynamically from whatever catalog is passed, never hard-coded.
    const narrow: SwitchEntry[] = [
      { id: 0x1000, name: 'A', group: 'Other', rangeMax: 3300, coefficient: 16000, color: '' },
      { id: 0x1001, name: 'B', group: 'Other', rangeMax: 3700, coefficient: 21000, color: '' },
    ];
    expect(customTriple(over, { axisV2Id: 0x1000, axisRangeMax: 3300, axisCoefficient: 16000 }, narrow)?.triple).toEqual({
      axisV2Id: 0x1000, axisRangeMax: 3700, axisCoefficient: 21000,
    });

    expect(customTriple(flux, cur, null)).toBeNull();
    expect(customTriple(flux, cur, [])).toBeNull();
    const unusableOnly: SwitchEntry[] = [{ id: 2128, name: 'Star Eye', group: 'Other', rangeMax: 3600, coefficient: 20224, color: '' }];
    expect(customTriple(flux, { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 }, unusableOnly)).toBeNull();
  });

  it('property: every ready-made entry and every generic class × both boards × valid/0/unlisted/2128 current ids always passes isCustomTriple', () => {
    const catalogs = [MAX_CATALOG, PRO_CATALOG];
    for (const catalog of catalogs) {
      const validId = catalog[0].id;
      const currents: SwitchTriple[] = [
        { axisV2Id: validId, axisRangeMax: catalog[0].rangeMax, axisCoefficient: catalog[0].coefficient },
        { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 },
        { axisV2Id: 99999, axisRangeMax: 3400, axisCoefficient: 20000 },
        { axisV2Id: 2128, axisRangeMax: 3600, axisCoefficient: 20224 },
      ];
      for (const ready of READY_SWITCHES) {
        const c = readyToCustomLike(ready);
        for (const cur of currents) {
          const res = customTriple(c, cur, catalog);
          expect(res, `${ready.uid} / ${cur.axisV2Id}`).not.toBeNull();
          expect(isCustomTriple(catalog, res!.triple, cur.axisV2Id), `${ready.uid} / ${cur.axisV2Id}`).toBe(true);
          const expectedKeep = cur.axisV2Id >= 0x1000 && !!findSwitch(catalog, cur.axisV2Id);
          expect(res!.idKept).toBe(expectedKeep);
        }
      }
      for (const um of [1000, ...GENERIC_CLASSES, 3450, 6000]) {
        const g = genericSwitch({ rangeUm: um }, catalog);
        for (const cur of currents) {
          const res = customTriple(g, cur, catalog);
          expect(res).not.toBeNull();
          expect(isCustomTriple(catalog, res!.triple, cur.axisV2Id)).toBe(true);
        }
      }
    }
  });
});

describe('suggestCurve, coefFromTravel and genericSwitch — CSW Test 3', () => {
  it('suggestCurve picks the maker entries first (folded via switchBrand), then nearest range, ties in picker order', () => {
    // TTC at 3500: TTC's HiFi Snow (8432, 3510) wins over Everglide Skyline V3 (13472, exact 3500) because TTC matches maker.
    expect(suggestCurve(MAX_CATALOG, 3500, 'TTC')?.id).toBe(8432);
    expect(suggestCurve(MAX_CATALOG, 3500, '  ttc  ')?.id).toBe(8432);
    // Folded accents match brand too.
    expect(suggestCurve(MAX_CATALOG, 3430, 'Gáteròn')?.id).toBe(4112);

    // Unknown/unlisted maker falls back to the whole catalog: at 3500, Skyline V3 (13472, exact 3500) wins.
    expect(suggestCurve(MAX_CATALOG, 3500, 'Wuque Studio')?.id).toBe(13472);
    // Empty maker must NOT match Unknown-brand switches (12448 Koi / 12720 Purple Star); it searches the whole catalog.
    expect(suggestCurve(MAX_CATALOG, 3500, '')?.id).toBe(13472);
    expect(suggestCurve(MAX_CATALOG, 3400, '')?.id).toBe(4144); // Gateron tab first in picker order among R=3400 entries

    // Verify all Gateron matches really have brand Gateron via switchBrand.
    const gat = suggestCurve(MAX_CATALOG, 3900, 'gateron')!;
    expect(switchBrand(gat.id)).toBe('Gateron');
    expect(gat.id).toBe(4512); // Magnetic Green, 3895

    expect(suggestCurve([], 3500, 'Gateron')).toBeNull();
    expect(suggestCurve(MAX_CATALOG, Number.NaN, 'Gateron')).toBeNull();
  });

  it('coefFromTravel matches every §5.7 / §19.3 example, is monotonic and stays inside bounds (kills M20)', () => {
    const b = coefBounds(MAX_CATALOG)!;
    const examples: [number, number][] = [
      [3130, 25728],
      [3200, 25728],
      [3300, 23139],
      [3390, 20809],
      [3400, 20550],
      [3450, 20200],
      [3500, 19850],
      [3600, 18750],
      [3700, 17838],
      [3800, 16925],
      [4000, 15100],
      [4015, 15100],
    ];
    for (const [um, want] of examples) {
      expect(coefFromTravel(um, b), `${um} µm`).toBe(want);
    }
    // 3.80 is strictly on the line between 3.60 (18750) and 4.00 (15100).
    expect(coefFromTravel(3800, b)).toBe(Math.round((18750 + 15100) / 2));

    // Monotonically non-increasing and integer within bounds across 3000–4200 µm.
    let prev = Infinity;
    for (let r = 3000; r <= 4200; r++) {
      const c = coefFromTravel(r, b);
      expect(Number.isInteger(c)).toBe(true);
      expect(c).toBeGreaterThanOrEqual(b.min);
      expect(c).toBeLessThanOrEqual(b.max);
      expect(c).toBeLessThanOrEqual(prev);
      prev = c;
    }

    // Tighter caller bounds clamp the output.
    expect(coefFromTravel(3200, { min: 16000, max: 22000 })).toBe(22000);
    expect(coefFromTravel(4000, { min: 16000, max: 22000 })).toBe(16000);
  });

  it('COEF_POINTS equals the medians recomputed from the union of both shipped board lists (±60 µm windows)', () => {
    const byId = new Map<number, SwitchEntry>();
    for (const e of [...MAX_CATALOG, ...PRO_CATALOG]) byId.set(e.id, e);
    const union = [...byId.values()];
    expect(union).toHaveLength(77);

    const median = (nums: number[]) => {
      const s = [...nums].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
    };

    const expectedCounts = [4, 40, 18, 14, 4];
    COEF_POINTS.forEach(([targetUm, tableC], idx) => {
      const inWindow = union.filter((e) => Math.abs(e.rangeMax - targetUm) <= 60);
      expect(inWindow, `n at ${targetUm} µm`).toHaveLength(expectedCounts[idx]);
      expect(median(inWindow.map((e) => e.coefficient)), `median at ${targetUm} µm`).toBe(tableC);
    });
  });

  it('genericSwitch uses GENERIC_START (3400 / 20550) when null, follows the class table and clamps to bounds (kills M20)', () => {
    expect(GENERIC_START).toBe(3400);
    expect(GENERIC_CLASSES).toEqual([3200, 3400, 3500, 3600, 3800, 4000]);

    const def = genericSwitch(null, MAX_CATALOG);
    expect(def).toEqual({ uid: GENERIC_UID, name: '', maker: '', rangeUm: 3400, coefficient: 20550 });
    expect(def.curveFrom).toBeUndefined();

    const classCoefs = GENERIC_CLASSES.map((um) => genericSwitch({ rangeUm: um }, MAX_CATALOG).coefficient);
    expect(classCoefs).toEqual([25728, 20550, 19850, 18750, 16925, 15100]);

    // Clamped to board bounds, and works without a catalog using READY_BOUNDS.
    const rb = rangeBounds(MAX_CATALOG)!;
    expect(genericSwitch({ rangeUm: 4200 }, MAX_CATALOG)).toMatchObject({ rangeUm: rb.max, coefficient: 15100 });
    expect(genericSwitch({ rangeUm: 2900 }, MAX_CATALOG)).toMatchObject({ rangeUm: rb.min, coefficient: 25728 });
    expect(genericSwitch({ rangeUm: 4200 }, null)).toMatchObject({ rangeUm: READY_BOUNDS.rMax, coefficient: 15100 });
  });

  it('userToCustomLike carries curveFrom only for curve.kind === "like"', () => {
    const base: CustomSwitch = {
      uid: 'u-0123456789ab', name: 'Mine', maker: 'Wuque', travelUm: 3500, rangeUm: 3500,
      coefficient: 17536, curve: { kind: 'like', id: 13472, name: 'Skyline V3' }, color: '', note: '',
    };
    expect(userToCustomLike(base).curveFrom).toEqual({ id: 13472 });
    expect(userToCustomLike({ ...base, curve: { kind: 'travel' } }).curveFrom).toBeUndefined();
    expect(userToCustomLike({ ...base, curve: { kind: 'manual' } }).curveFrom).toBeUndefined();
  });
});
