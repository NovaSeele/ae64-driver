import { describe, expect, it } from 'vitest';
import { SWITCH_GROUPS, findSwitch, isCatalogTriple, switchCatalogFor } from '../src/protocol/switches';
import { checkPerformanceWrite } from '../src/protocol/safety';
import type { Performance } from '../src/protocol/types';
import maxJson from '../src/data/switches-0030000D.json';
import proJson from '../src/data/switches-0030000A.json';
import displayJson from '../src/data/switch-display.json';
import { groupName, switchBrand, switchImage, switchName } from '../src/data/switchDisplay';

describe('switch catalog', () => {
  const catalog = switchCatalogFor('0030000d')!;

  it('has 76 unique switches in 1/31/19/25 groups', () => {
    expect(catalog).toHaveLength(76);
    expect(new Set(catalog.map((e) => e.id)).size).toBe(76);
    expect(SWITCH_GROUPS).toEqual(['JIANGWAN', 'GATERON', 'TTC', 'Other']);
    expect(SWITCH_GROUPS.map((g) => catalog.filter((e) => e.group === g).length)).toEqual([1, 31, 19, 25]);
  });

  it('freezes every entry', () => {
    expect(Object.isFrozen(catalog[0])).toBe(true);
  });

  it('lists 星瞳轴 once, under GATERON', () => {
    const star = catalog.filter((e) => e.id === 2128);
    expect(star).toHaveLength(1);
    expect(star[0].group).toBe('GATERON');
  });

  it('uses the detail range, not the top-level one', () => {
    expect(catalog.find((e) => e.name === '磁玉Pro')!.rangeMax).toBe(3390);
  });

  it('has both 天际线轴 entries', () => {
    const sky = catalog.filter((e) => e.name === '天际线轴');
    expect(sky.map((e) => e.id).sort()).toEqual([12608, 13472]);
  });

  it('knows the UR冰磁轴 and 阿波罗轴 triples', () => {
    expect(findSwitch(catalog, 12432)).toMatchObject({ rangeMax: 3310, coefficient: 20500, group: 'Other' });
    expect(isCatalogTriple(catalog, { axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500 })).toBe(true);
    expect(isCatalogTriple(catalog, { axisV2Id: 4208, axisRangeMax: 3310, axisCoefficient: 24500 })).toBe(false);
    expect(isCatalogTriple(null, { axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500 })).toBe(false);
  });

  it('has a catalog for the Max and the Pro only', () => {
    expect(switchCatalogFor('0030000D')).toBe(catalog);
    expect(switchCatalogFor('0030000a')).not.toBe(catalog);
    expect(switchCatalogFor('0030000A')).toBe(switchCatalogFor('0030000a'));
    expect(switchCatalogFor('00300001')).toBeNull();
    expect(switchCatalogFor(undefined)).toBeNull();
    expect(switchCatalogFor(null)).toBeNull();
  });
});

describe('Pro switch catalog', () => {
  const max = switchCatalogFor('0030000d')!;
  const pro = switchCatalogFor('0030000a')!;
  const tripleOf = (e: { id: number; rangeMax: number; coefficient: number }) =>
    ({ axisV2Id: e.id, axisRangeMax: e.rangeMax, axisCoefficient: e.coefficient });

  it('has 76 unique switches in the vendor group counts', () => {
    expect(pro).toHaveLength(76);
    expect(new Set(pro.map((e) => e.id)).size).toBe(76);
    const count = (g: string) => pro.filter((e) => e.group === g).length;
    expect(['JIANGWAN', 'GATERON', 'TTC', 'Other'].map(count)).toEqual([1, 30, 19, 26]);
  });

  it('takes the triple from the detail columns', () => {
    expect(findSwitch(pro, 4352)).toMatchObject({ rangeMax: 3440, coefficient: 19100 });
    expect(findSwitch(pro, 19504)).toMatchObject({ rangeMax: 3600, coefficient: 19456 });
    expect(findSwitch(pro, 13184)).toMatchObject({ rangeMax: 3625, coefficient: 22200 });
    expect(findSwitch(pro, 14544)).toMatchObject({ rangeMax: 3400, coefficient: 17664 });
  });

  it('follows the board: a Max-only triple is not a Pro triple and the other way round', () => {
    const starEye = tripleOf(findSwitch(max, 2128)!); // Star Eye is not in the Pro list
    const sakura = tripleOf(findSwitch(pro, 13184)!); // Polar Sakura Clear is not in the Max list
    expect(findSwitch(pro, 2128)).toBeUndefined();
    expect(findSwitch(max, 13184)).toBeUndefined();
    expect(isCatalogTriple(max, starEye)).toBe(true);
    expect(isCatalogTriple(pro, starEye)).toBe(false);
    expect(isCatalogTriple(pro, sakura)).toBe(true);
    expect(isCatalogTriple(max, sakura)).toBe(false);
  });

  it('shares an id between the boards only for the same switch (display is keyed by id)', () => {
    const rows = (d: { row_fields: string[]; rows: unknown }) => {
      const at = (n: string) => d.row_fields.indexOf(n);
      return new Map((d.rows as (string | number)[][]).map((r) => [r[at('detail_axis_id')] as number, {
        name: r[at('axis_name')], brand: r[at('brand')], range: r[at('detail_axis_range_max')], coef: r[at('detail_axis_coefficient')],
      }]));
    };
    const m = rows(maxJson);
    const p = rows(proJson);
    const shared = [...p.keys()].filter((id) => m.has(id));
    expect(shared.length).toBe(75);
    for (const id of shared) expect(p.get(id), `id ${id}`).toEqual(m.get(id));
  });

  it('write guard follows the board: accepts a Pro triple and refuses a Max-only one on 0030000a', () => {
    const base: Performance = {
      mode: 0, normalPress: 2, normalRelease: 2, rtFirstTouch: 1, rtPress: 0.5, rtRelease: 0.5,
      pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 0, calibrate: 1, axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500,
    };
    const sakura = tripleOf(findSwitch(pro, 13184)!);
    const starEye = tripleOf(findSwitch(max, 2128)!);
    expect(checkPerformanceWrite({ ...base, ...sakura }, [base], { boardIdHex: '0030000a' })).toBeNull();
    expect(checkPerformanceWrite({ ...base, ...starEye }, [base], { boardIdHex: '0030000a' })).toMatch(/switch fields/);
  });
});

