import { describe, expect, it } from 'vitest';
import { SWITCH_GROUPS, findSwitch, isCatalogTriple, switchCatalogFor } from '../src/protocol/switches';
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

  it('is only available for board 0030000d', () => {
    expect(switchCatalogFor('0030000a')).toBeNull();
    expect(switchCatalogFor('0030000D')).toBe(catalog);
    expect(switchCatalogFor(undefined)).toBeNull();
    expect(switchCatalogFor(null)).toBeNull();
  });
});

describe('switch display names', () => {
  const catalog = switchCatalogFor('0030000d')!;

  it('has a unique English (ASCII) name for every catalog switch', () => {
    const names = catalog.map((e) => switchName(e));
    expect(names.every((n) => n.length > 0 && /^[ -~]+$/.test(n))).toBe(true);
    expect(new Set(names).size).toBe(catalog.length);
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
    expect(withPhoto.length).toBe(69);
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
  it('shows JIANGWAN (the Chinese name of Everglide) as EVERGLIDE and keeps the others', () => {
    expect(groupName('JIANGWAN')).toBe('EVERGLIDE');
    expect(groupName('GATERON')).toBe('GATERON');
    expect(groupName('TTC')).toBe('TTC');
  });
});
