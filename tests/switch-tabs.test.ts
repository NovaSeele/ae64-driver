import { describe, expect, it } from 'vitest';
import { switchCatalogFor } from '../src/protocol/switches';
import { MAKER_TAB_MIN, makerTabOf, makerTabs, OTHER_TAB, switchBrand, switchName } from '../src/data/switchDisplay';
import display from '../src/data/switch-display.json';

const catalog = switchCatalogFor('0030000d')!;
const tabs = makerTabs(catalog);
const tab = (id: string) => tabs.find((t) => t.id === id)!;
const names = (id: string) => tab(id).entries.map((e) => switchName(e));

describe('makerTabs (demo catalog)', () => {
  it('labels and counts', () => {
    expect(tabs.map((t) => `${t.label ?? 'Other'} ${t.entries.length}`)).toEqual(['Gateron 30', 'TTC 19', 'Unionwell 8', 'Everglide 7', 'Other 12']);
    expect(tabs.at(-1)!.id).toBe(OTHER_TAB);
  });

  it('keeps the catalog entry objects and puts each switch in exactly one tab', () => {
    const all = tabs.flatMap((t) => t.entries);
    expect(all).toHaveLength(catalog.length);
    expect(all.every((e) => catalog.includes(e))).toBe(true);
  });

  it('all Everglide switches are in the Everglide tab', () => {
    const ids = catalog.filter((e) => switchBrand(e.id) === 'Everglide').map((e) => e.id);
    expect(ids).toHaveLength(7);
    expect(tab('Everglide').entries.map((e) => e.id).sort()).toEqual([...ids].sort());
  });

  // The loader lists Star Eye (id 2128) once although the driver files it under two groups, so the demo catalog holds one HUANO.
  it('HUANO is in Other, and switches of one maker are adjacent', () => {
    const o = tab(OTHER_TAB).entries;
    expect(o.filter((e) => switchBrand(e.id) === 'HUANO')).toHaveLength(1);
    const at = o.map((e, i) => (switchBrand(e.id) === 'AULA' ? i : -1)).filter((i) => i >= 0);
    expect(at).toHaveLength(3);
    expect(at[2] - at[0]).toBe(2);
  });

  it('the KTEK switch is in TTC', () => {
    const k = catalog.find((e) => switchBrand(e.id) === 'KTEK (TTC)')!;
    expect(makerTabOf(tabs, k.id)).toBe('TTC');
  });

  it('the two Unknown switches end Other', () => {
    expect(names(OTHER_TAB).slice(-2).sort()).toEqual(['Koi', 'Purple Star']);
    expect(tab(OTHER_TAB).entries.slice(-2).every((e) => switchBrand(e.id) === null)).toBe(true);
  });
});

describe('makerTabs (synthetic)', () => {
  const idsOf = (maker: string) => Object.entries(display).filter(([, v]) => v.brand === maker).map(([id]) => ({ id: Number(id) }));

  it('threshold: 4 switches go to Other, 5 get a tab', () => {
    expect(MAKER_TAB_MIN).toBe(5);
    const e = idsOf('Everglide');
    expect(makerTabs(e.slice(0, 4)).map((t) => t.id)).toEqual([OTHER_TAB]);
    expect(makerTabs(e.slice(0, 5)).map((t) => t.id)).toEqual(['Everglide']);
  });

  it('an ID missing from switch-display.json goes to Other, at the end', () => {
    const out = makerTabs([{ id: 999999 }, ...idsOf('AULA')]);
    expect(out.map((t) => t.id)).toEqual([OTHER_TAB]);
    expect(out[0].entries.at(-1)!.id).toBe(999999);
  });

  it('ties are sorted A to Z', () => {
    const out = makerTabs([...idsOf('Unionwell').slice(0, 5), ...idsOf('Everglide').slice(0, 5), ...idsOf('Gateron').slice(0, 5)]);
    expect(out.map((t) => t.id)).toEqual(['Everglide', 'Gateron', 'Unionwell']);
  });

  it('an empty catalog has no tabs', () => {
    expect(makerTabs([])).toEqual([]);
  });
});