describe('switch display names', () => {
  it('has no orphan: every display id is in at least one catalog', () => {
    const catalogs = [switchCatalogFor('0030000d')!, switchCatalogFor('0030000a')!];
    const orphans = Object.keys(displayJson).filter((id) => !catalogs.some((c) => findSwitch(c, Number(id))));
    expect(orphans).toEqual([]);
  });

  const catalog = switchCatalogFor('0030000d')!;

  it('has a unique English (ASCII) name for every catalog switch', () => {
    const names = catalog.map((e) => switchName(e));
    expect(names.every((n) => n.length > 0 && /^[ -~]+$/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(catalog.length);
  });

  it('has a unique English (ASCII) name for every Pro catalog switch', () => {
    const pro = switchCatalogFor('0030000a')!;
    const names = pro.map((e) => switchName(e));
    expect(names.every((n) => n.length > 0 && /^[ -~]+$/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(pro.length);
  });

  it('names the switches used in the demo flow and tells the two Skylines apart', () => {
    expect(switchName(findSwitch(catalog, 12432)!)).toBe('UR Ice HE-Ex');
    expect(switchName(findSwitch(catalog, 4208)!)).toBe('Apollo');
    expect(switchName(findSwitch(catalog, 12608)!)).not.toBe(switchName(findSwitch(catalog, 13472)!));
  });
});

describe('switch photos', () => {
  const catalog = switchCatalogFor('0030000d')!;

  it('ships a photo only for switches in the catalog', () => {
    const withPhoto = catalog.filter((e) => switchImage(e.id));
    expect(withPhoto.length).toBe(73);
    expect(switchImage(4208)).toMatch(/4208.*\.webp$/); // Apollo
  });

  it('falls back to the drawn swatch when there is no photo', () => {
    expect(switchImage(4240)).toBeUndefined(); // Magnetic Jade POM: no matching photo found yet
    expect(switchImage(1)).toBeUndefined();
  });
});

describe('switch makers', () => {
  const catalog = switchCatalogFor('0030000d')!;

  it('names a maker unless it is unknown', () => {
    expect(switchBrand(12432)).toBe('Ur Studio'); // UR Ice HE-Ex
    expect(switchBrand(2128)).toBe('HUANO'); // Star Eye, filed under GATERON by the driver
    expect(switchBrand(19504)).toBe('Everglide'); // Cullinan, in the driver's 江湾 group
    expect(switchBrand(4608)).toBe('Gateron'); // 玉刃 Jade Blade: Gateron's custom for ZYNOO, not Moyu's Yurui
    expect(catalog.filter((e) => switchBrand(e.id) === null).length).toBeGreaterThan(0);
    expect(catalog.some((e) => switchBrand(e.id) === 'Unknown')).toBe(false);
    expect(switchBrand(1)).toBeNull();
  });
});

describe('switch group names', () => {
  it('shows JIANGWAN (the Chinese name of Everglide) as Everglide, GATERON as Gateron and keeps the others', () => {
    expect(groupName('JIANGWAN')).toBe('Everglide');
    expect(groupName('GATERON')).toBe('Gateron');
    expect(groupName('TTC')).toBe('TTC');
  });
});
